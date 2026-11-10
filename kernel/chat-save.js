/**
 * 把聊天里的一轮对话存成经验（会话文件只读）。
 *
 * DSH 的会话存放在 `$DSH_HOME/sessions/<workspace>/session-<id>/session.v4.jsonl.zstd`，
 * 事件里有 `user/message` 与 `assistant/message`（`data.message.id` 就是界面上那条消息的 id）。
 * 这里按 messageId 找到那轮助手回复，再往前找最近的用户输入，拼成「意图 → 做法」存进经验库。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

const CHAT_SAVE_REV = 'v3'

import { readStore, upsertExperience, writeStore } from './store.js'

function dshHome() {
  const raw = String(process.env.DSH_HOME || '').trim()
  return raw === '' ? path.join(os.homedir(), '.dsh') : path.resolve(raw.replace(/^~(?=$|[\\/])/u, os.homedir()))
}

/** 找到 sessionId 对应的会话文件（可能在某个工作区子目录下）。 */
export function findSessionFile(sessionId, options = {}) {
  const raw = String(sessionId || '').trim()
  if (raw === '') return ''
  const bare = raw.startsWith('session-') ? raw.slice('session-'.length) : raw
  const names = [...new Set([raw, bare, `session-${bare}`].filter((name) => name !== ''))]
  const root = path.resolve(options.sessionsRoot || path.join(dshHome(), 'sessions'))
  const candidates = []
  for (const name of names) candidates.push(path.join(root, name))
  let workspaces = []
  try {
    workspaces = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory())
  } catch {
    workspaces = []
  }
  for (const workspace of workspaces) {
    for (const name of names) candidates.push(path.join(root, workspace.name, name))
  }
  for (const dir of candidates) {
    for (const name of ['session.v4.jsonl.zstd', 'session.v4.jsonl', 'session.jsonl.zstd', 'session.jsonl']) {
      const file = path.join(dir, name)
      if (fs.existsSync(file)) return file
    }
  }
  return ''
}

function readSessionLines(file) {
  const buffer = fs.readFileSync(file)
  let text = ''
  if (file.endsWith('.zstd')) {
    if (typeof zlib.zstdDecompressSync !== 'function') return []
    try {
      text = zlib.zstdDecompressSync(buffer).toString('utf8')
    } catch {
      // 文件正在追加、当前帧不完整：本次读不到就当空文件，调用方会重试。
      return []
    }
  } else {
    text = buffer.toString('utf8')
  }
  const out = []
  for (const line of text.split(/\r?\n/u)) {
    if (line.trim() === '') continue
    try {
      out.push(JSON.parse(line))
    } catch {
      // 坏行跳过
    }
  }
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

function userTextOf(event) {
  if (event === null || typeof event !== 'object') return ''
  if (event.type === 'user/message') return textOf(event.data && event.data.message && event.data.message.content)
  if (event.type === 'agent/inbox/spliced') {
    const inserted = (event.data && event.data.inserted) || []
    return inserted.map((item) => textOf(item && item.content)).filter((text) => text !== '').join('\n')
  }
  return ''
}

/**
 * 按 messageId 取那一轮的用户输入与助手回复。
 * @returns {{userText:string, assistantText:string, time:number} | null}
 */
export function readTurnByMessage(sessionId, messageId, options = {}) {
  const id = String(messageId || '').trim()
  if (id === '') return null
  const file = options.sessionFile || findSessionFile(sessionId, options)
  if (file === '') return null
  const events = readSessionLines(file)
  const index = events.findIndex((event) => event && event.type === 'assistant/message'
    && event.data && event.data.message && String(event.data.message.id || '') === id)
  if (index < 0) return null
  const assistant = events[index]
  const assistantText = textOf(assistant.data.message.content)
  let userText = ''
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const candidate = userTextOf(events[cursor])
    if (candidate !== '') {
      userText = candidate
      break
    }
  }
  return {
    userText,
    assistantText,
    time: Number(assistant.time) || 0,
  }
}

function sleepSync(ms) {
  const until = Date.now() + ms
  while (Date.now() < until) { /* 忙等，保持同步 API */ }
}

