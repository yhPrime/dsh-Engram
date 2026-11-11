/**
 * 会话读取（0.13.0）：按 cwd 找会话、取 turn 后第一条用户消息、抽 tool/call 绑定。
 *
 * Run: node tests/session-scan.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  clearSessionCache,
  findRecordBinding,
  firstUserMessageAfterTurn,
  listSessionFiles,
  readSessionEvents,
  sessionCwd,
  toolCallsOfTurn,
  userMessageForRecord,
} from '../session.js'

let passed = 0
let failed = 0

function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}`)
    console.log(`       ${error && error.message ? error.message : error}`)
  }
}

const sessionsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-sessions-'))
const cwd = path.join(os.tmpdir(), 'engram-workspace')
const otherCwd = path.join(os.tmpdir(), 'engram-other')
const sessionId = 'session-abc'
const dir = path.join(sessionsRoot, '--C-Users-test-ws--', sessionId)
fs.mkdirSync(dir, { recursive: true })

const events = [
  { type: 'session', data: { cwd } },
  { type: 'turn/start', data: { turn: 1 } },
  { type: 'user/message', data: { message: { content: [{ type: 'text', text: '给阅卷系统加导出' }] } } },
  { type: 'tool/call', data: { turn: 1, name: 'exp_record', arguments: JSON.stringify({ intent: '给阅卷系统加导出', action: '先做 CSV' }) } },
  { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '做好了，文件在 out.csv' }] } } },
  { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  { type: 'user/message', data: { message: { content: [{ type: 'text', text: '导出没有页码，改一下' }] } } },
  { type: 'turn/start', data: { turn: 2 } },
  { type: 'tool/call', data: { turn: 2, name: 'read', arguments: JSON.stringify({ file_path: 'a.md' }) } },
  { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
]
fs.writeFileSync(path.join(dir, 'session.v4.jsonl'), `${events.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8')

// 另一个工作区的会话，用来验证 cwd 过滤。
const otherDir = path.join(sessionsRoot, '--C-Users-other--', 'session-other')
fs.mkdirSync(otherDir, { recursive: true })
fs.writeFileSync(path.join(otherDir, 'session.v4.jsonl'), `${JSON.stringify({ type: 'session', data: { cwd: otherCwd } })}\n`, 'utf8')

const options = { sessionsRoot }

check('listSessionFiles：按目录扫到会话文件', () => {
  const files = listSessionFiles(options)
  assert.equal(files.length, 2)
  assert.ok(files.some((item) => item.sessionId === sessionId))
})

check('sessionCwd：首事件带 cwd', () => {
  clearSessionCache()
  const list = readSessionEvents(path.join(dir, 'session.v4.jsonl'))
  assert.equal(sessionCwd(list), cwd)
})

check('firstUserMessageAfterTurn：取 turn 之后第一条用户原话', () => {
  const list = readSessionEvents(path.join(dir, 'session.v4.jsonl'))
  assert.equal(firstUserMessageAfterTurn(list, 1), '导出没有页码，改一下')
  assert.equal(firstUserMessageAfterTurn(list, 2), '')
})

check('toolCallsOfTurn：只取该 turn 的工具调用', () => {
  const list = readSessionEvents(path.join(dir, 'session.v4.jsonl'))
  const calls = toolCallsOfTurn(list, 1)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, 'exp_record')
})

check('findRecordBinding：按 intent/action 反查 sessionId + turn + 用户原话', () => {
  const binding = findRecordBinding({ intent: '给阅卷系统加导出', action: '先做 CSV' }, options)
  assert.ok(binding !== null, '应能绑定')
  assert.equal(binding.sessionId, sessionId)
  assert.equal(binding.turn, 1)
  assert.equal(binding.cwd, cwd)
  assert.equal(binding.userText, '导出没有页码，改一下')
})

check('findRecordBinding：参数对不上返回 null', () => {
  assert.equal(findRecordBinding({ intent: '不存在的意图', action: '不存在的做法' }, options), null)
})

check('userMessageForRecord：按 sessionId + turn 取原话', () => {
  assert.equal(userMessageForRecord({ sessionId, turn: 1 }, options), '导出没有页码，改一下')
  assert.equal(userMessageForRecord({ sessionId: 'session-nope', turn: 1 }, options), '')
})

check('跳过 DSH 注入的 Time sampled 噪声行', () => {
  const noisy = [
    { type: 'assistant/message', data: { turn: 3, message: { content: [{ type: 'text', text: 'ok' }] } } },
    { type: 'user/message', data: { message: { content: [{ type: 'text', text: 'Time sampled while preparing turn 3, step 1: ...' }] } } },
  ]
  assert.equal(firstUserMessageAfterTurn(noisy, 3), '')
})

console.log('')
console.log(`结果：通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exit(1)
