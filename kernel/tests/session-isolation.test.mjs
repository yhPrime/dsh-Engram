/**
 * 会话归属 / 写侧上限 / 回填去重 / brief emoji / 老化排序（扩展场景测试发现）。
 *
 * Run: node tests/session-isolation.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { pendingBrief } from '../brief.js'
import { findActiveSession } from '../session.js'
import { pendingTasks, rankExperiences, resolveVerdicts, upsertExperience } from '../store.js'
import { readStore } from '../store.js'
import { buildTools } from '../tools.js'

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

const newStore = () => ({ version: 1, types: [], experiences: [] })

check('pending 按会话隔离：B 看不到 A 的待判定', () => {
  const store = newStore()
  const a = upsertExperience(store, { intent: '给研学课 PPT 插一页过渡页', action: '套模板', sessionId: 'sess-A', verdict: 'pending' }).experience
  const rowsB = store.experiences.filter((item) => item.verdict === 'pending' && item.sessionId === 'sess-B')
  assert.equal(rowsB.length, 0)
  assert.equal(store.experiences.find((item) => item.id === a.id).sessionId, 'sess-A')
})

check('回填按会话归属：B 结不了 A 的账', () => {
  const store = newStore()
  const a = upsertExperience(store, { intent: '给研学课 PPT 插一页过渡页', action: '套模板', sessionId: 'sess-A', verdict: 'pending' }).experience
  const denied = resolveVerdicts(store, [{ id: a.id, outcome: 'success' }], { sessionId: 'sess-B' })
  assert.equal(denied[0].ok, false)
  assert.match(denied[0].error, /不属于当前会话/)
  const allowed = resolveVerdicts(store, [{ id: a.id, outcome: 'success' }], { sessionId: 'sess-A' })
  assert.equal(allowed[0].ok, true)
})

check('回填列表重复 id 去重：只处理一次', () => {
  const store = newStore()
  const a = upsertExperience(store, { intent: '导出 PDF 中文字体方块', action: '嵌字体', sessionId: 'sess-A', verdict: 'pending' }).experience
  const results = resolveVerdicts(store, [
    { id: a.id, outcome: 'success' },
    { id: a.id, outcome: 'failed' },
  ], { sessionId: 'sess-A' })
  assert.equal(results.length, 1)
})

check('写侧上限：10 万字符 note / 1 万字符 intent 被截断', () => {
  const store = newStore()
  const row = upsertExperience(store, { intent: 'x'.repeat(10000), action: 'y'.repeat(10000), note: 'z'.repeat(100000) }).experience
  assert.ok(row.intent.length <= 500, String(row.intent.length))
  assert.ok(row.action.length <= 2000, String(row.action.length))
  assert.ok(row.note.length <= 2000, String(row.note.length))
})

check('brief 按码点截断：emoji 不产生孤立代理项', () => {
  const brief = pendingBrief({ intent: `过渡页${'😀'.repeat(30)}` }, { quote: `用户${'🎉'.repeat(30)}` })
  assert.doesNotMatch(brief, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
})

check('老化：180 天旧条不压当天新条', () => {
  const oldTs = new Date(Date.now() - 180 * 86400000).toISOString()
  const now = new Date().toISOString()
  const base = { outcome: 'success', G: 1, GOutcome: 1, verdict: 'decided', typeId: 'ty_other', typeName: '未分类', hits: 30 }
  const store = {
    version: 1,
    types: [{ id: 'ty_other', name: '未分类' }],
    experiences: [
      { ...base, id: 'ex_old', intent: '给研学课 PPT 插一页过渡页', action: '旧做法：克隆相邻页', ts: oldTs, lastSeenAt: oldTs },
      { ...base, id: 'ex_new', intent: '给研学课 PPT 插一页过渡页', action: '新做法：重排版式', ts: now, lastSeenAt: now },
    ],
  }
  const result = rankExperiences(store, '给研学课 PPT 插一页过渡页', 3)
  const first = result.candidates[0]
  const firstAction = first && first.evidence && first.evidence[0] ? first.evidence[0].action : ''
  assert.match(firstAction, /新做法/, `top1=${firstAction}`)
})

check('requireSession：认不出会话时回填一律拒绝', () => {
  const store = newStore()
  const a = upsertExperience(store, { intent: '导出 PDF', action: '嵌字体', sessionId: 'sess-A', verdict: 'pending' }).experience
  const denied = resolveVerdicts(store, [{ id: a.id, outcome: 'success' }], { requireSession: true })
  assert.equal(denied[0].ok, false)
  assert.match(denied[0].error, /无法确定会话/)
})

check('strict：认不出会话时不显示 pending', () => {
  const store = newStore()
  upsertExperience(store, { intent: '导出 PDF', action: '嵌字体', sessionId: 'sess-A', verdict: 'pending' })
  assert.equal(pendingTasks(store, 2, { strict: true }).rows.length, 0)
  assert.equal(pendingTasks(store, 2, { sessionId: 'sess-A', strict: true }).rows.length, 1)
})

check('findActiveSession：返回最近写入的会话', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-sess-'))
  const mk = (id, mtime) => {
    const dir = path.join(root, 'ws', `session-${id}`)
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'session.v4.jsonl.zstd')
    fs.writeFileSync(file, 'x')
    fs.utimesSync(file, mtime, mtime)
  }
  mk('older', new Date(Date.now() - 60000))
  mk('newer', new Date())
  assert.equal(findActiveSession({ sessionsRoot: root }).sessionId, 'session-newer')
})
check('recall note 按码点截断：emoji 不产生孤立代理项', () => {
  const now = new Date().toISOString()
  const store = {
    version: 1,
    types: [{ id: 'ty_other', name: '未分类' }],
    experiences: [{
      id: 'ex_emoji', intent: '给研学课 PPT 插页', action: '套模板', outcome: 'success',
      G: 1, GOutcome: 1, verdict: 'decided', typeId: 'ty_other', typeName: '未分类',
      hits: 3, ts: now, lastSeenAt: now, note: '😀'.repeat(400),
    }],
  }
  const result = rankExperiences(store, '给研学课 PPT 插页', 3)
  const note = result.candidates[0].evidence[0].note
  assert.doesNotMatch(note, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
})
check('findActiveSession：按 cwd 过滤，别的窗口后写不夺身份', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-sess-'))
  const mk = (ws, id, cwd, mtime) => {
    const dir = path.join(root, ws, id)
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'session.v4.jsonl')
    fs.writeFileSync(file, `${JSON.stringify({ type: 'session', version: 4, cwd })}\n`)
    fs.utimesSync(file, mtime, mtime)
  }
  const old = new Date(Date.now() - 60000)
  const now = new Date()
  mk('ws-a', 'session-A', path.join(root, 'work-a'), old)
  mk('ws-b', 'session-B', path.join(root, 'work-b'), now)
  assert.equal(findActiveSession({ sessionsRoot: root, cwd: path.join(root, 'work-a') }).sessionId, 'session-A')
  assert.equal(findActiveSession({ sessionsRoot: root, cwd: path.join(root, 'work-b') }).sessionId, 'session-B')
})

check('findActiveSession：裸 UUID 子会话目录也能识别', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-sub-'))
  const dir = path.join(root, 'ws', '55764309-e6eb-4934-87f3-cf515d1f1cdb')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl'), `${JSON.stringify({ type: 'session', version: 4, cwd: path.join(root, 'work-a'), origin: 'subagent' })}\n`)
  assert.equal(findActiveSession({ sessionsRoot: root, cwd: path.join(root, 'work-a') }).sessionId, '55764309-e6eb-4934-87f3-cf515d1f1cdb')
})

check('findActiveSession：优先含本次 exp_recall intent 的会话', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-intent-'))
  const mk = (id, lines, mtime) => {
    const dir = path.join(root, 'ws', id)
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'session.v4.jsonl')
    fs.writeFileSync(file, [`${JSON.stringify({ type: 'session', version: 4, cwd: path.join(root, 'work-a') })}`, ...lines.map((line) => JSON.stringify(line))].join('\n') + '\n')
    fs.utimesSync(file, mtime, mtime)
  }
  mk('session-other', [], new Date())
  mk('session-mine', [{ type: 'tool/call', data: { name: 'exp_recall', arguments: JSON.stringify({ intent: '给研学课 PPT 插页' }), turn: 3 } }], new Date(Date.now() - 60000))
  const active = findActiveSession({ sessionsRoot: root, cwd: path.join(root, 'work-a'), tool: 'exp_recall', intent: '给研学课 PPT 插页' })
  assert.equal(active.sessionId, 'session-mine')
})

check('recent 按会话过滤：不把别的会话的最近记录带出来', () => {
  const now = new Date().toISOString()
  const base = { outcome: 'success', G: 1, GOutcome: 1, verdict: 'decided', typeId: 'ty_other', typeName: '未分类', ts: now, lastSeenAt: now }
  const store = {
    version: 1,
    types: [{ id: 'ty_other', name: '未分类' }],
    experiences: [
      { ...base, id: 'ex_a', intent: 'A 的任务', action: 'A 做法', sessionId: 'sess-A' },
      { ...base, id: 'ex_b', intent: 'B 的任务', action: 'B 做法', sessionId: 'sess-B' },
    ],
  }
  const result = rankExperiences(store, '随便什么', 3, { recent: true, sessionId: 'sess-B' })
  assert.ok((result.recent || []).every((item) => item.id === 'ex_b'), JSON.stringify(result.recent))
})

// —— task-7 回归：真实宿主时序（tool/call 约 5s 才落盘）——
check('回归 B3：tool/call 未落盘时写行仍归属最近会话，不是孤儿 pending', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-b3-data-'))
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-b3-sess-'))
  const work = path.join(root, 'work')
  const dir = path.join(root, 'ws', 'session-b3')
  fs.mkdirSync(dir, { recursive: true })
  // 真实 v4 形状：首事件顶层 cwd；刻意没有任何 exp_record tool/call（模拟刷盘滞后）。
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl'), `${JSON.stringify({ type: 'session', version: 4, cwd: work, origin: 'local' })}\n`)
  const defineTool = (definition) => definition
  const tools = buildTools(defineTool, { dataDir, sessionsRoot: root, cwd: work })
  const record = tools.find((tool) => tool.name === 'exp_record')
  const out = record.execute({ intent: '给研学课 PPT 插一页过渡页', action: '套模板' })
  const row = readStore(dataDir).experiences.find((item) => item.id === out.id)
  assert.equal(row.sessionId, 'session-b3', 'binding 为 null 时也要写 fallback sessionId')
  // 下一轮同一会话能看到这条 pending（不是孤儿）。
  const recall = tools.find((tool) => tool.name === 'exp_recall')
  const recalled = recall.execute({ intent: '给研学课 PPT 插一页过渡页' })
  assert.ok((recalled.pending || []).some((item) => item.id === out.id), JSON.stringify(recalled.pending))
  fs.rmSync(dataDir, { recursive: true, force: true })
  fs.rmSync(root, { recursive: true, force: true })
})

check('回归 H4：三工作区并行，工具面各自按 config.cwd 归属（API 路径不串会话）', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-h4-data-'))
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-h4-sess-'))
  const works = ['work-a', 'work-b', 'work-c'].map((name) => path.join(root, name))
  const sessionIds = []
  works.forEach((work, index) => {
    const id = `session-h4-${index}`
    sessionIds.push(id)
    const sessionDir = path.join(root, `ws-${index}`, id)
    fs.mkdirSync(sessionDir, { recursive: true })
    const file = path.join(sessionDir, 'session.v4.jsonl')
    fs.writeFileSync(file, `${JSON.stringify({ type: 'session', version: 4, cwd: work, origin: 'local' })}\n`)
    fs.utimesSync(file, new Date(Date.now() - index * 1000), new Date(Date.now() - index * 1000))
  })
  const defineTool = (definition) => definition
  works.forEach((work, index) => {
    const tools = buildTools(defineTool, { dataDir, sessionsRoot: root, cwd: work })
    const record = tools.find((tool) => tool.name === 'exp_record')
    const out = record.execute({ intent: `H4 意图 ${index}`, action: `H4 做法 ${index}`, outcome: 'success' })
    const row = readStore(dataDir).experiences.find((item) => item.id === out.id)
    assert.equal(row.sessionId, sessionIds[index], `${work} 应归属 ${sessionIds[index]}`)
  })
  fs.rmSync(dataDir, { recursive: true, force: true })
  fs.rmSync(root, { recursive: true, force: true })
})

check('回归 B4：pending 上限按会话各自 ≤2，不推进别的会话的提醒计数', () => {
  const store = newStore()
  // 关掉近似合并，保证三条真是三条（默认阈值会把 a1/a2/a3 并成一条）。
  const noMerge = { mergeThreshold: 2, replaceThreshold: 2 }
  const a1 = upsertExperience(store, { intent: 'A1', action: 'a1', sessionId: 'sess-A', verdict: 'pending' }, noMerge).experience
  const a2 = upsertExperience(store, { intent: 'A2', action: 'a2', sessionId: 'sess-A', verdict: 'pending' }, noMerge).experience
  const a3 = upsertExperience(store, { intent: 'A3', action: 'a3', sessionId: 'sess-A', verdict: 'pending' }, noMerge).experience
  const b1 = upsertExperience(store, { intent: 'B1', action: 'b1', sessionId: 'sess-B', verdict: 'pending' }, noMerge).experience
  const own = pendingTasks(store, 2, { sessionId: 'sess-A' })
  assert.equal(own.rows.length, 2, '本会话最多 2 条')
  const aRows = store.experiences.filter((item) => item.sessionId === 'sess-A')
  assert.equal(aRows.filter((item) => Number(item.pendingReminders) > 0).length, 2, '只有展示的 2 条推进提醒')
  assert.equal(Number(store.experiences.find((item) => item.id === b1.id).pendingReminders) || 0, 0, '别的会话不能被推进')
  assert.ok(a1.id && a2.id && a3.id, '三条都在')
})

check('回归 BUG-5：recent 的 intent/action 按码点截断，不劈 emoji', () => {
  const now = new Date().toISOString()
  const base = { outcome: 'success', G: 1, GOutcome: 1, verdict: 'decided', typeId: 'ty_other', typeName: '未分类', ts: now, lastSeenAt: now }
  const store = {
    version: 1,
    types: [{ id: 'ty_other', name: '未分类' }],
    experiences: [{
      ...base,
      id: 'ex_emoji_recent',
      intent: `插页${'😀'.repeat(40)}`,
      action: `套模板${'🎉'.repeat(50)}`,
      sessionId: 'sess-A',
    }],
  }
  const result = rankExperiences(store, '插页', 3, { recent: true, sessionId: 'sess-A' })
  const entry = (result.recent || [])[0]
  assert.ok(entry !== undefined, JSON.stringify(result.recent))
  for (const text of [entry.intent, entry.action]) {
    assert.doesNotMatch(text, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
  }
})

check('回归 B7：宿主 exec.agent 提供 cwd/sessionId，不靠 config.cwd 也能归属本会话', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-b7-data-'))
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-b7-sess-'))
  const workA = path.join(root, 'work-a')
  const workB = path.join(root, 'work-b')
  const mk = (ws, id, workCwd, mtime) => {
    const sessionDir = path.join(root, ws, id)
    fs.mkdirSync(sessionDir, { recursive: true })
    const file = path.join(sessionDir, 'session.v4.jsonl')
    fs.writeFileSync(file, `${JSON.stringify({ type: 'session', version: 4, cwd: workCwd, origin: 'local' })}\n`)
    fs.utimesSync(file, mtime, mtime)
  }
  mk('ws-a', 'session-A', workA, new Date(Date.now() - 60000))
  mk('ws-b', 'session-B', workB, new Date())
  const defineTool = (definition) => definition
  // 刻意不传 config.cwd / sessionsRoot：只能靠宿主执行上下文。
  const tools = buildTools(defineTool, { dataDir })
  const record = tools.find((tool) => tool.name === 'exp_record')
  const execA = { agent: { id: 'session-A', session: { id: 'session-A', header: { cwd: workA } } } }
  const out = record.execute({ intent: '给研学课 PPT 插一页过渡页', action: '套模板', outcome: 'success' }, execA)
  const row = readStore(dataDir).experiences.find((item) => item.id === out.id)
  assert.equal(row.sessionId, 'session-A', '必须用宿主给的 sessionId，不能绑到后写的 B')
  assert.equal(row.cwd, workA, '必须用宿主给的 cwd')
  fs.rmSync(dataDir, { recursive: true, force: true })
  fs.rmSync(root, { recursive: true, force: true })
})

check('回归 B5：flush 窗口内子会话不顶替父会话（优先 exp_* intent 匹配，tie 优先非 subagent）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-b5-sess-'))
  const work = path.join(root, 'work')
  const intent = '给研学课 PPT 插一页过渡页'
  const call = { type: 'tool/call', data: { turn: 2, name: 'exp_recall', arguments: JSON.stringify({ intent }) } }
  const mk = (id, origin, mtime) => {
    const sessionDir = path.join(root, 'ws', id)
    fs.mkdirSync(sessionDir, { recursive: true })
    const file = path.join(sessionDir, 'session.v4.jsonl')
    fs.writeFileSync(file, [
      JSON.stringify({ type: 'session', version: 4, cwd: work, origin }),
      JSON.stringify(call),
    ].join('\n') + '\n')
    fs.utimesSync(file, mtime, mtime)
  }
  mk('session-parent', 'local', new Date(Date.now() - 60000))
  mk('11111111-2222-4333-8444-555555555555', 'subagent', new Date())
  const active = findActiveSession({ sessionsRoot: root, cwd: work, tool: 'exp_record', intent })
  assert.equal(active.sessionId, 'session-parent', '父会话应保持身份，不能被后写的子会话顶替')
  fs.rmSync(root, { recursive: true, force: true })
})

check('回归：工具路径认不出会话时 recent 为空（fail-closed），默认路径保留全量', () => {
  const now = new Date().toISOString()
  const base = { outcome: 'success', G: 1, GOutcome: 1, verdict: 'decided', typeId: 'ty_other', typeName: '未分类', ts: now, lastSeenAt: now }
  const store = {
    version: 1,
    types: [{ id: 'ty_other', name: '未分类' }],
    experiences: [
      { ...base, id: 'ex_a', intent: 'A 的任务', action: 'A 做法', sessionId: 'sess-A' },
      { ...base, id: 'ex_b', intent: 'B 的任务', action: 'B 做法', sessionId: 'sess-B' },
    ],
  }
  const leaked = rankExperiences(store, '随便什么', 3, { recent: true, sessionId: '' })
  assert.deepEqual(leaked.recent, [], '认不出会话时最近记录默认 fail-closed（审计 E2）')
  const ops = rankExperiences(store, '随便什么', 3, { recent: true, recentAllSessions: true, sessionId: '' })
  assert.ok((ops.recent || []).length > 0, '显式 recentAllSessions=true 的 UI/运维路径保留全量')
})
console.log('')
console.log(`结果：通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exit(1)