function clip(text, max) {
  const value = String(text || '').replace(/\s+/gu, ' ').trim()
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

/**
 * 把一轮对话写成经验条目（outcome 默认 unknown，等用户回填）。
 * @returns {{id:string, intent:string, action:string, outcome:string}}
 */
export function saveTurnAsExperience(dataDir, input = {}, options = {}) {
  const sessionId = String(input.sessionId || '').trim()
  const messageId = String(input.messageId || '').trim()
  let turn = readTurnByMessage(sessionId, messageId, options)
  if (turn === null) turn = readTurnByMessageId(messageId, options)
  if (turn === null) {
    // 会话文件是异步追加的：点击瞬间可能还没落盘，短暂重试几次。
    const attempts = Math.max(1, Math.trunc(Number(options.attempts) || 4))
    for (let index = 0; index < attempts && turn === null; index += 1) {
      if (index > 0) sleepSync(250)
      turn = readTurnByMessage(sessionId, messageId, options)
      if (turn === null) turn = readTurnByMessageId(messageId, options)
    }
  }
  if (turn === null) {
    const file = options.sessionFile || findSessionFile(sessionId, options)
    const root = options.sessionsRoot || path.join(dshHome(), 'sessions')
    throw new Error(`[${CHAT_SAVE_REV}] 找不到这条消息：session=${sessionId || '(空)'} mid=${messageId} file=${file || '(没找到会话文件)'} root=${root} zstd=${typeof zlib.zstdDecompressSync}`)
  }
  const outcome = String(input.outcome || 'unknown')
  const intent = clip(turn.userText || input.intent || '（未识别到用户输入）', 200)
  const action = clip(turn.assistantText || '（助手回复为空）', 600)
  const note = clip(input.note || `从会话一键存入：session ${sessionId} · message ${messageId}`, 300)
  const store = readStore(dataDir)
  const result = upsertExperience(store, {
    intent,
    action,
    outcome,
    type: String(input.type || '').trim(),
    note,
    context: Array.isArray(input.context) ? input.context : [],
  }, {
    mergeThreshold: options.mergeThreshold,
    replaceThreshold: options.replaceThreshold,
    maxTypes: options.maxTypes,
    newTypesPerDay: options.newTypesPerDay,
    typeSimilarity: options.typeSimilarity,
  })
  writeStore(dataDir, store)
  return {
    id: String(result.experience && result.experience.id ? result.experience.id : ''),
    intent,
    action,
    outcome,
  }
}

/**
 * 只给 messageId 时反查会话（按最近修改的前 N 个会话找）。
 * 界面槽位拿不到 sessionId 时用这条兜底路径。
 */
export function readTurnByMessageId(messageId, options = {}) {
  const id = String(messageId || '').trim()
  if (id === '') return null
  const root = path.resolve(options.sessionsRoot || path.join(dshHome(), 'sessions'))
  let dirs = []
  try {
    for (const workspace of fs.readdirSync(root, { withFileTypes: true })) {
      if (!workspace.isDirectory()) continue
      const base = path.join(root, workspace.name)
      for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith('session-')) continue
        const dir = path.join(base, entry.name)
        const file = path.join(dir, 'session.v4.jsonl.zstd')
        if (!fs.existsSync(file)) continue
        dirs.push({ file, mtime: fs.statSync(file).mtimeMs })
      }
    }
  } catch {
    dirs = []
  }
  dirs.sort((left, right) => right.mtime - left.mtime)
  const limit = Math.max(1, Math.trunc(Number(options.limit) || 8))
  for (const item of dirs.slice(0, limit)) {
    const turn = readTurnByMessage('', id, { sessionFile: item.file, sessionsRoot: root })
    if (turn !== null) return turn
  }
  return null
}
/** 只读自检：会话根、最近会话文件、某个 messageId 能否扫到。 */
export function probeSessions(messageId = '', options = {}) {
  const root = path.resolve(options.sessionsRoot || path.join(dshHome(), 'sessions'))
  const out = {
    root,
    rootExists: fs.existsSync(root),
    zstd: typeof zlib.zstdDecompressSync,
    dshHomeEnv: process.env.DSH_HOME || '(unset)',
    sessions: 0,
    newest: [],
    found: '',
    error: '',
  }
  const dirs = []
  try {
    for (const workspace of fs.readdirSync(root, { withFileTypes: true })) {
      if (!workspace.isDirectory()) continue
      const base = path.join(root, workspace.name)
      for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const file = path.join(base, entry.name, 'session.v4.jsonl.zstd')
        if (!fs.existsSync(file)) continue
        dirs.push({ dir: path.join(base, entry.name), file, size: fs.statSync(file).size, mtime: fs.statSync(file).mtimeMs })
      }
    }
  } catch (error) {
    out.error = error && error.message ? error.message : String(error)
  }
  dirs.sort((left, right) => right.mtime - left.mtime)
  out.sessions = dirs.length
  out.newest = dirs.slice(0, 5).map((item) => ({ dir: item.dir, size: item.size, mtime: new Date(item.mtime).toISOString() }))
  const id = String(messageId || '').trim()
  if (id !== '') {
    for (const item of dirs.slice(0, 30)) {
      const hit = readSessionLines(item.file).some((event) => event && event.data && event.data.message && String(event.data.message.id || '') === id)
      if (hit) {
        out.found = item.file
        break
      }
    }
  }
  return out
}