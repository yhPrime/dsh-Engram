/**
 * 提取即强化测试（0.26.0）
 *  - 只有 exp_recall({ mark: true }) 才累加 retrievals；普通召回不写库；
 *  - 只标记这次返回的证据，不碰其它条；
 *  - 证据带 retrievals；持久化后还在；
 *  - 不改排序（先只观察）。
 * Run: node tests/retrieval-practice.test.mjs
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-practice-'))
  const tools = buildTools((definition) => definition, { dataDir: dir })
  const call = (name, args) => tools.find((item) => item.name === name).execute(args)
  return {
    dir,
    record: (input) => call('exp_record', input),
    recall: (intent, extra = {}) => call('exp_recall', { intent, ...extra }),
    all: () => readStore(dir).experiences,
  }
}

const seed = (agent) => {
  agent.record({ intent: '给研学课 PPT 插一页过渡页', action: '克隆相邻页再改字', outcome: 'success', type: 'PPT / 课件', taskId: 't-prac', kind: 'step', stepIndex: 1 })
  agent.record({ intent: '给研学课 PPT 插一页过渡页', action: '直接套模板', outcome: 'failed', type: 'PPT / 课件', taskId: 't-prac', kind: 'step', stepIndex: 2 })
}

check('mark:true 才累加 retrievals；只标记返回的证据', () => {
  const agent = newAgent()
  seed(agent)
  const before = agent.all().map((item) => Number(item.retrievals) || 0)
  assert.deepEqual(before, [0, 0])
  const recalled = agent.recall('给研学课 PPT 插一页过渡页', { mark: true })
  assert.ok(recalled.marked >= 1)
  const rows = agent.all()
  const marked = rows.filter((item) => Number(item.retrievals) > 0)
  assert.equal(marked.length, recalled.marked)
})

check('普通召回不写库：retrievals 保持 0', () => {
  const agent = newAgent()
  seed(agent)
  agent.recall('给研学课 PPT 插一页过渡页')
  assert.ok(agent.all().every((item) => !item.retrievals))
})

check('证据带 retrievals（有才带）', () => {
  const agent = newAgent()
  seed(agent)
  agent.recall('给研学课 PPT 插一页过渡页', { mark: true })
  const evidence = agent.recall('给研学课 PPT 插一页过渡页').candidates.flatMap((candidate) => candidate.evidence)
  assert.ok(evidence.some((item) => Number(item.retrievals) >= 1))
})

check('多次 mark 累加，持久化仍在', () => {
  const agent = newAgent()
  seed(agent)
  agent.recall('给研学课 PPT 插一页过渡页', { mark: true })
  agent.recall('给研学课 PPT 插一页过渡页', { mark: true })
  const row = agent.all().find((item) => item.action === '克隆相邻页再改字')
  assert.equal(row.retrievals, 2)
})

check('不改排序：mark 前后 top1 一致', () => {
  const agent = newAgent()
  seed(agent)
  const before = agent.recall('给研学课 PPT 插一页过渡页').candidates[0].action
  agent.recall('给研学课 PPT 插一页过渡页', { mark: true })
  const after = agent.recall('给研学课 PPT 插一页过渡页').candidates[0].action
  assert.equal(after, before)
})

console.log('')
console.log(`结果：通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exit(1)
