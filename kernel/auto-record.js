/**
 * 自动记录钩子（0.24.1）：回合收尾时把「这轮做了什么」落成一条待判定经验。
 *
 * 为什么用 `agent/turn-stopping`：它在回合真正关闭前触发（serial、会被 await），
 * 此时工具都跑完了，模型也不会再输出；不会在回合中途重复记。
 *
 * 设计取舍：
 * - 只记「有交付动作」的回合：纯问答、纯检索、寒暄不记，避免把经验库冲成日志。
 * - 宿主注入的提醒（`<system-reminder>` / 运行时记忆快照 / 后台任务通知）不是用户意图，不记；
 *   以前它们会顶替真实用户消息成为 intent，落成一堆看不出内容的脏行。
 * - outcome 缺省 → pending：自动判成败不可靠，留给 verdicts 回填或 exp_feedback 修正。
 * - 过程写进 note（工具序列 + 产物路径），结果留给用户/模型后补。
 * - **标签也要自带**（0.24.x）：自动记录没有模型参与，只能按词表 + 工具信号确定性打标签，
 *   否则每条自动记录都是「无标签」，用户要在控制台一条条补。
 * - 模型本回合已经手动 exp_record 的，不再重复记。
 * - **默认关闭**（0.24.1 用户口径）：`ENGINE_CONFIG_DEFAULTS.autoRecord = false`，插件入口的 config
 *   代理把缺省值补成 false；要记由设置页或插件行显式打开。每轮都落一条待判定经验既没人回填又占库。
 */

import path from 'node:path'

import { findSessionFile } from './chat-save.js'
import { readSessionEvents, sessionCwd, userMessagesAfterTurn, userMessagesOfSession } from './session.js'
import { resolveEngramDataDir } from './settings.js'
import { ensureTagOverrides, extractQueryTags, facetOf } from './tag-registry.js'
import { specificFamilyOf } from './family-name.js'

/** 这些工具不构成「做完的活」：只读、记忆自身、流程控制。 */
const NON_DELIVER_TOOLS = new Set([
  'read', 'grep', 'glob',
  'job_list', 'job_output', 'job_kill',
  'list_agents', 'wait_agent', 'send_message',
  'todo_write', 'ask_user_question',
  'user_terminal_list', 'user_terminal_read',
  'terminal_list', 'terminal_read',
])

/** 交付类工具前缀白名单：写 / 改 / 跑 / 导出 / 安装 / 发布 / 排期。 */
const DELIVER_PREFIXES = [
  'write', 'edit', 'present', 'pwsh',
  'terminal_open', 'terminal_send', 'terminal_signal',
  'univer_', 'workflow', 'ralph', 'create_worktree', 'create_skill',
  'plugin_manager', 'schedule_', 'web_fetch',
]

/** 寒暄 / 纯推进词：不作为一次任务意图。 */
const CHITCHAT = new Set([
  '好', '好的', '可以', '行', '嗯', '对', '是的', '继续', '开始', '执行',
  '推送', '发布', '安装', '重试', '再来', '谢谢', '收到', '明白',
  'ok', 'okay', 'yes', 'no', 'go', 'continue',
])

/**
 * 宿主注入的文本：不是用户说的话。
 * 这类消息会出现在 user/message 里，`intentOfTurn` 以前直接把它当成本回合的意图，
 * 于是经验库里出现「intent = <system-reminder>…」「intent = background job … finished」的脏行。
 */
const NOISE_PREFIXES = [
  '<system-reminder>',
  'system-reminder',
  '[MNEMON]',
  'MNEMON RUNTIME MEMORY SNAPSHOT',
  'MNEMON VIEW TOOLS',
  'background job ',
  'Time sampled while preparing',
]

/** 用户文本是不是宿主注入的提醒 / 通知（不是真实意图）。 */
export function isNoiseUserText(value) {
  const text = String(value === undefined || value === null ? '' : value).trim()
  if (text === '') return true
  const head = text.slice(0, 80)
  return NOISE_PREFIXES.some((prefix) => head.startsWith(prefix))
}

/** 只有空白 / 控制字符（含零宽字符）的文本：写进去也召回不到，不如不记。 */
const INVISIBLE_ONLY = /^[\u0000-\u0020\u007f-\u009f\u200b-\u200f\u2028-\u202f\u2060-\u206f\ufeff]*$/u

