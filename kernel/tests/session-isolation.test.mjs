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
  const leaked = rankExperiences(store, '随便什么', 3, { recent: true, recentFailClosed: true, sessionId: '' })
  assert.deepEqual(leaked.recent, [], '认不出会话时不得带出别的会话记录')
  const ops = rankExperiences(store, '随便什么', 3, { recent: true, sessionId: '' })
  assert.ok((ops.recent || []).length > 0, 'UI/运维路径保留全量')
})
console.log('')
console.log(`结果：通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exit(1)
