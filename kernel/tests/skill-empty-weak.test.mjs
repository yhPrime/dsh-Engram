/**
 * 技能命中但经验候选为空时的 weak 口径（终验 O1）：
 * 只有技能、没有经验候选 → weak=true，note 明说「经验候选为空，别当参考」。
 *
 * Run: node tests/skill-empty-weak.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createSkill } from '../skills.js'
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-skill-empty-'))
createSkill(dir, {
  slug: 'sonner-toast',
  name: 'sonner-toast',
  description: 'Sonner toast 通知组件样式定制：位置、颜色、动画与关闭行为',
  body: '# 何时用\nSonner toast 通知组件样式定制',
})
const tools = buildTools((definition) => definition, { dataDir: dir, autoBind: false })
const call = (name, args) => tools.find((item) => item.name === name).execute(args)

check('技能命中且经验候选为空：weak=true 且 note 明说', () => {
  const recalled = call('exp_recall', { intent: 'Sonner toast 通知组件样式定制' })
  assert.ok(recalled.skill, `应命中技能，实际 mode=${recalled.mode}`)
  assert.equal((recalled.candidates || []).length, 0)
  assert.equal(recalled.weak, true)
  assert.ok(String(recalled.note || '').includes('经验候选为空'), recalled.note)
})

console.log('')
console.log(`结果：通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exit(1)