/** 按**码点**安全截断：刀口落在代理对高位时退一格，别把 emoji 劈成孤立代理项。 */
export function clipByCodePoint(value, max) {
  const text = String(value === undefined || value === null ? '' : value)
  const limit = Number(max)
  if (!Number.isFinite(limit) || limit <= 0 || text.length <= limit) return text
  let out = text.slice(0, limit)
  const last = out.charCodeAt(out.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1)
  return out
}

/** 工具名是否算「做了交付」。 */
export function isDeliverTool(name) {
  const tool = String(name || '').trim()
  if (tool === '' || tool.startsWith('exp_')) return false
  if (NON_DELIVER_TOOLS.has(tool)) return false
  return DELIVER_PREFIXES.some((prefix) => tool === prefix || tool.startsWith(prefix))
}

/** 意图是否值得自动记（太短、寒暄、宿主注入、全不可见、时间戳都跳过）。 */
export function isRecordableIntent(intent) {
  const text = String(intent || '').trim()
  if (text.length < 4) return false
  // 只有控制字符 / 零宽字符的意图：store 写侧会拒收（0.23.1 契约），这里先挡住，
  // 别让每个这种回合都在审计里留一条 'auto-record failed'。
  if (INVISIBLE_ONLY.test(text)) return false
  if (isNoiseUserText(text)) return false
  const head = text.toLowerCase().replace(/[。！？!?.,，~～\s]/gu, '')
  if (CHITCHAT.has(head)) return false
  return true
}

function baseName(value) {
  const text = String(value || '').trim()
  if (text === '') return ''
  return path.basename(text.replace(/[\\/]+$/u, '')) || text
}

/** 把一个工具调用压成短句，供 note 记录过程。 */
export function describeTool(tool) {
  const name = String((tool && tool.name) || '')
  const args = (tool && tool.args) || {}
  if (name === 'write' || name === 'edit') {
    const target = args.path || args.file_path || args.filePath
    return target ? `改 ${baseName(target)}` : '改文件'
  }
  if (name === 'pwsh') {
    const command = String(args.command || '').split(/\r?\n/u)[0].trim()
    return command ? `跑 ${clipByCodePoint(command, 40)}` : '跑命令'
  }
  if (name === 'present') {
    const files = Array.isArray(args.files) ? args.files : []
    const names = files.map((file) => baseName(file && file.path)).filter(Boolean).slice(0, 2)
    return names.length > 0 ? `交付 ${names.join('、')}` : '交付产物'
  }
  if (name === 'web_fetch') {
    return '抓网页'
  }
  if (name.startsWith('univer_')) {
    return `Univer ${name.slice('univer_'.length)}`
  }
  return name
}

/** 工具序列 → 过程摘要（连续重复去重）。 */
export function summarizeProcess(tools, max = 6) {
  const parts = (Array.isArray(tools) ? tools : [])
    .filter((tool) => isDeliverTool(tool && tool.name))
    .map(describeTool)
    .filter((part) => part !== '')
  const unique = parts.filter((part, index) => index === 0 || part !== parts[index - 1])
  return clipByCodePoint(unique.slice(0, max).join(' → '), 300)
}

/** 从工具参数里抽产物路径（write/edit/present）。 */
export function artifactsOf(tools, max = 5) {
  const out = []
  for (const tool of Array.isArray(tools) ? tools : []) {
    const name = String((tool && tool.name) || '')
    const args = (tool && tool.args) || {}
    if (name === 'write' || name === 'edit') {
      const target = args.path || args.file_path || args.filePath
      if (typeof target === 'string' && target.trim() !== '') out.push(target.trim())
    } else if (name === 'present' && Array.isArray(args.files)) {
      for (const file of args.files) {
        if (file && typeof file.path === 'string' && file.path.trim() !== '') out.push(file.path.trim())
      }
    }
  }
  return [...new Set(out)].slice(0, max)
}

/* ---------------------------------------------------------------- 自带标签 */

/**
 * 对象面兜底规则：词面没命中对象标签时，按路径 / 产物类型认一个（只取最具体的一个）。
 * 顺序即优先级：先认项目级对象（DSH插件），再认文档类型，最后才退到「代码」。
 */
