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

/**
 * 扫描缓存（task-8，2026-11-12）
 *
 * 为什么：`findRecordBinding` / `findActiveSession` 每次 exp_record / exp_recall 都会扫
 * `~/.dsh/sessions`。本机实测 356 个文件 / 216.7 MB：
 *   findActiveSession(tool+intent)：首次 54.3 s、P50 20.9 s；findRecordBinding：2.3 s/次。
 * 三件事（都只在开关打开时生效）：
 *   1. **目录树缓存**：按「root mtime + 各 workspace mtime / 名字」失效。新会话目录会改 workspace
 *      的 mtime，所以「本会话刚写入的新会话文件」一定能被发现（正确性红线）。
 *   2. **会话索引缓存**：整读一次后只留检索需要的字段（cwd / origin / tool-call / 消息锚点），
 *      按文件 `mtimeMs:size` 失效。本会话追加写入 → mtime/size 变 → 只重读那一个文件；
 *      没变的会话不再重复解压。**不缓存整个事件数组**——真实单会话解压后可达数十 MB，
 *      8 个就顶满内存；索引小一个量级，LRU 上限 `SESSION_INDEX_CACHE_MAX_BYTES`。
 *   3. **首帧读**：取 cwd 只需要首事件，`readSessionHead` 只解第一帧，不整包解压。
 * 扫描预算：`findActiveSession` 只先扫最近 N 个会话（默认 `SESSION_SCAN_BUDGET`）；预算内没命中
 * 就**回退全扫**并在结果里标 `scanLimited: true`——结果与全扫一致，只是多花一次。
 * 开关：`ENGRAM_SESSION_SCAN_CACHE=off` 关掉全部缓存与预算，行为回到 0.13 的逐次全扫。
 */
export const SESSION_SCAN_BUDGET = 50
export const SESSION_INDEX_CACHE_MAX_BYTES = 32 * 1024 * 1024
const SESSION_HEAD_BYTES = 128 * 1024
/** 磁盘索引版本：结构变更就 +1，旧版/坏文件静默重建。 */
export const SESSION_INDEX_VERSION = 1
/**
 * 磁盘索引的单文件上限（超过就丢掉最大的条目，下次用到再重建）。
 * 与计划书一致：索引文件超过 `CACHE_MAX_BYTES` 就重建不追加。
 */
export const SESSION_INDEX_FILE_MAX_BYTES = 32 * 1024 * 1024
/** 索引超过 30 天未用就忽略并重建（避免陈旧条目录无限堆积）。 */
export const SESSION_INDEX_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
const SESSION_CACHE_DIR = '.cache'
const SESSION_INDEX_FILE_NAME = 'sessions.idx.json'

const sessionTreeCache = new Map()
const sessionIndexCache = new Map()
let sessionIndexCacheBytes = 0
let indexWriteGeneration = 0
const sessionIndexFileState = new Map()
const scanStats = {
  listCalls: 0,
  treeHits: 0,
  treeMisses: 0,
  treeStats: 0,
  fileStats: 0,
  contentReads: 0,
  contentBytes: 0,
  headReads: 0,
  headBytes: 0,
  indexHits: 0,
  cwdHits: 0,
  budgetScans: 0,
  budgetFallbacks: 0,
}

/** 开关：`ENGRAM_SESSION_SCAN_CACHE=off` 时逐次全扫（排查 / 对照用）。 */
export function sessionScanCacheEnabled() {
  return String(process.env.ENGRAM_SESSION_SCAN_CACHE || '').trim().toLowerCase() !== 'off'
}

/** 扫描计数器（测试 / 交付测量用；只读快照）。 */
export function sessionScanStats() {
  return { ...scanStats }
}

export function resetSessionScanStats() {
  for (const key of Object.keys(scanStats)) scanStats[key] = 0
}

function parseEventText(text) {
  const events = []
  for (const line of String(text).split(/\r?\n/u)) {
    if (line.trim() === '') continue
    try {
      events.push(JSON.parse(line))
    } catch {
      // 坏行跳过
    }
  }
  return events
}

