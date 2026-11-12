/**
 * 残渣修复工具测试：只清洗 intent/action/note，不动 G / outcome / hits / 类型；幂等；
 * 清洗后会变空的条目跳过、不写坏。
 * Run: node tests/fix-residue.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { fixResidue, RESIDUE_RE } from '../tools/fix-residue.mjs'
import { readStore, visibleExperiences } from '../store.js'

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

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-residue-'))
  const store = readStore(dir)
  // 直接造脏数据：exp_record 写入时会清洗，真实残渣来自更早的版本或工具调用串味。
  store.experiences.push({
    id: 'ex_dirty000001',
    ts: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    hits: 2,
    intent: '修自写经验库插件的召回</note>',
    action: '改 scoreOf',
    state: {},
    step_rewards: [0.8],
    G: 0.8,
    outcome: 'success',
    note: '正文<parameter name="type">PPT / 课件',
    origin: 'manual',
    typeId: 'ty_other',
    typeName: '未分类',
    deleted_at: null,
    superseded_by: null,
  })
  return { dir, store }
}

check('RESIDUE_RE 与 audit 同口径：note 标签与 parameter 残渣都命中', () => {
  assert.equal(RESIDUE_RE.test('</note>'), true)
  assert.equal(RESIDUE_RE.test('<parameter name="type">x'), true)
  assert.equal(RESIDUE_RE.test('正常文字'), false)
})

check('清洗 intent / note，不动 G / outcome / hits / 类型 / id', () => {
  const { store } = freshStore()
  const { changed, skipped } = fixResidue(store)
  assert.deepEqual(skipped, [])
  assert.deepEqual(changed, [{ id: 'ex_dirty000001', fields: ['intent', 'note'] }])
  const item = store.experiences[0]
  assert.equal(item.intent, '修自写经验库插件的召回')
  assert.equal(item.note, '正文')
  assert.equal(item.G, 0.8)
  assert.equal(item.outcome, 'success')
  assert.equal(item.hits, 2)
  assert.equal(item.typeName, '未分类')
  assert.equal(item.id, 'ex_dirty000001')
  assert.equal(RESIDUE_RE.test(`${item.intent}\n${item.action}\n${item.note}`), false)
})

check('幂等：再跑一次没有可改的', () => {
  const { store } = freshStore()
  fixResidue(store)
  const second = fixResidue(store)
  assert.deepEqual(second.changed, [])
  assert.deepEqual(second.skipped, [])
})

check('清洗后 intent 会变空的条目跳过，不写坏', () => {
  const { store } = freshStore()
  store.experiences.push({
    ...store.experiences[0],
    id: 'ex_pure_residue',
    intent: '<parameter name="intent">只有残渣',
    action: '做法',
  })
  const { changed, skipped } = fixResidue(store)
  assert.equal(changed.some((item) => item.id === 'ex_pure_residue'), false)
  assert.equal(skipped.some((item) => item.id === 'ex_pure_residue'), true)
  assert.match(store.experiences.find((item) => item.id === 'ex_pure_residue').intent, /parameter/)
})

check('已删/被取代的条目不在修正范围内（只治可见条目）', () => {
  const { store } = freshStore()
  store.experiences.push({
    ...store.experiences[0],
    id: 'ex_hidden',
    intent: '旧条目</note>',
    superseded_by: 'ex_newer',
  })
  const { changed } = fixResidue(store)
  assert.equal(changed.some((item) => item.id === 'ex_hidden'), false)
  assert.equal(visibleExperiences(store).some((item) => item.id === 'ex_hidden'), false)
})

try {
  // 临时目录由 freshStore 逐个创建，测试结束统一交给系统临时目录清理。
} catch {}

console.log('')
console.log(`结果：通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exit(1)
