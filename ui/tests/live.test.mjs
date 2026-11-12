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

/** 在已迁移的分片库上手工登记一份冷档（模拟容量安全阀触发后的形态）。 */
function writeColdFixture(dataDir, rows) {
  fs.mkdirSync(path.join(dataDir, 'cold'), { recursive: true })
  const rel = 'cold/2026-a.jsonl'
  fs.writeFileSync(path.join(dataDir, rel), rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8')
  const manifestFile = path.join(dataDir, 'manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  manifest.cold = { years: [{ year: 2026, files: [{ file: rel, count: rows.length, bytes: fs.statSync(path.join(dataDir, rel)).size }] }] }
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

check('hot()：坏库给 {store, error}，不再静默当空库', () => {
  const dataDir = newDataDir()
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'exp-lib.json'), '{ 这不是 JSON', 'utf8')
  const source = createLiveSource({ dataDir })
  const hot = source.hot()
  assert.deepEqual(hot.store.experiences, [], '坏档仍要给可渲染的空 store')
  assert.equal(hot.error.code, 'store-unreadable')
  assert.ok(hot.error.message.length > 0)
  assert.ok(String(hot.error.file).endsWith('manifest.json'), `error.file 应是 manifest 路径：${hot.error.file}`)
})

check('coldRows：分页/检索/年份；无冷档返回空结构', () => {
  const dataDir = newDataDir()
  const engine = createEngine({ dataDir })
  engine.record({ intent: '热档一条', action: '普通记录', outcome: 'success', type: '代码 / 插件' })
  const source = createLiveSource({ dataDir })
  assert.deepEqual(source.coldRows(), { total: 0, rows: [], years: [] })
  writeColdFixture(dataDir, [
    { id: 'ex_cold_1', intent: '旧任务一：给课件插页', action: '复制相邻页', typeName: 'PPT / 课件', outcome: 'failed', G: -0.6, lastSeenAt: '2026-01-08T09:30:00.000Z' },
    { id: 'ex_cold_2', intent: '旧任务二：整理文档', action: '逐段复述', typeName: '文档 / 教案', outcome: 'corrected', G: -0.4, lastSeenAt: '2026-01-05T14:10:00.000Z' },
  ])
  const all = source.coldRows()
  assert.equal(all.total, 2)
  assert.equal(all.years[0].year, 2026)
  assert.equal(all.years[0].count, 2)
  assert.deepEqual(all.rows.map((row) => row.id), ['ex_cold_1', 'ex_cold_2'])
  assert.equal(all.rows[0].action, '复制相邻页')
  assert.equal(all.rows[0].G, -0.6)
  assert.equal(all.rows[0].outcome, 'failed')
  assert.equal(all.rows[0].lastSeenAt, '2026-01-08T09:30:00.000Z')

  const page = source.coldRows({ offset: 1, limit: 1 })
  assert.equal(page.total, 2)
  assert.deepEqual(page.rows.map((row) => row.id), ['ex_cold_2'])
  assert.equal(source.coldRows({ year: 2026 }).total, 2)
  assert.equal(source.coldRows({ year: 2025 }).total, 0)
  assert.equal(source.coldRows({ query: '文档' }).total, 1)
  assert.equal(source.coldRows({ query: 'PPT' }).total, 1)
  assert.equal(source.coldRows({ query: '完全没有' }).total, 0)
})

check('usage.byDay：按本地日期聚合 7 天、chars 求和', () => {
  const dataDir = newDataDir()
  fs.mkdirSync(dataDir, { recursive: true })
  const source = createLiveSource({ dataDir })
  const now = new Date()
  const keyOf = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  const past = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 3, 10, 0, 0)
  const rows = [
    { at: now.toISOString(), tool: 'exp_recall', ok: true, chars: 120 },
    { at: now.toISOString(), tool: 'exp_record', ok: true, chars: 80 },
    { at: past.toISOString(), tool: 'exp_feedback', ok: true, chars: 30 },
    { at: new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30).toISOString(), tool: 'exp_recall', chars: 999 },
  ]
  fs.writeFileSync(path.join(dataDir, 'usage.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8')
  const usage = buildState(source).usage
  assert.equal(usage.byDay.length, 7)
  assert.equal(usage.byDay[6].date, keyOf(now))
  assert.equal(usage.byDay[6].count, 2)
  assert.equal(usage.byDay[6].chars, 200)
  assert.equal(usage.byDay[3].date, keyOf(past))
  assert.equal(usage.byDay[3].count, 1)
  assert.equal(usage.byDay[3].chars, 30)
  // 30 天前那行不进 7 日窗口，但仍在 total 里
  assert.equal(usage.total, 4)
})

console.log('')
console.log(`结果：通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exit(1)