const OBJECT_RULES = [
  { tag: 'DSH插件', pattern: /(?:dsh[-_ ]?engram|awesome-dsh-plugin|[\\/]插件(?:[\\/]|$)|经验库插件|\.exp[\\/])/iu },
  { tag: '智能体平台', pattern: /(?:eigenflux|智能体平台)/iu },
  { tag: 'PPT', pattern: /(?:\.pptx?\b|\bppt\b|幻灯片|演示文稿)/iu },
  { tag: '课件', pattern: /(?:课件|研学课|教案)/u },
  { tag: 'Word', pattern: /(?:\.docx\b|\bword\b)/iu },
  { tag: 'Excel', pattern: /(?:\.xlsx?\b|\bxlsx\b)/iu },
  { tag: '网页应用', pattern: /(?:\.html?\b|网页应用)/iu },
  { tag: '代码', pattern: /\.(?:js|mjs|cjs|ts|tsx|py|css)\b/iu },
]

/**
 * 动作面兜底规则：工具序列里真正发生的动作（只收已登记的动作词）。
 * 一条自动记录至多两个动作标签——凑出「对象 + 动作」的可检索指纹即可，不追求打全。
 */
const ACTION_RULES = [
  { tag: '提交', pattern: /\bgit\b[^\n]{0,160}\bcommit\b|\bcommit\s+-m\b/iu },
  { tag: '推送', pattern: /\bgit\b[^\n]{0,160}\bpush\b/iu },
  { tag: '校验', pattern: /\b(?:npm|pnpm|yarn)\s+(?:run\s+)?test\b|\btest:ui\b|\bvitest\b|\bnode\s+[^\n]*test\.(?:mjs|js|cjs)\b|\baudit\b/iu },
  { tag: '注册', pattern: /\bplugin_manager\b|\binstall_bundle\b|\bremove_bundle\b|\bdsh\s+plugin\b/iu },
  { tag: '沉淀', pattern: /\bexp_consolidate\b|\bexp_skill_attach\b/iu },
  { tag: '分类', pattern: /\bexp_type\b|\bassignType\b|tag-registry/iu },
]

/** 产出类工具：没有任何命令可抽时，它们至少证明这一回合在「编写/交付」。 */
const WRITE_TOOLS = new Set(['write', 'edit', 'present'])

/** 标签词表的用户覆盖按数据目录加载一次；读坏不拖垮记录。 */
function loadTagOverrides(dataDir) {
  const dir = String(dataDir || '').trim()
  if (dir === '') return
  try {
    ensureTagOverrides(dir)
  } catch {
    // 覆盖文件读坏时按内建词表算标签。
  }
}

/**
 * 对象面的文本：只认「这一轮要做什么 + 产物在哪 + 在哪个工作区」。
 *
 * 0.24.1 修正：**不扫命令正文**。命令里出现的词是脚本内容/参数，不是这一轮做的事——
 * 曾经有一条改回填脚本的命令带着 `tags: ['课件', '编写']` 字面量，于是「推送发布安装」
 * 被安上了对象标签「课件」。对象面只该来自意图、产物路径、工作区。
 */
function objectTextOf({ intent, artifacts, cwd }) {
  return [intent, ...(Array.isArray(artifacts) ? artifacts : []), cwd]
    .filter((part) => typeof part === 'string' && part.trim() !== '')
    .join('\n')
    .slice(0, 12000)
}

/** 动作/主题面的文本：意图 + 过程摘要 + 真实命令（每条前 2000 码点）。命令只用来证明「做了什么动作」。 */
function actionTextOf({ intent, process, tools }) {
  const commands = []
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (!tool || typeof tool !== 'object' || String(tool.name) !== 'pwsh') continue
    const command = (tool.args && tool.args.command) || ''
    if (typeof command === 'string' && command.trim() !== '') commands.push(clipByCodePoint(command, 2000))
  }
  return [intent, process, ...commands]
    .filter((part) => typeof part === 'string' && part.trim() !== '')
    .join('\n')
    .slice(0, 12000)
}

