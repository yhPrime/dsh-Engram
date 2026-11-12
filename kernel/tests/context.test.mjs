/**
 * 编码特异性测试（0.25.0）
 *  - exp_record 可选 context（≤5 个标签、≤24 字符、去重小写）；
 *  - exp_recall 带 context 时，情境匹配的候选优先；
 *  - 证据带 context / contextMatch；不带查询 context 时不影响排序；
 *  - Agent 工作流：同一意图、不同情境应该想起不同做法。
 * Run: node tests/context.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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

const newAgent = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-ctx-'))
  const tools = buildTools((definition) => definition, { dataDir: dir })
  const call = (name, args) => tools.find((item) => item.name === name).execute(args)
  return {
    dir,
    record: (input) => call('exp_record', input),
    recall: (intent, extra = {}) => call('exp_recall', { intent, ...extra }),
    all: () => readStore(dir).experiences,
  }
}

function seed(agent) {
  // 用 kind=step + 不同 stepIndex，避免「同意图不同做法、都成功 → 互相取代」。
  agent.record({
    intent: '给研学课 PPT 插一页过渡页', action: '克隆相邻页再改字', outcome: 'success',
    type: 'PPT / 课件', context: ['课件', '插页'], taskId: 'task-ctx', kind: 'step', stepIndex: 1, stepTotal: 2,
  })
  agent.record({
    intent: '给研学课 PPT 插一页过渡页', action: '直接改写原页文案', outcome: 'success',
    type: 'PPT / 课件', context: ['教案', '文字'], taskId: 'task-ctx', kind: 'step', stepIndex: 2, stepTotal: 2,
  })
}

check('context 规范化：去重、小写、截断、最多 5 个', () => {
  const agent = newAgent()
  const made = agent.record({
    intent: '做 PPT', action: '克隆页', outcome: 'success', type: 'PPT / 课件',
    context: [' 课件 ', 'PPT', 'ppt', 'a'.repeat(40), 'x', 'y', 'z'],
  })
  const row = agent.all().find((item) => item.id === made.id)
  assert.deepEqual(row.context.slice(0, 3), ['课件', 'ppt', 'a'.repeat(24)])
  assert.equal(row.context.length, 5)
})

check('同一意图不同情境：召回应想起匹配的那条（课件 vs 教案）', () => {
  const agent = newAgent()
  seed(agent)
  const forDeck = agent.recall('给研学课 PPT 插一页过渡页', { context: ['课件'] })
  assert.equal(forDeck.candidates[0].action, '克隆相邻页再改字')
  const forDoc = agent.recall('给研学课 PPT 插一页过渡页', { context: ['教案'] })
  assert.equal(forDoc.candidates[0].action, '直接改写原页文案')
})

check('证据带 context 与 contextMatch；不带查询情境时两字段不出现', () => {
  const agent = newAgent()
  seed(agent)
  const withCtx = agent.recall('给研学课 PPT 插一页过渡页', { context: ['课件'] })
  const evidence = withCtx.candidates[0].evidence[0]
  assert.deepEqual(evidence.context, ['课件', '插页'])
  assert.equal(evidence.contextMatch, 1)

  const noCtx = agent.recall('给研学课 PPT 插一页过渡页')
  const plain = noCtx.candidates[0].evidence[0]
  assert.equal('contextMatch' in plain, false)
})

check('没有匹配情境时不影响候选集合', () => {
  const agent = newAgent()
  seed(agent)
  const withCtx = agent.recall('给研学课 PPT 插一页过渡页', { context: ['完全不相关的标签'] })
  assert.equal(withCtx.candidates.length, 2)
  assert.ok(withCtx.candidates.every((candidate) => candidate.contextMatch === 0))
})

check('重记时可更新情境线索（不传则保留）', () => {
  const agent = newAgent()
  const made = agent.record({ intent: '做 PPT', action: '克隆页', outcome: 'success', type: 'PPT / 课件', context: ['课件'] })
  agent.record({ intent: '做 PPT', action: '克隆页', outcome: 'success', type: 'PPT / 课件', context: ['课件', '研学课'] })
  let row = agent.all().find((item) => item.id === made.id)
  assert.deepEqual(row.context, ['课件', '研学课'])
  agent.record({ intent: '做 PPT', action: '克隆页', outcome: 'success', type: 'PPT / 课件' })
  row = agent.all().find((item) => item.id === made.id)
  assert.deepEqual(row.context, ['课件', '研学课'], '不传 context 时保留')
})

console.log('')
console.log(`结果：通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exit(1)
