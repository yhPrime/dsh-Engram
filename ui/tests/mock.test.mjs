/**
 * exp-ui 示例数据测试：覆盖度、可点性、反馈只改内存。
 * Run: node tests/mock.test.mjs
 */
import assert from 'node:assert/strict'

import { createMockSource, createMockStore, createMockUsage } from '../mock.js'
import { detailOf, rowOf, statsOf, typesOf, visibleOf } from '../data-source.js'

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
    console.log(`       ${error && error.stack ? error.stack : error}`)
  }
}

const store = createMockStore()

check('6 个类型，含 1 个系统类型', () => {
  assert.equal(store.types.length, 6)
  assert.equal(store.types.filter((type) => type.system === true).length, 1)
  for (const type of store.types) {
    assert.ok(type.id.startsWith('ty_'))
    assert.ok(type.name.length > 0)
    assert.ok(type.description.length > 5)
  }
})

check('15 条经验，12 条可见（退休/被取代/已删除各 1 条被过滤）', () => {
  assert.equal(store.experiences.length, 15)
  assert.equal(visibleOf(store).length, 12)
  assert.equal(store.experiences.filter((item) => item.retired_at).length, 1)
  assert.equal(store.experiences.filter((item) => item.superseded_by).length, 1)
  assert.equal(store.experiences.filter((item) => item.deleted_at).length, 1)
})

check('结果覆盖成功/部分/失败/被纠正/中止/未知', () => {
  const outcomes = new Set(store.experiences.map((item) => item.outcome))
  for (const value of ['success', 'partial', 'failed', 'corrected', 'aborted', 'unknown']) {
    assert.equal(outcomes.has(value), true, `缺少 outcome=${value}`)
  }
  assert.ok(store.experiences.some((item) => Number(item.G) < 0), '缺少负回报样本')
})

check('有反馈 / 无反馈 / 超长备注 / 任务步骤 / 负 G 都覆盖', () => {
  assert.ok(store.experiences.some((item) => item.feedback !== null && item.feedback !== undefined))
  assert.ok(store.experiences.some((item) => item.feedback === null))
  assert.ok(store.experiences.some((item) => String(item.note || '').length > 400))
  assert.ok(store.experiences.some((item) => item.kind === 'step' && Number(item.stepIndex) > 0))
  assert.ok(store.experiences.some((item) => item.GSource === 'feedback'))
})

check('类型计数与可见条数一致', () => {
  const types = typesOf(store)
  const sum = types.reduce((total, type) => total + type.count, 0)
  assert.equal(sum, 12)
  assert.equal(statsOf(store).totalInsights, 12)
})

check('示例用法日志 10 行且按时间升序（面板会 reverse）', () => {
  const usage = createMockUsage()
  assert.equal(usage.length, 10)
  for (let i = 1; i < usage.length; i += 1) {
    assert.ok(String(usage[i - 1].at) <= String(usage[i].at), '示例日志没有按时间升序')
  }
  assert.ok(usage.some((row) => row.ok === false), '缺少失败调用样本')
  assert.ok(usage.some((row) => row.feedback), '缺少反馈调用样本')
})

check('mock source：read 返回示例库与说明，字节数 > 0', () => {
  const source = createMockSource()
  assert.equal(source.mode, 'mock')
  assert.equal(source.readOnly, false)
  assert.ok(source.notice.includes('示例数据'))
  const read = source.read()
  assert.equal(read.exists, true)
  assert.ok(read.bytes > 1000)
  assert.equal(read.store.experiences.length, 15)
})

check('mock 反馈：改内存里的 G、不动 hits/outcome，并记进反馈日志', () => {
  const source = createMockSource()
  const before = source.read().store.experiences.find((item) => item.id === 'ex_mock_02')
  const hits = before.hits
  const outcome = before.outcome
  const receipt = source.feedback('ex_mock_02', 'hurt')
  assert.equal(receipt.id, 'ex_mock_02')
  assert.ok(receipt.G_after < receipt.G_before)
  const after = source.read().store.experiences.find((item) => item.id === 'ex_mock_02')
  assert.equal(after.hits, hits)
  assert.equal(after.outcome, outcome)
  assert.equal(after.G, receipt.G_after)
  assert.ok(detailOf(source.read().store, 'ex_mock_02').feedbackLog.length > 0)
})

check('mock 反馈：未知 id 报 not-found', () => {
  const source = createMockSource()
  assert.throws(() => source.feedback('ex_nope', 'helped'), (error) => error && error.code === 'not-found')
})

check('rowOf 对缺字段的脏数据不抛错', () => {
  const row = rowOf({ id: 'ex_dirty', intent: '只有意图' })
  assert.equal(row.action, '')
  assert.equal(row.G, 0)
  assert.equal(row.feedback, null)
  assert.equal(row.lifecycle.deletedAt, '')
  assert.equal(row.stepIndex, null)
})

check('固化技能 5 条，覆盖已固化/试用中/不稳定/待验证/有未解障碍', () => {
  const source = createMockSource()
  const skills = source.skills()
  assert.equal(skills.length, 5)
  const statuses = new Set(skills.map((skill) => skill.status))
  for (const status of ['solid', 'trial', 'risky', 'new', 'blocked']) {
    assert.equal(statuses.has(status), true, `缺少 status=${status}`)
  }
  for (const skill of skills) {
    assert.ok(skill.id.length > 0)
    assert.ok(skill.name.length > 0)
    assert.ok(skill.body.length > 20, `${skill.id} 正文太短`)
    assert.ok(Array.isArray(skill.derivedFrom) && skill.derivedFrom.length >= 1)
    assert.ok(Number.isFinite(skill.ratio) && skill.ratio >= 0 && skill.ratio <= 1)
  }
})

check('技能自信度规则与 exp-lib 一致：uses = helped + hurt，≥3 且比例 ≥0.8 才算固化', () => {
  const source = createMockSource()
  const skills = source.skills()
  const solid = skills.find((skill) => skill.status === 'solid')
  assert.equal(solid.confident, true)
  assert.ok(solid.attempts >= 3)
  assert.ok(solid.ratio >= 0.8)
  assert.equal(solid.attempts, solid.helped + solid.hurt)

  const risky = skills.find((skill) => skill.status === 'risky')
  assert.equal(risky.confident, false)
  assert.ok(risky.attempts >= 3 && risky.ratio < 0.5)

  const fresh = skills.find((skill) => skill.status === 'new')
  assert.equal(fresh.attempts, 0)
  assert.equal(fresh.confident, false)

  const blocked = skills.find((skill) => skill.status === 'blocked')
  assert.ok(blocked.openObstacleCount > 0)
  assert.equal(blocked.confident, false)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
