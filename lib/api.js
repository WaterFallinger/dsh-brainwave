/**
 * api.js —— `/api/brainwave/*` 路由。
 *
 * 都走宿主 webServer 的 prefix 注册（和 dsh-obs-canvas、dsh-see-now 一个写法）。
 * 宿主没有 webServer（headless）时整个跳过：adapter 照常能用，只是没有 UI。
 */

import {
  configSnapshot, writeConfig, getPrefixMeta, setPrefix, clearAllPrefixes, listHistory, MAX_PREFIX_CHARS,
  readConfig,
} from './core.mjs'
import { lastProviderOf, snapshot as stateSnapshot } from './state.mjs'

const PREFIX = '/api/brainwave'

function readBody(req, limit = 64 << 10) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { reject(new Error('请求体太大')); try { req.destroy() } catch {} return }
      chunks.push(c)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (!text) return resolve({})
      try { resolve(JSON.parse(text)) } catch { reject(new Error('不是合法 JSON')) }
    })
    req.on('error', reject)
  })
}

function json(res, status, body) {
  try {
    res.statusCode = status
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.end(JSON.stringify(body))
  } catch { /* 响应已经结束 */ }
}

/**
 * @param {object} [hooks]
 * @param {() => string} [hooks.defaultProvider] 默认模型的 provider（新会话兜底用）
 */
export function createHandler(hooks = {}) {
  const defaultProvider = typeof hooks.defaultProvider === 'function' ? hooks.defaultProvider : () => ''
  return async function handle(req, res) {
    const url = String(req?.url || '')
    const method = String(req?.method || 'GET').toUpperCase()
    try {
      // GET /api/brainwave/state?sessionId=xxx
      // 前端靠它决定「前缀」按钮显不显示：只有这个会话真的在走 brainwave 才显示。
      //   lastProvider   这个会话最近一次请求实际用的 provider（adapter 记的）
      //   defaultProvider 默认模型的 provider（新会话还没请求过时的兜底）
      if (method === 'GET' && /\/state(\?|$)/.test(url)) {
        const q = url.split('?')[1] || ''
        const sessionId = new URLSearchParams(q).get('sessionId') || ''
        const lastProto = lastProviderOf(sessionId)
        let def = ''
        try { def = String(defaultProvider() || '') } catch { def = '' }
        return json(res, 200, {
          ok: true,
          sessionId,
          lastProvider: lastProto,
          defaultProvider: def,
          // 前端一行判断用：这个会话现在是不是跑在 brainwave 上
          active: lastProto === 'brainwave' || (!lastProto && def === 'brainwave'),
        })
      }

      // GET /api/brainwave/state-all  → 调试用，看所有记录
      if (method === 'GET' && /\/state-all(\?|$)/.test(url)) {
        return json(res, 200, { ok: true, map: stateSnapshot() })
      }

      // GET /api/brainwave/prefix?sessionId=xxx
      if (method === 'GET' && /\/prefix(\?|$)/.test(url)) {
        const q = url.split('?')[1] || ''
        const params = new URLSearchParams(q)
        const sessionId = params.get('sessionId') || ''
        const meta = getPrefixMeta(sessionId)
        // 上限走配置：面板上的计数和保存时的校验用同一个值，改设置两边一起变
        const limit = readConfig().values.maxPrefixChars || MAX_PREFIX_CHARS
        return json(res, 200, { ok: true, sessionId, text: meta.text, at: meta.at, maxChars: limit })
      }

      // POST /api/brainwave/prefix  { sessionId, text }
      if (method === 'POST' && /\/prefix(\?|$)/.test(url)) {
        const body = await readBody(req)
        const sessionId = String(body?.sessionId || '')
        if (!sessionId) return json(res, 200, { ok: false, rejected: ['缺少 sessionId'] })
        const text = body?.text ?? ''
        const r = setPrefix(sessionId, text)
        // ── 保存时**不做**熔断检查 ──────────────────────────────────────
        // 试过三种判断当前 provider 的办法，全部不可靠：
        //   1. 前端传：model.label slot 不保证渲染，拿到的常常是空串
        //   2. state.mjs 的内存 Map：热重载不重置，会保留旧值
        //   3. 默认模型：那是全局的，不代表这个会话
        // 只要判断错一次就会误报，而误报（以为被拦、其实会注入）比漏报糟得多——
        // 它让人对自己的状态完全失去判断。
        //
        // 真正的拦截在 adapter 注入那一道，那里一定执行、且能被子类精确覆写。
        // 想知道某轮有没有被拦，看 ~/.dsh/brainwave/history.jsonl 里的 blocked 字段。
        return json(res, 200, r)
      }

      // POST /api/brainwave/clear  → 清空所有会话的前缀
      if (method === 'POST' && /\/clear(\?|$)/.test(url)) {
        return json(res, 200, clearAllPrefixes())
      }

      // GET /api/brainwave/config
      if (method === 'GET' && /\/config(\?|$)/.test(url)) {
        return json(res, 200, { ok: true, ...configSnapshot() })
      }

      // POST /api/brainwave/config  { enabled, autoSwitchModel, ... }
      if (method === 'POST' && /\/config(\?|$)/.test(url)) {
        const body = await readBody(req)
        if (!body || typeof body !== 'object') return json(res, 200, { ok: false, rejected: ['请求体不是 JSON'] })
        return json(res, 200, writeConfig(body))
      }

      // GET /api/brainwave/history?limit=50
      if (method === 'GET' && /\/history(\?|$)/.test(url)) {
        const q = url.split('?')[1] || ''
        const limit = Math.min(200, Math.max(1, Number(new URLSearchParams(q).get('limit')) || 30))
        return json(res, 200, { ok: true, items: listHistory(limit) })
      }

      return json(res, 404, { ok: false, error: '没有这个接口：' + method + ' ' + url })
    } catch (error) {
      return json(res, 200, { ok: false, rejected: [String(error?.message || error)] })
    }
  }
}

export { PREFIX }
