/**
 * 待判定队列（0.13.0）：outcome 可省 → pending；回执带出；超时转 skipped；补判后落 decided。
 *
 * Run: node tests/pending.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { pendingRows, readStore } from '../store.js'
import { buildTools } from '../tools.js'
import { measure } from '../token-budget.js'

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

const newAgent = (config = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-pending-'))
  const tools = buildTools((definition) => definition, { dataDir: dir, autoBind: false, ...config })
  const call = (name, args) => tools.find((item) => item.name === name).execute(args)
  return {
    dir,
    record: (input) => call('exp_record', input),
    recall: (intent, extra = {}) => call('exp_recall', { intent, ...extra }),
    store: () => readStore(dir),
    pending: (limit) => pendingRows(readStore(dir), limit),
  }
}

check('不给 outcome：落 pending，G=0，回执标明 verdict', () => {
  const agent = newAgent()
  const made = agent.record({ intent: '给阅卷系统加导出', action: '先做 CSV', typeName: '代码 / 插件' })
  assert.equal(made.verdict, 'pending')
  assert.equal(made.outcome, 'unknown')
  assert.equal(made.G, 0)
  const row = agent.store().experiences.find((item) => item.id === made.id)
  assert.equal(row.verdict, 'pending')
  assert.equal(row.decidedBy, null)
  assert.ok(typeof row.registeredAt === 'string' && row.registeredAt !== '')
})

check('给 outcome：直接 decided', () => {
  const agent = newAgent()
  const made = agent.record({ intent: '导出 PDF', action: '用 LibreOffice', outcome: 'success', typeName: '导出' })
  assert.equal(made.verdict, 'decided')
  const row = agent.store().experiences.find((item) => item.id === made.id)
  assert.equal(row.verdict, 'decided')
  assert.equal(row.decidedBy, 'model')
})

check('下一条回执带 pending（id + brief ≤80 字）', () => {
  const agent = newAgent()
  const made = agent.record({ intent: '给阅卷系统加导出', action: '先做 CSV', typeName: '代码 / 插件' })
  const recalled = agent.recall('给阅卷系统加导出')
  assert.ok(Array.isArray(recalled.pending) && recalled.pending.length === 1, '应带出 1 条 pending')
  assert.equal(recalled.pending[0].id, made.id)
  assert.ok(recalled.pending[0].brief.length <= 80, 'brief 不超过 80 字')
  assert.ok(recalled.pending[0].brief.includes('上一轮'), 'brief 含「上一轮」')
})

check('回填后 pending 消失、G 按 outcome 重算', () => {
  const agent = newAgent()
  const made = agent.record({ intent: '给阅卷系统加导出', action: '先做 CSV', typeName: '代码 / 插件' })
  assert.equal(agent.pending().length, 1)
  const filled = agent.record({
    intent: '给阅卷系统加导出',
    action: '先做 CSV',
    dimensionNote: '',
    typeName: '代码 / 插件',
    verdicts: [{ id: made.id, outcome: 'corrected', dimensions: ['布局'] }],
  })
  assert.equal(filled.verdicts.ok, 1)
  assert.equal(filled.verdicts.failed, undefined)
  assert.equal(agent.pending().length, 0)
  const row = agent.store().experiences.find((item) => item.id === made.id)
  assert.equal(row.verdict, 'decided')
  assert.deepEqual(row.dimensions, ['布局'])
})

check('同做法再记（带 outcome）：就地合并 pending 条，翻成 decided', () => {
  const agent = newAgent()
  const first = agent.record({ intent: '导出 PDF', action: '用 LibreOffice', typeName: '导出' })
  const second = agent.record({ intent: '导出 PDF', action: '用 LibreOffice', outcome: 'failed', typeName: '导出' })
  assert.equal(second.action, 'updated')
  assert.equal(second.id, first.id)
  const row = agent.store().experiences.find((item) => item.id === first.id)
  assert.equal(row.verdict, 'decided')
  assert.equal(row.outcome, 'failed')
  assert.equal(row.G, -0.6)
})

check('提醒满 pendingTtl 次后转 skipped，不再出现在回执里', () => {
  const agent = newAgent({ pendingTtl: 2 })
  const made = agent.record({ intent: '给 PPT 加装饰', action: '先画一个圆', typeName: 'PPT / 课件' })
  assert.equal(agent.recall('给 PPT 加装饰').pending.length, 1, '第 1 次提醒')
  assert.equal(agent.recall('给 PPT 加装饰').pending.length, 1, '第 2 次提醒')
  const third = agent.recall('给 PPT 加装饰')
  assert.equal(third.pending, undefined, '超过 2 次不再带出')
  const row = agent.store().experiences.find((item) => item.id === made.id)
  assert.equal(row.verdict, 'skipped')
})

check('pendingReceipt=false：回执不带 pending', () => {
  const agent = newAgent({ pendingReceipt: false })
  agent.record({ intent: '写发布说明', action: '先列改动', typeName: '文档 / 教案' })
  assert.equal(agent.recall('写发布说明').pending, undefined)
})

check('回执预算：普通 / 带 pending / 带回填 都 ≤300 字符', () => {
  const agent = newAgent()
  const first = agent.record({ intent: '导出 PDF', action: '用 LibreOffice', typeName: '导出' })
  assert.ok(measure(first) <= 300, `pending 回执 ${measure(first)} 字符`)
  const second = agent.record({ intent: '改页码', action: '重算物理页序', typeName: 'PPT / 课件' })
  assert.ok(measure(second) <= 300, `带 pending 的回执 ${measure(second)} 字符`)
  const third = agent.record({
    intent: '回填',
    action: '一次回填',
    typeName: '导出',
    verdicts: [{ id: first.id, outcome: 'success' }],
  })
  assert.ok(measure(third) <= 300, `带回填的回执 ${measure(third)} 字符`)
})

check('回执预算边界：2 条长 brief + 一次回填 3 条 ≤350', () => {
  const agent = newAgent()
  agent.record({ intent: '给研学课 PPT 插一页过渡页并调整标题字号的整体版式', action: '做法一', typeName: 'PPT / 课件' })
  agent.record({ intent: '给研学课 PPT 插一页过渡页并调整标题字号的整体版式（第二轮）', action: '做法二', typeName: 'PPT / 课件' })
  const ids = [0, 1, 2].map((index) => agent.record({ intent: `已判定任务 ${index}`, action: `已判定做法 ${index}`, outcome: 'success', typeName: 'PPT / 课件' }).id)
  const receipt = agent.record({
    intent: '批量回填三条',
    action: '一次回填',
    typeName: 'PPT / 课件',
    verdicts: ids.map((id) => ({ id, outcome: 'success' })),
  })
  assert.equal(receipt.verdicts.ok, 3)
  assert.ok(measure(receipt) <= 350, `长 brief + 3 条回填 ${measure(receipt)} 字符`)
})

console.log('')
console.log(`结果：通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exit(1)
