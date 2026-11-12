/**
 * 会话文件读取（只读，零宿主依赖）。
 *
 * 用途：插件要在「模型调工具」这类同步时刻，知道「上一轮交付后用户说了什么」。
 * DSH 把会话写在 `$DSH_HOME/sessions/<workspace>/session-<id>/session.v4.jsonl.zstd`，
 * 首事件 `type:"session"` 带 `cwd`，事件里有 `turn/start|turn/end|tool/call|user/message`。
 *
 * 分帧解压的实现与 chat-save.js 同源，但这里独立一份：
 * chat-save 是「一键存经验」的已验收路径，不为了复用去改它。
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

import { dshHome } from './settings.js'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const SESSION_FILE_NAMES = ['session.v4.jsonl.zstd', 'session.v4.jsonl', 'session.jsonl.zstd', 'session.jsonl']

/** 多帧 zstd 解压：整段与逐帧都试，取解出更长的（宿主边写边追加时只解第一帧）。 */
export function decodeZstdFrames(buffer) {
  let whole = null
  try {
    whole = zlib.zstdDecompressSync(buffer)
  } catch {
    whole = null
  }
  const starts = []
  let cursor = buffer.indexOf(ZSTD_MAGIC, 0)
  while (cursor !== -1) {
    starts.push(cursor)
    cursor = buffer.indexOf(ZSTD_MAGIC, cursor + 4)
  }
  if (starts.length === 0) return whole === null ? Buffer.alloc(0) : whole
  const parts = []
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index]
    const end = index + 1 < starts.length ? starts[index + 1] : buffer.length
    try {
      parts.push(zlib.zstdDecompressSync(buffer.subarray(start, end)))
    } catch {
      break
    }
  }
  const framed = Buffer.concat(parts)
  if (whole === null) return framed
  return framed.length >= whole.length ? framed : whole
}

/** 读一个会话文件的事件数组；坏行跳过，读失败返回 []（绝不影响写入路径）。 */
export function readSessionEvents(file) {
  try {
    const buffer = fs.readFileSync(file)
    const text = file.endsWith('.zstd') && typeof zlib.zstdDecompressSync === 'function'
      ? decodeZstdFrames(buffer).toString('utf8')
      : buffer.toString('utf8')
    const events = []
    for (const line of text.split(/\r?\n/u)) {
      if (line.trim() === '') continue
      try {
        events.push(JSON.parse(line))
      } catch {
        // 坏行跳过
      }
    }
    return events
  } catch {
    return []
  }
}

/** 会话所属工作区（首事件的 cwd）；没有就返回 ''。 */
export function sessionCwd(events) {
  for (const event of Array.isArray(events) ? events : []) {
    if (!event) continue
    if (event.type !== 'session') break
    // 真实 DSH v4 会话首事件把 cwd 放在**顶层**（`{type:"session",cwd}`）；
    // 旧夹具/旧版本放在 `data.cwd`，两者都兼容（真实库 352/352 顶层 cwd 实测）。
    if (typeof event.cwd === 'string' && event.cwd !== '') return event.cwd
    if (event.data && typeof event.data.cwd === 'string' && event.data.cwd !== '') return event.data.cwd
    return ''
  }
  return ''
}

const cwdCache = new Map()

function cachedCwd(file, events) {
  try {
    const mtime = fs.statSync(file).mtimeMs
    const hit = cwdCache.get(file)
    if (hit !== undefined && hit.mtime === mtime) return hit.cwd
    const cwd = sessionCwd(events !== undefined ? events : readSessionEvents(file))
    cwdCache.set(file, { mtime, cwd })
    return cwd
  } catch {
    return ''
  }
}

/** 列出全部会话文件（按 mtime 倒序）。只 stat，不解析。 */
export function listSessionFiles(options = {}) {
  const root = path.resolve(options.sessionsRoot || path.join(dshHome(), 'sessions'))
  const out = []
  let workspaces = []
  try {
    workspaces = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory())
  } catch {
    return out
  }
  for (const workspace of workspaces) {
    const base = path.join(root, workspace.name)
    let sessions = []
    try {
      // 子代理会话目录是裸 UUID（首事件 origin:subagent），不能只认 session- 前缀；
      // 真正的判据是「目录里有会话文件」（下面的 SESSION_FILE_NAMES 检查）。
      sessions = fs.readdirSync(base, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    } catch {
      continue
    }
    for (const session of sessions) {
      const dir = path.join(base, session.name)
      for (const name of SESSION_FILE_NAMES) {
        const file = path.join(dir, name)
        try {
          if (!fs.existsSync(file)) continue
          out.push({ file, dir, sessionId: session.name, workspace: workspace.name, mtime: fs.statSync(file).mtimeMs })
        } catch {
          // 单个会话读不到就跳过
        }
        break
      }
    }
  }
  out.sort((left, right) => right.mtime - left.mtime)
  return out
}

/** 某个工作区最近的会话（cwd 精确匹配；给不出 cwd 时返回 null）。 */
export function newestSessionForCwd(cwd, options = {}) {
  const target = path.resolve(String(cwd || ''))
  if (String(cwd || '') === '') return null
  const limit = Math.max(1, Math.trunc(Number(options.scan) || 12))
  for (const item of listSessionFiles(options).slice(0, limit)) {
    if (cachedCwd(item.file) === target) return item
  }
  return null
}

