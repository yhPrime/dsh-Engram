/**
 * 生命周期事件测试（0.11.0）
 *  - 取代 / 复活 / 删除都写 history；复活会顶替现任（不是并列）；
 *  - 删取代者时清孤儿边并给被取代条写 revived 事件；
 *  - kind=step 且没给 taskId：按意图自动归组（同一步骤族算一个任务）；
 *  - history 封顶 50 条。
 * Run: node tests/lifecycle.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { HISTORY_LIMIT, forgetExperience, pushHistory, readStore, readStore as read2, upsertExperience } from '../store.js'
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

const newAgent = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-life-'))
  const tools = buildTools((definition) => definition, { dataDir: dir })
  const call = (name, args) => tools.find((item) => item.name === name).execute(args)
  return {
    dir,
    record: (input) => call('exp_record', input),
    recall: (intent) => call('exp_recall', { intent }),
    all: () => readStore(dir).experiences,
    visible: () => readStore(dir).experiences.filter((item) => !item.deleted_at && !item.superseded_by),
  }
}

check('取代：旧条写 superseded(by)，新条写 created(supersedes)', () => {
  const agent = newAgent()
  const a = agent.record({ intent: '发布插件', action: '法甲', outcome: 'success', type: '代码 / 插件' })
  const b = agent.record({ intent: '发布插件', action: '法乙', outcome: 'success', type: '代码 / 插件' })
  const store = readStore(agent.dir)
  const rowA = store.experiences.find((item) => item.id === a.id)
  const rowB = store.experiences.find((item) => item.id === b.id)
  assert.ok(rowA.history.some((event) => event.type === 'superseded' && event.by === b.id))
  assert.ok(rowB.history.some((event) => event.type === 'created' && event.supersedes === a.id))
})

check('复活：写 revived(displaced)，被顶替的现任写 superseded(reason=revived)', () => {
  const agent = newAgent()
  const a = agent.record({ intent: '发布插件', action: '法甲', outcome: 'success', type: '代码 / 插件' })
  const b = agent.record({ intent: '发布插件', action: '法乙', outcome: 'success', type: '代码 / 插件' })
  agent.record({ intent: '发布插件', action: '法甲', outcome: 'success', type: '代码 / 插件' })
  const store = readStore(agent.dir)
  const rowA = store.experiences.find((item) => item.id === a.id)
  const rowB = store.experiences.find((item) => item.id === b.id)
  assert.ok(rowA.history.some((event) => event.type === 'revived' && event.displaced === b.id))
  assert.ok(rowB.history.some((event) => event.type === 'superseded' && event.reason === 'revived'))
  assert.equal(rowB.superseded_by, a.id)
})

check('复活链 A→B→C：复活 A 顶替当前的 C，B 保持隐藏', () => {
  const agent = newAgent()
  const a = agent.record({ intent: '发布插件', action: '法甲', outcome: 'success', type: '代码 / 插件' })
  const b = agent.record({ intent: '发布插件', action: '法乙', outcome: 'success', type: '代码 / 插件' })
  const c = agent.record({ intent: '发布插件', action: '法丙', outcome: 'success', type: '代码 / 插件' })
  agent.record({ intent: '发布插件', action: '法甲', outcome: 'success', type: '代码 / 插件' })
  const store = readStore(agent.dir)
  const rowA = store.experiences.find((item) => item.id === a.id)
  const rowB = store.experiences.find((item) => item.id === b.id)
  const rowC = store.experiences.find((item) => item.id === c.id)
  assert.ok(rowA.history.some((event) => event.type === 'revived' && event.displaced === c.id))
  assert.equal(rowC.superseded_by, a.id)
  assert.ok(rowB.superseded_by !== null, 'B 仍隐藏')
})

check('删取代者：写 forgotten、清孤儿边、被取代条写 revived(superseder-deleted)', () => {
  const agent = newAgent()
  const a = agent.record({ intent: '发布插件', action: '法甲', outcome: 'success', type: '代码 / 插件' })
  const b = agent.record({ intent: '发布插件', action: '法乙', outcome: 'success', type: '代码 / 插件' })
  const store = readStore(agent.dir)
  forgetExperience(store, b.id)
  const rowA = store.experiences.find((item) => item.id === a.id)
  const rowB = store.experiences.find((item) => item.id === b.id)
  assert.equal(rowB.supersedes, null, '墓碑不应留孤儿 supersedes 边')
  assert.ok(rowB.history.some((event) => event.type === 'forgotten'))
  assert.ok(rowA.history.some((event) => event.type === 'revived' && event.reason === 'superseder-deleted'))
  assert.equal(rowA.superseded_by, null)
})

check('step 没给 taskId：按意图自动归组，簇统计算 1 个任务', () => {
  const agent = newAgent()
  for (let i = 1; i <= 3; i += 1) {
    agent.record({ intent: '给研学课 PPT 插页（多步）', action: `步骤 ${i}`, outcome: 'success', type: 'PPT / 课件', kind: 'step', stepIndex: i, stepTotal: 3 })
  }
  const store = readStore(agent.dir)
  const rows = store.experiences
  const ids = new Set(rows.map((item) => item.taskId))
  assert.equal(ids.size, 1, '三步应归到同一个自动任务 id')
  assert.ok([...ids][0].startsWith('auto_'))
  const cluster = store.clusters.find((item) => item.name === 'PPT / 课件')
  assert.equal(cluster.stats.count, 1)
  assert.equal(cluster.stats.steps, 3)
})

check('history 封顶 50 条', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-life-cap-'))
  const store = read2(dir)
  const row = upsertExperience(store, { intent: '测试封顶', action: '做法', outcome: 'success' }).experience
  for (let i = 0; i < HISTORY_LIMIT + 5; i += 1) pushHistory(row, { type: 'noise', index: i })
  assert.equal(row.history.length, HISTORY_LIMIT)
  assert.equal(row.history[row.history.length - 1].index, HISTORY_LIMIT + 4)
})

console.log('')
console.log(`结果：通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exit(1)
