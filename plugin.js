/**
 * dsh-engram —— 单一 DSH 插件入口。
 *
 * 开发期代码分两半（kernel = 引擎/工具面，ui = 控制台外壳），
 * 但对宿主只暴露一个包、一个插件行：同一个 apply 里同时挂上
 *   1) exp_* 工具 + 每轮提示段        → kernel/plugin.js
 *   2) 控制台 API `/exp-ui/api`       → ui/shell.js（webServer）
 *
 * webServer 只在 Web 宿主存在：CLI/TUI 下没有这个服务，控制台 API 直接跳过，
 * 工具面照常可用。
 */

import * as kernel from './kernel/plugin.js'
import { API_PREFIX, createApi } from './ui/shell.js'

export const name = 'dsh-engram'

// Cordis 标准：等工具面与提示词服务就绪后再 apply。
export const inject = ['tools', 'systemPrompt']

function registerConsole(target, config) {
  if (!target || !target.webServer || typeof target.webServer.register !== 'function') return false
  const api = createApi(config)
  target.effect(() => target.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: api,
  }))
  return true
}

export async function apply(ctx, rawConfig = {}) {
  await kernel.apply(ctx, rawConfig)
  if (registerConsole(ctx, rawConfig)) return
  // 宿主有 webServer 但此刻还没就绪：挂一个等待器，就绪后再注册。
  if (ctx && typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (webCtx) => registerConsole(webCtx, rawConfig))
  }
}
