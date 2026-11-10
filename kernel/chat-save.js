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

import { readStore, upsertExperience, writeStore } from './store.js'

function dshHome() {
  const raw = String(process.env.DSH_HOME || '').trim()
  return raw === '' ? path.join(os.homedir(), '.dsh') : path.resolve(raw.replace(/^~(?=$|[\\/])/u, os.homedir()))
}

/** 找到 sessionId 对应的会话文件（可能在某个工作区子目录下）。 */
export function findSessionFile(sessionId, options = {}) {
  const id = String(sessionId || '').trim()
  if (id === '') return ''
  const root = path.resolve(options.sessionsRoot || path.join(dshHome(), 'sessions'))
  const candidates = [path.join(root, id)]
  if (!id.startsWith('session-')) candidates.push(path.join(root, `session-${id}`))
  let workspaces = []
  try {
    workspaces = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory())
  } catch {
    workspaces = []
  }
  for (const workspace of workspaces) {
    candidates.push(path.join(root, workspace.name, id))
    if (!id.startsWith('session-')) candidates.push(path.join(root, workspace.name, `session-${id}`))
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
  const text = file.endsWith('.zstd')
    ? zlib.zstdDecompressSync(buffer).toString('utf8')
    : buffer.toString('utf8')
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
  if (turn === null) throw new Error('找不到这条消息（会话文件不存在或消息 id 不匹配）')
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