/**
 * 会话 → 经验：从 zstd 会话文件按 messageId 取那一轮，写成经验条目。
 * Run: node kernel/tests/chat-save.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

const chatSave = await import('../chat-save.js')
const { findSessionFile, readTurnByMessage, readTurnByMessageId, saveTurnAsExperience } = chatSave
const { readStore } = await import('../store.js')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-chat-'))
const dataDir = path.join(root, 'exp')
fs.mkdirSync(dataDir, { recursive: true })
const sessionsRoot = path.join(root, 'sessions')
const sessionId = 'session-test-0001'
const workspace = path.join(sessionsRoot, '--C-Users-yh-demo--')
const sessionDir = path.join(workspace, sessionId)
fs.mkdirSync(sessionDir, { recursive: true })

function event(type, seq, data, time) {
  return JSON.stringify({ type, seq, time: time || 1700000000000 + seq, data })
}
const lines = [
  event('session', 0, { id: sessionId, version: 4 }),
  event('user/message', 1, { turn: 1, message: { role: 'user', content: [{ type: 'text', text: '帮我给插件市场提交收录 PR' }] } }),
  event('assistant/message', 2, { turn: 1, step: 1, message: { role: 'assistant', id: 'msg-aaa', content: [{ type: 'reasoning', text: '先读 README' }, { type: 'text', text: '先读 README，再核对 4 项，然后走 API 开 PR。' }] } }),
  event('user/message', 3, { turn: 2, message: { role: 'user', content: [{ type: 'text', text: '第二个问题：仓库满一天了吗' }] } }),
  event('assistant/message', 4, { turn: 2, step: 1, message: { role: 'assistant', id: 'msg-bbb', content: [{ type: 'text', text: '看 created_at，未满一天就先等。' }] } }),
]
fs.writeFileSync(path.join(sessionDir, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(lines.join('\n'), 'utf8')))

let passed = 0
let failed = 0
async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}`)
    console.log(`       ${error && error.stack ? error.stack : error}`)
  }
}

await check('findSessionFile：按 sessionId 找到会话文件', () => {
  const file = findSessionFile(sessionId, { sessionsRoot })
  assert.equal(file, path.join(sessionDir, 'session.v4.jsonl.zstd'))
  assert.equal(findSessionFile('nope', { sessionsRoot }), '')
})

await check('readTurnByMessage：取助手正文（跳过 reasoning）与最近的用户输入', () => {
  const turn = readTurnByMessage(sessionId, 'msg-aaa', { sessionsRoot })
  assert.equal(turn.userText, '帮我给插件市场提交收录 PR')
  assert.equal(turn.assistantText, '先读 README，再核对 4 项，然后走 API 开 PR。')
  assert.ok(turn.time > 0)
})

await check('readTurnByMessageId：只给 messageId 反查最近会话', () => {
  const turn = readTurnByMessageId('msg-bbb', { sessionsRoot })
  assert.equal(turn.userText, '第二个问题：仓库满一天了吗')
  assert.equal(turn.assistantText, '看 created_at，未满一天就先等。')
})

await check('saveTurnAsExperience：写进经验库（intent=用户输入，action=助手正文）', () => {
  const saved = saveTurnAsExperience(dataDir, { sessionId, messageId: 'msg-aaa' }, { sessionsRoot })
  assert.ok(saved.id.startsWith('ex_'))
  assert.equal(saved.intent, '帮我给插件市场提交收录 PR')
  assert.match(saved.action, /先读 README/)
  const store = readStore(dataDir)
  const row = store.experiences.find((item) => item.id === saved.id)
  assert.equal(row.outcome, 'unknown')
  assert.match(row.note, /session-test-0001/)
  assert.match(row.note, /msg-aaa/)
})

await check('saveTurnAsExperience：messageId 不存在时报错', () => {
  assert.throws(() => saveTurnAsExperience(dataDir, { messageId: 'msg-none' }, { sessionsRoot }), /找不到这条消息/)
})

fs.rmSync(root, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