/**
 * 自动记录的标签推导（纯函数）。
 *
 * 自动记录没有模型参与，标签只能从**已登记词表**与工具信号里确定性推出：
 * - 对象面：意图 / 产物路径 / 工作区（词面 → 路径与产物类型兜底），**不看命令正文**；
 * - 动作面：意图里的词 + 命令里的结构化信号（git commit→提交、npm test→校验…）+ 产出类工具→编写；
 * - 主题面：意图里的已登记主题词（如 计划书）。
 * 词面只认「用户说的话」：命令正文里的字面量（脚本、参数、被改文件的内容）不算这一轮做的事——
 * 0.24.1 修正前，一条带 `tags: ['课件', '编写']` 的命令让「推送发布安装」被安上了课件和编写。
 * 只收已登记的词，不凭空造标签；推不出来就不给标签。
 *
 * @returns {string[]} 最多 6 个标签，顺序为对象 → 动作 → 主题
 */
export function autoTagsOf({ intent, process, artifacts, cwd, tools, dataDir } = {}) {
  loadTagOverrides(dataDir)
  const intentText = clipByCodePoint(String(intent === undefined || intent === null ? '' : intent).trim(), 6000)
  const objectText = objectTextOf({ intent, artifacts, cwd })
  const actionText = actionTextOf({ intent, process, tools })
  if (objectText === '' && actionText === '') return []
  // 词面命中只认用户意图；命令正文只用来跑结构化动作规则（见下）。
  const intentTags = extractQueryTags(intentText)
  const objectTags = extractQueryTags(objectText)
  const tags = []
  const push = (name) => {
    const value = String(name === undefined || name === null ? '' : name).trim()
    if (value === '' || facetOf(value) === null) return
    if (tags.some((tag) => tag.toLowerCase() === value.toLowerCase())) return
    tags.push(value)
  }
  // 0.37：object 面已物理删除。产物/工作区抽出的词现在归 topic 面，不再产对象标签；
  // 原来按 OBJECT_RULES 兜底推「PPT/课件」这类对象词的做法一并停用（那些词已不是登记词）。
  for (const name of (objectTags.topic || []).slice(0, 2)) push(name)
  let actionCount = 0
  for (const name of intentTags.action.slice(0, 2)) {
    const before = tags.length
    push(name)
    if (tags.length > before) actionCount += 1
  }
  for (const rule of ACTION_RULES) {
    if (actionCount >= 2) break
    if (!rule.pattern.test(actionText)) continue
    const before = tags.length
    push(rule.tag)
    if (tags.length > before) actionCount += 1
  }
  // 没有命令可抽的交付回合（只写 .pptx/.docx、present 交付）也要有动作面：
  // 写/改/交付本身就是一个动作，别让文档类自动记录只剩对象标签。
  if (actionCount === 0 && (Array.isArray(tools) ? tools : []).some((tool) => tool && WRITE_TOOLS.has(String(tool.name)))) {
    push('编写')
  }
  for (const name of intentTags.topic.slice(0, 2)) push(name)
  return tags.slice(0, 6)
}

/** 多步→对象 的默认步数门槛（可被 config.autoRecordObjectMinSteps 覆盖；拍板④阈值不钉死）。 */
export const DEFAULT_OBJECT_MIN_STEPS = 3

/**
 * 0.38 P5：判定一回合该走「对象链」还是「经验」。
 * 交付动作数 ≥ objectMinSteps → 多步任务 → object；否则单步可复用 → experience。
 * 纯函数；自动记录默认关，本分流只在开启后生效。
 * @returns {'object'|'experience'}
 */
export function classifyAutoTurn(tools, { objectMinSteps = DEFAULT_OBJECT_MIN_STEPS } = {}) {
  const list = (Array.isArray(tools) ? tools : []).filter((tool) => tool && typeof tool.name === 'string')
  const delivered = list.filter((tool) => isDeliverTool(tool.name))
  const min = Number.isFinite(Number(objectMinSteps)) && Number(objectMinSteps) >= 1 ? Math.trunc(Number(objectMinSteps)) : DEFAULT_OBJECT_MIN_STEPS
  return delivered.length >= min ? 'object' : 'experience'
}

/** 单个交付工具 → 动作文本（用来推导族）。 */
function toolActionText(tool) {
  const args = tool && tool.args && typeof tool.args === 'object' ? tool.args : {}
  const name = String((tool && tool.name) || '')
  if (typeof args.command === 'string' && args.command.trim() !== '') return args.command.trim()
  if (typeof args.path === 'string' && args.path.trim() !== '') return `改 ${args.path.trim()}`
  return name
}

