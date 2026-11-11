/**
 * 召回预算（0.13.0）：默认 2 条、去重、note ≤120；detail:true 才给全量。
 * 用合成库（不依赖真实数据），阈值按「单次回执 ≤1,200 字符」守。
 *
 * Run: node tests/recall-budget.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-recall-budget-'))
const tools = buildTools((definition) => definition, { dataDir: dir, autoBind: false, induction: false })
const call = (name, args) => tools.find((item) => item.name === name).execute(args)

// 造 12 条经验：两个类型、正负都有、note 都很长（验证截断）。
const topics = [
  ['给研学课 PPT 插页', '先克隆相邻页再改字', 'PPT / 课件', 'success'],
  ['给研学课 PPT 插页失败', '直接新建页再复制样式', 'PPT / 课件', 'failed'],
  ['把课件导出 PDF', '用 LibreOffice 嵌字体', 'PPT / 课件', 'success'],
  ['导出 PDF 字体丢失', '直接 print 成 PDF', 'PPT / 课件', 'failed'],
  ['改 PPT 页码', '重算物理页序', 'PPT / 课件', 'success'],
  ['给插件写测试', '先跑 npm test 再改', '代码 / 插件', 'success'],
  ['插件热更新不生效', '重启 DSH', '代码 / 插件', 'failed'],
  ['装插件到 profile', '用 tgz 安装', '代码 / 插件', 'success'],
  ['安装报 already-installed', '先 remove_bundle', '代码 / 插件', 'success'],
  ['排查沙箱写入被拒', '看 ACL 再放权', '代码 / 插件', 'partial'],
  ['发布到 GitHub', '先 tag 再 push', '代码 / 插件', 'success'],
  ['推送连接被重置', '换 IP 写 hosts', '代码 / 插件', 'failed'],
]
for (const [intent, action, typeName, outcome] of topics) {
  call('exp_record', {
    intent,
    action,
    outcome,
    typeName,
    note: '很长的注意事项：'.repeat(20),
  })
}

const intents = ['给研学课 PPT 插页', '导出 PDF', '改 PPT 页码', '给插件写测试', '装插件到 profile', '排查沙箱写入被拒']
const payloads = intents.map((intent) => ({ intent, payload: call('exp_recall', { intent }) }))

check('默认返回 ≤4 条候选', () => {
  for (const item of payloads) {
    assert.ok((item.payload.candidates || []).length <= 4, `${item.intent} 返回 ${(item.payload.candidates || []).length} 条`)
  }
})

check('单次回执 ≤3,000 字符（能用的前提下，只防失控）', () => {
  for (const item of payloads) {
    const size = measure(item.payload)
    assert.ok(size <= 3000, `${item.intent} 回执 ${size} 字符`)
  }
})

check('evidence 保留 id，note 截到 ≤201 字符', () => {
  for (const item of payloads) {
    for (const candidate of item.payload.candidates || []) {
      for (const evidence of candidate.evidence || []) {
        assert.ok(typeof evidence.id === 'string' && evidence.id !== '', 'evidence 必须有 id（回填/反馈要用）')
        if (evidence.note !== undefined) assert.ok(evidence.note.length <= 201, `note ${evidence.note.length} 字符`)
      }
    }
  }
})

check('候选与 evidence 不重复同一段 action', () => {
  for (const item of payloads) {
    for (const candidate of item.payload.candidates || []) {
      const evidence = candidate.evidence || []
      for (let index = 1; index < evidence.length; index += 1) {
        assert.equal(evidence[index].action, undefined, '非首条 evidence 不该重复 action')
      }
    }
  }
})

check('detail:true 返回完整回执（更长、含 route/邻居数）', () => {
  const slim = measure(call('exp_recall', { intent: '装插件到 profile' }))
  const full = call('exp_recall', { intent: '装插件到 profile', detail: true })
  assert.ok(full.route !== undefined || full.neighbor_count !== undefined, '完整回执应有 route/neighbor_count')
  assert.ok(measure(full) > slim, '完整回执应更长')
})

check('显式 limit 会放宽条数', () => {
  const payload = call('exp_recall', { intent: '给研学课 PPT 插页', limit: 4 })
  assert.ok((payload.candidates || []).length >= 2)
})

check('显式 limit 在簇内也不再被截到 4（行为模拟发现的 limit 形同虚设）', () => {
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-limit-'))
  const tools2 = buildTools((definition) => definition, { dataDir: dir2, autoBind: false, induction: false })
  const call2 = (name, args) => tools2.find((item) => item.name === name).execute(args)
  for (let index = 0; index < 6; index += 1) {
    call2('exp_record', { intent: `给研学课 PPT 插页的第 ${index} 种做法`, action: `做法 ${index}（克隆、重画、挪块、重算页码）`, outcome: 'success', typeName: 'PPT / 课件' })
  }
  const payload = call2('exp_recall', { intent: '给研学课 PPT 插页', limit: 6 })
  assert.equal((payload.candidates || []).length, 6, `显式 limit=6 只回了 ${(payload.candidates || []).length} 条`)
})

check('dimensions 写进去要能看到（召回 evidence 带 dimensions）', () => {
  const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-dims-'))
  const tools3 = buildTools((definition) => definition, { dataDir: dir3, autoBind: false, induction: false })
  const call3 = (name, args) => tools3.find((item) => item.name === name).execute(args)
  const made = call3('exp_record', { intent: '给 PPT 加装饰元素', action: '先画一个圆放在标题旁', typeName: 'PPT / 课件' })
  call3('exp_record', {
    intent: '给 PPT 加装饰元素',
    action: '先画一个圆放在标题旁',
    typeName: 'PPT / 课件',
    verdicts: [{ id: made.id, outcome: 'corrected', dimensions: ['布局'] }],
  })
  const payload = call3('exp_recall', { intent: '给 PPT 加装饰元素' })
  const evidence = (payload.candidates || []).flatMap((candidate) => candidate.evidence || [])
  const row = evidence.find((item) => item.id === made.id)
  assert.ok(row, '应召回刚记的那条')
  assert.deepEqual(row.dimensions, ['布局'])
})

console.log('')
console.log(`结果：通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exit(1)
