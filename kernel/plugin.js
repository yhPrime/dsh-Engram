/**
 * DSH 插件入口（可安装/开启/禁用）：注册工具面（exp_record / exp_recall / exp_feedback / exp_type）。
 *
 * Provider 本身由 memory-spaces 作为子 Fiber 挂载（在「记忆引擎 → Provider」里开关）；
 * 这个入口让本包同时是一个普通的 DSH 插件，出现在插件管理里，可整体启停工具面。
 */

import fs from 'node:fs'
import path from 'node:path'

import { createTools } from './engine.js'
import { ensureDefaultTypes, renderHint } from './store.js'
import { readEngineConfig, resolveEngramDataDir } from './settings.js'

export const name = 'dsh-engram'
// Cordis 标准：等 tools / systemPrompt 服务就绪后再 apply。
export const inject = ['tools', 'systemPrompt']

/** 启动审计：apply 是否真的跑过、工具注册到哪一步。写小文件，失败不影响加载。 */
function audit(config, line) {
  try {
    const dir = resolveEngramDataDir(config)
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(path.join(dir, 'plugin-apply.log'), `${new Date().toISOString()} ${line}\n`, 'utf8')
  } catch {
    // 审计失败不影响插件加载。
  }
}

export async function apply(ctx, rawConfig = {}) {
  // 设置页保存的参数优先于插件行配置，且每次读取都取最新值。
  const config = new Proxy({}, {
    get(_target, key) {
      const overrides = readEngineConfig()
      if (Object.prototype.hasOwnProperty.call(overrides, String(key))) return overrides[String(key)]
      return rawConfig[key]
    },
  })
  let defineTool = (definition) => definition
  // 首次安装 / 换到全新目录：开箱即用的默认主分类。
  // 已有业务类型或经验时 ensureDefaultTypes 自己会跳过，不覆盖用户数据。
  try {
    const seeded = ensureDefaultTypes(resolveEngramDataDir(config))
    audit(config, `apply: default types ensured (${seeded.types.length})`)
  } catch (error) {
    audit(config, `apply: default types failed: ${error && error.message ? error.message : String(error)}`)
  }
  try {
    const toolsSdk = await import('@deepseek-ai/dsh-tools')
    if (toolsSdk && typeof toolsSdk.defineTool === 'function') defineTool = toolsSdk.defineTool
  } catch {
    // 宿主未暴露该入口时保持纯对象定义。
  }

  const register = (target) => {
    const tools = createTools(config, defineTool)
    // 一次性把「宿主转换后的 JSON Schema」记进审计日志：provider 严格校验报错时（如
    // exp_consolidate 的 anyOf 报错）只能从真实 schema 定位，不能靠猜。
    try {
      const probe = tools.find((tool) => tool.name === 'exp_consolidate')
      if (probe) audit(config, `apply: exp_consolidate schema ${JSON.stringify(probe.parameters).slice(0, 1500)}`)
    } catch {
      // 探测失败不影响注册。
    }
    for (const tool of tools) target.tools.register(tool)
  }

  // 每轮提示层：把类型目录与用法写进系统提示段；禁用插件即消失，不动记忆组合。
  const registerHint = (target) => {
    if (config.hint === false) return
    const prompt = target.systemPrompt || (typeof target.get === 'function' ? target.get('systemPrompt') : undefined)
    if (!prompt || typeof prompt.section !== 'function') {
      audit(config, 'apply: systemPrompt unavailable, hint skipped')
      return
    }
    prompt.section({ name: 'exp-lib', order: 160, text: () => renderHint(config, Number(config.maxHintChars) || 1400) })
    audit(config, 'apply: prompt section registered')
  }

  try {
    if (ctx && ctx.tools && typeof ctx.tools.register === 'function') {
      register(ctx)
      registerHint(ctx)
      audit(config, 'apply: registered via ctx.tools')
      return
    }
    if (ctx && typeof ctx.inject === 'function') {
      ctx.inject(['tools'], (toolCtx) => {
        register(toolCtx)
        audit(config, 'apply: registered via ctx.inject')
      })
      ctx.inject(['systemPrompt'], (promptCtx) => registerHint(promptCtx))
      audit(config, 'apply: waiting for services')
      return
    }
    throw new Error('tools service unavailable')
  } catch (error) {
    audit(config, `apply failed: ${error && error.message ? error.message : String(error)}`)
    throw error
  }
}