/**
 * 0.38 P5：多步回合 → exp_object create 入参（每步=推导出的动作族；方向自动记录给不出，留空）。
 * 推不出族的步骤跳过；没有可用步骤返回 null（回退经验/不记）。对象名取意图截断，重名由调用方兜底。
 * @returns {object|null}
 */
export function buildAutoObject({ sessionId, turn, cwd, intent, tools, objectMinSteps }) {
  const text = String(intent || '').trim()
  if (!isRecordableIntent(text)) return null
  const list = (Array.isArray(tools) ? tools : []).filter((tool) => tool && typeof tool.name === 'string')
  if (list.some((tool) => tool.name === 'exp_record' || tool.name === 'exp_object')) return null
  const delivered = list.filter((tool) => isDeliverTool(tool.name))
  if (classifyAutoTurn(list, { objectMinSteps }) !== 'object') return null
  const chain = []
  for (const tool of delivered) {
    if (chain.length >= 20) break
    const family = specificFamilyOf(toolActionText(tool))
    if (family === '') continue
    const step = { family }
    const note = clipByCodePoint(toolActionText(tool), 120)
    if (note !== '') step.note = note
    if (tool.isError === true) step.outcome = 'failed'
    chain.push(step)
  }
  if (chain.length === 0) return null
  return {
    action: 'create',
    object: clipByCodePoint(text, 40),
    chain,
    note: clipByCodePoint(`[auto] turn ${turn} session ${sessionId}，${delivered.length} 次交付动作`, 200),
  }
}

/**
 * 纯函数：根据一回合的工具序列生成 exp_record 入参。
 * @returns {object|null} null = 不该自动记
 */
export function buildAutoRecord({ sessionId, turn, cwd, intent, tools, dataDir }) {
  const text = String(intent || '').trim()
  if (!isRecordableIntent(text)) return null
  const list = (Array.isArray(tools) ? tools : []).filter((tool) => tool && typeof tool.name === 'string')
  if (list.some((tool) => tool.name === 'exp_record')) return null
  const delivered = list.filter((tool) => isDeliverTool(tool.name))
  if (delivered.length === 0) return null
  const process = summarizeProcess(list)
  if (process === '') return null
  const failed = list.filter((tool) => tool.isError === true).length
  const artifacts = artifactsOf(list)
  const noteParts = [`[auto] ${delivered.length} 次交付动作${failed > 0 ? `，${failed} 次工具失败` : ''}`, `过程：${process}`]
  if (artifacts.length > 0) noteParts.push(`产物：${artifacts.join('、')}`)
  const tags = autoTagsOf({ intent: text, process, artifacts, cwd, tools: list, dataDir })
  return {
    intent: clipByCodePoint(text, 500),
    action: clipByCodePoint(process, 2000),
    note: clipByCodePoint(noteParts.join('；'), 2000),
    sessionId,
    turn,
    cwd,
    // 过程性记录易腐：默认按 perishable 复核，别让它长期霸占排序。
    volatility: 'perishable',
    // 来源标记：自动记录与模型手记要能区分（store.record 已支持 input.origin）。
    // 主分类不在这里算：exp_record 见到 origin==='auto' 会用 autoRouteMinScore 归族（0.21.3 计划书 §0.1 D3），
    // 这样自动记录与手动记录共用一条写入路径，避免两套逻辑漂移。
    origin: 'auto',
    artifacts,
    // 标签必须自带（0.24.x）：自动记录没有模型参与，事后没人补，用户只能一条条手填。
    ...(tags.length === 0 ? {} : { context: tags }),
    // 不写 outcome：走 pending，等回执/用户纠正回填。
  }
}

/**
 * 读本回合的用户输入（上一回合结束之后的第一条**真实**用户消息）。
 * 宿主注入的提醒常常排在本回合最前面，跳过它们继续往后找；找不到就不记。
 * （以前是「第一条 user/message 直接用」，于是 `<system-reminder>` / 后台任务通知被当成意图。）
 *
 * 上一回合没有锚点（回合被中止 / 宿主漏写 assistant、turn-end）时不能从头扫，
 * 否则会把会话最早的旧意图写进本回合；这时只认「会话最后一条 user/message 本身就是真实用户消息」。
 */
