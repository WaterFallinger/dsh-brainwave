/**
 * adapter.js —— 会往推理开头塞前缀的 LLM 适配器。
 *
 * 为什么自己写：DSH 自带的适配器走 anthropic 协议，不认思维链前缀；换走 OpenAI 兼容
 * 路（deepseek 的 beta 端点）能塞前缀，但那边思考块和正文块的位置会错。这里自己发
 * 请求、自己编块号，两件事就都能由自己说了算。
 *
 * 和 dsh-beta-adapter 的差别只在一处：**前缀从哪来**。那边是自动从念头库里抽，
 * 这边是用户自己在 chat 面板里填的——所以不需要概率、冷却、触发词这一整套。
 *
 * 三条硬限制（全部实测过，别再踩）：
 *   · prefix 必须是**最后一条** assistant 消息，`content: ''`，
 *     且带 `prefix: true`
 *   · prefix 和 function calling **互斥**：body 里有 `tools`、或者 messages 里有
 *     `tool_calls` / `role: 'tool'`，一律 400 "Function call should not be used with prefix"
 *   · 触发的那一轮必须把 tools **和工具痕迹一起**剥掉，否则模型这轮调不了工具
 */

import { getPrefix, appendHistory, readConfig, checkPrefix as coreCheckPrefix } from './core.mjs'
import { noteRequest } from './state.mjs'

/**
 * **刻意不 `extends LlmAdapter`。**
 *
 * DSH 的 `registerAdapter()` 只检查鸭子类型（`instanceof LlmAdapter` 在整套源码里
 * 出现 0 次），而 `import '@deepseek-ai/dsh-llm'` 把适配器钉死在宿主包里——
 * 后果是：调试变体（`dsh-brainwave-test`）没法 import 这份文件，因为它的真实路径
 * 在工作区、往上找不到 profile 的 node_modules。
 *
 * 所以基类那七个方法全部自己实现（下面都齐了）：
 *   providerInfo / providerRetryPolicy / imageRequestPricing / imageRequestTarget
 *   listModels / resolveModel / prepareCall
 * 代价是 DSH 将来给 LlmAdapter 加新方法时要记得跟进；收益是这份适配器只依赖
 * node 内置模块，能被任何包继承。
 *
 * ⚠️ 曾经漏掉 `prepareCall`，报错是 `registration.adapter.prepareCall is not a function`，
 * 请求在 DSH 内部就炸了、连 API 都没到。加方法时逐个对照上面那张表。
 */

export const PROVIDER = 'brainwave'
const DEFAULT_MAX_TOKENS = 32000
const DEFAULT_BASE = 'https://api.deepseek.com/beta'

// 熔断统计位（保留，当前未启用）
let blockedTotal = 0
const MAX_BLOCK_REASONS = 4

/**
 * 注入那一轮追加到 system 末尾的一句话。
 *
 * 为什么必须有：prefix 和 function calling 互斥，所以注入轮必须把 tools 拿掉、
 * 把历史里的工具痕迹也剥掉。但 system prompt 里仍然写着「你可以用 bash / read」——
 * 模型不知道自己没有工具，会照常"用"一遍并**编一个结果出来**。
 * 这句把事实说清楚，它就只会说「这轮读不了」。
 */
const NO_TOOL_NOTE = '（本轮不提供工具调用能力，只能用文字回答；不要声称你调用或执行过任何工具。）'

