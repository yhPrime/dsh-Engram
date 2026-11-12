/**
 * 判定回填（0.13.0）：exp_record / exp_recall 都收 verdicts，插件只写回、不判断。
 *
 * Run: node tests/verdicts.test.mjs
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-verdict-'))
  const tools = buildTools((definition) => definition, { dataDir: dir, autoBind: false })
  const call = (name, args) => tools.find((item) => item.name === name).execute(args)
  return {
    record: (input) => call('exp_record', input),
    recall: (intent, extra = {}) => call('exp_recall', { intent, ...extra }),
    store: () => readStore(dir),
  }
}

check('exp_record 带 verdicts：写回 outcome / G / dimensions', () => {
  const agent = newAgent()
  const made = agent.record({ intent: '给 PPT 加装饰', action: '先画一个圆', typeName: 'PPT / 课件' })
  const receipt = agent.record({
    intent: '给 PPT 加装饰',
    action: '先画一个圆',
    typeName: 'PPT / 课件',
    verdicts: [{ id: made.id, outcome: 'corrected', dimensions: ['布局', '美学'] }],
  })
  assert.equal(receipt.verdicts.ok, 1)
  assert.equal(receipt.verdicts.failed, undefined)
  const row = agent.store().experiences.find((item) => item.id === made.id)
  assert.equal(row.outcome, 'corrected')
  assert.equal(row.G, -0.8)
  assert.equal(row.verdict, 'decided')
  assert.equal(row.decidedBy, 'model')
  assert.deepEqual(row.dimensions, ['布局', '美学'])
})

check('exp_recall 也收 verdicts（召回时顺手回填，省一次调用）', () => {
  const agent = newAgent()
  const made = agent.record({ intent: '导出 PDF', action: '用 LibreOffice', typeName: '导出' })
  const recalled = agent.recall('导出 PDF', { verdicts: [{ id: made.id, outcome: 'partial' }] })
  assert.equal(recalled.verdicts.ok, 1)
  const row = agent.store().experiences.find((item) => item.id === made.id)
  assert.equal(row.outcome, 'partial')
  assert.equal(row.G, 0.3)
})

check('非法 outcome / 不存在的 id：只报错，不写坏数据', () => {
  const agent = newAgent()
  const made = agent.record({ intent: '写发布说明', action: '先列改动', typeName: '文档 / 教案' })
  const receipt = agent.record({
    intent: '写发布说明',
    action: '先列改动',
    typeName: '文档 / 教案',
    verdicts: [
      { id: made.id, outcome: '完美' },
      { id: 'ex_nope', outcome: 'success' },
    ],
  })
  assert.equal(receipt.verdicts.ok, 0)
  assert.equal(receipt.verdicts.failed.length, 2)
  assert.ok(receipt.verdicts.failed[0].error.includes('outcome'))
  assert.ok(receipt.verdicts.failed[1].error.includes('没有这条'))
  const row = agent.store().experiences.find((item) => item.id === made.id)
  assert.equal(row.verdict, 'pending')
})

check('dimensions 上限：最多 3 个、每个 ≤24 字符', () => {
  const agent = newAgent()
  const made = agent.record({ intent: '改页码', action: '重算物理页序', typeName: 'PPT / 课件' })
  const receipt = agent.record({
    intent: '改页码',
    action: '重算物理页序',
    typeName: 'PPT / 课件',
    verdicts: [{
      id: made.id,
      outcome: 'success',
      dimensions: ['布局', '语义理解', '代码编辑', '内容取舍', '一个非常非常非常长的维度名字超过二十四个字符'],
    }],
  })
  assert.equal(receipt.verdicts.ok, 1)
  const row = agent.store().experiences.find((item) => item.id === made.id)
  assert.equal(row.dimensions.length, 3)
  assert.ok(row.dimensions.every((tag) => tag.length <= 24))
})

check('重复回填：后一次覆盖前一次，不报错（模型可以改口）', () => {
  const agent = newAgent()
  const made = agent.record({ intent: '装插件', action: '用 tgz 装', typeName: '环境 / 部署' })
  agent.record({
    intent: '装插件',
    action: '用 tgz 装',
    typeName: '环境 / 部署',
    verdicts: [{ id: made.id, outcome: 'failed' }],
  })
  const again = agent.record({
    intent: '装插件',
    action: '用 tgz 装',
    typeName: '环境 / 部署',
    verdicts: [{ id: made.id, outcome: 'success', note: '用户说其实没问题' }],
  })
  assert.equal(again.verdicts.ok, 1)
  const row = agent.store().experiences.find((item) => item.id === made.id)
  assert.equal(row.outcome, 'success')
  assert.equal(row.G, 0.8)
  assert.equal(row.note, '用户说其实没问题')
})

console.log('')
console.log(`结果：通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exit(1)
