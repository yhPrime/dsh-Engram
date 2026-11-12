/**
 * 反馈时间衰减测试（0.12.0）
 *  - 写入时把超窗（默认 30 天）事件折叠进 GOutcome，读时绝不折叠；
 *  - 折叠后日志只留窗口内事件，终身计数保留；
 *  - decayDays=0 关闭；重记时先折叠再换新基准（旧教训不无限期压着）。
 * Run: node tests/feedback-decay.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  DEFAULT_FEEDBACK_DECAY_DAYS,
  applyFeedback,
  readStore,
  replayFeedback,
  upsertExperience,
  writeStore,
} from '../store.js'

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

const DAY = 86400000
const newDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'exp-decay-'))

check('超窗事件在写入时折叠进 GOutcome，日志只留窗口内事件', () => {
  const store = readStore(newDir())
  const row = upsertExperience(store, { intent: '改 PPT 页码', action: '重算物理页序', outcome: 'success', type: 'PPT / 课件' }).experience
  const now = Date.now()
  applyFeedback(store, row.id, { result: 'hurt' }, { now: now - 31 * DAY })
  applyFeedback(store, row.id, { result: 'helped' }, { now: now - 1 * DAY })
  const before = row.feedback_log.length
  assert.equal(before, 2)
  applyFeedback(store, row.id, { result: 'hurt' }, { now })
  assert.equal(row.feedback_log.length, 2, '31 天前那条被折叠，只剩 1 天前 + 刚写的')
  assert.equal(row.GOutcome, 0.17, '旧的 hurt 折进基准')
  // G = replay(0.17, [helped(1天前), hurt(今天)])
  let expected = 0.17
  expected = replayFeedback(expected, [{ result: 'helped' }, { result: 'hurt' }])
  assert.equal(row.G, expected)
})

check('全部超窗：日志清空，G 等于折叠后的基准', () => {
  const store = readStore(newDir())
  const row = upsertExperience(store, { intent: '装插件', action: '用 tgz 装', outcome: 'success', type: '环境 / 部署' }).experience
  const now = Date.now()
  applyFeedback(store, row.id, { result: 'hurt' }, { now: now - 40 * DAY })
  applyFeedback(store, row.id, { result: 'hurt' }, { now: now - 35 * DAY })
  // 折叠发生在「下一次写入之前」：再写一条，两条超窗 hurt 才被折进基准。
  applyFeedback(store, row.id, { result: 'neutral' }, { now })
  assert.equal(row.feedback_log.length, 1, '只剩刚才那条 neutral')
  assert.equal(row.GOutcome, replayFeedback(0.8, [{ result: 'hurt' }, { result: 'hurt' }]))
  assert.equal(row.G, row.GOutcome)
})

check('decayDays=0 关闭折叠', () => {
  const store = readStore(newDir())
  const row = upsertExperience(store, { intent: '查论文', action: '先读摘要', outcome: 'success', type: '调研 / 资料' }).experience
  const now = Date.now()
  applyFeedback(store, row.id, { result: 'hurt' }, { now: now - 100 * DAY, decayDays: 0 })
  assert.equal(row.feedback_log.length, 1, '关闭后不折叠')
})

check('读时绝不折叠：writeStore 后连读两次，日志与 G 不变', () => {
  const dir = newDir()
  const store = readStore(dir)
  const row = upsertExperience(store, { intent: '改 PPT 页码', action: '重算物理页序', outcome: 'success', type: 'PPT / 课件' }).experience
  applyFeedback(store, row.id, { result: 'hurt' }, { now: Date.now() - 60 * DAY, decayDays: 0 })
  writeStore(dir, store)
  const once = readStore(dir).experiences[0]
  const twice = readStore(dir).experiences[0]
  assert.equal(once.feedback_log.length, 1, '读时不能把超窗事件折掉')
  assert.equal(once.G, twice.G)
})

check('终身计数不因折叠丢失；折叠时间可查', () => {
  const store = readStore(newDir())
  const row = upsertExperience(store, { intent: '装插件', action: '用 tgz 装', outcome: 'success', type: '环境 / 部署' }).experience
  const now = Date.now()
  applyFeedback(store, row.id, { result: 'hurt' }, { now: now - 40 * DAY })
  assert.equal(row.feedback.hurt, 1)
  applyFeedback(store, row.id, { result: 'neutral' }, { now })
  assert.ok(typeof row.lastDecayedAt === 'string', '发生折叠时应留时间戳')
  assert.equal(row.feedback.hurt, 1, '折叠后计数保留')
  assert.equal(row.feedback.neutral, 1)
})

check('重记：先折叠旧事件再换新基准，未过期事件继续生效', () => {
  const store = readStore(newDir())
  const row = upsertExperience(store, { intent: '发布插件', action: '法甲', outcome: 'success', type: '代码 / 插件' }).experience
  const now = Date.now()
  applyFeedback(store, row.id, { result: 'hurt' }, { now: now - 60 * DAY })
  applyFeedback(store, row.id, { result: 'hurt' }, { now: now - 1 * DAY })
  const again = upsertExperience(store, { intent: '发布插件', action: '法甲', outcome: 'success', type: '代码 / 插件' }, { feedbackDecayDays: DEFAULT_FEEDBACK_DECAY_DAYS })
  assert.equal(again.action, 'updated')
  const after = again.experience
  assert.equal(after.GOutcome, 0.8, '基准换成今天的 outcome')
  assert.equal(after.feedback_log.length, 1, '60 天前那条已折叠，1 天前仍在')
  assert.equal(after.G, replayFeedback(0.8, [{ result: 'hurt' }]), '未过期 hurt 继续生效')
})

console.log('')
console.log(`结果：通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exit(1)
