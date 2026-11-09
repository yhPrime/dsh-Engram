/**
 * 「归纳提示」v2（一句提示）测试：
 *  - 样本不足不输出；同族够了才给；
 *  - 只输出一句（不含换行），带同族计数；全成功时明说归纳不出哪种更好；
 *  - 跨类型取样本最多的族；同一 evidence 去重；确定性；字数上限；
 *  - 工具层：exp_recall 带 induction，config.induction=false 时没有。
 * Run: node tests/induction.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { buildInduction, readStore, upsertExperience, writeStore } from '../store.js'
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

const row = (id, typeName, action, G, note = '', similarity = 0.5) => ({
  id, typeName, action, G, note, similarity, outcome: G > 0 ? 'success' : 'failed',
})
const cand = (action, evidence) => ({ action, evidence })

check('样本不足（2 条 < 3）：不输出', () => {
  const out = buildInduction([cand('a', [row('e1', 'PPT / 课件', '做法一', 0.8), row('e2', 'PPT / 课件', '做法二', 0.8)])])
  assert.equal(out, null)
})

check('3 条同族（2 正 1 负）：一句提示、带计数、要求自己归纳', () => {
  const out = buildInduction([
    cand('x', [row('e1', 'PPT / 课件', '先定主题色', 0.8)]),
    cand('y', [row('e2', 'PPT / 课件', '先排版后调色', 0.8)]),
    cand('z', [row('e3', 'PPT / 课件', '直接套模板', -0.6, '页脚错位')]),
  ])
  assert.equal(out.includes('\n'), false, '必须是一句，不带换行')
  assert.ok(out.includes('本次可见 3 条'))
  assert.ok(out.includes('正回报 2｜负回报 1'))
  assert.ok(out.includes('先自己写一句共性'))
  assert.ok(out.includes('别把这里当成结论'))
  assert.ok(out.length <= 160, `len=${out.length}`)
})

check('全正回报：计数照实给（0 负回报），不额外加免责话术', () => {
  const out = buildInduction([
    cand('x', [row('e1', 'PPT / 课件', '做法一', 0.8)]),
    cand('y', [row('e2', 'PPT / 课件', '做法二', 0.8)]),
    cand('z', [row('e3', 'PPT / 课件', '做法三', 1)]),
  ])
  assert.ok(out.includes('正回报 3｜负回报 0'))
  assert.ok(!out.includes('全是正回报样本'), '不再单列免责分支')
})

check('跨类型：取样本最多的那一族', () => {
  const out = buildInduction([
    cand('a', [row('p1', 'PPT / 课件', '甲', 0.8), row('p2', 'PPT / 课件', '乙', 0.8), row('p3', 'PPT / 课件', '丙', 0.8)]),
    cand('b', [row('c1', '代码 / 插件', '丁', 0.8), row('c2', '代码 / 插件', '戊', 0.8)]),
  ])
  assert.ok(out.includes('PPT / 课件'))
  assert.ok(!out.includes('代码 / 插件'))
})

check('同一 evidence 重复出现只算一次', () => {
  const shared = row('e1', 'PPT / 课件', '同一条', 0.8)
  const out = buildInduction([cand('a', [shared]), cand('b', [shared, row('e2', 'PPT / 课件', '另一条', 0.8)])])
  assert.equal(out, null, '去重后只有 2 条，不足门槛')
})

check('确定性：同输入两次一致；maxChars 生效', () => {
  const input = [
    cand('x', [row('e1', 'PPT / 课件', '做法一', 0.8)]),
    cand('y', [row('e2', 'PPT / 课件', '做法二', 0.8)]),
    cand('z', [row('e3', 'PPT / 课件', '做法三', -0.6)]),
  ]
  assert.equal(buildInduction(input), buildInduction(input))
  const short = buildInduction(input, { maxChars: 60 })
  assert.ok(short.length <= 60, `len=${short.length}`)
})

check('工具层：exp_recall 返回 induction；config.induction=false 时不返回', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-induction-'))
  const store = readStore(dir)
  upsertExperience(store, { intent: '给研学课课件插一页过渡页', action: '克隆相邻页再改字', outcome: 'success', type: 'PPT / 课件' })
  upsertExperience(store, { intent: '研学课课件插入过渡页前先核史实', action: '先读史实底稿', outcome: 'success', type: 'PPT / 课件' })
  upsertExperience(store, { intent: '研学课件做一页地图页', action: '直接截图贴上去', outcome: 'failed', type: 'PPT / 课件', note: '字太小' })
  writeStore(dir, store)

  const on = buildTools((definition) => definition, { dataDir: dir })
  const off = buildTools((definition) => definition, { dataDir: dir, induction: false })
  const query = { intent: '研学课课件过渡页', limit: 5 }
  const outOn = on.find((tool) => tool.name === 'exp_recall').execute(query)
  const outOff = off.find((tool) => tool.name === 'exp_recall').execute(query)
  assert.ok(typeof outOn.induction === 'string', `induction=${JSON.stringify(outOn.induction)}`)
  assert.equal(outOn.induction.includes('\n'), false)
  assert.equal(outOff.induction, undefined)
})

console.log('')
console.log(`结果：通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exit(1)
