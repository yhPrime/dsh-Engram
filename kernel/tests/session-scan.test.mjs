/**
 * 会话读取（0.13.0）：按 cwd 找会话、取 turn 后第一条用户消息、抽 tool/call 绑定。
 *
 * Run: node tests/session-scan.test.mjs
 */
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import {
  clearSessionCache,
  findActiveSession,
  findRecordBinding,
  firstUserMessageAfterTurn,
  listSessionFiles,
  readSessionEvents,
  readSessionHead,
  resetSessionScanStats,
  sessionCwd,
  sessionScanCacheEnabled,
  sessionScanStats,
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

// —— task-8：session 扫描缓存 ——
const zstdFrame = (event) => zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(event)}\n`, 'utf8'))

/** 写一个真实形状的多帧 zstd 会话文件（每行一帧，与宿主一致）。 */
function writeZstdSession(root, workspace, id, cwdValue, eventList) {
  const sessionDir = path.join(root, workspace, id)
  fs.mkdirSync(sessionDir, { recursive: true })
  const file = path.join(sessionDir, 'session.v4.jsonl.zstd')
  fs.writeFileSync(file, Buffer.concat(eventList.map(zstdFrame)))
  return file
}

/** 缓存开/关跑同一段逻辑：两边都先清缓存，结果按字段比对。返回 [开缓存结果, 关缓存结果]。 */
function bothModes(fn) {
  const previous = process.env.ENGRAM_SESSION_SCAN_CACHE
  clearSessionCache()
  const on = fn()
  process.env.ENGRAM_SESSION_SCAN_CACHE = 'off'
  try {
    clearSessionCache()
    const off = fn()
    return [on, off]
  } finally {
    if (previous === undefined) delete process.env.ENGRAM_SESSION_SCAN_CACHE
    else process.env.ENGRAM_SESSION_SCAN_CACHE = previous
    clearSessionCache()
  }
}

const task8Root = () => fs.mkdtempSync(path.join(os.tmpdir(), 'engram-scan-cache-'))

function baseEvents(id, cwdValue, toolCall) {
  const events = [
    { type: 'session', version: 4, id, cwd: cwdValue, origin: 'local' },
    { type: 'user/message', data: { content: [{ type: 'text', text: `原话 ${id}` }], role: 'user' } },
    { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'ok' }] } } },
  ]
  if (toolCall !== undefined) {
    events.push({ type: 'tool/call', data: { turn: 1, name: 'exp_record', arguments: JSON.stringify(toolCall) } })
  }
  return events
}

check('task-8 开关：默认开，ENGRAM_SESSION_SCAN_CACHE=off 关', () => {
  const previous = process.env.ENGRAM_SESSION_SCAN_CACHE
  try {
    delete process.env.ENGRAM_SESSION_SCAN_CACHE
    assert.equal(sessionScanCacheEnabled(), true)
    process.env.ENGRAM_SESSION_SCAN_CACHE = 'off'
    assert.equal(sessionScanCacheEnabled(), false)
    process.env.ENGRAM_SESSION_SCAN_CACHE = 'OFF'
    assert.equal(sessionScanCacheEnabled(), false)
  } finally {
    if (previous === undefined) delete process.env.ENGRAM_SESSION_SCAN_CACHE
    else process.env.ENGRAM_SESSION_SCAN_CACHE = previous
  }
})

check('task-8 缓存开/关：binding / activeSession / userMessage / list 结果逐字段一致', () => {
  const root = task8Root()
  const work = path.join(root, 'work-space')
  writeZstdSession(root, 'ws', 'session-x', work, [
    { type: 'session', version: 4, id: 'session-x', cwd: work, origin: 'local' },
    { type: 'user/message', data: { content: [{ type: 'text', text: '把导出加个页码' }], role: 'user' } },
    { type: 'tool/call', data: { turn: 2, name: 'exp_record', arguments: JSON.stringify({ intent: '给导出加页码', action: '先量页边距' }) } },
  ])
  writeZstdSession(root, 'ws', 'session-y', path.join(root, 'other-work'), baseEvents('session-y', path.join(root, 'other-work')))
  const collect = () => ({
    binding: findRecordBinding({ intent: '给导出加页码', action: '先量页边距' }, { sessionsRoot: root, cwd: work }),
    active: findActiveSession({ sessionsRoot: root, cwd: work, tool: 'exp_record', intent: '给导出加页码' }),
    user: userMessageForRecord({ sessionId: 'session-x', turn: 2 }, { sessionsRoot: root }),
    list: listSessionFiles({ sessionsRoot: root }).map((item) => ({ sessionId: item.sessionId, workspace: item.workspace, file: item.file })),
  })
  const [on, off] = bothModes(collect)
  assert.deepEqual(on, off, '缓存开/关的结果必须逐字段一致')
  assert.ok(on.binding !== null && on.active !== null)
})

check('task-8 正确性红线：缓存热了以后，新建会话文件仍能被发现', () => {
  const root = task8Root()
  const work = path.join(root, 'work-space')
  writeZstdSession(root, 'ws', 'session-old', work, baseEvents('session-old', work))
  // 先扫一遍把目录树/事件缓存热起来
  clearSessionCache()
  assert.equal(findActiveSession({ sessionsRoot: root, cwd: work, tool: 'exp_record', intent: '新会话意图' }) !== null, true)
  // 再新建一个会话目录 + 文件（workspace mtime 变 → 目录树缓存必须失效）
  const newFile = writeZstdSession(root, 'ws', 'session-new', work, baseEvents('session-new', work, { intent: '新会话意图', action: '新做法' }))
  const future = new Date(Date.now() + 2000)
  fs.utimesSync(newFile, future, future)
  const active = findActiveSession({ sessionsRoot: root, cwd: work, tool: 'exp_record', intent: '新会话意图' })
  assert.equal(active && active.sessionId, 'session-new', '新会话文件必须能被发现（正确性红线）')
  const binding = findRecordBinding({ intent: '新会话意图', action: '新做法' }, { sessionsRoot: root, cwd: work })
  assert.equal(binding && binding.sessionId, 'session-new')
  assert.equal(binding && binding.turn, 1)
  fs.rmSync(root, { recursive: true, force: true })
})

check('task-8 正确性红线：已有会话追加写入（mtime/size 变）后能看到新 tool/call', () => {
  const root = task8Root()
  const work = path.join(root, 'work-space')
  const file = writeZstdSession(root, 'ws', 'session-append', work, baseEvents('session-append', work))
  clearSessionCache()
  assert.equal(findRecordBinding({ intent: '追加意图', action: '追加做法' }, { sessionsRoot: root, cwd: work }), null)
  fs.appendFileSync(file, zstdFrame({ type: 'tool/call', data: { turn: 3, name: 'exp_record', arguments: JSON.stringify({ intent: '追加意图', action: '追加做法' }) } }))
  const future = new Date(Date.now() + 2000)
  fs.utimesSync(file, future, future)
  const binding = findRecordBinding({ intent: '追加意图', action: '追加做法' }, { sessionsRoot: root, cwd: work })
  assert.ok(binding !== null, '追加写入后的事件缓存必须失效并重读')
  assert.equal(binding.sessionId, 'session-append')
  assert.equal(binding.turn, 3)
  fs.rmSync(root, { recursive: true, force: true })
})

check('task-8 扫描预算：只扫最近 N 个；预算内没命中就回退全扫并标注 scanLimited', () => {
  const root = task8Root()
  const work = path.join(root, 'work-space')
  // 最新 4 个会话没有匹配；匹配在最旧的那个
  for (let index = 0; index < 4; index += 1) {
    const file = writeZstdSession(root, 'ws', `session-new-${index}`, work, baseEvents(`session-new-${index}`, work))
    fs.utimesSync(file, new Date(Date.now() - index * 1000), new Date(Date.now() - index * 1000))
  }
  const oldFile = writeZstdSession(root, 'ws', 'session-old', work, baseEvents('session-old', work, { intent: '深意图', action: '深做法' }))
  fs.utimesSync(oldFile, new Date(Date.now() - 60000), new Date(Date.now() - 60000))
  const run = () => findActiveSession({ sessionsRoot: root, cwd: work, tool: 'exp_record', intent: '深意图', scanBudget: 2 })
  const previous = process.env.ENGRAM_SESSION_SCAN_CACHE
  try {
    delete process.env.ENGRAM_SESSION_SCAN_CACHE
    clearSessionCache()
    resetSessionScanStats()
    const limited = run()
    const stats = sessionScanStats()
    assert.ok(limited !== null)
    assert.equal(limited.sessionId, 'session-old', '预算内没命中必须回退全扫')
    assert.equal(limited.scanLimited, true, '回退全扫必须标注 scanLimited')
    assert.ok(stats.budgetScans >= 1 && stats.budgetFallbacks >= 1)
    // 与关缓存的结果逐字段一致（scanLimited 是新增的标注字段，单独比）
    process.env.ENGRAM_SESSION_SCAN_CACHE = 'off'
    clearSessionCache()
    const full = run()
    assert.deepEqual({ ...limited, scanLimited: undefined }, { ...full, scanLimited: undefined })
  } finally {
    if (previous === undefined) delete process.env.ENGRAM_SESSION_SCAN_CACHE
    else process.env.ENGRAM_SESSION_SCAN_CACHE = previous
    clearSessionCache()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

check('task-8 首帧读：cwd 只解第一帧（不整包解压），首帧被截断时回退全读', () => {
  const root = task8Root()
  const work = path.join(root, 'work-space')
  // 大文件：头部帧小，后面跟 10 个 ~30KB 的不可压缩事件帧（base64 随机，压不动 → 文件 >128KB）
  const bigEvents = [{ type: 'session', version: 4, id: 'session-big', cwd: work, origin: 'local' }]
  for (let index = 0; index < 10; index += 1) {
    bigEvents.push({ type: 'user/message', data: { content: [{ type: 'text', text: crypto.randomBytes(30000).toString('base64') }], role: 'user' } })
  }
  const bigFile = writeZstdSession(root, 'ws', 'session-big', work, bigEvents)
  assert.ok(fs.statSync(bigFile).size > 128 * 1024, `夹具文件必须 >128KB，实际 ${fs.statSync(bigFile).size}`)
  clearSessionCache()
  resetSessionScanStats()
  const head = readSessionHead(bigFile)
  const stats = sessionScanStats()
  assert.equal(sessionCwd(head), work, '首帧里就有 session 头，cwd 必须取到')
  assert.ok(stats.headBytes <= 128 * 1024, `首帧读必须 ≤128KB，实际 ${stats.headBytes}`)
  assert.ok(stats.headBytes < fs.statSync(bigFile).size, `大文件不该整包读：head=${stats.headBytes} size=${fs.statSync(bigFile).size}`)
  // 首帧自己就大于 128KB：截断后解不出来 → 必须回退全读，结果仍然正确
  const hugeHeader = [{ type: 'session', version: 4, id: 'session-huge', cwd: work, origin: 'local', padding: crypto.randomBytes(250000).toString('hex') }]
  const hugeFile = writeZstdSession(root, 'ws', 'session-huge', work, hugeHeader)
  clearSessionCache()
  const fallback = readSessionHead(hugeFile)
  assert.equal(sessionCwd(fallback), work, '首帧截断时必须回退全读并取到 cwd')
  fs.rmSync(root, { recursive: true, force: true })
})

check('task-8 缓存命中计数：第二次检索不再解压（索引缓存）；关缓存时逐次都读', () => {
  const root = task8Root()
  const work = path.join(root, 'work-space')
  for (let index = 0; index < 3; index += 1) {
    writeZstdSession(root, 'ws', `session-${index}`, work, baseEvents(`session-${index}`, work, index === 0 ? { intent: '计数意图', action: '计数做法' } : undefined))
  }
  const run = () => findRecordBinding({ intent: '计数意图', action: '计数做法' }, { sessionsRoot: root, cwd: work })
  const previous = process.env.ENGRAM_SESSION_SCAN_CACHE
  try {
    delete process.env.ENGRAM_SESSION_SCAN_CACHE
    clearSessionCache()
    resetSessionScanStats()
    assert.ok(run() !== null)
    const first = sessionScanStats()
    assert.ok(run() !== null)
    const second = sessionScanStats()
    assert.ok(first.contentReads >= 1, '首跑必须整读会话文件')
    assert.equal(second.contentReads - first.contentReads, 0, `索引缓存命中后不该再整读会话文件，实际多读 ${second.contentReads - first.contentReads}`)
    assert.ok(second.indexHits - first.indexHits >= 1, '第二次必须命中索引缓存')
    assert.ok(second.treeHits - first.treeHits >= 1, '第二次必须命中目录树缓存')
    process.env.ENGRAM_SESSION_SCAN_CACHE = 'off'
    clearSessionCache()
    resetSessionScanStats()
    run()
    const offFirst = sessionScanStats()
    run()
    const offSecond = sessionScanStats()
    assert.ok(offSecond.contentReads - offFirst.contentReads > 0, '关缓存时每次都要整读')
    assert.equal(offSecond.indexHits, 0)
    assert.equal(offSecond.treeHits, 0)
  } finally {
    if (previous === undefined) delete process.env.ENGRAM_SESSION_SCAN_CACHE
    else process.env.ENGRAM_SESSION_SCAN_CACHE = previous
    clearSessionCache()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// —— task-10：索引持久化 ——
const indexFileOf = (dataDir) => path.join(dataDir, '.cache', 'sessions.idx.json')
const timeIt = (fn) => {
  const t0 = process.hrtime.bigint()
  const value = fn()
  return [Number(process.hrtime.bigint() - t0) / 1e6, value]
}

function withTask10Root(count, matcher) {
  const root = task8Root()
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-idx-'))
  const work = path.join(root, 'work-space')
  for (let index = 0; index < count; index += 1) {
    writeZstdSession(root, 'ws', `session-${String(index).padStart(3, '0')}`, work, baseEvents(
      `session-${String(index).padStart(3, '0')}`,
      work,
      matcher(index, count) ? { intent: '索引意图', action: '索引做法' } : undefined,
    ))
  }
  return { root, dataDir, work }
}

/** 带匹配 tool/call 的会话必须是**最新**那个（findRecordBinding 只扫最近 8 个）。 */
const newestMatch = (index, count) => index === count - 1

check('task-10 持久化：写盘 → 清内存（模拟重启）→ 首调 ≤200ms 且不再整读会话', () => {
  const { root, dataDir, work } = withTask10Root(120, newestMatch)
  const previous = process.env.ENGRAM_SESSION_SCAN_CACHE
  try {
    delete process.env.ENGRAM_SESSION_SCAN_CACHE
    clearSessionCache()
    resetSessionScanStats()
    const first = findRecordBinding({ intent: '索引意图', action: '索引做法' }, { sessionsRoot: root, cwd: work, dataDir })
    assert.ok(first !== null)
    assert.ok(fs.existsSync(indexFileOf(dataDir)), '索引必须落盘到 <dataDir>/.cache/sessions.idx.json')
    const saved = JSON.parse(fs.readFileSync(indexFileOf(dataDir), 'utf8'))
    assert.equal(saved.version, 1)
    assert.equal(saved.root, path.resolve(root))
    // 模拟进程重启：清内存缓存（含文件状态）
    clearSessionCache()
    resetSessionScanStats()
    const [ms, second] = timeIt(() => findRecordBinding({ intent: '索引意图', action: '索引做法' }, { sessionsRoot: root, cwd: work, dataDir }))
    const stats = sessionScanStats()
    console.log(`       重启后首调 ${ms.toFixed(1)}ms，整读 ${stats.contentReads} 文件，head ${(stats.headBytes / 1024).toFixed(0)}KB`)
    assert.equal(second && second.sessionId, first.sessionId)
    assert.equal(stats.contentReads, 0, '命中磁盘索引时不该整读任何会话文件')
    assert.ok(ms <= 200, `重启后首调应 ≤200ms，实际 ${ms.toFixed(1)}ms`)
  } finally {
    if (previous === undefined) delete process.env.ENGRAM_SESSION_SCAN_CACHE
    else process.env.ENGRAM_SESSION_SCAN_CACHE = previous
    clearSessionCache()
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

check('task-10 索引损坏 / 版本不符：静默重建，结果正确且回写合法文件', () => {
  const { root, dataDir, work } = withTask10Root(12, newestMatch)
  const previous = process.env.ENGRAM_SESSION_SCAN_CACHE
  try {
    delete process.env.ENGRAM_SESSION_SCAN_CACHE
    const run = () => findRecordBinding({ intent: '索引意图', action: '索引做法' }, { sessionsRoot: root, cwd: work, dataDir })
    clearSessionCache(); resetSessionScanStats()
    assert.ok(run() !== null)
    assert.ok(fs.existsSync(indexFileOf(dataDir)))
    for (const broken of ['{ 这不是 JSON', JSON.stringify({ version: 999, root: path.resolve(root), entries: {} })]) {
      fs.writeFileSync(indexFileOf(dataDir), broken, 'utf8')
      clearSessionCache(); resetSessionScanStats()
      const out = run()
      assert.ok(out !== null, '索引坏了也必须自动重建并给出正确结果')
      const saved = JSON.parse(fs.readFileSync(indexFileOf(dataDir), 'utf8'))
      assert.equal(saved.version, 1, '重建后必须回写当前版本的索引')
    }
  } finally {
    if (previous === undefined) delete process.env.ENGRAM_SESSION_SCAN_CACHE
    else process.env.ENGRAM_SESSION_SCAN_CACHE = previous
    clearSessionCache()
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

check('task-10 不一致条目只重建那一个会话（其它条目走磁盘索引）', () => {
  const { root, dataDir, work } = withTask10Root(30, () => false)
  const previous = process.env.ENGRAM_SESSION_SCAN_CACHE
  try {
    delete process.env.ENGRAM_SESSION_SCAN_CACHE
    clearSessionCache(); resetSessionScanStats()
    // 先建索引（此时还没有匹配项）
    assert.equal(findRecordBinding({ intent: '追加索引意图', action: '追加索引做法' }, { sessionsRoot: root, cwd: work, dataDir }), null)
    const file = path.join(root, 'ws', 'session-000', 'session.v4.jsonl.zstd')
    fs.appendFileSync(file, zstdFrame({ type: 'tool/call', data: { turn: 2, name: 'exp_record', arguments: JSON.stringify({ intent: '追加索引意图', action: '追加索引做法' }) } }))
    const future = new Date(Date.now() + 2000)
    fs.utimesSync(file, future, future)
    clearSessionCache(); resetSessionScanStats()
    const binding = findRecordBinding({ intent: '追加索引意图', action: '追加索引做法' }, { sessionsRoot: root, cwd: work, dataDir })
    const stats = sessionScanStats()
    assert.equal(binding && binding.sessionId, 'session-000')
    assert.equal(stats.contentReads, 1, `只该整读被改的那一个会话文件，实际 ${stats.contentReads}`)
  } finally {
    if (previous === undefined) delete process.env.ENGRAM_SESSION_SCAN_CACHE
    else process.env.ENGRAM_SESSION_SCAN_CACHE = previous
    clearSessionCache()
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

check('task-10 开关关闭：不读也不写磁盘索引', () => {
  const { root, dataDir, work } = withTask10Root(8, newestMatch)
  const previous = process.env.ENGRAM_SESSION_SCAN_CACHE
  try {
    process.env.ENGRAM_SESSION_SCAN_CACHE = 'off'
    clearSessionCache(); resetSessionScanStats()
    const out = findRecordBinding({ intent: '索引意图', action: '索引做法' }, { sessionsRoot: root, cwd: work, dataDir })
    assert.ok(out !== null)
    assert.equal(fs.existsSync(indexFileOf(dataDir)), false, '关缓存时不能写磁盘索引')
  } finally {
    if (previous === undefined) delete process.env.ENGRAM_SESSION_SCAN_CACHE
    else process.env.ENGRAM_SESSION_SCAN_CACHE = previous
    clearSessionCache()
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

check('task-10 索引 30 天过期 → 忽略并重建；.gitignore 写入 .cache/ 与 .locks/', () => {
  const { root, dataDir, work } = withTask10Root(6, newestMatch)
  const previous = process.env.ENGRAM_SESSION_SCAN_CACHE
  try {
    delete process.env.ENGRAM_SESSION_SCAN_CACHE
    // 假装是 git 仓：保存索引时要把本地目录写进 .gitignore
    fs.mkdirSync(path.join(dataDir, '.git'), { recursive: true })
    clearSessionCache(); resetSessionScanStats()
    assert.ok(findRecordBinding({ intent: '索引意图', action: '索引做法' }, { sessionsRoot: root, cwd: work, dataDir }) !== null)
    const ignore = fs.readFileSync(path.join(dataDir, '.gitignore'), 'utf8')
    assert.ok(ignore.includes('.cache/'), '.gitignore 必须包含 .cache/')
    assert.ok(ignore.includes('.locks/'), '.gitignore 必须包含 .locks/')
    // 把 savedAt 改成 40 天前 → 应忽略并重建
    const saved = JSON.parse(fs.readFileSync(indexFileOf(dataDir), 'utf8'))
    saved.savedAt = new Date(Date.now() - 40 * 86400000).toISOString()
    fs.writeFileSync(indexFileOf(dataDir), JSON.stringify(saved), 'utf8')
    clearSessionCache(); resetSessionScanStats()
    assert.ok(findRecordBinding({ intent: '索引意图', action: '索引做法' }, { sessionsRoot: root, cwd: work, dataDir }) !== null)
    const refreshed = JSON.parse(fs.readFileSync(indexFileOf(dataDir), 'utf8'))
    assert.ok(Date.now() - Date.parse(refreshed.savedAt) < 60 * 60 * 1000, '过期索引应被重建并刷新 savedAt')
  } finally {
    if (previous === undefined) delete process.env.ENGRAM_SESSION_SCAN_CACHE
    else process.env.ENGRAM_SESSION_SCAN_CACHE = previous
    clearSessionCache()
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

check('task-10 activeSession 同样走磁盘索引：重启后首调 ≤200ms', () => {
  const { root, dataDir, work } = withTask10Root(60, newestMatch)
  const previous = process.env.ENGRAM_SESSION_SCAN_CACHE
  try {
    delete process.env.ENGRAM_SESSION_SCAN_CACHE
    const options = { sessionsRoot: root, cwd: work, tool: 'exp_record', intent: '索引意图', dataDir }
    clearSessionCache(); resetSessionScanStats()
    const first = findActiveSession(options)
    assert.ok(first !== null)
    assert.ok(fs.existsSync(indexFileOf(dataDir)))
    clearSessionCache(); resetSessionScanStats()
    const [ms, second] = timeIt(() => findActiveSession(options))
    const stats = sessionScanStats()
    console.log(`       activeSession 重启后首调 ${ms.toFixed(1)}ms，整读 ${stats.contentReads} 文件`)
    assert.equal(second && second.sessionId, first.sessionId)
    assert.equal(stats.contentReads, 0, '命中磁盘索引时不该整读会话文件')
    assert.ok(ms <= 200, `activeSession 重启后首调应 ≤200ms，实际 ${ms.toFixed(1)}ms`)
  } finally {
    if (previous === undefined) delete process.env.ENGRAM_SESSION_SCAN_CACHE
    else process.env.ENGRAM_SESSION_SCAN_CACHE = previous
    clearSessionCache()
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

console.log('')
console.log(`结果：通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exit(1)
