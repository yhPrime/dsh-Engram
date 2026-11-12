/**
 * P3-A（0.14.0 分片存储）engine 门面测试：`snapshot()` 只读 manifest + 存储用量，不再加载全量经验。
 *
 * 覆盖：
 *  - 迁移后的分片库：exists/bytes/file/manifest/storage 正确，legacy 标记正确，snapshot 不再带 store；
 *  - storage 分项与实际文件字节一致（含 legacy；`storageBytes()` 不含 legacy 是坑）；
 *  - 未迁移的单文件库：manifest=null、bytes 含 exp-lib.json、legacy=false；
 *  - 空目录：exists=false；
 *  - 坏单文件：corrupt=true 且不静默当空库；
 *  - `readHot()` 仍能读行（页面级路径）。
 *
 * Run: node kernel/tests/engine-manifest.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createEngine } from '../engine.js'
import { readManifest } from '../store.js'

const shard = await import('../shard-store.js')

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

function newDir() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'exp-engine-manifest-')), '.exp')
}

/** 写一份合法的旧单文件库（迁移前形态）。 */
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

check('分片库：snapshot 走 manifest+storage，不再返回全量 store', () => {
  const dataDir = newDir()
  const engine = createEngine({ dataDir })
  engine.record({ intent: '给插件跑测试', action: '先跑 npm test', outcome: 'success', type: '代码 / 插件' })
  const snap = engine.snapshot()
  assert.equal(snap.exists, true)
  assert.equal(snap.corrupt, false)
  assert.equal(snap.parseError, '')
  assert.ok(snap.manifest !== null && typeof snap.manifest === 'object', 'manifest 应该读出来')
  assert.equal(snap.manifest.schema, 2)
  assert.ok(String(snap.file).endsWith('manifest.json'), `file 应指向 manifest：${snap.file}`)
  assert.ok(snap.bytes > 0)
  assert.equal('store' in snap, false, 'snapshot 不该再返回全量 store（P3-A）')
  assert.equal('experiences' in snap, false, 'snapshot 不该返回经验数组')
})

check('分片库：storage 分项齐全且与文件字节一致', () => {
  const dataDir = newDir()
  const engine = createEngine({ dataDir })
  engine.record({ intent: '给插件跑测试', action: '先跑 npm test', outcome: 'success', type: '代码 / 插件' })
  const { storage } = engine.snapshot()
  for (const key of ['manifestBytes', 'bucketBytes', 'bucketFiles', 'coldBytes', 'coldFiles', 'fileCount', 'totalBytes']) {
    assert.equal(typeof storage[key], 'number', `storage.${key} 应为数字`)
  }
  // 全新目录第一次写：直接落分片，没有旧库可迁移 → legacy 不存在
  assert.ok(storage.manifestBytes > 0)
  assert.ok(storage.bucketFiles >= 1)
  assert.ok(storage.bucketBytes > 0)
  assert.equal(storage.coldBytes, 0)
  assert.equal(storage.coldFiles, 0)
  assert.equal(storage.legacy.exists, false)
  assert.equal(storage.legacy.bytes, 0)
  // 分项和 == 总字节（single 不存在）
  const sum = storage.manifestBytes + storage.bucketBytes + storage.coldBytes + storage.legacy.bytes
  assert.equal(storage.totalBytes, sum)
  // fileCount = manifest 1 + 桶 + 冷档 + legacy 0
  assert.equal(storage.fileCount, 1 + storage.bucketFiles + storage.coldFiles)
})

check('迁移老库：legacy 被保留、storage 里能看到它', () => {
  const dataDir = newDir()
  const made = writeSingleFileStore(dataDir)
  const engine = createEngine({ dataDir })
  engine.record({ intent: '写一条旧库的经验', action: '直接写 exp-lib.json', outcome: 'success', type: '未分类' })
  const { storage, bytes } = engine.snapshot()
  assert.equal(storage.legacy.exists, true, '迁移会把 exp-lib.json 改名成 legacy')
  assert.equal(storage.legacy.bytes, made.bytes)
  assert.ok(storage.bucketFiles >= 1)
  assert.ok(bytes >= made.bytes)
  assert.equal(storage.fileCount, 1 + storage.bucketFiles + storage.coldFiles + 1)
})

