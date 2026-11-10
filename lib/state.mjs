/**
 * state.mjs —— 每个会话最近一次请求实际走的 provider，以及「谁被允许开后门」。
 *
 * 为什么需要它：前端要知道「现在这个会话是不是 brainwave」，否则没法决定
 * 该不该显示「前缀」按钮；主包保存前缀时也要据此判断该不该弹熔断警告。
 * DSH 的模型选择是会话级的，插件在客户端拿不到它（那个信息在 model-selection
 * 包的私有 store 里），所以换一条路：
 *
 *   adapter 每次真的被调用时，把 sessionId → provider 记下来。
 *
 * **落盘，不是纯内存。** 早先是内存 Map，踩过两次：
 *   - 热重载不重置，保留着上一次（可能是错的）记录
 *   - 进程重启就丢，重启后所有会话都「不知道自己在用谁」
 * 文件很小、写入频率也低（每个请求一次），不值得为它省这点 IO。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

const HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const FILE = join(HOME, 'brainwave', 'state.json')

/** 最多记多少个会话，超了丢最早的 */
const MAX_SESSIONS = 500

let last = new Map()
let loaded = false

function load() {
  if (loaded) return
  loaded = true
  try {
    if (!existsSync(FILE)) return
    const raw = JSON.parse(readFileSync(FILE, 'utf8'))
    for (const [k, v] of Object.entries(raw || {})) {
      if (v && typeof v.provider === 'string') last.set(k, { provider: v.provider, at: Number(v.at) || 0 })
    }
  } catch { /* 坏了就当没记过 */ }
}

function persist() {
  try {
    mkdirSync(dirname(FILE), { recursive: true })
    if (last.size > MAX_SESSIONS) {
      const sorted = [...last.entries()].sort((a, b) => (a[1].at || 0) - (b[1].at || 0))
      for (const [k] of sorted.slice(0, last.size - MAX_SESSIONS)) last.delete(k)
    }
    writeFileSync(FILE, JSON.stringify(Object.fromEntries(last)), 'utf8')
  } catch { /* 写不进去也不能影响请求 */ }
}

/** adapter 每次 stream 时调 */
export function noteRequest(sessionId, provider = 'brainwave') {
  const id = String(sessionId || '')
  if (!id) return
  load()
  last.set(id, { provider: String(provider || 'brainwave'), at: Date.now() })
  persist()
}

/** 查某个会话最近一次用的 provider；没有就返回 null */
export function lastProviderOf(sessionId) {
  load()
  const rec = last.get(String(sessionId || ''))
  return rec ? rec.provider : null
}

// ── 后门登记 ────────────────────────────────────────────────────────────
/**
 * 哪些 provider 允许跳过主包的「保存时熔断警告」。
 *
 * 主包本身永不调用 `markBypass`——正常版一视同仁地警告。
 * 这是留给**调试变体**的口子：它继承主包 adapter、覆写 checkPrefix()，
 * 注入时本来就不受熔断约束，保存时也不该弹出「会被拦下」的假警告。
 *
 * 不进文件：后门由插件在 apply() 时自己登记，进程重启后重新登记即可。
 */
const bypassed = new Set()

export function markBypass(provider) {
  const id = String(provider || '')
  if (id) bypassed.add(id)
}

export function isBypassed(provider) {
  return bypassed.has(String(provider || ''))
}

/** 调试/诊断用 */
export function snapshot() {
  load()
  const out = {}
  for (const [k, v] of last) out[k] = v
  return out
}