export const MODELS = [
  { id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash (brainwave)', vision: true },
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro (brainwave)', vision: false },
]

/**
 * 拿 API key。顺序很重要：
 *
 *   1. `ctx.credentials.resolve(ref)` —— DSH 的凭据服务（**用户已经配好的那份在这**，
 *      账号登录或设置页里填的 key 都存在这，不落到环境变量里）
 *   2. 环境变量兜底（`DEEPSEEK_API_KEY` 等，老用法）
 *
 * 一开始只查环境变量，结果用户明明登录了 DSH 还是报「没有 API key」——
 * 因为 DSH 的 key 从来不在进程环境里。
 */
async function readKey(ctx) {
  // 1) DSH 凭据服务。ref 名是环境变量名，DSH 的账号系统按这个名字存。
  for (const ref of ['DEEPSEEK_API_KEY', 'DEEPSEEK_BETA_KEY', 'DEEPSEEK_KEY']) {
    try {
      const svc = ctx?.credentials
      if (svc && typeof svc.resolve === 'function') {
        const v = await svc.resolve(ref)
        if (v && typeof v === 'string' && v.trim()) return v.trim()
        if (v && typeof v === 'object' && typeof v.value === 'string' && v.value.trim()) return v.value.trim()
      }
    } catch { /* 这个 ref 没配，试下一个 */ }
  }
  // 2) 环境变量兜底
  for (const name of ['DEEPSEEK_API_KEY', 'DEEPSEEK_BETA_KEY', 'DEEPSEEK_KEY']) {
    const v = process.env[name]
    if (v && v.trim()) return v.trim()
  }
  return ''
}

/** 把 dsh 的 ContentBlock[] 拍成一段纯文本 */
function blocksToText(blocks) {
  if (!Array.isArray(blocks)) return ''
  const out = []
  for (const b of blocks) {
    if (!b) continue
    if (b.type === 'text') out.push(b.text ?? '')
    else if (b.type === 'tool-result') out.push(blocksToText(b.content))
  }
  return out.join('\n')
}

/**
 * 把一张 DSH 的 image 块读成 OpenAI 的 image_url。
 * 读不到就丢掉这一张——宁可少一张图，也不能让整轮请求挂掉。
 *
 * **但绝不能静默丢**。之前的版本四个失败分支都裸 return null，结果
 * `inject` 里漏了 `attachments`、`ctx.attachments` 是 undefined，
 * 每一张图都被丢掉而没有任何痕迹——模型看起来在正常回答，其实什么都没看见。
 * 现在每一次丢图都留一条 warn，日志里能查出来。
 */
async function imageBlockToUrl(ctx, block, signal) {
  const att = ctx?.attachments
  if (!att || typeof att.readImage !== 'function') {
    logOnce('no-attachments', 'brainwave: 拿不到 attachments 服务，图片会被丢掉（检查 inject 里有没有声明 attachments）')
    return null
  }
  try {
    const stored = await att.readImage(block.attachment, signal)
    if (!stored || !stored.data) {
      logOnce('no-data', 'brainwave: readImage 没返回数据，这一张丢掉')
      return null
    }
    const mediaType = (stored.ref && stored.ref.mediaType) || 'image/png'
    const b64 = Buffer.from(stored.data).toString('base64')
    return `data:${mediaType};base64,${b64}`
  } catch (error) {
    logOnce('read-fail', 'brainwave: 读图片失败，这一张丢掉 —— ' + String(error?.message || error))
    return null
  }
}

/** 同一类警告只打一次，避免一条长对话刷屏 */
const _logged = new Set()
function logOnce(key, message) {
  if (_logged.has(key)) return
  _logged.add(key)
  console.warn(message)
}

/** 一条 user 消息的 content 装成 wire 格式：纯文字压成字符串，带图才用分块 */
async function userContentToWire(ctx, content, signal) {
  const blocks = Array.isArray(content) ? content : []
  const parts = []
  for (const b of blocks) {
    if (!b) continue
    if (b.type === 'text') {
      parts.push({ type: 'text', text: b.text ?? '' })
    } else if (b.type === 'image') {
      const url = await imageBlockToUrl(ctx, b, signal)
      if (url) parts.push({ type: 'image_url', image_url: { url } })
    } else if (b.type === 'tool-result') {
      parts.push({ type: 'text', text: blocksToText(b.content) })
    }
  }
  if (parts.length === 1 && parts[0].type === 'text') return parts[0].text
  return parts
}

/** dsh 的 Message[] → OpenAI 的 messages[] */
async function toWireMessages(messages, system, ctx, signal) {
  const wire = []
  if (system) wire.push({ role: 'system', content: system })

  for (const m of messages ?? []) {
    if (!m) continue

    // ⚠️ DSH 把系统提示词作为 `developer` 角色的消息放进 messages，
    // 而不是 `options.system`。不认这两个角色，它们就会掉到下面的 else 分支、
    // 被当成 `role: user` 发出去——模型那边看着一模一样，但语义完全变了：
    // 「这是系统给我的规则」变成了「用户对我说的话」，而且 `prepareWire`
    // 按 role==='system' 找它永远找不到。
    if (m.role === 'system' || m.role === 'developer') {
      wire.push({ role: 'system', content: blocksToText(m.content) })
      continue
    }

    const toolBlock = Array.isArray(m.content) ? m.content.find((b) => b && b.type === 'tool-result') : null
    if (toolBlock) {
      wire.push({
        role: 'tool',
        tool_call_id: String(toolBlock.toolCallId ?? (m.source && m.source.callId) ?? ''),
        content: blocksToText(toolBlock.content),
      })
      continue
    }

    if (m.role === 'tool') {
      wire.push({
        role: 'tool',
        tool_call_id: String(m.toolCallId ?? (m.source && m.source.callId) ?? ''),
        content: blocksToText(m.content),
      })
      continue
    }

    if (m.role === 'assistant') {
      const text = blocksToText(m.content)
      const reasoning = (m.content ?? [])
        .filter((b) => b && b.type === 'reasoning')
        .map((b) => b.text ?? '')
        .join('')
      const calls = (m.content ?? []).filter((b) => b && b.type === 'tool-call')
      const msg = { role: 'assistant', content: text || '' }
      if (reasoning) msg.reasoning_content = reasoning
      if (calls.length) {
        msg.tool_calls = calls.map((c) => ({
          id: String(c.id ?? ''),
          type: 'function',
          function: { name: c.name ?? '', arguments: c.arguments ?? '{}' },
        }))
      }
      wire.push(msg)
      continue
    }

    wire.push({ role: 'user', content: await userContentToWire(ctx, m.content, signal) })
  }
  return wire
}

/**
 * 带前缀的这一轮：摘掉消息里的工具往返，只留说话的正文。
 * prefix 和 function calling 互斥，历史里残留的 tool_calls / tool 消息也会让请求 400。
 */
export function stripToolArtifacts(wire) {
  const out = []
  for (const m of wire) {
    if (m.role === 'tool') continue
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const { tool_calls, ...rest } = m
      if (!rest.content && !rest.reasoning_content) continue
      out.push(rest)
      continue
    }
    out.push(m)
  }
  return out
}