check('分片库：updatedAt 取 manifest（D1 后没有就是 null，不编时间）', () => {
  const dataDir = newDir()
  const engine = createEngine({ dataDir })
  engine.record({ intent: '给插件跑测试', action: '先跑 npm test', outcome: 'success', type: '代码 / 插件' })
  const snap = engine.snapshot()
  assert.ok(snap.updatedAt === null || typeof snap.updatedAt === 'string')
  assert.equal(snap.updatedAt, null, 'buildManifest 不写 updated_at（D1）')
})

check('readHot 仍能读行（页面级路径）', () => {
  const dataDir = newDir()
  const engine = createEngine({ dataDir })
  engine.record({ intent: '给插件跑测试', action: '先跑 npm test', outcome: 'success', type: '代码 / 插件' })
  const store = engine.readHot()
  assert.equal(store.experiences.length, 1)
  assert.ok(Array.isArray(store.types) && store.types.length >= 1)
  assert.ok(Array.isArray(store.clusters))
})

check('readHot 走只读缓存路径：写盘后立刻读到新数据（缓存必须失效）', () => {
  const dataDir = newDir()
  const engine = createEngine({ dataDir })
  engine.record({ intent: '给插件跑测试', action: '先跑 npm test', outcome: 'success', type: '代码 / 插件' })
  assert.equal(engine.readHot().experiences.length, 1)
  engine.record({ intent: '再记一条', action: '写第二个测试', outcome: 'success', type: '代码 / 插件' })
  assert.equal(engine.readHot().experiences.length, 2, '写路径不能让只读缓存返回旧对象')
})

check('未迁移单文件库：manifest=null、bytes 含 exp-lib.json、legacy=false', () => {
  const dataDir = newDir()
  const made = writeSingleFileStore(dataDir)
  const engine = createEngine({ dataDir })
  const snap = engine.snapshot()
  assert.equal(snap.manifest, null)
  assert.equal(snap.exists, true)
  assert.equal(snap.file.replace(/\\/g, '/').endsWith('exp-lib.json'), true)
  assert.equal(snap.bytes, made.bytes)
  assert.equal(snap.storage.legacy.exists, false)
  assert.equal(snap.storage.legacy.bytes, 0)
  assert.equal(snap.storage.single.exists, true)
  assert.equal(snap.storage.fileCount, 1)
  assert.equal(engine.readHot().experiences.length, 1)
})

check('空目录：exists=false、storage 全 0、readHot 空库', () => {
  const dataDir = newDir()
  const engine = createEngine({ dataDir })
  const snap = engine.snapshot()
  assert.equal(snap.exists, false)
  assert.equal(snap.manifest, null)
  assert.equal(snap.bytes, 0)
  assert.equal(snap.storage.fileCount, 0)
  assert.equal(snap.storage.totalBytes, 0)
  assert.deepEqual(engine.readHot().experiences, [])
})

check('坏的单文件库：corrupt=true、parseError 非空（不静默当空库）', () => {
  const dataDir = newDir()
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'exp-lib.json'), '{ 这不是 JSON', 'utf8')
  const engine = createEngine({ dataDir })
  const snap = engine.snapshot()
  assert.equal(snap.corrupt, true)
  assert.ok(String(snap.parseError).length > 0)
  assert.equal(snap.exists, true)
})

check('storageUsage 已落地时：field 形状与 engine 归一化一致', () => {
  if (typeof shard.storageUsage !== 'function') {
    throw new Error('G7 storageUsage 尚未导出——本项在 P1 尾部落地的下一轮会自动生效（当前用 engine 本地换算，其余断言仍有效）')
  }
  const dataDir = newDir()
  writeSingleFileStore(dataDir)
  const engine = createEngine({ dataDir })
  engine.record({ intent: '写一条旧库的经验', action: '直接写 exp-lib.json', outcome: 'success', type: '未分类' })
  const usage = shard.storageUsage(dataDir)
  for (const key of ['manifestBytes', 'bucketBytes', 'bucketFiles', 'coldBytes', 'coldFiles', 'fileCount', 'totalBytes']) {
    assert.equal(typeof usage[key], 'number', `storageUsage.${key} 应为数字`)
  }
  assert.ok(usage.legacy !== null && typeof usage.legacy === 'object', 'storageUsage.legacy 必须存在（含 exists/bytes）')
  assert.equal(typeof usage.legacy.exists, 'boolean')
  assert.equal(typeof usage.legacy.bytes, 'number')
  const snap = engine.snapshot()
  assert.equal(snap.storage.totalBytes, usage.totalBytes)
  assert.equal(snap.storage.legacy.exists, true)
  assert.equal(snap.storage.legacy.bytes, usage.legacy.bytes)
})

