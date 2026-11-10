/**
 * api.js —— `/api/brainwave/*` 路由。
 *
 * 都走宿主 webServer 的 prefix 注册（和 dsh-obs-canvas、dsh-see-now 一个写法）。
 * 宿主没有 webServer（headless）时整个跳过：adapter 照常能用，只是没有 UI。
 */

import {
  configSnapshot, writeConfig, getPrefixMeta, setPrefix, clearAllPrefixes, listHistory, MAX_PREFIX_CHARS,
  checkPrefix, readConfig,
} from './core.mjs'
import { lastProviderOf, isBypassed, snapshot as stateSnapshot } from './state.mjs'

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
        // ── 保存时的熔断警告 ─────────────────────────────────────────────
        // **正常版一律检查**。判断「这个会话用哪个 provider」只看一个来源：
        // adapter 落盘记录的上一次实际 provider（state.json）。它不依赖前端传参
        // （model.label slot 不保证渲染），也不怕热重载（内存 Map 会留旧值，踩过）。
        // 会话还没发过请求时退回默认模型。
        //
        // 后门：调试变体在 apply() 里调 markBypass() 登记自己，这里据此放行。
        // 主包自身从不调用 markBypass，所以正常版的行为完全不受影响。
        const provider = lastProviderOf(sessionId) || String(defaultProvider() || '')
        const verdict = isBypassed(provider) ? { ok: true, reasons: [] } : checkPrefix(text)
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
