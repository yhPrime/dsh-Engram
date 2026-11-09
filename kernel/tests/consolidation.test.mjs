/**
 * 巩固测试（0.21.0）：同族 ≥3 且有正负对照时，exp_recall 返回一条「候选规则」。
 *  - 抽共同词（中文二元组）+ 负例独有词，不写库、零 LLM；
 *  - 全成功 / 样本不足 / 关闭开关时都不给。
 * Run: node tests/consolidation.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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

const newAgent = (extra = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-cons-'))
  const tools = buildTools((definition) => definition, { dataDir: dir, ...extra })
  const call = (name, args) => tools.find((item) => item.name === name).execute(args)
  return {
    record: (input) => call('exp_record', input),
    recall: (intent, opts = {}) => call('exp_recall', { intent, ...opts }),
  }
}

function seed(agent, negative = true) {
  const taskId = 'task-cons'
  const steps = [
    ['先克隆相邻页再改字', negative ? 'success' : 'success'],
    ['先克隆相邻页再重画主体', 'success'],
    [negative ? '直接套模板不做相邻页' : '先克隆相邻页再检查', negative ? 'failed' : 'success'],
  ]
  steps.forEach(([action, outcome], index) => {
    agent.record({
      intent: `给研学课 PPT 插页：${action}`, action, outcome, type: 'PPT / 课件',
      taskId, kind: 'step', stepIndex: index + 1, stepTotal: 3,
    })
  })
}

check('同族 3 条（2 正 1 负）→ 候选规则含共同词与负例独有词', () => {
  const agent = newAgent()
  seed(agent)
  const recalled = agent.recall('给研学课 PPT 插页')
  assert.ok(typeof recalled.consolidated === 'string', `consolidated=${JSON.stringify(recalled.consolidated)}`)
  assert.ok(recalled.consolidated.includes('候选规则'), recalled.consolidated)
  assert.ok(recalled.consolidated.includes('优先'), recalled.consolidated)
  assert.ok(recalled.consolidated.includes('避免'), recalled.consolidated)
  assert.ok(recalled.consolidated.includes('克隆'), `应含共同词，实际：${recalled.consolidated}`)
})

check('全成功 → 不给候选规则（没有「哪种更好」）', () => {
  const agent = newAgent()
  seed(agent, false)
  const recalled = agent.recall('给研学课 PPT 插页')
  assert.equal(recalled.consolidated, undefined)
})

check('样本不足（2 条）→ 不给', () => {
  const agent = newAgent()
  agent.record({ intent: '装插件到 profile', action: '先用 tgz 打包', outcome: 'success', type: '环境 / 部署' })
  agent.record({ intent: '装插件到 profile', action: '先用目录安装', outcome: 'failed', type: '环境 / 部署' })
  const recalled = agent.recall('装插件到 profile')
  assert.equal(recalled.consolidated, undefined)
})

check('config.consolidation=false → 关闭', () => {
  const agent = newAgent({ consolidation: false })
  seed(agent)
  const recalled = agent.recall('给研学课 PPT 插页')
  assert.equal(recalled.consolidated, undefined)
})

check('候选规则有长度上限（≤200）', () => {
  const agent = newAgent()
  seed(agent)
  const recalled = agent.recall('给研学课 PPT 插页')
  assert.ok(recalled.consolidated.length <= 200, `len=${recalled.consolidated.length}`)
})

console.log('')
console.log(`结果：通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exit(1)