check('coldList：无冷档返回空结构（安全阀常态，不报错）', () => {
  const dataDir = newDir()
  const engine = createEngine({ dataDir })
  engine.record({ intent: '给冷档测试写一条热档', action: '普通记录', outcome: 'success', type: '代码 / 插件' })
  assert.deepEqual(engine.coldList(), { years: [], total: 0, samples: [] })
  assert.deepEqual(engine.coldList({ limit: 0 }), { years: [], total: 0, samples: [] })
})

/** 在已迁移的分片库上手工登记一份冷档（模拟容量安全阀触发后的形态）。 */
function writeColdFixture(dataDir, rows) {
  const coldDir = shard.coldPath(dataDir)
  fs.mkdirSync(coldDir, { recursive: true })
  const file = 'cold/2026-a.jsonl'
  fs.writeFileSync(path.join(dataDir, file), rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8')
  const manifest = readManifest(dataDir)
  manifest.cold = { years: [{ year: 2026, files: [{ file, count: rows.length, bytes: fs.statSync(path.join(dataDir, file)).size }] }] }
  shard.writeManifest(dataDir, manifest)
  return manifest
}

check('coldList：有冷档返回年档/条数/大小 + 前 N 条摘要（只读）', () => {
  const dataDir = newDir()
  const engine = createEngine({ dataDir })
  engine.record({ intent: '热档一条', action: '普通记录', outcome: 'success', type: '代码 / 插件' })
  const coldRows = [
    { id: 'ex_cold_1', intent: '旧任务一：给课件插页', typeName: 'PPT / 课件', lastSeenAt: '2026-01-08T09:30:00.000Z' },
    { id: 'ex_cold_2', intent: '旧任务二：整理文档', typeName: '文档 / 教案', lastSeenAt: '2026-01-05T14:10:00.000Z' },
  ]
  writeColdFixture(dataDir, coldRows)
  const all = engine.coldList()
  assert.equal(all.years.length, 1)
  assert.equal(all.years[0].year, 2026)
  assert.equal(all.years[0].count, 2)
  assert.ok(all.years[0].bytes > 0)
  assert.equal(all.years[0].files[0].file, 'cold/2026-a.jsonl')
  assert.equal(all.total, 2)
  assert.deepEqual(all.samples, coldRows.map((row) => ({
    id: row.id,
    intent: row.intent,
    typeName: row.typeName,
    lastSeenAt: row.lastSeenAt,
  })))
  const limited = engine.coldList({ limit: 1 })
  assert.equal(limited.samples.length, 1)
  assert.equal(limited.samples[0].id, 'ex_cold_1')
  // 只读：冷档文件与 manifest 的 cold 登记不应被改写。
  assert.equal(fs.readFileSync(path.join(dataDir, 'cold/2026-a.jsonl'), 'utf8').trim().split('\n').length, 2)
  assert.equal(readManifest(dataDir).cold.years[0].files[0].count, 2)
})

check('coldList：冷档登记存在但文件缺失 → 明确报错（不静默当没有）', () => {
  const dataDir = newDir()
  const engine = createEngine({ dataDir })
  engine.record({ intent: '热档一条', action: '普通记录', outcome: 'success', type: '代码 / 插件' })
  const manifest = readManifest(dataDir)
  manifest.cold = { years: [{ year: 2026, files: [{ file: 'cold/2026-a.jsonl', count: 1, bytes: 10 }] }] }
  shard.writeManifest(dataDir, manifest)
  assert.throws(() => engine.coldList(), /分片丢失|分片损坏/)
})

console.log('')
console.log(`结果：通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exit(1)
