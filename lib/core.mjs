/**
 * core.mjs —— 前缀的存储与校验。
 *
 * 这个文件只管数据，不碰 LLM、不碰 UI。三份文件都在 `~/.dsh/brainwave/`：
 *
 *   config.json    开关、模型、baseURL、历史条数
 *   prefixes.json  每个会话一份前缀：{ [sessionId]: { text, at } }
 *   history.jsonl  每次注入一行，方便回头看「哪些前缀真的上去过」
 *
 * **前缀是会话级的**：多开对话各存各的，切回去还在，不会串。
 */

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const DIR = join(HOME, 'brainwave')

export const CONFIG_FILE = join(DIR, 'config.json')
export const PREFIX_FILE = join(DIR, 'prefixes.json')
export const HISTORY_FILE = join(DIR, 'history.jsonl')

/** 前缀最多几个字。比念头放开很多——这是用户手写的，不是模型摘的 */
export const MAX_PREFIX_CHARS = 500

export const DEFAULTS = {
  /** 总开关：关掉后 adapter 完全不注入 */
  enabled: true,
  /** 默认用哪个模型 id */
  model: 'deepseek-flash',
  /** 推理接口地址；空 = 用 adapter 内置的 https://api.deepseek.com/beta */
  baseURL: '',
  /** 历史最多留几条 */
  maxHistory: 200,
}

export const FIELDS = [
  { key: 'enabled', label: '启用前缀注入', type: 'boolean', hint: '关掉后 adapter 不会往推理开头塞任何东西' },
  { key: 'model', label: '默认模型', type: 'text', hint: 'brainwave 提供的模型 id，默认 deepseek-flash' },
  { key: 'baseURL', label: '接口地址（可选）', type: 'text', hint: '留空用内置的 https://api.deepseek.com/beta' },
  { key: 'maxHistory', label: '历史条数上限', type: 'number', min: 20, max: 2000, step: 20, hint: '超过后从最早的开始删' },
]

function clamp(key, value) {
  const f = FIELDS.find((x) => x.key === key)
  if (!f) return { ok: false, why: `不认识的配置项「${key}」` }
  if (f.type === 'boolean') {
    // 只认真布尔：写 "false" 是真值，用户会以为关掉了
    if (typeof value === 'boolean') return { ok: true, value }
    return { ok: false, why: `${f.label} 要填 true / false` }
  }
  if (f.type === 'number') {
    const n = Number(value)
    if (!Number.isFinite(n)) return { ok: false, why: `${f.label} 要填数字` }
    if (n < f.min || n > f.max) return { ok: false, why: `${f.label} 要在 ${f.min}~${f.max} 之间` }
    return { ok: true, value: Math.round(n) }
  }
  return { ok: true, value: String(value ?? '').trim() }
}

function readJson(file, fallback) {
  try {
    if (!existsSync(file)) return fallback
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(file, data) {
  mkdirSync(DIR, { recursive: true })
  writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
}

/** 读配置：文件坏了/没写都回默认值，不让一个坏文件把插件拖垮 */
export function readConfig() {
  const raw = readJson(CONFIG_FILE, {})
  const out = { ...DEFAULTS }
  const warnings = []
  for (const f of FIELDS) {
    if (raw[f.key] === undefined) continue
    const r = clamp(f.key, raw[f.key])
    if (r.ok) out[f.key] = r.value
    else warnings.push(r.why)
  }
  return { values: out, warnings, path: CONFIG_FILE }
}

/** 写配置：只写提交过的键，有一个不合法就整批不落盘 */
export function writeConfig(patch = {}) {
  const next = { ...readConfig().values }
  const rejected = []
  for (const [key, value] of Object.entries(patch || {})) {
    const r = clamp(key, value)
    if (r.ok) next[key] = r.value
    else rejected.push(r.why)
  }
  if (rejected.length) return { ok: false, rejected, values: next }
  try {
    writeJson(CONFIG_FILE, next)
    return { ok: true, values: next, path: CONFIG_FILE }
  } catch (error) {
    return { ok: false, rejected: ['写文件失败：' + String(error?.message || error)], values: next }
  }
}

/** 读某一个会话的前缀；没有就返回空串 */
export function getPrefix(sessionId) {
  const all = readJson(PREFIX_FILE, {})
  const item = all[String(sessionId || '')]
  return item && typeof item.text === 'string' ? item.text : ''
}

/** 这一条前缀是什么时候写的（面板显示用） */
export function getPrefixMeta(sessionId) {
  const all = readJson(PREFIX_FILE, {})
  const item = all[String(sessionId || '')]
  return item ? { text: item.text || '', at: item.at || 0 } : { text: '', at: 0 }
}

/**
 * 存一个会话的前缀。空字符串 = 清掉这一条。
 * @returns {{ok:true, text:string}|{ok:false, rejected:string[]}}
 */
export function setPrefix(sessionId, text) {
  const id = String(sessionId || '')
  if (!id) return { ok: false, rejected: ['没有会话 id'] }
  const raw = String(text ?? '')
  // 换行保留（多行前缀是合理用法），只去掉首尾空白
  const clean = raw.trim()
  if (clean.length > MAX_PREFIX_CHARS) {
    return { ok: false, rejected: [`前缀最多 ${MAX_PREFIX_CHARS} 字，现在是 ${clean.length} 字`] }
  }
  const all = readJson(PREFIX_FILE, {})
  if (!clean) {
    delete all[id]
    try { writeJson(PREFIX_FILE, all) } catch (e) { return { ok: false, rejected: ['写文件失败：' + String(e?.message || e)] } }
    return { ok: true, text: '' }
  }
  all[id] = { text: clean, at: Date.now() }
  try {
    writeJson(PREFIX_FILE, all)
    return { ok: true, text: clean }
  } catch (e) {
    return { ok: false, rejected: ['写文件失败：' + String(e?.message || e)] }
  }
}

/** 清掉所有会话的前缀（设置页的「全部清空」用） */
export function clearAllPrefixes() {
  try {
    rmSync(PREFIX_FILE, { force: true })
    return { ok: true }
  } catch (e) {
    return { ok: false, rejected: [String(e?.message || e)] }
  }
}

/** 记一次注入（尽力而为，失败不影响主流程） */
export function appendHistory(entry) {
  try {
    mkdirSync(DIR, { recursive: true })
    appendFileSync(HISTORY_FILE, JSON.stringify({ at: Date.now(), ...entry }) + '\n', 'utf8')
    pruneHistory(readConfig().values.maxHistory)
  } catch { /* 记不上就算了 */ }
}

function pruneHistory(max) {
  try {
    const text = readFileSync(HISTORY_FILE, 'utf8')
    const lines = text.split('\n').filter(Boolean)
    if (lines.length <= max) return
    writeFileSync(HISTORY_FILE, lines.slice(lines.length - max).join('\n') + '\n', 'utf8')
  } catch { /* 剪不掉也没事 */ }
}

/** 最近 N 条注入记录（新的在前） */
export function listHistory(limit = 50) {
  try {
    const text = readFileSync(HISTORY_FILE, 'utf8')
    const lines = text.split('\n').filter(Boolean)
    const out = []
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i -= 1) {
      try { out.push(JSON.parse(lines[i])) } catch { /* 坏行跳过 */ }
    }
    return out
  } catch {
    return []
  }
}

/** 面板要的整套配置 */
export function configSnapshot() {
  const { values, warnings, path } = readConfig()
  return { values, defaults: DEFAULTS, fields: FIELDS, warnings, path }
}

export { DIR as DATA_DIR }