/** 解析 SSE 的一行 data */
function parseData(line) {
  const s = line.trim()
  if (!s.startsWith('data:')) return null
  const payload = s.slice(5).trim()
  if (!payload) return null
  if (payload === '[DONE]') return 'done'
  try {
    return JSON.parse(payload)
  } catch {
    return null
  }
}

export class BrainwaveAdapter {
  constructor(config = {}, ctx) {
    this.ctx = ctx
    const cfg = readConfig().values
    this.baseURL = config.baseURL || cfg.baseURL || DEFAULT_BASE
    this.models = config.models || MODELS
    /** provider id 可覆盖：调试插件要挂成另一个 provider，跟本体共存 */
    this.providerId = config.providerId || PROVIDER
    /** 显示名也可覆盖 */
    this.displayName = config.displayName || '福至心灵 · brainwave'
  }

  /**
   * 图片请求的定价信息。没有私有定价 → 返回 undefined，让宿主用自己的中性估算。
   * （这是 LlmAdapter 的默认行为，本类不继承它，所以自己实现一份。）
   */
  imageRequestPricing(_provider, _model) {
    return undefined
  }

  /**
   * 这张图发给模型时的目标尺寸。
   * 默认原样保留宿主归一化过的尺寸——本适配器不额外缩放。
   */
  imageRequestTarget(_provider, _model, image) {
    return {
      width: image.width,
      height: image.height,
      maxBytes: image.bytes,
    }
  }

  providerInfo(provider) {
    return { id: provider, name: this.displayName }
  }

  providerRetryPolicy() {
    return undefined
  }

  async listModels() {
    return this.models.map((m) => ({
      provider: this.providerId,
      id: m.id,
      name: m.name,
      inputModalities: m.vision ? ['text', 'image'] : ['text'],
    }))
  }

  async resolveModel(provider, model) {
    const found = this.models.find((m) => m.id === model) || this.models[0]
    return {
      provider,
      id: model,
      name: found.name,
      inputModalities: found.vision ? ['text', 'image'] : ['text'],
      defaultMaxTokens: DEFAULT_MAX_TOKENS,
      reasoning: {
        efforts: [
          { id: 'low', name: 'low' },
          { id: 'high', name: 'high' },
          { id: 'max', name: 'max' },
        ],
        defaultEffort: 'high',
      },
    }
  }

