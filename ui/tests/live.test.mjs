/**
 * live data source × kernel engine 测试（UI 接 engine）
 *  - read() 走 engine.snapshot（只读 manifest + storage，不加载全量经验）；
 *  - hot() 才是页面级热档行读；
 *  - feedback() 真正写回（readOnly=false），返回 G 前后；
 *  - 迁移前（只有 exp-lib.json）与迁移后（manifest + legacy）两种存储状态的 storage 口径；
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
import { buildState } from '../shell.js'

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

/** 写一份迁移前的旧单文件库（真实布局：只有 exp-lib.json）。 */
function writeSingleFileStore(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true })
  const store = {
    version: 1,
    types: [{ id: 'ty_other', name: '未分类', description: '', system: true }],
    experiences: [{
      id: 'ex_single_1',
      ts: '2026-11-12T00:00:00.000Z',
      lastSeenAt: '2026-11-12T00:00:00.000Z',
      hits: 1,
      intent: '写一条旧库的经验',
      action: '直接写 exp-lib.json',
      outcome: 'success',
      G: 0.8,
      GOutcome: 0.8,
      GSource: 'outcome',
      typeId: 'ty_other',
      typeName: '未分类',
    }],
  }
  const file = path.join(dataDir, 'exp-lib.json')
  fs.writeFileSync(file, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
  return { file, bytes: fs.statSync(file).size }
}

check('没有 dataDir：按默认目录兜底，空库不抛错', () => {
  const old = process.env.DSH_HOME
  process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-home-'))
  try {
    const source = createLiveSource({})
    const read = source.read()
    assert.equal(read.exists, false)
    assert.equal(read.manifest, null)
    assert.deepEqual(source.hot().store.experiences, [])
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
  // P3-A：read() 只给 manifest + storage，行数据走 hot()
  assert.ok(read.manifest !== null && typeof read.manifest === 'object')
  assert.ok(String(read.file).endsWith('manifest.json'))
  assert.ok(read.storage && read.storage.bucketFiles >= 1)
  assert.equal(source.hot().store.experiences.length, 1)
  assert.equal(source.readOnly, false)
})

check('feedback 真正写回：G 下降，再读能看到', () => {
  const dataDir = newDataDir()
  const engine = createEngine({ dataDir })
  const made = engine.record({ intent: '给插件跑测试', action: '先跑 npm test', outcome: 'success', type: '代码 / 插件' })
  const source = createLiveSource({ dataDir })
  const receipt = source.feedback(made.id, 'hurt')
  assert.ok(receipt.G_after < receipt.G_before)
  const after = source.hot().store.experiences.find((row) => row.id === made.id)
  assert.equal(after.G, receipt.G_after)
})

check('迁移前（只有 exp-lib.json）：计入总量、legacy=false、single=true', () => {
  const dataDir = newDataDir()
  const made = writeSingleFileStore(dataDir)
  const source = createLiveSource({ dataDir })
  const read = source.read()
  assert.equal(read.exists, true)
  assert.equal(read.manifest, null)
  assert.equal(read.bytes, made.bytes, '未迁移老库的 exp-lib.json 必须计入总量')
  assert.equal(read.storage.legacy.exists, false)
  assert.equal(read.storage.legacy.bytes, 0)
  assert.equal(read.storage.single.exists, true)
  assert.equal(read.storage.single.bytes, made.bytes)
  // /state 与设置页共用同一份 storage（不各算一套）
  assert.equal(buildState(source).bytes, read.bytes)
  assert.deepEqual(buildState(source).storage, read.storage)
})

check('迁移后：legacy=true 且计入 totalBytes（两种状态口径一致）', () => {
  const dataDir = newDataDir()
  const made = writeSingleFileStore(dataDir)
  const engine = createEngine({ dataDir })
  engine.record({ intent: '写一条旧库的经验', action: '直接写 exp-lib.json', outcome: 'success', type: '未分类' })
  const source = createLiveSource({ dataDir })
  const read = source.read()
  assert.ok(read.manifest !== null && typeof read.manifest === 'object')
  assert.equal(read.storage.legacy.exists, true)
  assert.equal(read.storage.legacy.bytes, made.bytes, 'legacy 就是迁移前那份 exp-lib.json')
  assert.ok(read.bytes >= read.storage.legacy.bytes)
  assert.equal(read.storage.single.exists, false)
  assert.equal(buildState(source).bytes, read.bytes)
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