function indexBytesOf(index) {
  let bytes = 200 + (Array.isArray(index.calls) ? index.calls.length : 0) * 160
  for (const marker of Array.isArray(index.markers) ? index.markers : []) {
    bytes += marker.kind === 'user' ? String(marker.text || '').length * 2 + 40 : 40
  }
  return bytes
}

function putIndexCache(file, sig, index) {
  const bytes = indexBytesOf(index)
  const existing = sessionIndexCache.get(file)
  if (existing !== undefined) {
    sessionIndexCache.delete(file)
    sessionIndexCacheBytes -= existing.bytes
  }
  sessionIndexCache.set(file, { sig, bytes, index })
  sessionIndexCacheBytes += bytes
  indexWriteGeneration += 1
  while (sessionIndexCacheBytes > SESSION_INDEX_CACHE_MAX_BYTES && sessionIndexCache.size > 1) {
    const oldest = sessionIndexCache.keys().next().value
    const removed = sessionIndexCache.get(oldest)
    sessionIndexCache.delete(oldest)
    sessionIndexCacheBytes -= removed.bytes
  }
}

/** 一条 user/message 里的文本（与 `firstUserMessageAfterTurn` 取法一致）。 */
function userTextOf(event) {
  const data = (event && event.data) || {}
  const content = Array.isArray(data.content) ? data.content : (data.message && data.message.content)
  return textOf(content)
}

/**
 * 会话索引：只保留检索要用的字段——cwd、origin（首事件，判断子代理）、
 * tool/call（name/intent/action/turn/time）、以及 assistant|turnEnd|user 的位置锚点。
 * `firstUserMessageAfterTurnFromIndex` 与直接遍历事件的版本逐字等价。
 */
function buildSessionIndex(events) {
  const index = {
    cwd: sessionCwd(events),
    origin: String((events[0] && events[0].origin) || ''),
    calls: [],
    markers: [],
  }
  for (let pointer = 0; pointer < events.length; pointer += 1) {
    const event = events[pointer]
    if (!event || typeof event !== 'object') continue
    if (event.type === 'tool/call' && event.data) {
      const args = parseArguments(event.data.arguments)
      index.calls.push({
        name: String(event.data.name || ''),
        intent: String(args.intent || '').trim(),
        action: String(args.action || '').trim(),
        turn: Number(event.data.turn),
        time: Number.isFinite(Number(event.time)) ? Number(event.time) : pointer,
      })
      continue
    }
    if (event.type === 'assistant/message' && event.data) {
      index.markers.push({ kind: 'assistant', turn: Number(event.data.turn), index: pointer })
      continue
    }
    if (event.type === 'turn/end' && event.data) {
      index.markers.push({ kind: 'turnEnd', turn: Number(event.data.turn), index: pointer })
      continue
    }
    if (event.type === 'user/message') {
      index.markers.push({ kind: 'user', text: userTextOf(event), index: pointer })
    }
  }
  return index
}

/** 索引版的 `firstUserMessageAfterTurn`：同样的锚点规则（assistant → turn/end 兜底），逐字一致。 */
function firstUserMessageAfterTurnFromIndex(index, turn) {
  const target = Number(turn)
  if (!Number.isFinite(target)) return ''
  let anchor = -1
  for (const marker of index.markers) {
    if (marker.kind === 'assistant' && marker.turn === target) anchor = marker.index
  }
  if (anchor < 0) {
    for (const marker of index.markers) {
      if (marker.kind === 'turnEnd' && marker.turn === target) anchor = marker.index
    }
  }
  if (anchor < 0) return ''
  for (const marker of index.markers) {
    if (marker.kind !== 'user' || marker.index <= anchor) continue
    const text = marker.text
    if (text !== '' && !/^Time sampled while preparing/u.test(text)) return text
  }
  return ''
}

/**
 * 取会话索引：缓存命中直接用；未命中就整读一次再建索引（开关打开时缓存）。
 * @returns {object|null} 读不到返回 null
 */