export function intentOfTurn(events, turn) {
  const list = Array.isArray(events) ? events : []
  const current = Number(turn)
  if (!Number.isFinite(current)) return ''
  const candidates = userMessagesAfterTurn(list, current <= 1 ? -1 : current - 1)
  for (const text of candidates) {
    if (!isNoiseUserText(text)) return text
  }
  // 有候选但全是宿主注入 → 本回合没有真实用户输入，不记（别把上一轮的话搬过来）。
  if (candidates.length > 0) return ''
  const texts = userMessagesOfSession(list)
  const last = texts[texts.length - 1]
  return last !== undefined && !isNoiseUserText(last) ? last : ''
}

/**
 * 钩子本体：在 plugin.apply 里注册到 `tools/result` 与 `agent/turn-stopping`。
 * @param {{config: object, record: object, audit: (config: object, line: string) => void}} deps
 */
export function createAutoRecorder({ config, record, object = null, audit }) {
  const buffers = new Map()
  const handled = new Set()

  /**
   * 缺省值由配置层给（`ENGINE_CONFIG_DEFAULTS.autoRecord = false`，插件入口的 config 代理补齐），
   * 这里只把「显式关」当关闭——测试与外部调用传进来的 config 不带这个键时仍按旧行为。
   */
  function enabled() {
    return config.autoRecord !== false
  }

  /** 标签词表的用户覆盖按数据目录加载（配置代理每次读最新设置）。 */
  function dataDirOf() {
    try {
      return resolveEngramDataDir(config)
    } catch {
      return ''
    }
  }

  function onToolResult(exec, result) {
    try {
      if (!enabled()) return
      const sessionId = exec && exec.agent && typeof exec.agent.id === 'string' ? exec.agent.id : ''
      if (sessionId === '') return
      const list = buffers.get(sessionId) || []
      list.push({
        name: String((exec && exec.name) || ''),
        args: (exec && exec.arguments) || {},
        isError: result !== null && typeof result === 'object' && result.isError === true,
      })
      // 单回合工具数上限：异常长跑不把内存撑爆。
      if (list.length > 200) list.splice(0, list.length - 200)
      buffers.set(sessionId, list)
    } catch {
      // 收集失败不影响工具执行。
    }
  }

  async function onTurnStopping(payload) {
    if (!enabled()) return
    const agent = payload && payload.agent
    const sessionId = agent && typeof agent.id === 'string' ? agent.id : ''
    const turn = Number(payload && payload.turn)
    if (sessionId === '' || !Number.isFinite(turn)) return
    const key = `${sessionId}:${turn}`
    if (handled.has(key)) return
    handled.add(key)
    if (handled.size > 500) handled.clear()
    const tools = buffers.get(sessionId) || []
    buffers.delete(sessionId)
    if (tools.length === 0) return
    try {
      const file = findSessionFile(sessionId, { sessionsRoot: config.sessionsRoot })
      if (file === '') return
      const events = readSessionEvents(file)
      const intent = intentOfTurn(events, turn)
      const cwd = sessionCwd(events)
      // 0.38 P5：多步任务 → 对象链（需 object 工具且分流判定为 object）；否则单步 → 经验。默认关时整段不执行。
      const objectMinSteps = config.autoRecordObjectMinSteps
      if (object !== null && classifyAutoTurn(tools, { objectMinSteps }) === 'object') {
        const objArgs = buildAutoObject({ sessionId, turn, cwd, intent, tools, objectMinSteps })
        if (objArgs !== null) {
          const objExec = { agent: { id: sessionId, session: { header: { cwd } } } }
          await object.execute(objArgs, objExec)
          audit(config, `auto-object: turn ${turn} session ${sessionId} (${objArgs.chain.length} 步)`)
          return
        }
      }
      const args = buildAutoRecord({ sessionId, turn, cwd, intent, tools, dataDir: dataDirOf() })
      if (args === null) return
      const exec = { agent: { id: sessionId, session: { header: { cwd: args.cwd } } } }
      await record.execute(args, exec)
      audit(config, `auto-record: turn ${turn} session ${sessionId} (${args.action.slice(0, 120)})`)
    } catch (error) {
      audit(config, `auto-record failed: ${error && error.message ? error.message : String(error)}`)
    }
  }

  return { onToolResult, onTurnStopping }
}
