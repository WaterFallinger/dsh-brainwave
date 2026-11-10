/**
 * api.js —— `/api/brainwave/*` 路由。
 *
 * 都走宿主 webServer 的 prefix 注册（和 dsh-obs-canvas、dsh-see-now 一个写法）。
 * 宿主没有 webServer（headless）时整个跳过：adapter 照常能用，只是没有 UI。
 */

import {
  configSnapshot, writeConfig, getPrefixMeta, setPrefix, clearAllPrefixes, listHistory, MAX_PREFIX_CHARS,
  checkPrefix,
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
        return json(res, 200, { ok: true, sessionId, text: meta.text, at: meta.at, maxChars: MAX_PREFIX_CHARS })
      }

      // POST /api/brainwave/prefix  { sessionId, text }
      if (method === 'POST' && /\/prefix(\?|$)/.test(url)) {
        const body = await readBody(req)
        const sessionId = String(body?.sessionId || '')
        if (!sessionId) return json(res, 200, { ok: false, rejected: ['缺少 sessionId'] })
        const text = body?.text ?? ''
        const r = setPrefix(sessionId, text)
        // 安全熔断：保存路径只警告、不拒绝。用户存得进去，注入时由 adapter 拦下。
        // 这条 warning 只是让「存了却没生效」的原因当场可见，不是安全结论。
        const verdict = checkPrefix(text)
        return json(res, 200, {
          ...r,
          warning: verdict.ok ? '' : `这段前缀会被安全熔断拦下，不会注入：${verdict.reasons.join('；')}`,
        })
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