function sessionIndexOf(file) {
  const cacheOn = sessionScanCacheEnabled()
  let sig = null
  try {
    const stat = fs.statSync(file)
    scanStats.fileStats += 1
    sig = `${stat.mtimeMs}:${stat.size}`
    if (cacheOn) {
      const hit = sessionIndexCache.get(file)
      if (hit !== undefined && hit.sig === sig) {
        sessionIndexCache.delete(file)
        sessionIndexCache.set(file, hit) // LRU touch
        scanStats.indexHits += 1
        return hit.index
      }
    }
  } catch {
    return null
  }
  const events = readSessionEvents(file)
  const index = buildSessionIndex(events)
  if (cacheOn) putIndexCache(file, sig, index)
  return index
}

/**
 * 只读会话文件开头（首帧）的事件：cwd 只需要首事件 `type:"session"`。
 * 首帧被截断 / 解不出来时回退 `readSessionEvents`（正确性优先，性能其次）。
 */
export function readSessionHead(file) {
  try {
    const stat = fs.statSync(file)
    const length = Math.min(stat.size, SESSION_HEAD_BYTES)
    if (length <= 0) return []
    const buffer = Buffer.alloc(length)
    const fd = fs.openSync(file, 'r')
    let read = 0
    try {
      read = fs.readSync(fd, buffer, 0, length, 0)
    } finally {
      fs.closeSync(fd)
    }
    scanStats.headReads += 1
    scanStats.headBytes += read
    const slice = buffer.subarray(0, read)
    const truncated = read < stat.size
    if (!file.endsWith('.zstd') || typeof zlib.zstdDecompressSync !== 'function') {
      if (!truncated) return parseEventText(slice.toString('utf8'))
      // 只读了一段：只解析最后一个换行之前的完整行。
      const text = slice.toString('utf8')
      const lastBreak = text.lastIndexOf('\n')
      if (lastBreak < 0) return readSessionEvents(file)
      return parseEventText(text.slice(0, lastBreak + 1))
    }
    const first = slice.indexOf(ZSTD_MAGIC, 0)
    if (first < 0) return readSessionEvents(file)
    const next = slice.indexOf(ZSTD_MAGIC, first + 4)
    let frame
    try {
      // 还有下一帧 → 首帧完整，只解它；没有下一帧且文件没读全 → 首帧可能被截断，解压会抛错。
      frame = zlib.zstdDecompressSync(next < 0 ? slice.subarray(first) : slice.subarray(first, next))
    } catch {
      return readSessionEvents(file)
    }
    return parseEventText(frame.toString('utf8'))
  } catch {
    return readSessionEvents(file)
  }
}


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
    scanStats.contentReads += 1
    scanStats.contentBytes += buffer.length
    const text = file.endsWith('.zstd') && typeof zlib.zstdDecompressSync === 'function'
      ? decodeZstdFrames(buffer).toString('utf8')
      : buffer.toString('utf8')
    return parseEventText(text)
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

/** 会话所属 cwd（缓存按 mtime+size 失效；开了缓存时只读首帧，不整包解压）。 */
function cachedCwd(file) {
  try {
    const stat = fs.statSync(file)
    scanStats.fileStats += 1
    const hit = cwdCache.get(file)
    if (hit !== undefined && hit.mtime === stat.mtimeMs && hit.size === stat.size) {
      scanStats.cwdHits += 1
      return hit.cwd
    }
    let cwd = ''
    if (sessionScanCacheEnabled()) {
      cwd = sessionCwd(readSessionHead(file))
      if (cwd === '') cwd = sessionCwd(readSessionEvents(file))
    } else {
      cwd = sessionCwd(readSessionEvents(file))
    }
    cwdCache.set(file, { mtime: stat.mtimeMs, size: stat.size, cwd })
    return cwd
  } catch {
    return ''
  }
}

/** 目录树缓存指纹：root mtime + 各 workspace 的 mtime 与名字（新会话目录会改 workspace mtime）。 */
function treeStampOf(root, workspaces) {
  const parts = []
  try {
    parts.push(`r:${fs.statSync(root).mtimeMs}`)
  } catch {
    parts.push('r:-')
  }
  scanStats.treeStats += 1
  for (const workspace of workspaces) {
    let mtime = '-'
    try {
      mtime = fs.statSync(path.join(root, workspace.name)).mtimeMs
    } catch {
      mtime = '-'
    }
    scanStats.treeStats += 1
    parts.push(`${workspace.name}:${mtime}`)
  }
  return parts.join('|')
}

