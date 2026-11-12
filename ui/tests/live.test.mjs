/**
 * live data source × kernel engine 测试（UI 接 engine）
 *  - read() 走 engine.snapshot，不再直接解析 JSON；
 *  - feedback() 真正写回（readOnly=false），返回 G 前后；
 *  - skills() 走 engine.listSkills + 界面映射；
 *  - 没有 dataDir 时按空库兜底。
 * Run: node tests/live.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createEngine } from '../../kernel/engine.js'
import { createLiveSource } from '../live.js'

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

const newDataDir = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'exp-ui-live-')), '.exp')

check('没有 dataDir：按默认目录兜底，空库不抛错', () => {
  const old = process.env.DSH_HOME
  process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-home-'))
  try {
    const source = createLiveSource({})
    const read = source.read()
    assert.equal(read.exists, false)
    assert.deepEqual(read.store.experiences, [])
    assert.ok(read.notice.includes('没有找到经验库文件'))
    assert.equal(source.readOnly, false)
  } finally {
    if (old === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = old
  }
})

check('read 走 engine：能看到 engine 记录的经验', () => {
  const dataDir = newDataDir()
  const engine = createEngine({ dataDir })
  engine.record({ intent: '给插件跑测试', action: '先跑 npm test', outcome: 'success', type: '代码 / 插件' })
  const source = createLiveSource({ dataDir })
  const read = source.read()
  assert.equal(read.exists, true)
  assert.equal(read.store.experiences.length, 1)
  assert.equal(source.readOnly, false)
})

check('feedback 真正写回：G 下降，再读能看到', () => {
  const dataDir = newDataDir()
  const engine = createEngine({ dataDir })
  const made = engine.record({ intent: '给插件跑测试', action: '先跑 npm test', outcome: 'success', type: '代码 / 插件' })
  const source = createLiveSource({ dataDir })
  const receipt = source.feedback(made.id, 'hurt')
  assert.ok(receipt.G_after < receipt.G_before)
  const after = source.read().store.experiences.find((row) => row.id === made.id)
  assert.equal(after.G, receipt.G_after)
})

check('skills 走 engine.listSkills 并映射成界面行', () => {
  const dataDir = newDataDir()
  const engine = createEngine({ dataDir })
  const taskId = 'task-live-skills'
  engine.record({ intent: '给 PPT 插页：一', action: '先克隆相邻页再改字', outcome: 'success', type: 'PPT / 课件', taskId, kind: 'step', stepIndex: 1, stepTotal: 3 })
  engine.record({ intent: '给 PPT 插页：二', action: '先克隆相邻页再重画', outcome: 'success', type: 'PPT / 课件', taskId, kind: 'step', stepIndex: 2, stepTotal: 3 })
  engine.record({ intent: '给 PPT 插页：三', action: '直接套模板不做克隆', outcome: 'failed', type: 'PPT / 课件', taskId, kind: 'step', stepIndex: 3, stepTotal: 3 })
  engine.consolidate({ intent: '给 PPT 插页' })
  const source = createLiveSource({ dataDir })
  const skills = source.skills()
  assert.equal(skills.length, 1)
  assert.ok(skills[0].name.length > 0)
  assert.ok(Array.isArray(skills[0].body) === false && typeof skills[0].body === 'string')
})

console.log('')
console.log(`结果：通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exit(1)
