/**
 * state.mjs —— 每个会话最近一次请求实际走的 provider。
 *
 * 为什么需要它：前端要知道「现在这个会话是不是 brainwave」，否则没法决定
 * 该不该显示「前缀」按钮。DSH 的模型选择是会话级的，插件在客户端拿不到它
 * （那个信息在 model-selection 包的私有 store 里），所以换一条路：
 *
 *   adapter 每次真的被调用时，把 sessionId → brainwave 记下来。
 *   前端问 /api/brainwave/state?sessionId=… 就知道这个会话最近用的是谁。
 *
 * 只放内存：进程重启后清空。新会话第一次请求之前查不到，前端退回看默认模型。
 */

const last = new Map()

/** adapter 每次 stream 时调；provider 固定是 brainwave，留参数是为了以后扩展 */
export function noteRequest(sessionId, provider = 'brainwave') {
  const id = String(sessionId || '')
  if (!id) return
  last.set(id, { provider, at: Date.now() })
}

/** 查某个会话最近一次用的 provider；没有就返回 null */
export function lastProviderOf(sessionId) {
  const rec = last.get(String(sessionId || ''))
  return rec ? rec.provider : null
}

/** 调试/诊断用 */
export function snapshot() {
  const out = {}
  for (const [k, v] of last) out[k] = v
  return out
}