/** 递归两层的目录树（workspace → session 目录），只 readdir，不 stat 会话文件。 */
function scanSessionDirs(root, workspaces) {
  const items = []
  for (const workspace of workspaces) {
    const base = path.join(root, workspace.name)
    let sessions = []
    try {
      // 子代理会话目录是裸 UUID（首事件 origin:subagent），不能只认 session- 前缀；
      // 真正的判据是「目录里有会话文件」（listSessionFiles 里按 SESSION_FILE_NAMES 检查）。
      sessions = fs.readdirSync(base, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    } catch {
      continue
    }
    for (const session of sessions) {
      items.push({ dir: path.join(base, session.name), sessionId: session.name, workspace: workspace.name })
    }
  }
  return items
}

/** 列出全部会话文件（按 mtime 倒序）。目录树走缓存，会话文件每次 stat（追加写入要能立刻反映）。 */
export function listSessionFiles(options = {}) {
  scanStats.listCalls += 1
  const root = path.resolve(options.sessionsRoot || path.join(dshHome(), 'sessions'))
  const out = []
  let workspaces = []
  try {
    workspaces = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory())
  } catch {
    return out
  }
  const cacheOn = sessionScanCacheEnabled()
  let items
  if (cacheOn) {
    const stamp = treeStampOf(root, workspaces)
    const hit = sessionTreeCache.get(root)
    if (hit !== undefined && hit.stamp === stamp) {
      items = hit.items
      scanStats.treeHits += 1
    } else {
      items = scanSessionDirs(root, workspaces)
      sessionTreeCache.set(root, { stamp, items })
      scanStats.treeMisses += 1
    }
  } else {
    items = scanSessionDirs(root, workspaces)
  }
  for (const item of items) {
    for (const name of SESSION_FILE_NAMES) {
      const file = path.join(item.dir, name)
      try {
        const stat = fs.statSync(file)
        scanStats.fileStats += 1
        if (!stat.isFile()) continue
        out.push({ file, dir: item.dir, sessionId: item.sessionId, workspace: item.workspace, mtime: stat.mtimeMs })
        break
      } catch {
        scanStats.fileStats += 1
      }
    }
  }
  out.sort((left, right) => right.mtime - left.mtime)
  return out
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
 * 在候选会话里找「最近一次 exp_* tool/call 与 intent 一致」的那个（按事件时间取最新）。
 * 用会话索引，不重读事件流。
 * @returns {{item: object, time: number, isSubagent: boolean, index: object}|null}
 */
function bestSessionCall(candidates, tool, intent) {
  let best = null
  for (const item of candidates) {
    const index = sessionIndexOf(item.file)
    if (index === null) continue
    const isSubagent = index.origin === 'subagent'
    for (let pointer = index.calls.length - 1; pointer >= 0; pointer -= 1) {
      const call = index.calls[pointer]
      // 任意 exp_* 且 intent 匹配都算：同一会话上一轮做过 exp_recall，也是它属于本任务的强证据。
      if (call.name !== tool && !call.name.startsWith('exp_')) continue
      if (call.intent !== intent) continue
      if (best === null || call.time > best.time || (call.time === best.time && best.isSubagent && !isSubagent)) {
        best = { item, time: call.time, isSubagent, index }
      }
      break
    }
  }
  return best
}

/**
 * 把一次 `exp_record` 调用绑到它所在的 turn：
 * 在最近几个会话里找 `tool/call`（name=exp_record，intent/action 与本次入参一致），
 * 找到就返回 `{sessionId, turn, cwd, userText}`；找不到返回 null（调用方降级为只记时间）。
 *
 * 给了 `options.dataDir` 时走磁盘索引（`.cache/sessions.idx.json`）：进程重启后首次调用
 * 只需 stat + 读索引，不再重建全目录（task-10）；写索引失败静默。
 */
export function findActiveSession(options = {}) {
  const scanRoot = path.resolve(options.sessionsRoot || path.join(dshHome(), 'sessions'))
  const dataDir = String(options.dataDir || '')
  if (dataDir !== '') loadSessionIndex(dataDir, scanRoot)
  try {
    return findActiveSessionCore(options)
  } finally {
    if (dataDir !== '') saveSessionIndex(dataDir, scanRoot)
  }
}

function findActiveSessionCore(options = {}) {
  // 当前会话 = 本工作区里最近有写入的会话文件。必须按 cwd 过滤：别的 DSH 窗口后写不能顶掉身份。
  // 子代理会话目录是裸 UUID，listSessionFiles 已按「目录里有会话文件」收录。
  const cwd = String(options.cwd || '').trim()
  const target = cwd === '' ? '' : path.resolve(cwd)
  let candidates = listSessionFiles(options)
  if (target !== '') candidates = candidates.filter((item) => cachedCwd(item.file) === target)
  if (candidates.length === 0) return null
  // 并行窗口/父子会话同时写时，优先「最近一次 exp_* tool/call 与本次 intent 一致」的会话。
  // 不能只看文件 mtime：父会话的 tool/call 还没刷盘（宿主约 5s）时，后写的子会话会顶替父身份；
  // fork 会把父历史复制进子会话（同一 event.time），此时优先非 subagent 的父会话。
  const tool = String(options.tool || '').trim()
  const intent = String(options.intent || '').trim()
  if (tool !== '' && intent !== '') {
    const budget = Math.max(1, Math.trunc(Number(options.scanBudget) || SESSION_SCAN_BUDGET))
    const limited = sessionScanCacheEnabled() && candidates.length > budget
    const scanned = limited ? candidates.slice(0, budget) : candidates
    if (limited) scanStats.budgetScans += 1
    const best = bestSessionCall(scanned, tool, intent)
    if (best !== null) {
      return { sessionId: best.item.sessionId, file: best.item.file, cwd: best.index.cwd }
    }
    // 预算内没命中 → 回退全扫并标注（结果与全扫一致；这一步会多花一次扫描）。
    if (limited) {
      const fallback = bestSessionCall(candidates, tool, intent)
      if (fallback !== null) {
        scanStats.budgetFallbacks += 1
        return {
          sessionId: fallback.item.sessionId,
          file: fallback.item.file,
          cwd: fallback.index.cwd,
          scanLimited: true,
        }
      }
    }
  }
  const [item] = candidates
  return { sessionId: item.sessionId, file: item.file, cwd: cachedCwd(item.file) }
}

/** 给了 `options.dataDir` 时同样走磁盘索引（见 findActiveSession）。 */
export function findRecordBinding(input = {}, options = {}) {
  const scanRoot = path.resolve(options.sessionsRoot || path.join(dshHome(), 'sessions'))
  const dataDir = String(options.dataDir || '')
  if (dataDir !== '') loadSessionIndex(dataDir, scanRoot)
  try {
    return findRecordBindingCore(input, options)
  } finally {
    if (dataDir !== '') saveSessionIndex(dataDir, scanRoot)
  }
}

function findRecordBindingCore(input = {}, options = {}) {
  const intent = String(input.intent || '').trim()
  const action = String(input.action || '').trim()
  const limit = Math.max(1, Math.trunc(Number(options.scan) || 8))
  // 会话归属（0.13.0）：给了 cwd 就只在本工作区的会话里找。
  // 必须在 slice(0, limit) **之前**过滤，否则别的工作区后写的同参记录会把本工作区的绑走。
  const cwd = String(options.cwd || '').trim()
  const target = cwd === '' ? '' : path.resolve(cwd)
  let files = listSessionFiles(options)
  if (target !== '') files = files.filter((item) => cachedCwd(item.file) === target)
  const matches = []
  for (const item of files.slice(0, limit)) {
    const index = sessionIndexOf(item.file)
    if (index === null) continue
    let matched = null
    for (const call of index.calls) {
      if (call.name !== 'exp_record') continue
      if (call.intent !== intent) continue
      if (call.action !== action) continue
      matched = call
    }
    if (matched === null) continue
    matches.push({ item, matched, index })
  }
  if (matches.length === 0) return null
  // 两会话同参且写入时间几乎相同：无法唯一归属 → 宁可不绑（别张冠李戴）。
  if (matches.length > 1 && Math.abs(matches[0].item.mtime - matches[1].item.mtime) < 5000) return null
  const { item, matched, index } = matches[0]
  const turn = Number(matched.turn)
  return {
    sessionId: item.sessionId,
    file: item.file,
    cwd: index.cwd,
    turn: Number.isFinite(turn) ? turn : null,
    userText: firstUserMessageAfterTurnFromIndex(index, turn),
  }
}

/** 某条经验绑定的 turn 之后的第一条用户原话（读不到返回 ''）。 */
export function userMessageForRecord(input = {}, options = {}) {
  const scanRoot = path.resolve(options.sessionsRoot || path.join(dshHome(), 'sessions'))
  const dataDir = String(options.dataDir || '')
  if (dataDir !== '') loadSessionIndex(dataDir, scanRoot)
  try {
    return userMessageForRecordCore(input, options)
  } finally {
    if (dataDir !== '') saveSessionIndex(dataDir, scanRoot)
  }
}

function userMessageForRecordCore(input = {}, options = {}) {
  const sessionId = String(input.sessionId || '').trim()
  const turn = Number(input.turn)
  if (sessionId === '' || !Number.isFinite(turn)) return ''
  const item = listSessionFiles(options).find((entry) => entry.sessionId === sessionId)
  if (item === undefined) return ''
  const index = sessionIndexOf(item.file)
  if (index === null) return ''
  return firstUserMessageAfterTurnFromIndex(index, turn)
}

/** 磁盘索引路径：`<dataDir>/.cache/sessions.idx.json`（.cache/ 会写进同步忽略项）。 */
function sessionIndexFile(dataDir) {
  return path.join(String(dataDir || ''), SESSION_CACHE_DIR, SESSION_INDEX_FILE_NAME)
}

/**
 * 载入磁盘索引（task-10）：进程重启后的第一次调用不再重建全目录索引。
 * 只做结构校验（版本 / root / 30 天内）；每个条目的 `mtimeMs:size` 由 `sessionIndexOf` /
 * `cachedCwd` 在实际用到时校验——不一致就只重建那一个会话文件。
 * 静默失败：索引是缓存，读坏了/版本不符/过期都只是「按没缓存继续」，绝不影响功能。
 */
function loadSessionIndex(dataDir, root) {
  const dir = String(dataDir || '')
  if (dir === '' || !sessionScanCacheEnabled()) return
  const key = `${path.resolve(dir)}\u0000${path.resolve(root)}`
  const existing = sessionIndexFileState.get(key)
  if (existing !== undefined && existing.loaded === true) return
  const state = { loaded: true, savedGeneration: indexWriteGeneration, savedCwdCount: cwdCache.size }
  sessionIndexFileState.set(key, state)
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(sessionIndexFile(dir), 'utf8'))
  } catch {
    return
  }
  if (raw === null || typeof raw !== 'object' || Number(raw.version) !== SESSION_INDEX_VERSION) return
  if (String(raw.root || '') !== path.resolve(root)) return
  const savedAt = Date.parse(String(raw.savedAt || ''))
  if (!Number.isFinite(savedAt) || Date.now() - savedAt > SESSION_INDEX_MAX_AGE_MS) return
  const entries = raw.entries !== null && typeof raw.entries === 'object' ? raw.entries : {}
  for (const [file, entry] of Object.entries(entries)) {
    if (entry === null || typeof entry !== 'object') continue
    const index = entry.index
    const hasIndex = index !== null && typeof index === 'object' && Array.isArray(index.calls) && Array.isArray(index.markers)
    if (index !== null && !hasIndex) continue
    const sig = String(entry.sig || '')
    if (hasIndex) sessionIndexCache.set(file, { sig, bytes: indexBytesOf(index), index })
    const mtime = Number(entry.mtimeMs)
    const size = Number(entry.size)
    const cwd = typeof entry.cwd === 'string' ? entry.cwd : ''
    if (Number.isFinite(mtime) && Number.isFinite(size) && cwd !== '') {
      cwdCache.set(file, { mtime, size, cwd })
    }
  }
}

