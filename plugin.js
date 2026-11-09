/**
 * dsh-engram —— 单一 DSH 插件入口。
 *
 * 开发期代码分两半（kernel = 引擎/工具面，ui = 控制台外壳），
 * 但对宿主只暴露一个包、一个插件行：同一个 apply 里同时挂上
 *   1) exp_* 工具 + 每轮提示段        → kernel/plugin.js
 *   2) 控制台 API `/exp-ui/api`       → ui/shell.js（webServer）
 *
 * webServer 只在 Web 宿主存在。Cordis 规定「没声明 inject 的服务不能直接读」，
 * 所以这里绝不碰 ctx.webServer：只通过 ctx.inject(['webServer'], …) 等它就绪。
 * CLI/TUI 里没有这个服务，等待器不会触发，工具面照常可用。
 *
 * 控制台注册失败也不能拖垮工具面：整段包在 try/catch 里，只写审计。
 */

import fs from 'node:fs'
import path from 'node:path'

import * as kernel from './kernel/plugin.js'
import { API_PREFIX, createApi } from './ui/shell.js'
import { resolveEngramDataDir } from './kernel/settings.js'

export const name = 'dsh-engram'

// Cordis 标准：等工具面与提示词服务就绪后再 apply。
export const inject = ['tools', 'systemPrompt']

function audit(config, line) {
  try {
    const dir = resolveEngramDataDir(config)
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(path.join(dir, 'plugin-apply.log'), `${new Date().toISOString()} ${line}\n`, 'utf8')
  } catch {
    // 审计失败不影响插件加载。
  }
}

/** 在已声明 webServer 的上下文里注册控制台 API。 */
function mountConsole(webCtx, config) {
  try {
    const api = createApi(config)
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler: api,
    }))
    audit(config, 'apply: console api mounted')
  } catch (error) {
    audit(config, `apply: console api failed: ${error && error.message ? error.message : String(error)}`)
  }
}

export async function apply(ctx, rawConfig = {}) {
  await kernel.apply(ctx, rawConfig)
  // 只能用 ctx.inject 拿到带 webServer 声明的上下文；没有该服务的宿主永不触发。
  if (ctx && typeof ctx.inject === 'function') {
    try {
      ctx.inject(['webServer'], (webCtx) => mountConsole(webCtx, rawConfig))
    } catch (error) {
      audit(rawConfig, `apply: webServer inject failed: ${error && error.message ? error.message : String(error)}`)
    }
  }
}
