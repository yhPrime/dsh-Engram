/**
 * 预测误差测试（0.24.0）
 *  - exp_record 可选 expectedG / expectedOutcome，记 predictionError = 实际回报 − 预期；
 *  - 没有预期就不算；重记没带预期时沿用上次预期并重算；
 *  - 证据里只在有预期时带 expectedG / predictionError。
 * Run: node tests/prediction-error.test.mjs
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-pred-'))
  const tools = buildTools((definition) => definition, { dataDir: dir })
  const call = (name, args) => tools.find((item) => item.name === name).execute(args)
  return {
    dir,
    record: (input) => call('exp_record', input),
    recall: (intent) => call('exp_recall', { intent }),
    all: () => readStore(dir).experiences,
  }
}

check('预期成功、实际成功 → 误差 0；预期成功、实际失败 → -1.4', () => {
  const agent = newAgent()
  const ok = agent.record({ intent: '做 PPT 插页', action: '克隆相邻页', outcome: 'success', type: 'PPT / 课件', expectedG: 0.8 })
  assert.equal(ok.action, 'added')
  const rowOk = agent.all().find((item) => item.id === ok.id)
  assert.equal(rowOk.expectedG, 0.8)
  assert.equal(rowOk.predictionError, 0)

  const bad = agent.record({ intent: '做 PPT 插页', action: '直接套模板', outcome: 'failed', type: 'PPT / 课件', expectedG: 0.8 })
  const rowBad = agent.all().find((item) => item.id === bad.id)
  assert.equal(rowBad.predictionError, -1.4)
})

check('expectedOutcome 结果词可用（success → 0.8）', () => {
  const agent = newAgent()
  const made = agent.record({ intent: '给插件跑测试', action: '先跑 npm test', outcome: 'success', type: '代码 / 插件', expectedOutcome: 'success' })
  const row = agent.all().find((item) => item.id === made.id)
  assert.equal(row.expectedG, 0.8)
  assert.equal(row.predictionError, 0)
})

check('没有预期：不算误差，证据里不带字段', () => {
  const agent = newAgent()
  const made = agent.record({ intent: '查论文结论', action: '先读摘要', outcome: 'success', type: '调研 / 资料' })
  const row = agent.all().find((item) => item.id === made.id)
  assert.equal(row.expectedG, null)
  assert.equal(row.predictionError, null)
  const evidence = agent.recall('查论文结论').candidates.flatMap((candidate) => candidate.evidence)[0]
  assert.equal('expectedG' in evidence, false)
  assert.equal('predictionError' in evidence, false)
})

check('重记没带预期：沿用上次预期并重算误差', () => {
  const agent = newAgent()
  const first = agent.record({ intent: '做 PPT 插页', action: '克隆相邻页', outcome: 'failed', type: 'PPT / 课件', expectedG: 0.8 })
  assert.equal(agent.all().find((item) => item.id === first.id).predictionError, -1.4)
  const again = agent.record({ intent: '做 PPT 插页', action: '克隆相邻页', outcome: 'success', type: 'PPT / 课件', expectedG: 0.8 })
  assert.equal(again.action, 'added', '正负翻转 → 新条')
  const repo = agent.record({ intent: '做 PPT 插页', action: '克隆相邻页', outcome: 'success', type: 'PPT / 课件' })
  assert.equal(repo.action, 'updated')
  const row = agent.all().find((item) => item.id === repo.id)
  assert.equal(row.expectedG, 0.8, '沿用上次预期')
  assert.equal(row.predictionError, 0, '按本次实测重算')
})

check('证据里带 expectedG / predictionError', () => {
  const agent = newAgent()
  agent.record({ intent: '做 PPT 插页', action: '克隆相邻页', outcome: 'failed', type: 'PPT / 课件', expectedG: 0.8 })
  const evidence = agent.recall('做 PPT 插页').candidates.flatMap((candidate) => candidate.evidence)[0]
  assert.equal(evidence.expectedG, 0.8)
  assert.equal(evidence.predictionError, -1.4)
})

console.log('')
console.log(`结果：通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exit(1)