/** 把内存索引落盘（只在本次进程新建过条目时写）；任何失败静默。 */
function saveSessionIndex(dataDir, root) {
  const dir = String(dataDir || '')
  if (dir === '' || !sessionScanCacheEnabled()) return
  const key = `${path.resolve(dir)}\u0000${path.resolve(root)}`
  const state = sessionIndexFileState.get(key)
  if (state === undefined) return
  if (state.savedGeneration === indexWriteGeneration && state.savedCwdCount === cwdCache.size) return
  const rootAbs = path.resolve(root)
  const entries = {}
  let total = 0
  // 候选 = 有索引的文件（完整条目）∪ 只有 cwd 的文件（index:null）。
  // 只缓存 cwd 的条目很小，却能让重启后的「按 cwd 过滤」不再逐个读首帧（实测 356 文件省 ~25MB 读）。
  const candidates = new Map()
  for (const [file, cached] of sessionIndexCache.entries()) candidates.set(file, cached)
  for (const [file, cached] of cwdCache.entries()) {
    if (candidates.has(file)) continue
    candidates.set(file, { sig: `${cached.mtime}:${cached.size}`, bytes: 120, index: null, cwd: cached.cwd, mtimeMs: cached.mtime, size: cached.size })
  }
  for (const [file, cached] of [...candidates.entries()]
    .filter(([file]) => path.resolve(file).startsWith(rootAbs))
    .sort((left, right) => (Number(left[1].bytes) || 0) - (Number(right[1].bytes) || 0))) {
    const cwdHit = cwdCache.get(file)
    const [mtimeText, sizeText] = String(cached.sig || '').split(':')
    const entry = {
      sig: String(cached.sig || ''),
      mtimeMs: Number.isFinite(Number(cached.mtimeMs)) ? Number(cached.mtimeMs) : Number(mtimeText),
      size: Number.isFinite(Number(cached.size)) ? Number(cached.size) : Number(sizeText),
      cwd: cwdHit !== undefined ? String(cwdHit.cwd || '') : String(cached.cwd || ''),
      index: cached.index === undefined ? null : cached.index,
    }
    const bytes = Buffer.byteLength(JSON.stringify(entry), 'utf8')
    if (total + bytes > SESSION_INDEX_FILE_MAX_BYTES) break
    entries[file] = entry
    total += bytes
  }
  const payload = JSON.stringify({ version: SESSION_INDEX_VERSION, savedAt: new Date().toISOString(), root: rootAbs, entries })
  const file = sessionIndexFile(dir)
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const temp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(temp, payload, 'utf8')
    fs.renameSync(temp, file)
    state.savedGeneration = indexWriteGeneration
    state.savedCwdCount = cwdCache.size
    ensureSyncIgnored(dir)
  } catch {
    // 索引是缓存：写失败只影响下次启动的冷启动速度
  }
}

/** `.exp` 是 git 仓、同步用 `git add -A`：把本地缓存/备份目录写进 .gitignore，别让它们参与同步。 */
function ensureSyncIgnored(dataDir) {
  try {
    const dir = String(dataDir || '')
    if (dir === '') return
    if (!fs.existsSync(path.join(dir, '.git'))) return
    const file = path.join(dir, '.gitignore')
    let text = ''
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      text = ''
    }
    const lines = text.split(/\r?\n/u).map((line) => line.trim())
    const missing = ['.cache/', '.locks/'].filter((item) => !lines.includes(item))
    if (missing.length === 0) return
    const next = `${text === '' || text.endsWith('\n') ? text : `${text}\n`}${missing.join('\n')}\n`
    fs.writeFileSync(file, next, 'utf8')
  } catch {
    // 忽略：写不了 .gitignore 不影响索引与绑定功能
  }
}

/** 清掉全部会话缓存（测试 / 排查用；扫描计数用 resetSessionScanStats 单独清）。 */
export function clearSessionCache() {
  cwdCache.clear()
  sessionTreeCache.clear()
  sessionIndexCache.clear()
  sessionIndexCacheBytes = 0
  sessionIndexFileState.clear()
}
