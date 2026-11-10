/**
 * dsh-brainwave —— 浏览器半身。
 *
 * 两件事：
 *   1. 在 chat 输入框（模型选择器与发送按钮之间）放一个按钮，点开展开面板填「思考前缀」
 *   2. 设置里放一页「福至心灵」，调开关和默认模型
 *
 * 位置用的是 `conversation.input.activity` —— DSH 官方文档把它描述为
 * 「在模型选择器与发送按钮之间承载一个控件」，并给了 `onActiveChange`（传 true 会把
 * 它展开成整条工具栏、隐藏普通辅助控件）。正好是「点开填一段话」的形状。
 *
 * 结构照 dsh-see-now / dsh-obs-canvas 的 client.js：
 * `window.__ModuleLoader__.load({ id, factory })`，**id 必须是包名**，否则
 * client-modules 一路抛 `loaded without registering`，宿主侧毫无异样。
 */

window.__ModuleLoader__.load({
  id: 'dsh-brainwave',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createElement: h, useState, useEffect, useCallback } = React

    const API = '/api/brainwave'

    /**
     * 当前会话选中的 provider —— 靠 `conversation.input.model.label` 捕获。
     *
     * 为什么绕这一圈：模型选择是会话级的，存在 model-selection 包的私有 store 里，
     * 别的插件读不到；`/api/brainwave/state` 只能告诉你「这个会话上次请求走的谁」，
     * 新会话在发第一条消息之前是空的。
     *
     * 但 DSH 渲染模型名时会调 `conversation.input.model.label` 这个 slot，props 里
     * 就带着 `{ provider, model, placement }`。在那个 slot 里取值，是唯一能实时
     * 知道「用户此刻选了哪个模型」的官方扩展点。
     *
     * 用模块级 store + 订阅而不是 context，是因为两个 slot 是各自独立挂载的。
     */
    let activeProvider = ''
    const providerSubs = new Set()
    function setActiveProvider(next) {
      if (next === activeProvider) return
      activeProvider = next
      for (const fn of providerSubs) { try { fn(next) } catch { /* 订阅者自己炸了不关我事 */ } }
    }
    function useActiveProvider() {
      const [p, setP] = useState(activeProvider)
      useEffect(() => {
        providerSubs.add(setP)
        setP(activeProvider)   // 订阅瞬间同步一次：model.label 可能比按钮先渲染
        return () => { providerSubs.delete(setP) }
      }, [])
      return p
    }

    const CSS = `
      .bw_bar { display: flex; align-items: center; }
      .bw_btn {
        display: inline-flex; align-items: center; gap: 6px;
        font: inherit; font-size: 12.5px; line-height: 1;
        padding: 6px 10px; border-radius: 8px; cursor: pointer;
        border: 1px solid rgba(128,128,128,.28);
        background: transparent; color: inherit; opacity: .78;
        white-space: nowrap;
        transition: background .12s ease, opacity .12s ease, border-color .12s ease;
      }
      .bw_btn:hover { opacity: 1; background: rgba(128,128,128,.12); }
      .bw_btn.on { opacity: 1; border-color: rgba(126,168,255,.65); background: rgba(126,168,255,.14); }
      .bw_btn.warn { border-color: rgba(255,160,120,.65); background: rgba(255,160,120,.12); }
      .bw_dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; opacity: .45; flex: none; }
      .bw_btn.on .bw_dot { opacity: 1; background: rgb(126,168,255); }

      .bw_panel { display: flex; flex-direction: column; gap: 8px; width: 100%; }
      .bw_head { display: flex; align-items: center; gap: 8px; }
      .bw_title { font-size: 13px; font-weight: 600; }
      .bw_hint { font-size: 11.5px; opacity: .6; line-height: 1.5; }
      .bw_ta {
        font: inherit; font-size: 13px; line-height: 1.55;
        width: 100%; box-sizing: border-box; resize: vertical;
        min-height: 64px; max-height: 220px;
        padding: 8px 10px; border-radius: 8px;
        border: 1px solid rgba(128,128,128,.32);
        background: rgba(128,128,128,.06); color: inherit; outline: none;
      }
      .bw_ta:focus { border-color: rgba(126,168,255,.7); box-shadow: 0 0 0 3px rgba(126,168,255,.14); }
      .bw_row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .bw_grow { flex: 1 1 auto; }
      .bw_act {
        font: inherit; font-size: 12.5px; padding: 6px 12px; border-radius: 8px;
        cursor: pointer; border: 1px solid rgba(128,128,128,.3);
        background: transparent; color: inherit;
        white-space: nowrap; flex: none;
      }
      .bw_act:hover { background: rgba(128,128,128,.12); }
      .bw_act.primary { border-color: rgba(126,168,255,.7); background: rgba(126,168,255,.16); }
      .bw_act:disabled { opacity: .45; cursor: default; }
      .bw_count { font-size: 11.5px; opacity: .55; font-variant-numeric: tabular-nums; white-space: nowrap; flex: none; }
      .bw_msg { font-size: 12px; padding: 6px 10px; border-radius: 7px; background: rgba(128,128,128,.1); }
      .bw_msg.bad { background: rgba(255,120,120,.16); }
      .bw_msg.good { background: rgba(120,200,140,.16); }
    `

    /** 读当前会话的前缀 */
    async function loadPrefix(sessionId) {
      if (!sessionId) return { text: '', at: 0 }
      const res = await fetch(`${API}/prefix?sessionId=${encodeURIComponent(sessionId)}`, { cache: 'no-store' })
      const data = await res.json()
      if (!data || !data.ok) throw new Error((data && data.rejected && data.rejected[0]) || '读不到前缀')
      return { text: data.text || '', at: data.at || 0 }
    }

    async function savePrefix(sessionId, text) {
      const res = await fetch(`${API}/prefix`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, text }),
      })
      return res.json()
    }

    /** 输入框里那个按钮 + 展开后的面板 */
    function ActivityControl(props) {
      // sessionId 由宿主的 session-scope slot 自动注入。拿不到时退回空串：
      // 后端会明确拒绝「没有会话 id」，而不是静默写进错误的会话。
      // （老版本宿主把会话挂在 props.session 下，这里两种都认。）
      const sessionId = props?.sessionId || props?.session?.id || props?.session?.sessionId || ''
      const [open, setOpen] = useState(false)
      const [text, setText] = useState('')
      const [saved, setSaved] = useState('')
      const [busy, setBusy] = useState(false)
      const [msg, setMsg] = useState({ text: '', kind: '' })

      // 主判据：模型选择器上那个 provider（model.label slot 捕获的，实时）
      const modelProvider = useActiveProvider()

      const refresh = useCallback(async () => {
        try {
          const r = await loadPrefix(sessionId)
          setText(r.text)
          setSaved(r.text)
        } catch { /* 读不到就先空着 */ }
      }, [sessionId])

      useEffect(() => { refresh() }, [refresh])

      // 是否是 brainwave 系：用前缀匹配而不是全等，调试变体 `brainwave-debug`
      // 共用同一个前缀面板。真正的判定放在下面的 `confirmedOther` 里。

      const toggle = () => {
        const next = !open
        setOpen(next)
        // 通知宿主：展开时把整条工具栏让出来
        try { props?.onActiveChange?.(next) } catch { /* 宿主没给就算了 */ }
        if (next) { setMsg({ text: '', kind: '' }); refresh() }
      }

      /**
       * 保存。传 `value` 可以覆盖输入框里的当前值——清空要用它，
       * 因为 `setText('')` 之后同一次事件里读到的 `text` 还是旧值（React 状态更新是异步的）。
       */
      const save = async (value) => {
        const payload = value === undefined ? text : value
        setBusy(true)
        setMsg({ text: '', kind: '' })
        try {
          const r = await savePrefix(sessionId, payload)
          if (r && r.ok) {
            setSaved(r.text || '')
            setText(r.text || '')
            // r.warning 来自服务端的安全熔断检查。它**不是保存失败**：文本已经存进去了，
            // 只是注入那一轮会被 adapter 拦下。用 bad 色提示，但不能说「保存失败」。
            if (r.warning) setMsg({ text: r.warning, kind: 'bad' })
            else setMsg({ text: r.text ? '已保存。下一个请求的推理开头就是它。' : '已清空。', kind: 'good' })
          } else {
            setMsg({ text: ((r && r.rejected) || ['保存失败']).join('；'), kind: 'bad' })
          }
        } catch (e) {
          setMsg({ text: '保存失败：' + String((e && e.message) || e), kind: 'bad' })
        }
        setBusy(false)
      }

      /** 清空 = 立刻把空串存到服务器，不是只清输入框 */
      const clear = async () => {
        setText('')
        await save('')
      }

      // 只在「明确确认当前模型不是 brainwave」时隐藏，拿不准就显示。
      //
      // 为什么不再用 `active === true` 才渲染：主判据要靠宿主把 model.label slot
      // 渲染成 trigger 形态，那件事不保证发生；兜底 state API 又只在会话真的发过
      // 一次请求之后才有值。新建会话切到 brainwave、还没开口的那一瞬间，两条路
      // 都是空的，按钮就被藏掉了——用户会连入口都找不到。误报看得见也纠得回来，
      // 漏报不行。
      const confirmedOther = Boolean(modelProvider) &&
        modelProvider !== 'brainwave' &&
        !modelProvider.startsWith('brainwave-')
      if (confirmedOther) return null

      if (!open) {
        const has = Boolean(saved)
        return h('div', { className: 'bw_bar' },
          h('button', {
            type: 'button',
            className: 'bw_btn' + (has ? ' on' : ''),
            onClick: toggle,
            title: has ? '这次对话已经设了思考前缀' : '设一段思考前缀，让推理从它开始',
            'aria-label': has ? '编辑思考前缀（已设置）' : '设置思考前缀',
          },
            h('span', { className: 'bw_dot' }),
            '前缀',
          ))
      }

      const left = 500 - text.length
      return h('div', { className: 'bw_panel' },
        h('div', { className: 'bw_head' },
          h('span', { className: 'bw_title' }, '思考前缀'),
          h('span', { className: 'bw_hint' }, '说完这段，下一个请求的推理会从它开始往下想'),
          h('span', { className: 'bw_hint', style: { marginLeft: 'auto', opacity: .38, fontSize: 11 } },
            sessionId ? '会话 ' + sessionId.slice(-8) : '⚠ 没拿到会话 id')),
        h('textarea', {
          className: 'bw_ta',
          value: text,
          placeholder: '比如：先别急着给结论，把你知道的和不知道的分开摆出来。',
          onChange: (e) => setText(e.target.value),
          spellCheck: false,
        }),
        h('div', { className: 'bw_row' },
          h('span', { className: 'bw_count' }, text.length + ' / 500'),
          h('span', { className: 'bw_grow' }),
          h('button', { className: 'bw_act', onClick: toggle }, '收起'),
          h('button', { className: 'bw_act', onClick: () => clear(), disabled: busy || !text }, '清空'),
          h('button', { className: 'bw_act primary', onClick: () => save(), disabled: busy }, busy ? '保存中…' : '保存')),
        msg.text ? h('div', { className: 'bw_msg ' + (msg.kind || '') }, msg.text) : null,
        left < 0 ? h('div', { className: 'bw_msg bad' }, '超了 ' + (-left) + ' 字，保存会被拒绝') : null,
      )
    }

    /** 设置页 */
    function SettingsPage() {
      const [status, setStatus] = useState(null)
      const [draft, setDraft] = useState({})
      const [busy, setBusy] = useState(false)
      const [msg, setMsg] = useState({ text: '', kind: '' })
      const [err, setErr] = useState('')

      const load = useCallback(async () => {
        setBusy(true)
        setErr('')
        try {
          const res = await fetch(`${API}/config`, { cache: 'no-store' })
          const data = await res.json()
          if (!data || !data.ok) throw new Error((data && data.rejected && data.rejected[0]) || '读不到配置')
          setStatus(data)
          setDraft({ ...(data.values || {}) })
        } catch (e) {
          setErr(String((e && e.message) || e))
        }
        setBusy(false)
      }, [])

      useEffect(() => { load() }, [load])

      const save = async () => {
        setBusy(true)
        setMsg({ text: '', kind: '' })
        try {
          const res = await fetch(`${API}/config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(draft),
          })
          const data = await res.json()
          if (data && data.ok) {
            setStatus((s) => (s ? { ...s, values: data.values } : s))
            setDraft({ ...(data.values || {}) })
            setMsg({ text: '已保存。下一个请求就按新设置走。', kind: 'good' })
          } else {
            setMsg({ text: ((data && data.rejected) || ['保存失败']).join('；'), kind: 'bad' })
          }
        } catch (e) {
          setMsg({ text: '保存失败：' + String((e && e.message) || e), kind: 'bad' })
        }
        setBusy(false)
      }

      if (err) {
        return h('div', { className: 'bw_panel' },
          h('div', { className: 'bw_msg bad' }, '读取配置失败：' + err),
          h('button', { className: 'bw_act', onClick: load }, '重试'))
      }
      if (!status) return h('div', { className: 'bw_panel' }, h('div', { className: 'bw_msg' }, '读取中…'))

      const fields = status.fields || []
      return h('div', { className: 'bw_panel' },
        h('div', { className: 'bw_head' },
          h('span', { className: 'bw_title' }, '福至心灵'),
          h('span', { className: 'bw_hint' }, '在推理起点注入一段你自己写的话')),
        h('div', { className: 'bw_hint' }, '配置文件：' + (status.path || '')),
        ...fields.map((f) => h('label', { className: 'bw_head', key: f.key, style: { flexDirection: 'column', alignItems: 'stretch', gap: 4 } },
          h('span', { className: 'bw_title', style: { fontWeight: 500 } }, f.label),
          f.type === 'boolean'
            ? h('input', {
              type: 'checkbox',
              checked: Boolean(draft[f.key]),
              onChange: (e) => setDraft((d) => ({ ...d, [f.key]: e.target.checked })),
            })
            : h('input', {
              className: 'bw_ta',
              style: { minHeight: 0, height: 34, resize: 'none' },
              type: f.type === 'number' ? 'number' : 'text',
              min: f.min, max: f.max, step: f.step,
              value: draft[f.key] === undefined ? '' : draft[f.key],
              onChange: (e) => setDraft((d) => ({ ...d, [f.key]: e.target.value })),
            }),
          f.hint ? h('span', { className: 'bw_hint' }, f.hint) : null)),
        h('div', { className: 'bw_row' },
          h('button', { className: 'bw_act primary', onClick: save, disabled: busy }, busy ? '保存中…' : '保存'),
          h('button', { className: 'bw_act', onClick: load, disabled: busy }, '重新读取')),
        msg.text ? h('div', { className: 'bw_msg ' + (msg.kind || '') }, msg.text) : null,
      )
    }

    function apply(ctx) {
      ctx.effect(() => {
        const style = document.createElement('style')
        style.setAttribute('data-plugin', 'dsh-brainwave')
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, 'dsh-brainwave: styles')

      // 输入框里的按钮。`conversation.input.activity` 是宿主定义好的 single / session
      // slot（宿主传 locked 与 onActiveChange、以及 session scope 的 sessionId），
      // 注册时只给 name —— kind/scope 是 slot 定义，不是注册项。
      ctx.slots.inject('conversation.input.activity', () => ctx.slots.register({
        name: 'conversation.input.activity',
      }, (props) => h(ActivityControl, props)))

      // 捕获当前会话选中的 provider。这是唯一能实时读到模型选择的官方扩展点：
      // 宿主渲染模型名时把 `{ provider, model, placement }` 交给这个 slot。
      // 我们只取值，**不改显示**——原样返回 model.name，和宿主的 fallback 一致。
      try {
        ctx.slots.inject('conversation.input.model.label', () => ctx.slots.register({
          name: 'conversation.input.model.label',
        }, (props) => {
          const pid = props?.provider?.id || ''
          const isTrigger = props?.placement === 'trigger'
          // 只认「模型选择器那个按钮」上的 provider；菜单选项里也会调这个 slot，
          // 那些不能当成「当前选择」
          useEffect(() => {
            if (isTrigger) setActiveProvider(pid)
          }, [pid, isTrigger])
          return h('span', null, props?.model?.name || '')
        }))
      } catch (error) {
        // 注册不上就退回 state API 的判断（延迟一步，但不至于整个插件挂掉）
        try {
          ctx.logger?.warn?.('[brainwave] model.label slot 没注册上：' + String(error?.message || error))
        } catch { /* 没有 logger */ }
      }

      // 设置页
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'brainwave',
        order: 45,
        label: () => '福至心灵',
      }, () => h(SettingsPage)))
    }

    exports.apply = apply
    exports.inject = ['slots']
    exports.name = 'dsh-brainwave'
    return module.exports
  },
})
