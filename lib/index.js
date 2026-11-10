/**
 * index.js —— host 半身。
 *
 * 两件事：
 *   1. 注册 `brainwave` provider（会往推理开头塞前缀的 adapter）
 *   2. 挂 `/api/brainwave/*` 路由，给 chat 面板读写前缀、查询当前会话的 provider
 *
 * **不碰默认模型**：DSH 的模型选择是会话级的，插件启动时去改全局默认值等于
 * 替用户决定所有新会话用什么——那是回避「prefix 只在 beta 端点可用」这个事实，
 * 而不是解决它。所以这里只注册 provider，切不切由用户自己选。
 */

import { BrainwaveAdapter, PROVIDER, MODELS } from './adapter.js'
import { createHandler, PREFIX } from './api.js'
import { readConfig } from './core.mjs'

const VERSION = '0.1.0'

export const name = 'brainwave'
/**
 * credentials 用来拿用户已经配好的 API key（DSH 的 key 不在进程环境里）。
 *
 * **attachments 不能漏**：adapter 里把 user 消息中的 image 块转成 OpenAI 的
 * image_url 时，要靠 `ctx.attachments.readImage()` 读出字节。没声明这个依赖，
 * `ctx.attachments` 是 undefined，`imageBlockToUrl` 会静默返回 null，
 * 于是**每一张图都被丢掉**——模型看似正常回答，其实什么都没看到。
 * （实测吃过这个亏：截图里的内容它完全看不见，只能靠文字上下文猜。）
 */
export const inject = ['llm', 'credentials', 'attachments']

export class Brainwave {
  constructor(ctx, config = {}) {
    this.ctx = ctx
    this.config = config

    // 注册 provider
    const adapter = new BrainwaveAdapter(config, ctx)
    ctx.llm.registerAdapter([PROVIDER], adapter)
    ctx.logger?.info?.(`[brainwave] provider ${PROVIDER} 已注册（v${VERSION}）`)

    return this
  }

  /**
   * 挂 `/api/brainwave/*`。**必须在 apply 里调，不能在 constructor 里**——
   * `ctx.inject` 在 Service 的构造期抛错会让整个插件起不来（dsh-obs-canvas 踩过）。
   * 这里是普通类，但仍然把它挪出来：失败只影响路由，不影响 adapter。
   */
  mountRoutes(ctx) {
    try {
      ctx.inject(['webServer'], (scoped) => {
        scoped.effect(
          () => scoped.webServer.register({
            kind: 'prefix',
            path: PREFIX,
            handler: createHandler({
              /** 默认模型是谁，给前端兜底用（新会话还没有请求记录时） */
              defaultProvider: () => {
                try {
                  // 两种拿法都试：直接属性（DSH 源码里这两种都有用到），
                  // 拿不到就返回空——上层会退回「不判断」。
                  const dm = ctx.agentDefaultModel || ctx.get?.('agentDefaultModel')
                  const cur = dm?.currentSelection?.()
                  return cur?.provider || ''
                } catch { return '' }
              },
            }),
          }),
          'dsh-brainwave: api routes',
        )
      })
    } catch (error) {
      ctx.logger?.warn?.('[brainwave] 路由没挂上：' + String(error?.message || error))
    }
  }
}

export function apply(ctx, config = {}) {
  const svc = new Brainwave(ctx, config)
  svc.mountRoutes(ctx)
  return svc
}

export { VERSION, PROVIDER, MODELS }
