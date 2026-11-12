/**
 * 提示段预算（0.13.0）：瘦身档常态 ≤130 字符，有 pending ≤320；full 档仍是完整目录。
 *
 * Run: node tests/hint-budget.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { readStore, renderHint, renderHintFull, writeStore } from '../store.js'

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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-hint-'))
const store = readStore(dir)
store.types.push(
  { id: 'ty_ppt', name: 'PPT / 课件', description: '做课件、插页、改版式' },
  { id: 'ty_code', name: '代码 / 插件', description: '写插件、改 bug、跑测试' },
)
store.experiences.push(
  { id: 'ex_a', intent: '给研学课 PPT 插页', action: '先克隆相邻页', outcome: 'success', G: 0.8, GOutcome: 0.8, ts: '2026-11-01T00:00:00.000Z', typeId: 'ty_ppt', typeName: 'PPT / 课件', verdict: 'decided', hits: 1 },
  { id: 'ex_b', intent: '导出 PDF 字体丢了', action: '用 LibreOffice 嵌入字体', outcome: 'failed', G: -0.6, GOutcome: -0.6, ts: '2026-11-02T00:00:00.000Z', typeId: 'ty_ppt', typeName: 'PPT / 课件', verdict: 'decided', hits: 1 },
)
writeStore(dir, store)

check('瘦身档（无 pending，不列技能）≤130 字符', () => {
  const hint = renderHint({ dataDir: dir, hintMode: 'slim', hintSkills: false }, 1400)
  assert.ok(hint.length <= 130, `实际 ${hint.length} 字符：${hint}`)
  assert.ok(hint.includes('exp_recall'))
  assert.ok(hint.includes('verdicts'))
  assert.ok(!hint.includes('类型/簇'))
})

check('瘦身档：不列技能时也不出现技能目录', () => {
  const hint = renderHint({ dataDir: dir, hintMode: 'slim', hintSkills: false }, 1400)
  assert.ok(!hint.includes('技能：'))
})

check('有 pending：提示段加一行，总长 ≤320', () => {
  const withPending = readStore(dir)
  withPending.experiences.push({ id: 'ex_p', intent: '给 PPT 加装饰', action: '先画一个圆', outcome: 'unknown', G: 0, ts: '2026-11-03T00:00:00.000Z', typeId: 'ty_ppt', typeName: 'PPT / 课件', verdict: 'pending', registeredAt: '2026-11-03T00:00:00.000Z', hits: 1 })
  writeStore(dir, withPending)
  const hint = renderHint({ dataDir: dir, hintMode: 'slim', hintSkills: false }, 1400)
  assert.ok(hint.includes('待判定'), '应提示待判定')
  assert.ok(hint.includes('ex_p'), '应带出 id')
  assert.ok(hint.length <= 320, `实际 ${hint.length} 字符：${hint}`)
})

check('full 档：保留类型目录（回滚用）', () => {
  const hint = renderHint({ dataDir: dir, hintMode: 'full' }, 2000)
  assert.ok(hint.includes('类型/簇'), 'full 档应列类型目录')
  assert.ok(hint.length > 130)
  assert.ok(renderHintFull({ dataDir: dir }, 2000).includes('类型/簇'))
})

check('预算裁剪：cap 很小时不超长', () => {
  const hint = renderHint({ dataDir: dir, hintMode: 'slim', hintSkills: true }, 100)
  assert.ok(hint.length <= 100)
})

console.log('')
console.log(`结果：通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exit(1)
