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

// 事件形状按真实 DSH v4 会话文件（复制自 ~/.dsh/sessions 只读探针）：
// 首事件 `type:"session"` 把 cwd 放顶层；用户消息是 `data.content`。
const events = [
  { type: 'session', version: 4, id: sessionId, createdAt: Date.now(), cwd, isSeeded: false, origin: 'local' },
  { type: 'turn/start', seq: 1, time: Date.now(), data: { turn: 1 } },
  { type: 'user/message', seq: 2, time: Date.now(), data: { content: [{ type: 'text', text: '给阅卷系统加导出' }], source: { kind: 'user' }, role: 'user', id: 'msg-1' } },
  { type: 'tool/call', seq: 3, time: Date.now(), data: { turn: 1, step: 1, callId: 'call-1', name: 'exp_record', arguments: JSON.stringify({ intent: '给阅卷系统加导出', action: '先做 CSV' }) } },
  { type: 'assistant/message', seq: 4, time: Date.now(), data: { turn: 1, message: { content: [{ type: 'text', text: '做好了，文件在 out.csv' }] } } },
  { type: 'turn/end', seq: 5, time: Date.now(), data: { turn: 1, reason: { kind: 'completed' } } },
  { type: 'user/message', seq: 6, time: Date.now(), data: { content: [{ type: 'text', text: '导出没有页码，改一下' }], source: { kind: 'user' }, role: 'user', id: 'msg-2' } },
  { type: 'turn/start', seq: 7, time: Date.now(), data: { turn: 2 } },
  { type: 'tool/call', seq: 8, time: Date.now(), data: { turn: 2, step: 1, callId: 'call-2', name: 'read', arguments: JSON.stringify({ file_path: 'a.md' }) } },
  { type: 'turn/end', seq: 9, time: Date.now(), data: { turn: 2, reason: { kind: 'completed' } } },
]
fs.writeFileSync(path.join(dir, 'session.v4.jsonl'), `${events.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8')

// 另一个工作区的会话，用来验证 cwd 过滤。
const otherDir = path.join(sessionsRoot, '--C-Users-other--', 'session-other')
fs.mkdirSync(otherDir, { recursive: true })
fs.writeFileSync(path.join(otherDir, 'session.v4.jsonl'), `${JSON.stringify({ type: 'session', version: 4, id: 'session-other', createdAt: Date.now(), cwd: otherCwd, origin: 'local' })}\n`, 'utf8')

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
    { type: 'user/message', data: { content: [{ type: 'text', text: 'Time sampled while preparing turn 3, step 1: ...' }] } },
  ]
  assert.equal(firstUserMessageAfterTurn(noisy, 3), '')
})

// —— task-7 回归：真实 DSH v4 会话形状（B1/B6）——
check('回归 B1：sessionCwd 读首事件顶层 cwd（真实 v4 形状）', () => {
  assert.equal(sessionCwd([{ type: 'session', version: 4, cwd: 'C:\\work\\a' }]), 'C:\\work\\a')
  // 旧夹具/旧版本 data.cwd 仍兼容
  assert.equal(sessionCwd([{ type: 'session', data: { cwd: 'C:\\work\\b' } }]), 'C:\\work\\b')
})

check('回归 B6：用户原话读 data.content（真实形状），data.message.content 兼容', () => {
  const realShaped = [
    { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'ok' }] } } },
    { type: 'user/message', data: { content: [{ type: 'text', text: '真实形状的用户原话' }], source: { kind: 'user' }, role: 'user', id: 'm1' } },
  ]
  assert.equal(firstUserMessageAfterTurn(realShaped, 1), '真实形状的用户原话')
  const legacy = [
    { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'ok' }] } } },
    { type: 'user/message', data: { message: { content: [{ type: 'text', text: '旧夹具原话' }] } } },
  ]
  assert.equal(firstUserMessageAfterTurn(legacy, 1), '旧夹具原话')
})

check('回归 B2：findRecordBinding 按 cwd 过滤，别的工作区后写不夺绑定', () => {
  // 同 intent/action 的 A、B 两个工作区会话，B 的 mtime 比 A 新 10s（> 5s 歧义阈值）。
  const leakRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-bind-'))
  const cwdA = path.join(leakRoot, 'work-a')
  const cwdB = path.join(leakRoot, 'work-b')
  const mkSession = (ws, id, workCwd, mtime) => {
    const sessionDir = path.join(leakRoot, ws, id)
    fs.mkdirSync(sessionDir, { recursive: true })
    const file = path.join(sessionDir, 'session.v4.jsonl')
    const sessionEvents = [
      { type: 'session', version: 4, id, cwd: workCwd, origin: 'local' },
      { type: 'user/message', data: { content: [{ type: 'text', text: '插一页过渡页' }], role: 'user' } },
      { type: 'tool/call', data: { turn: 2, name: 'exp_record', arguments: JSON.stringify({ intent: '插一页过渡页', action: '套模板' }) } },
    ]
    fs.writeFileSync(file, `${sessionEvents.map((event) => JSON.stringify(event)).join('\n')}\n`)
    fs.utimesSync(file, mtime, mtime)
  }
  mkSession('ws-a', 'session-A', cwdA, new Date(Date.now() - 60000))
  mkSession('ws-b', 'session-B', cwdB, new Date(Date.now() - 50000))
  const bindingA = findRecordBinding({ intent: '插一页过渡页', action: '套模板' }, { sessionsRoot: leakRoot, cwd: cwdA })
  assert.equal(bindingA && bindingA.sessionId, 'session-A', 'A 工作区只能绑 A 的会话')
  const bindingB = findRecordBinding({ intent: '插一页过渡页', action: '套模板' }, { sessionsRoot: leakRoot, cwd: cwdB })
  assert.equal(bindingB && bindingB.sessionId, 'session-B', 'B 工作区只能绑 B 的会话')
  fs.rmSync(leakRoot, { recursive: true, force: true })
})

check('回归 OBS-1：findRecordBinding 默认扫描窗口 ≥8，5 个会话外的记录也能绑到', () => {
  const wideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-scan8-'))
  const work = path.join(wideRoot, 'work')
  const mk = (id, withCall, mtime) => {
    const sessionDir = path.join(wideRoot, 'ws', id)
    fs.mkdirSync(sessionDir, { recursive: true })
    const file = path.join(sessionDir, 'session.v4.jsonl')
    const lines = [JSON.stringify({ type: 'session', version: 4, cwd: work, origin: 'local' })]
    if (withCall) lines.push(JSON.stringify({ type: 'tool/call', data: { turn: 1, name: 'exp_record', arguments: JSON.stringify({ intent: '深扫描意图', action: '深扫描做法' }) } }))
    fs.writeFileSync(file, lines.join('\n') + '\n')
    fs.utimesSync(file, mtime, mtime)
  }
  for (let index = 0; index < 4; index += 1) mk(`session-new-${index}`, false, new Date(Date.now() - index * 1000))
  mk('session-match', true, new Date(Date.now() - 60000))
  const binding = findRecordBinding({ intent: '深扫描意图', action: '深扫描做法' }, { sessionsRoot: wideRoot, cwd: work })
  assert.ok(binding !== null, '默认窗口应扫到第 5 个会话')
  assert.equal(binding.sessionId, 'session-match')
  fs.rmSync(wideRoot, { recursive: true, force: true })
})

console.log('')
console.log(`结果：通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exit(1)
