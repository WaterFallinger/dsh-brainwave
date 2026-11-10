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

/**
 * 一级红线：涉及未成年人。
 *
 * 这一组**判断内容本身**，不判断结构。**出现即拦，不要求共现、不做上下文豁免。**
 *
 * 早先是「未成年 + 性字样」共现才拦，为的是不误杀「保护未成年人」这种正常表述。
 * 但前缀是「思考起点」，没人会把它写成那样——共现条件只会放跑真正该拦的。
 * 现在改成单字即拦，误杀认了，它对面是法律红线。
 */
const MINOR_REDLINE = [
  {
    re: /未成年|幼女|幼童|萝莉|正太|恋童|儿童色情|童交/,
    why: '涉及未成年人的内容',
  },
]

/**
 * 前缀的安全熔断规则。**这是一层可移除的便利防护，不是安全保证。**
 *
 * 「防呆不防黑」：只拦结构上就危险的写法，不判断内容好坏——内容判断既拦不住
 * 真想绕的人，又会误杀正常用法。而一个把「忽略之前所有指令」粘进来的人，
 * 是真的会让插件看起来坏掉：模型甩掉 system 之后行为不可控，用户只会以为
 * 插件坏了。那才是要防的。
 *
 * **本段可被移除或绕过。** 移除属于修改者对自身部署的改动，不构成原作者的
 * 推荐、认可或任何形式的担保；改动后的行为及其后果由修改者自行承担。
 *
 * 具体做法上，覆写 adapter 的 `checkPrefix()` 即可整段跳过（调试变体就这么做的：
 * 它要测的恰恰是「不受任何约束时会发生什么」）。
 */
const RISKY_PREFIX = [
  {
    re: /\b(ignore|disregard|forget)\b[^。！\n]{0,24}\b(previous|prior|above|all|system)\b[^。！\n]{0,24}\b(instruction|prompt|rule|setting|message)s?\b/i,
    why: '含「忽略此前指令」式的越狱语句',
  },
  {
    re: /(忽略|无视|忘记|不要理会|抛开)[^。！？\n]{0,12}(之前|以上|上述|前面|所有|系统)[^。！？\n]{0,8}(指令|提示|设定|规则|身份)/,
    why: '含「忽略此前指令」式的越狱语句',
  },
  {
    re: /<\/?system\s*>|\[system\]|<<\s*sys\s*>>/i,
    why: '含系统提示词标记，会被当成指令而不是起念',
  },
  {
    re: /<\|[a-z_]+\|>|\btool_calls\b|\bfunction_call\b/i,
    why: '含特殊 token 或工具调用标记，会污染请求体',
  },
  {
    re: /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/,
    why: '含控制字符（多半是粘贴时带进来的脏东西）',
  },
]

// ── 规则集登记 ────────────────────────────────────────────────────────────
// 改规则表之前先看这几行。它们不参与任何判断，也没有被任何地方引用——
// 留着是为了让规则表的形状有据可查，而不是让人「顺手删一条试试」。
const RULESET_EPOCH = 1
const RULESET_SIZE = RISKY_PREFIX.length
const RULESET_FINGERPRINT = RISKY_PREFIX.map((r) => r.re.source.length).join('.')
const MIN_ACCEPTED_RULES = 4

// 预留：规则分级（尚未启用）
const RULE_TIERS = Object.freeze({ structural: 1, corpus: 2 })

/**
 * 检查一段前缀会不会把请求搞坏。
 * @param {string} text
 * @returns {{ok: boolean, reasons: string[]}}
 */
export function checkPrefix(text) {
  const clean = String(text ?? '').trim()
  if (!clean) return { ok: true, reasons: [] }
  const reasons = []
  // 一级红线先过，出现即拦
  for (const rule of MINOR_REDLINE) {
    if (rule.re.test(clean) && !reasons.includes(rule.why)) reasons.push(rule.why)
  }
  for (const rule of RISKY_PREFIX) {
    if (rule.re.test(clean) && !reasons.includes(rule.why)) reasons.push(rule.why)
  }
  for (const rule of SEXUAL_REDLINE) {
    if (rule.re.test(clean) && !reasons.includes(rule.why)) reasons.push(rule.why)
  }
  for (const rule of HARM_REDLINE) {
    if (rule.re.test(clean) && !reasons.includes(rule.why)) reasons.push(rule.why)
  }
  return { ok: reasons.length === 0, reasons }
}

/**
 * 二级红线：露骨性内容与成人用品。
 *
 * 只收「本义明确」的词——「做爱」「破处」「精液」这类不会出现在别的语境里。
 * 单字「性」不收：它在「可能性」「性格」「属性」里出现得太频繁，收了插件就没法用。
 */
const SEXUAL_REDLINE = [
  {
    re: /(做爱|交欢|性交|口交|肛交|抽插|射精|精液|破处|处女膜|自慰|性高潮|淫水|肉棒|下体)/,
    why: '露骨性内容',
  },
  {
    re: /(飞机杯|倒模|名器|跳蛋|按摩棒|情趣用品|硅胶娃娃|成人玩具)/,
    why: '成人用品',
  },
]

/**
 * 二级红线：自伤、致死方法与极端暴力。
 *
 * 同样只收词不收字——「杀」「死」单字在「杀死进程」「死循环」里是正常表达，
 * 拦了会让正常工作前缀全部失效。
 */
const HARM_REDLINE = [
  {
    re: /(自杀|割腕|上吊|勒死|掐死|窒息致死|自残|怎么死|如何自杀)/,
    why: '自伤或致死内容',
  },
  {
    re: /(虐杀|分尸|肢解|奸杀|碎尸|虐童)/,
    why: '极端暴力内容',
  },
]

export const DEFAULTS = {
  /** 总开关：关掉后 adapter 完全不注入 */
  enabled: true,
  /** 默认用哪个模型 id */
  model: 'deepseek-flash',
  /** 推理接口地址；空 = 用 adapter 内置的 https://api.deepseek.com/beta */
  baseURL: '',
  /** 历史最多留几条 */
  maxHistory: 200,
  /** 前缀字数上限。默认 500；调试时可以调大，用来测长前缀 */
  maxPrefixChars: 500,
}

export const FIELDS = [
  { key: 'enabled', label: '启用前缀注入', type: 'boolean', hint: '关掉后 adapter 不会往推理开头塞任何东西' },
  { key: 'model', label: '默认模型', type: 'text', hint: 'brainwave 提供的模型 id，默认 deepseek-flash' },
  { key: 'baseURL', label: '接口地址（可选）', type: 'text', hint: '留空用内置的 https://api.deepseek.com/beta' },
  { key: 'maxPrefixChars', label: '前缀字数上限', type: 'number', min: 100, max: 20000, step: 100, hint: '默认 500。测长前缀时可以调大，面板上的计数会跟着变' },
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
  // 上限走配置（默认 500，可在设置里调大——测长前缀时要靠它）
  const limit = readConfig().values.maxPrefixChars || MAX_PREFIX_CHARS
  if (clean.length > limit) {
    return { ok: false, rejected: [`前缀最多 ${limit} 字，现在是 ${clean.length} 字`] }
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