  /**
   * 把「这个模型是什么」和「真正发请求的入口」一起交给宿主，并且绑死在这一代适配器上。
   *
   * 宿主只拿 `prepareCall()` 的返回值去发请求（`adapterCall.stream(options)`），
   * 之后不再碰适配器本身。少了它，请求会在 DSH 内部就炸在
   * `registration.adapter.prepareCall is not a function`——根本到不了 API。
   *
   * 基类的默认实现就是「解析模型 + 转到自己的 stream」，本类不继承基类，照抄一份。
   */
  async prepareCall(provider, model, signal) {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options) => this.stream(options),
    }
  }

  /**
   * 注入轮的 wire 收尾：决定这一轮里 system 放不放、放多少。
   *
   * **这是留给调试插件的扩展点。** 本体只做一件事：把「本轮没有工具」这个事实
   * 追加到 system 末尾（不做会有编造工具结果的风险，见 NO_TOOL_NOTE 的注释）。
   *
   * 子类可以整个替掉它——比如把宿主给的 system 全部丢弃，用来测「零 system 时
   * 模型会怎样」。那个变体是评估用的调试工具，**不跟本体一起发布**。
   *
   * @param {Array} wire  已经拼好的 OpenAI 消息数组（会被就地修改）
   * @param {{injected: boolean}} ctx  这一轮有没有真的注入前缀
   * @returns {Array} 同一个 wire
   */
  prepareWire(wire, { injected } = {}) {
    if (!injected) return wire
    // system 可能不止一条（DSH 的系统提示词、运行时上下文都是分开的 developer 消息）。
    // 追加到最后一条上，保证那句「本轮没有工具」离对话最近。
    let last = -1
    for (let i = 0; i < wire.length; i += 1) {
      if (wire[i] && wire[i].role === 'system') last = i
    }
    if (last >= 0) {
      wire[last].content = [String(wire[last].content || ''), NO_TOOL_NOTE].filter(Boolean).join('\n\n')
    } else {
      wire.unshift({ role: 'system', content: NO_TOOL_NOTE })
    }
    return wire
  }

  /**
   * 请求体的最后一道工序，发出去之前调用。
   *
   * **这是留给调试插件的第二个扩展点。** 本体什么都不做——messages、tools、
   * 采样参数在上面已经拼好了，原样交出去。
   *
   * 子类可以整个改掉它，比如连 `tools` 一起删，用来测「既没有 system、
   * 也没有任何工具线索」时模型还剩什么。
   *
   * ⚠️ 删 `tools` 的同时必须把 messages 里的 `tool_calls` / `role: 'tool'` 也剥掉，
   * 否则历史里带着工具调用却没有工具声明，接口会 400。`stripToolArtifacts`
   * 就是干这个的，已经导出可以直接用。
   *
   * @param {object} body  即将发给 API 的请求体（会被就地修改）
   * @param {{injected: boolean}} ctx  这一轮有没有真的注入前缀
   * @returns {object} 同一个 body
   */
  prepareBody(body, { injected } = {}) {
    return body
  }

  /**
   * 前缀的静态检查——**安全熔断**。默认走 `core.mjs` 里那套「防呆不防黑」的规则：
   * 只拦结构上就危险的写法（越狱模板、系统提示词标记、特殊 token、控制字符），
   * 不判断内容好坏。它不替代宿主的 approval，也不替代 API 的内容审核。
   *
   * **本段可被移除或绕过。** 移除属于修改者对自身部署的改动，不构成原作者的
   * 推荐、认可或任何形式的担保；改动后的行为及其后果由修改者自行承担。
   *
   * 覆写成永远返回 `{ ok: true, reasons: [] }` 即可整段跳过。调试变体就是这么做的。
   *
   * @param {string} text
   * @returns {{ok: boolean, reasons: string[]}}
   */
  checkPrefix(text) {
    return coreCheckPrefix(text)
  }

  /**
   * 响应元信息回调：HTTP 状态、原始 `finish_reason`、错误响应体。
   *
   * 本体什么都不做——不写文件、不打日志。这是留给调试变体的诊断口子。
   *
   * 为什么要留：`finish_reason` 里能区分「模型自己说完」（`stop`）、
   * 「被截断」（`content_filter`）和「撞上 token 上限」（`length`）。
   * 只看 `text` 长度是分不出来的——空回复可能是模型不想说，也可能是被筛掉了。
   *
   * @param {object} meta  { status, finishReason?, error?, sessionId? }
   */
  noteResponse(meta) {
    /* 留给子类 */
  }

  async *stream(options) {
    // 记账要用的状态提到最外层：generator 被调用方中断时（用户点了停止），
    // finally 里也要能读到这些值，否则最该留档的那一轮什么都留不下。
    let injected = false
    let prefix = ''
    /** 被安全熔断拦下的原因；空数组 = 没拦 */
    let blocked = []
    let reasoningText = ''
    let textText = ''
    let logged = false

    /** 记账：正常收尾传 true，被中断传 false。只会写一次。 */
    const writeHistory = (completed) => {
      // 被熔断的轮次也要留一笔：否则「设了前缀却没生效」会一点痕迹都没有，
      // 用户只能看到模型莫名其妙地不按前缀走。这里记的是没被注入的原始前缀
      // 和拦截原因，不构成任何安全结论。
      if (logged || (!injected && !blocked.length)) return
      logged = true
      try {
        appendHistory({
          sessionId: options.sessionId || '',
          prefix,
          reasoning: reasoningText,
          reply: textText,
          completed,
          ...(blocked.length ? { blocked } : {}),
        })
      } catch { /* 记不上也不能影响主流程 */ }
    }

    try {
      const key = await readKey(this.ctx)
      if (!key) throw new Error('brainwave: 没有 API key（设 DEEPSEEK_API_KEY）')

      // 记一笔：这个会话真的在用 brainwave。前端靠它决定要不要显示「前缀」按钮。
      // 放在最前面——哪怕后面请求失败，也说明用户确实切过来了。
      noteRequest(options.sessionId, PROVIDER)

      const cfg = readConfig().values
      const wire = await toWireMessages(options.messages, options.system, this.ctx, options.signal)

      // 前缀从会话存储里读；辅助调用（起标题之类）不注入
      prefix = cfg.enabled && !options.purpose
        ? getPrefix(options.sessionId)
        : ''

      // 安全熔断：拦「会把请求搞坏的写法」，不判断内容好坏。
      // 本段可被移除或绕过——移除属于修改者对自身部署的改动，原作者不作任何担保。
      if (prefix) {
        const verdict = this.checkPrefix(prefix)
        if (!verdict.ok) {
          blocked = verdict.reasons
          logOnce('prefix-blocked', '[brainwave] 前缀被安全熔断拦下，这一轮不注入：' + verdict.reasons.join('；'))
        }
      }

      if (prefix && !blocked.length) {
        const last = wire[wire.length - 1]
        if (!last || last.role !== 'assistant') {
          wire.push({ role: 'assistant', content: '', reasoning_content: prefix, prefix: true })
          injected = true
        }
      }

      // 注入轮的收尾交给 prepareWire（子类可覆盖，见方法定义）
      this.prepareWire(wire, { injected, sessionId: options.sessionId, messages: options.messages })

      // 光去掉 body.tools 不够：只要 messages 里还留着 tool_calls / role: tool，
      // prefix 一样被拒。这一轮把这些痕迹也摘掉，只留说话的正文。
    const outWire = injected ? stripToolArtifacts(wire) : wire

    const body = {
      model: options.model,
      messages: outWire.filter(
        (m) => !(m.role === 'assistant' && !m.content && !m.reasoning_content
          && !(m.tool_calls && m.tool_calls.length)),
      ),
      stream: true,
      stream_options: { include_usage: true },
    }
    body.max_tokens = options.maxTokens || DEFAULT_MAX_TOKENS
    if (options.temperature !== undefined) body.temperature = options.temperature
    if (options.reasoningEffort && options.reasoningEffort !== 'off') {
      body.reasoning_effort = String(options.reasoningEffort)
    }
    if (!injected && Array.isArray(options.tools) && options.tools.length) {
      body.tools = options.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }))
    }

    // 请求体的收尾交给 prepareBody（子类可覆盖，见方法定义）
    this.prepareBody(body, { injected, sessionId: options.sessionId, messages: options.messages })

    const res = await fetch(`${this.baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: options.signal,
    })

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      this.noteResponse({ status: res.status, error: detail.slice(0, 500), sessionId: options.sessionId })
      throw new Error(`brainwave: HTTP ${res.status} ${detail.slice(0, 200)}`)
    }
    if (!res.body) throw new Error('brainwave: 没有响应体')

      // 块号自己编：思考块先占 0，正文块占 1，工具调用接着排
      let reasoningIndex = -1
      let textIndex = -1
      let nextIndex = 0
      const toolState = new Map()
      let finishKind = 'stop'
      /** 原始 finish_reason：content_filter / stop / length / tool_calls，原样交给 noteResponse */
      let rawFinish = ''
      // reasoningText / textText 在外层声明过了（finally 要用）

      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''

    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })

      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        const data = parseData(line)
        if (!data) continue
        if (data === 'done') continue

        const choice = data.choices && data.choices[0]
        if (data.usage && !choice?.delta) {
          yield {
            type: 'usage',
            usage: {
              inputTokens: data.usage.prompt_tokens ?? 0,
              outputTokens: data.usage.completion_tokens ?? 0,
            },
          }
          continue
        }
        if (!choice) continue
        const delta = choice.delta || {}

        // 思考：API 不回显注入的前缀（模型从它之后继续想），
        // 这里把前缀补在第一个 reasoning 块前面，让「前缀 → 模型往下想」整段都在界面可见
        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length) {
          if (reasoningIndex < 0) {
            reasoningIndex = nextIndex++
            yield { type: 'block-start', index: reasoningIndex, blockType: 'reasoning' }
          }
          // ⚠️ 这里必须带 `injected`：被安全熔断拦下的轮次 prefix 变量仍在（要留给留档），
          // 但请求里根本没注入——不判断就会把它拼进思维链，**显示出一段模型没想过的内容**。
          // 踩过：被拦后前端仍然以「未成年用户……」开头显示，看起来熔断完全没生效。
          const shown = reasoningText === '' && injected && prefix
            ? prefix + delta.reasoning_content
            : delta.reasoning_content
          reasoningText += shown
          yield { type: 'reasoning-delta', index: reasoningIndex, text: shown }
        }

        // 正文
        if (typeof delta.content === 'string' && delta.content.length) {
          if (textIndex < 0) {
            textIndex = nextIndex++
            yield { type: 'block-start', index: textIndex, blockType: 'text' }
          }
          textText += delta.content
          yield { type: 'text-delta', index: textIndex, text: delta.content }
        }

        // 工具调用：id / name / arguments 自己累积，block-end 要交出完整对象
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const k = tc.index ?? 0
            let st = toolState.get(k)
            if (!st) {
              st = { index: nextIndex++, id: '', name: '', args: '', started: false }
              toolState.set(k, st)
            }
            if (typeof tc.id === 'string' && tc.id) st.id = tc.id
            if (typeof tc.function?.name === 'string' && tc.function.name) st.name = tc.function.name
            if (!st.id) st.id = `call_${k}_${Math.random().toString(36).slice(2, 10)}`
            if (!st.started) {
              st.started = true
              yield { type: 'tool-call-delta', index: st.index, id: st.id, name: st.name, argumentsDelta: '' }
            }
            if (typeof tc.function?.arguments === 'string' && tc.function.arguments) {
              st.args += tc.function.arguments
              yield { type: 'tool-call-delta', index: st.index, id: st.id, name: st.name, argumentsDelta: tc.function.arguments }
            }
          }
        }

        if (choice.finish_reason) {
          rawFinish = String(choice.finish_reason)
          finishKind = choice.finish_reason === 'tool_calls' ? 'tool-calls'
            : choice.finish_reason === 'length' ? 'max-tokens'
            : 'stop'
        }
      }
    }

    // 收尾：把开过的块都关掉
    if (reasoningIndex >= 0) {
      yield { type: 'block-end', index: reasoningIndex, block: { type: 'reasoning', text: reasoningText } }
    }
    if (textIndex >= 0) {
      yield { type: 'block-end', index: textIndex, block: { type: 'text', text: textText } }
    }
    for (const st of toolState.values()) {
      if (!st.started || !st.name) continue
      yield {
        type: 'block-end',
        index: st.index,
        block: { type: 'tool-call', id: st.id, name: st.name, arguments: st.args || '{}' },
      }
    }

      // 响应元信息交给 noteResponse（子类可覆盖，用来分辨「模型自己停」和「被截断」）
      this.noteResponse({
        status: 200,
        finishReason: rawFinish || '(none)',
        reasoningChars: reasoningText.length,
        textChars: textText.length,
        injected,
        sessionId: options.sessionId,
      })

      // 正常收尾：先记账，再 finish。
      // finish 之后调用方通常不再迭代这个 generator，finally 就不会跑——
      // 所以正常路径要自己写一遍（writeHistory 内部有去重，不会写两条）。
      writeHistory(true)

      yield { type: 'finish', reason: { kind: finishKind } }
    } finally {
      // 中断路径：用户点了停止、或调用方提前 return。
      // 这种情况下最后一轮的思考与回答恰恰是最该留档的（实测有一次死循环
      // 就是在这种状态下发生的，而旧代码把记账写在 yield 之后，什么都没留下）。
      writeHistory(false)
    }
  }
}
