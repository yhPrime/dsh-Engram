/**
 * DSH 插件入口（可安装/开启/禁用）：注册工具面（exp_record / exp_recall / exp_feedback / exp_type）。
 *
 * Provider 本身由 memory-spaces 作为子 Fiber 挂载（在「记忆引擎 → Provider」里开关）；
 * 这个入口让本包同时是一个普通的 DSH 插件，出现在插件管理里，可整体启停工具面。
 */

import fs from 'node:fs'
import path from 'node:path'

import { createTools } from './engine.js'
import { createAutoRecorder } from './auto-record.js'
import { ensureDefaultTypes, renderHint } from './store.js'
import { readSavedEngineConfig, resolveEngramDataDir } from './settings.js'
import { createSkillCatalogHook } from './skills.js'

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
  // 只认「磁盘上真存了的键」：默认值不能压掉插件行配置（例如插件行显式写 skillCatalog:false）。
  const config = new Proxy({}, {
    get(_target, key) {
      const overrides = readSavedEngineConfig()
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

  const tools = createTools(config, defineTool)
  // 自动记录钩子（0.24.1）：回合收尾时把交付过程落成 pending 经验；`autoRecord: false` 关闭。
  const recordTool = tools.find((tool) => tool.name === 'exp_record') || null
  const recorder = recordTool === null ? null : createAutoRecorder({ config, record: recordTool, audit })
  // 单会话技能目录（0.21.1 P1）：pre-step 按可见面判目录在不在，被压缩遮罩就整份补发。
  // 启动自检只探「宿主会话面能力」；真正的运行时探测在钩子里，缺失就降级 + 写审计，绝不抛错。
  const catalogHook = createSkillCatalogHook({
    config,
    dataDirOf: () => resolveEngramDataDir(config),
    audit: (line) => audit(config, line),
  })
  audit(config, `apply: skill catalog ${catalogHook.disabled ? 'disabled (skillCatalog=false)' : 'enabled'}`)
  // 宿主会话面探测：探不到只记日志（降级为每次命中给全文 + 尾部重取提示），不影响工具面。
  let surfaceProbe = 'unknown'
  try {
    const sessionSdk = await import('@deepseek-ai/dsh-session')
    surfaceProbe = sessionSdk && (typeof sessionSdk.SurfaceManager === 'function' || typeof sessionSdk.foldSurface === 'function') ? 'ok' : 'partial'
  } catch {
    surfaceProbe = 'unavailable'
  }
  audit(config, `apply: session surface probe ${surfaceProbe}`)

  const register = (target) => {
    // 一次性把「宿主转换后的 JSON Schema」记进审计日志：provider 严格校验报错时（如
    // exp_consolidate 的 anyOf 报错）只能从真实 schema 定位，不能靠猜。
    try {
      const probe = tools.find((tool) => tool.name === 'exp_consolidate')
      if (probe) audit(config, `apply: exp_consolidate schema ${JSON.stringify(probe.parameters).slice(0, 1500)}`)
    } catch {
      // 探测失败不影响注册。
    }
    for (const tool of tools) target.tools.register(tool)
    // 测试桩 / 极简宿主可能没有事件上下文：没有 on 就只注册工具面，不装钩子。
    if (typeof target.on !== 'function') {
      audit(config, 'apply: no event context, auto-record/catalog hooks skipped')
      return
    }
    const installHooks = () => {
      const offs = []
      if (recorder !== null) {
        offs.push(target.on('tools/result', (exec, result) => recorder.onToolResult(exec, result)))
        offs.push(target.on('agent/turn-stopping', (payload) => recorder.onTurnStopping(payload)))
      }
      const offCatalog = catalogHook.register(target)
      if (typeof offCatalog === 'function') offs.push(offCatalog)
      return () => {
        for (const off of offs) {
          if (typeof off === 'function') off()
        }
      }
    }
    // 事件注册归插件上下文所有：卸载/禁用时一起摘掉，不留悬挂监听。
    if (typeof target.effect === 'function') target.effect(installHooks)
    else installHooks()
    audit(config, 'apply: auto-record/catalog hooks registered')
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
