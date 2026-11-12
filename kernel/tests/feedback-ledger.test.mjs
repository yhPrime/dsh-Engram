/**
 * 反馈台账测试（0.14.0）
 *  - 每次反馈写一条 history: feedback；
 *  - 20 条重放窗口裁剪时写 feedback-trimmed（dropped + byResult），能对上终身计数；
 *  - 终身计数（feedback.hurt 等）与窗口（feedback.window / feedback_log.length）分开；
 *  - 证据里带 window，模型知道「计数是终身、窗口是最近」。
 * Run: node tests/feedback-ledger.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { FEEDBACK_LOG_LIMIT, applyFeedback, readStore, upsertExperience } from '../store.js'
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

const newDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'exp-ledger-'))
const newAgent = () => {
  const dir = newDir()
  const tools = buildTools((definition) => definition, { dataDir: dir })
  const call = (name, args) => tools.find((item) => item.name === name).execute(args)
  return {
    dir,
    record: (input) => call('exp_record', input),
    recall: (intent) => call('exp_recall', { intent }),
    feedback: (id, result) => call('exp_feedback', { id, result }),
  }
}

check('反馈不写 history（feedback_log 已是同一事实）', () => {
  const store = readStore(newDir())
  const row = upsertExperience(store, { intent: '改 PPT 页码', action: '重算物理页序', outcome: 'success', type: 'PPT / 课件' }).experience
  applyFeedback(store, row.id, { result: 'helped' })
  applyFeedback(store, row.id, { result: 'hurt' })
  const events = (row.history || []).filter((event) => event.type === 'feedback')
  assert.equal(events.length, 0, '反馈不应再往 history 塞重复事件')
  assert.equal(row.feedback_log.length, 2)
})

check('裁剪写 feedbackTrimmed：累计 dropped + byResult，能和终身计数对上', () => {
  const store = readStore(newDir())
  const row = upsertExperience(store, { intent: '改 PPT 页码', action: '重算物理页序', outcome: 'success', type: 'PPT / 课件' }).experience
  for (let i = 0; i < FEEDBACK_LOG_LIMIT + 5; i += 1) applyFeedback(store, row.id, { result: 'hurt' })
  const summary = row.feedbackTrimmed
  assert.ok(summary, '应写裁剪累计')
  assert.equal(summary.dropped, FEEDBACK_LOG_LIMIT + 5 - row.feedback_log.length)
  const dropped = summary.dropped
  assert.equal(row.feedback.hurt, FEEDBACK_LOG_LIMIT + 5)
  assert.ok(dropped >= 5)
})

check('终身计数与窗口分开：hurt=25、window=20，G 只按窗口重放', () => {
  const agent = newAgent()
  const made = agent.record({ intent: '改 PPT 页码', action: '重算物理页序', outcome: 'success', type: 'PPT / 课件' })
  for (let i = 0; i < 25; i += 1) agent.feedback(made.id, 'hurt')
  const recalled = agent.recall('改 PPT 页码')
  const evidence = recalled.candidates.flatMap((candidate) => candidate.evidence).find((item) => item.id === made.id)
  assert.equal(evidence.feedback.hurt, 25)
  assert.equal(evidence.feedback.window, 20)
})

check('neutral 洪水裁掉的是 neutral，不动 hurt 事件', () => {
  const store = readStore(newDir())
  const row = upsertExperience(store, { intent: '改 PPT 页码', action: '重算物理页序', outcome: 'success', type: 'PPT / 课件' }).experience
  for (let i = 0; i < FEEDBACK_LOG_LIMIT; i += 1) applyFeedback(store, row.id, { result: 'hurt' })
  const gBefore = row.G
  for (let i = 0; i < FEEDBACK_LOG_LIMIT; i += 1) applyFeedback(store, row.id, { result: 'neutral' })
  assert.equal(row.G, gBefore, 'neutral 不参与重放')
  const trimmed = row.feedbackTrimmed
  assert.ok(trimmed && trimmed.byResult.neutral >= 1, '被裁的应是 neutral')
  assert.ok(!trimmed.byResult.hurt, 'hurt 不应被裁')
  assert.equal(row.feedback.hurt, FEEDBACK_LOG_LIMIT)
  assert.equal(row.feedback.neutral, FEEDBACK_LOG_LIMIT)
})

check('反馈不占 history：60 次反馈后历史仍为空', () => {
  const store = readStore(newDir())
  const row = upsertExperience(store, { intent: '查论文', action: '先读摘要', outcome: 'success', type: '调研 / 资料' }).experience
  for (let i = 0; i < 60; i += 1) applyFeedback(store, row.id, { result: 'neutral' })
  assert.equal((row.history || []).length, 0)
  assert.equal(row.feedback.neutral, 60)
})

check('brief 标清终身计数与重放窗口', () => {
  const agent = newAgent()
  const made = agent.record({ intent: '改 PPT 页码', action: '重算物理页序', outcome: 'success', type: 'PPT / 课件' })
  agent.feedback(made.id, 'helped')
  agent.feedback(made.id, 'hurt')
  const recalled = agent.recall('改 PPT 页码')
  assert.ok(typeof recalled.brief === 'string')
  assert.ok(recalled.brief.includes('终身'), recalled.brief)
  assert.ok(recalled.brief.includes('窗口'), recalled.brief)
})

console.log('')
console.log(`结果：通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exit(1)