function textOf(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/** 某 turn 结束之后的**第一条用户消息**（没有则 ''）。 */
export function firstUserMessageAfterTurn(events, turn) {
  const list = Array.isArray(events) ? events : []
  const target = Number(turn)
  if (!Number.isFinite(target)) return ''
  let anchor = -1
  for (let index = 0; index < list.length; index += 1) {
    const event = list[index]
    if (event && event.type === 'assistant/message' && event.data && Number(event.data.turn) === target) anchor = index
  }
  if (anchor < 0) {
    // 兼容：没有 assistant 消息时退回 turn/end 的位置。
    for (let index = 0; index < list.length; index += 1) {
      const event = list[index]
      if (event && event.type === 'turn/end' && event.data && Number(event.data.turn) === target) anchor = index
    }
  }
  if (anchor < 0) return ''
  for (let index = anchor + 1; index < list.length; index += 1) {
    const event = list[index]
    if (!event || event.type !== 'user/message') continue
    // 真实 DSH v4 用户消息是 `data.content`（实测）；`data.message.content` 是旧夹具形状，保留兼容。
    const data = event.data || {}
    const content = Array.isArray(data.content) ? data.content : (data.message && data.message.content)
    const text = textOf(content)
    if (text !== '' && !/^Time sampled while preparing/u.test(text)) return text
  }
  return ''
}

/** 某 turn 内的工具调用（name + arguments 原文）。 */
export function toolCallsOfTurn(events, turn) {
  const target = Number(turn)
  return (Array.isArray(events) ? events : [])
    .filter((event) => event && event.type === 'tool/call' && event.data && Number(event.data.turn) === target)
    .map((event) => ({ name: String(event.data.name || ''), arguments: event.data.arguments }))
}

function parseArguments(raw) {
  if (raw !== null && typeof raw === 'object') return raw
  try {
    const parsed = JSON.parse(String(raw || ''))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * 把一次 `exp_record` 调用绑到它所在的 turn：
 * 在最近几个会话里找 `tool/call`（name=exp_record，intent/action 与本次入参一致），
 * 找到就返回 `{sessionId, turn, cwd, userText}`；找不到返回 null（调用方降级为只记时间）。
 */
export function findActiveSession(options = {}) {
  // 当前会话 = 本工作区里最近有写入的会话文件。必须按 cwd 过滤：别的 DSH 窗口后写不能顶掉身份。
  // 子代理会话目录是裸 UUID，listSessionFiles 已按「目录里有会话文件」收录。
  const cwd = String(options.cwd || '').trim()
  const target = cwd === '' ? '' : path.resolve(cwd)
  let candidates = listSessionFiles(options)
  if (target !== '') candidates = candidates.filter((item) => cachedCwd(item.file) === target)
  if (candidates.length === 0) return null
  // 并行窗口/父子会话同时写时，优先「最近一次 exp_* tool/call 与本次 intent 一致」的会话。
  const tool = String(options.tool || '').trim()
  const intent = String(options.intent || '').trim()
  if (tool !== '' && intent !== '') {
    const hit = candidates.find((item) => {
      const events = readSessionEvents(item.file)
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index]
        if (!event || event.type !== 'tool/call' || !event.data) continue
        if (String(event.data.name || '') !== tool) continue
        const args = parseArguments(event.data.arguments)
        if (String(args.intent || '').trim() === intent) return true
      }
      return false
    })
    if (hit !== undefined) return { sessionId: hit.sessionId, file: hit.file, cwd: cachedCwd(hit.file) }
  }
  const [item] = candidates
  return { sessionId: item.sessionId, file: item.file, cwd: cachedCwd(item.file) }
}

export function findRecordBinding(input = {}, options = {}) {
  const intent = String(input.intent || '').trim()
  const action = String(input.action || '').trim()
  const limit = Math.max(1, Math.trunc(Number(options.scan) || 3))
  // 会话归属（0.13.0）：给了 cwd 就只在本工作区的会话里找。
  // 必须在 slice(0, limit) **之前**过滤，否则别的工作区后写的同参记录会把本工作区的绑走。
  const cwd = String(options.cwd || '').trim()
  const target = cwd === '' ? '' : path.resolve(cwd)
  let files = listSessionFiles(options)
  if (target !== '') files = files.filter((item) => cachedCwd(item.file) === target)
  const matches = []
  for (const item of files.slice(0, limit)) {
    const events = readSessionEvents(item.file)
    if (events.length === 0) continue
    let matched = null
    for (const event of events) {
      if (!event || event.type !== 'tool/call' || !event.data) continue
      if (String(event.data.name || '') !== 'exp_record') continue
      const args = parseArguments(event.data.arguments)
      if (String(args.intent || '').trim() !== intent) continue
      if (String(args.action || '').trim() !== action) continue
      matched = event
    }
    if (matched === null) continue
    matches.push({ item, matched, events })
  }
  if (matches.length === 0) return null
  // 两会话同参且写入时间几乎相同：无法唯一归属 → 宁可不绑（别张冠李戴）。
  if (matches.length > 1 && Math.abs(matches[0].item.mtime - matches[1].item.mtime) < 5000) return null
  const { item, matched, events } = matches[0]
  const turn = Number(matched.data.turn)
  return {
    sessionId: item.sessionId,
    file: item.file,
    cwd: cachedCwd(item.file, events),
    turn: Number.isFinite(turn) ? turn : null,
    userText: firstUserMessageAfterTurn(events, turn),
  }
}

/** 某条经验绑定的 turn 之后的第一条用户原话（读不到返回 ''）。 */
export function userMessageForRecord(input = {}, options = {}) {
  const sessionId = String(input.sessionId || '').trim()
  const turn = Number(input.turn)
  if (sessionId === '' || !Number.isFinite(turn)) return ''
  const item = listSessionFiles(options).find((entry) => entry.sessionId === sessionId)
  if (item === undefined) return ''
  return firstUserMessageAfterTurn(readSessionEvents(item.file), turn)
}

/** 清掉 cwd 缓存（测试用）。 */
export function clearSessionCache() {
  cwdCache.clear()
}
