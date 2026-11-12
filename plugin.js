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
import { readGitConfig, resolveEngramDataDir } from './kernel/settings.js'
import { gitPush } from './kernel/git-sync.js'

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
    // 「添加技能」的分类/标签/排序要开一个临时模型会话。
    // llm 与 agentDefaultModel 都不在 inject 里（缺了也不能拖垮插件），
    // 所以只经 ctx.get 取、取不到就退回本地归类，读取本身也包一层兜底。
    const safeGet = (name) => {
      try {
        return typeof webCtx.get === 'function' ? webCtx.get(name) : undefined
      } catch {
        return undefined
      }
    }
    // 目录选择服务晚于本插件挂上也照样能用（inject 就绪后回填）。
    let latePicker = null
    const api = createApi(config, {
      getLlm: () => safeGet('llm'),
      getRoute: () => {
        const model = safeGet('agentDefaultModel')
        if (model === undefined || model === null || typeof model.currentSelection !== 'function') return null
        try {
          return model.currentSelection() || null
        } catch {
          return null
        }
      },
      // 设置页「选择文件夹」用的系统选目录窗口。同样是「拿不到也不能拖垮插件」：
      // 桌面版由 web-app bundle 提供 native 能力，CLI/TUI 宿主没有，界面会退回手填路径。
      // 服务可能比本插件晚挂上，所以先 try 一次 ctx.get，再等 inject 回调补上。
      getDirectoryPicker: () => safeGet('directoryPicker') || latePicker,
    })
    try {
      if (typeof webCtx.inject === 'function') {
        webCtx.inject(['directoryPicker'], (pickerCtx) => { latePicker = pickerCtx.directoryPicker })
      }
    } catch {
      // 没有这个服务就是没有。
    }
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
  startAutoBackup(ctx, rawConfig)
}

/**
 * 自动备份：设置里 autoBackupMinutes > 0 时，按间隔 commit + push。
 * 每次触发都重新读配置与数据目录（改设置/换存储位置后立刻跟随），没有改动时 gitPush 会直接返回。
 */
function startAutoBackup(ctx, rawConfig) {
  try {
    const minutes = Number(readGitConfig().autoBackupMinutes) || 0
    if (minutes <= 0) return
    const intervalMs = Math.max(15, minutes) * 60000
    const timer = setInterval(() => {
      const dataDir = resolveEngramDataDir(rawConfig)
      gitPush(dataDir, readGitConfig())
        .then((result) => {
          if (result && result.pushed) audit(rawConfig, `auto-backup: pushed ${result.commit || ''}`.trim())
        })
        .catch((error) => audit(rawConfig, `auto-backup failed: ${error && error.message ? error.message : String(error)}`))
    }, intervalMs)
    if (timer && typeof timer.unref === 'function') timer.unref()
    if (ctx && typeof ctx.effect === 'function') ctx.effect(() => () => clearInterval(timer))
    audit(rawConfig, `auto-backup: every ${intervalMs / 60000} min`)
  } catch (error) {
    audit(rawConfig, `auto-backup setup failed: ${error && error.message ? error.message : String(error)}`)
  }
}
