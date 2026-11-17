/**
 * 自动记录钩子（0.24.1）：回合收尾时把「这轮做了什么」落成一条待判定经验。
 *
 * 为什么用 `agent/turn-stopping`：它在回合真正关闭前触发（serial、会被 await），
 * 此时工具都跑完了，模型也不会再输出；不会在回合中途重复记。
 *
 * 设计取舍：
 * - 只记「有交付动作」的回合：纯问答、纯检索、寒暄不记，避免把经验库冲成日志。
 * - outcome 缺省 → pending：自动判成败不可靠，留给 verdicts 回填或 exp_feedback 修正。
 * - 过程写进 note（工具序列 + 产物路径），结果留给用户/模型后补。
 * - 模型本回合已经手动 exp_record 的，不再重复记。
 * - 默认开启，`autoRecord: false` 可关。
 */

import path from 'node:path'

import { findSessionFile } from './chat-save.js'
import { firstUserMessageAfterTurn, readSessionEvents, sessionCwd } from './session.js'

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

/** 事件里的用户文本（与 session.js 的取法一致；那边没导出）。 */
function userTextOf(event) {
  const data = (event && event.data) || {}
  const content = Array.isArray(data.content) ? data.content : (data.message && data.message.content)
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/** 工具名是否算「做了交付」。 */
export function isDeliverTool(name) {
  const tool = String(name || '').trim()
  if (tool === '' || tool.startsWith('exp_')) return false
  if (NON_DELIVER_TOOLS.has(tool)) return false
  return DELIVER_PREFIXES.some((prefix) => tool === prefix || tool.startsWith(prefix))
}

/** 意图是否值得自动记（太短、寒暄、系统时间戳都跳过）。 */
export function isRecordableIntent(intent) {
  const text = String(intent || '').trim()
  if (text.length < 4) return false
  if (/^Time sampled while preparing/iu.test(text)) return false
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
    return command ? `跑 ${command.slice(0, 40)}` : '跑命令'
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
  return unique.slice(0, max).join(' → ').slice(0, 300)
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

/**
 * 纯函数：根据一回合的工具序列生成 exp_record 入参。
 * @returns {object|null} null = 不该自动记
 */
export function buildAutoRecord({ sessionId, turn, cwd, intent, tools }) {
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
  return {
    intent: text.slice(0, 500),
    action: process.slice(0, 2000),
    note: noteParts.join('；').slice(0, 2000),
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
    // 不写 outcome：走 pending，等回执/用户纠正回填。
  }
}

/** 读本回合的用户输入（上一回合结束后的第一条；首回合退到最后一条）。 */
export function intentOfTurn(events, turn) {
  const list = Array.isArray(events) ? events : []
  const previous = firstUserMessageAfterTurn(list, Number(turn) - 1)
  if (previous !== '') return previous
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const event = list[index]
    if (!event || event.type !== 'user/message') continue
    const text = userTextOf(event)
    if (text !== '' && !/^Time sampled while preparing/iu.test(text)) return text
  }
  return ''
}

/**
 * 钩子本体：在 plugin.apply 里注册到 `tools/result` 与 `agent/turn-stopping`。
 * @param {{config: object, record: object, audit: (config: object, line: string) => void}} deps
 */
export function createAutoRecorder({ config, record, audit }) {
  const buffers = new Map()
  const handled = new Set()

  function onToolResult(exec, result) {
    try {
      if (config.autoRecord === false) return
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
    if (config.autoRecord === false) return
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
      const args = buildAutoRecord({ sessionId, turn, cwd, intent, tools })
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
