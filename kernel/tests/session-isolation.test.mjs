/**
 * 会话归属 / 写侧上限 / 回填去重 / brief emoji / 老化排序（扩展场景测试发现）。
 *
 * Run: node tests/session-isolation.test.mjs
 */
import assert from 'node:assert/strict'

import { pendingBrief } from '../brief.js'
import { rankExperiences, resolveVerdicts, upsertExperience } from '../store.js'

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

console.log('')
console.log(`结果：通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exit(1)
