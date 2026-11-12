/**
 * P3.5（task-9）验收：exp_record 定向写 + 压缩触发。
 *
 * 覆盖：
 *  1. 性能：10x（1280 条）单条记录耗时 ≤ 30ms（P50），与 writeTypeShards 同量级；
 *  2. 写后全量等价（id/G/hits/verdict 逐字段）+ 其它类型分片 mtime/字节不变（证明走的是定向写）；
 *  3. fast/slow 等价：同类型近重复（hits+1）与近似替换（superseded 链）两条路径逐字段一致；
 *  4. partial 路由一致性：manifest.clusters 构造的 store 与全量 readStore 的路由结果逐 intent 相同；
 *  5. manifest.clusters 写后与全量 ensureClusters 逐字段相等；
 *  6. 触顶时触发压缩且守恒、不触顶不产生冷档。
 *
 * Run: node kernel/tests/shard-record.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createEngine } from '../engine.js'
import { ensureClusters, routeCluster, signatureOf } from '../cluster.js'
import { abstractState, abstractStateCacheStats, clearAbstractStateCache } from '../kernel.js'
import { readManifest, readStore, writeStore, upsertExperience } from '../store.js'
import {
  MAX_BUCKET_BYTES,
  bucketsPath,
  coldPath,
  readShardRecordsOfTypes,
  writeTypeShards,
} from '../shard-store.js'

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

const now = Date.now()
const at = (days) => new Date(now - days * 86400000).toISOString()
const newDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'exp-shard-record-'))
const body = (n) => '件'.repeat(n)

const PLAN = [
  ['代码 / 插件', 430],
  ['验收 / 判据', 330],
  ['文档 / 教案', 140],
  ['环境 / 部署', 140],
  ['网络 / 心跳', 110],
  ['PPT / 课件', 90],
  ['其他类', 40],
]

/** 造 10x 库（1280 条，约 3 MiB；state 与真实写入一致，签名走快速路径）。 */
function seed10x(dir) {
  const types = PLAN.map(([name], index) => ({ id: `ty_${index}`, name, description: `${name} 描述`, system: false }))
  const experiences = []
  let index = 0
  for (const [name, count] of PLAN) {
    const type = types.find((item) => item.name === name)
    for (let i = 0; i < count; i += 1) {
      const intent = `任务 ${index} ${body(30)}`
      const action = `做法 ${index} ${body(200)}`
      const G = index % 11 === 0 ? -0.6 : 0.8
      experiences.push({
        id: `ex_${String(index).padStart(5, '0')}`,
        taskId: `ex_${String(index).padStart(5, '0')}`,
        kind: 'task',
        intent,
        action,
        note: body(450),
        ts: at(Math.floor(index / 30)),
        lastSeenAt: at(Math.floor(index / 30)),
        hits: 1,
        G,
        GOutcome: G,
        GSource: 'outcome',
        outcome: G > 0 ? 'success' : 'failed',
        state: abstractState(intent, action),
        step_rewards: [G],
        typeId: type.id,
        typeName: type.name,
        verdict: 'decided',
      })
      index += 1
    }
  }
  writeStore(dir, { version: 1, types, experiences })
  return { types, experiences }
}

/** 小库种子（用于 fast/slow 等价、压缩触发）。 */
function seedSmall(dir, options = {}) {
  const types = [
    { id: 'ty_code', name: '代码 / 插件', description: '写代码', system: false },
    { id: 'ty_ppt', name: 'PPT / 课件', description: '做课件', system: false },
  ]
  const experiences = options.experiences || []
  if (experiences.length === 0) {
    for (let index = 0; index < 6; index += 1) {
      const type = types[index % 2]
      const intent = `任务 ${index}：给课件插页`
      const action = `做法 ${index} ${body(60)}`
      experiences.push({
        id: `ex_seed_${index}`,
        taskId: `ex_seed_${index}`,
        kind: 'task',
        intent,
        action,
        ts: at(index),
        lastSeenAt: at(index),
        hits: 1,
        G: 0.8,
        GOutcome: 0.8,
        GSource: 'outcome',
        outcome: 'success',
        state: abstractState(intent, action),
        step_rewards: [0.8],
        typeId: type.id,
        typeName: type.name,
        verdict: 'decided',
      })
    }
  }
  writeStore(dir, { version: 1, types, experiences })
  return { types, experiences }
}

const filesOf = (dir) => {
  const out = new Map()
  let names = []
  try {
    names = fs.readdirSync(bucketsPath(dir)).filter((name) => name.endsWith('.jsonl')).sort()
  } catch {
    names = []
  }
  for (const name of names) {
    const full = path.join(bucketsPath(dir), name)
    out.set(name, { mtimeMs: fs.statSync(full).mtimeMs, bytes: fs.statSync(full).size })
  }
  return out
}

const timeIt = (fn) => {
  const t0 = process.hrtime.bigint()
  const value = fn()
  return [Number(process.hrtime.bigint() - t0) / 1e6, value]
}

/**
 * 性能 / 结构判据（Lead 2026-11-12 定稿 v2）：
 *  - 主判据是**结构性**的：快路径只读目标类型的 1–2 个分片（+至多 1 个 pending 类型），
 *    写入只动目标类型桶 + manifest；不依赖机器速度。
 *  - 次判据是时间：fast P50 ≤ 同轮 writeTypeShards P50 × 3.5，绝对兜底 ≤150ms。
 *  - 测量条件：autoBind:false（不含 session binding）、DSH_HOME 隔离；并发下绝对值会漂 2–3×。
 */
check('结构判据：快路径只读目标类型分片、写入只动目标类型桶 + manifest', () => {
  const dir = newDir()
  seed10x(dir)
  const manifest = readManifest(dir)
  const totalBuckets = manifest.buckets.length
  const targetType = manifest.types.find((type) => type.name === '代码 / 插件')
  assert.ok(targetType !== undefined)
  const targetTypeId = String(targetType.id)
  const engine = createEngine({ dataDir: dir, config: { autoBind: false, usageLog: false } })
  engine.record({ intent: '预热任务 给课件插页', action: '预热做法', outcome: 'success', type: '代码 / 插件' })
  // 记录一次真实写入碰过的文件（只用于测量，不进实现）。
  const readPaths = []
  const writePaths = []
  const originalRead = fs.readFileSync
  const originalWrite = fs.writeFileSync
  const originalRename = fs.renameSync
  fs.readFileSync = function patchedRead(file, ...rest) {
    readPaths.push(String(file))
    return originalRead.call(fs, file, ...rest)
  }
  fs.writeFileSync = function patchedWrite(file, ...rest) {
    writePaths.push(String(file))
    return originalWrite.call(fs, file, ...rest)
  }
  fs.renameSync = function patchedRename(from, to) {
    writePaths.push(String(to))
    return originalRename.call(fs, from, to)
  }
  try {
    engine.record({ intent: '结构判据：给课件插一页', action: '结构判据做法', outcome: 'success', type: '代码 / 插件' })
  } finally {
    fs.readFileSync = originalRead
    fs.writeFileSync = originalWrite
    fs.renameSync = originalRename
  }
  const normalize = (file) => String(file).replace(/\\/g, '/')
  const bucketReads = [...new Set(readPaths.filter((file) => normalize(file).includes('/buckets/')))].map(normalize)
  const bucketWrites = [...new Set(writePaths.filter((file) => normalize(file).includes('/buckets/') && normalize(file).endsWith('.jsonl')))].map(normalize)
  const manifestWrites = writePaths.filter((file) => normalize(file).endsWith('/manifest.json'))
  console.log(`       结构读数：读分片 ${bucketReads.length}/${totalBuckets} 个｜写分片 ${bucketWrites.length} 个｜manifest 写 ${manifestWrites.length} 次｜缓存命中 ${abstractStateCacheStats().hits}`)
  // 主判据 1：只读目标类型的 1–2 个分片（+ 至多 1 个 pending 类型分片 → 上限 3）
  assert.ok(bucketReads.length > 0, '快路径必须至少读目标类型分片')
  assert.ok(bucketReads.length <= 3, `快路径最多读 3 个分片（目标 1-2 + pending 至多 1），实际 ${bucketReads.length}`)
  assert.ok(bucketReads.length < totalBuckets, `快路径不能读全部分片（实际 ${bucketReads.length}/${totalBuckets}）`)
  for (const file of bucketReads) {
    assert.ok(file.includes(`${targetTypeId}.`), `只该读目标类型分片（${targetTypeId}），实际读了 ${file}`)
  }
  // 主判据 2：写入只动目标类型桶 + manifest
  assert.ok(bucketWrites.length > 0, '必须写入目标类型桶')
  for (const file of bucketWrites) {
    assert.ok(file.includes(`${targetTypeId}.`), `只该写目标类型分片，实际写了 ${file}`)
  }
  assert.ok(manifestWrites.length >= 1, 'manifest 必须写')
})

check('次判据：fast P50 ≤ writeTypeShards P50 × 3.5，且 ≤150ms 兜底', () => {
  const dir = newDir()
  seed10x(dir)
  const shardCopy = newDir()
  writeStore(shardCopy, readStore(dir))
  const statsOf = (samples) => {
    const sorted = [...samples].sort((left, right) => left - right)
    return { min: sorted[0], p50: sorted[Math.floor(sorted.length / 2)] }
  }
  // 定向写基线：改该类型一条 → writeTypeShards。
  const shardRows = readShardRecordsOfTypes(shardCopy, readManifest(shardCopy), ['ty_0']).records
  const writeShardSamples = []
  for (let index = 0; index < 5; index += 1) {
    shardRows[0].note = `${shardRows[0].note}改`
    writeShardSamples.push(timeIt(() => writeTypeShards(shardCopy, readManifest(shardCopy), { touchedTypeIds: ['ty_0'], rowsByType: { ty_0: shardRows } }))[0])
  }
  const writeShardStats = statsOf(writeShardSamples)
  // 被测：exp_record 快路径（3 批 × 20 次；每批报 min + P50）。
  const engine = createEngine({ dataDir: dir, config: { autoBind: false, usageLog: false } })
  engine.record({ intent: '预热任务 给课件插页', action: '预热做法', outcome: 'success', type: '代码 / 插件' })
  const batchMin = []
  const batchP50 = []
  for (let batch = 0; batch < 3; batch += 1) {
    const times = []
    for (let index = 0; index < 20; index += 1) {
      times.push(timeIt(() => engine.record({
        intent: `新任务 ${batch}-${index} 给课件插页`,
        action: `新做法 ${batch}-${index}`,
        outcome: 'success',
        type: '代码 / 插件',
      }))[0])
    }
    const stats = statsOf(times)
    batchMin.push(stats.min)
    batchP50.push(stats.p50)
  }
  const fastStats = { min: Math.min(...batchMin), p50: [...batchP50].sort((left, right) => left - right)[Math.floor(batchP50.length / 2)] }
  const fmt = (value) => `${value.toFixed(1)}ms`
  console.log(`       ${'路径'.padEnd(18)}min       P50`)
  console.log(`       writeTypeShards   ${fmt(writeShardStats.min).padEnd(9)} ${fmt(writeShardStats.p50)}（定向写基线）`)
  console.log(`       exp_record(fast)  ${fmt(fastStats.min).padEnd(9)} ${fmt(fastStats.p50)}（3 批 P50：[${batchP50.map((value) => value.toFixed(1)).join(', ')}]）`)
  console.log(`       比值 P50 fast/writeTypeShards = ${(fastStats.p50 / writeShardStats.p50).toFixed(2)}×｜摘要缓存 ${JSON.stringify(abstractStateCacheStats())}`)
  console.log('       测量条件：autoBind:false（不含 session binding）、DSH_HOME 隔离；并发负载下绝对值会漂 2–3×。')
  assert.ok(fastStats.p50 <= writeShardStats.p50 * 3.5, `fast P50 ${fmt(fastStats.p50)} 应 ≤ writeTypeShards P50 ${fmt(writeShardStats.p50)} × 3.5`)
  assert.ok(fastStats.p50 <= 150, `fast P50 ${fmt(fastStats.p50)} 应 ≤ 150ms 兜底（拦住退回 315ms 的退化）`)
  assert.ok(abstractStateCacheStats().hits > 0, 'abstractState 缓存应在批量写入时命中')
})

check('abstractState 缓存：冷/暖结果逐字段一致（缓存只加速、不改语义）', () => {
  const pure = (() => {
    clearAbstractStateCache()
    const cold = abstractState('同一意图：给课件插一页', '做法：先克隆')
    const warm = abstractState('同一意图：给课件插一页', '做法：先克隆')
    return { cold, warm, hit: abstractStateCacheStats().hits }
  })()
  assert.deepEqual(pure.cold, pure.warm, '缓存命中返回的 state 必须与冷算逐字段一致')
  assert.ok(pure.hit >= 1)
  // 集成：同一份种子，冷缓存 vs 暖缓存各记一条**新做法**（会走 replaceTarget 逐行比较 intent），
  // 结果逐字段一致；暖缓存应命中更多。
  const run = (warmCache) => {
    const dir = newDir()
    const { experiences } = seedSmall(dir)
    const target = experiences[0]
    clearAbstractStateCache()
    if (warmCache) {
      // 预热：把目标类型所有行的 intent 先算一遍（模拟上一次记录留下的缓存）
      for (const row of readStore(dir).experiences) abstractState(row.intent)
    }
    const engine = createEngine({ dataDir: dir, config: { autoBind: false, usageLog: false } })
    const receipt = engine.record({ intent: '全新任务：给课件插一页过渡页', action: '全新做法：直接套模板', outcome: 'success', type: target.typeName })
    const row = readStore(dir).experiences.find((item) => item.id === receipt.id)
    return { hits: abstractStateCacheStats().hits, row }
  }
  const cold = run(false)
  const warm = run(true)
  assert.ok(warm.hits > cold.hits, `暖缓存应命中更多（冷 ${cold.hits} / 暖 ${warm.hits}）`)
  for (const key of ['hits', 'G', 'GOutcome', 'outcome', 'verdict', 'typeId', 'superseded_by', 'deleted_at']) {
    assert.deepEqual(warm.row[key], cold.row[key], `缓存冷/暖的 ${key} 必须一致`)
  }
  assert.deepEqual(warm.row.feedback_log, cold.row.feedback_log)
  assert.deepEqual(warm.row.state, cold.row.state, '记录里的 state 必须一致')
})

check('签名复用 row.state vs 重算：逐字段一致；缺 state / 空壳 state 必须回退重算', () => {
  const rows = [
    { intent: '给研学课 PPT 插一页', action: '先克隆相邻页再改字' },
    { intent: '把插件发布到 GitHub', action: '先打 tag 再推' },
    { intent: '改 PPT 页码', action: '用页脚工具重排' },
  ]
  const withState = rows.map((row) => ({ ...row, state: abstractState(row.intent, row.action) }))
  const withoutState = rows.map((row) => ({ ...row }))
  const emptyState = rows.map((row) => ({ ...row, state: { tokens: [], cgrams: [], artifacts: [] } }))
  const fromState = signatureOf(withState)
  const fromText = signatureOf(withoutState)
  const fromEmpty = signatureOf(emptyState)
  assert.deepEqual(fromState, fromText, '有 state 与无 state（重算）的签名必须逐字段一致')
  assert.deepEqual(fromEmpty, fromText, '空壳 state 必须回退重算，不能当成空签名')
  assert.ok(fromText.tokens.length > 0 && fromText.cgrams.length > 0, '签名不能为空')
})

check('写后全量等价 + 其它类型分片 mtime/字节不变（证明走定向写）', () => {
  const dir = newDir()
  const { experiences } = seed10x(dir)
  const before = readStore(dir)
  const beforeRows = new Map(before.experiences.map((row) => [row.id, JSON.stringify(row)]))
  const filesBefore = filesOf(dir)
  const engine = createEngine({ dataDir: dir, config: { autoBind: false, usageLog: false } })
  const receipt = engine.record({ intent: '新增：给课件插一页过渡页', action: '克隆相邻页再改字', outcome: 'success', type: 'PPT / 课件' })
  assert.equal(receipt.action, 'added')
  assert.equal(receipt.count, experiences.length + 1, '回执条数应来自写后 manifest.stats.visible')
  const after = readStore(dir)
  assert.equal(after.experiences.length, experiences.length + 1)
  // 既有行逐字段不变
  for (const row of after.experiences) {
    if (row.id === receipt.id) continue
    assert.equal(JSON.stringify(row), beforeRows.get(row.id), `既有记录 ${row.id} 必须逐字段不变`)
  }
  const added = after.experiences.find((row) => row.id === receipt.id)
  assert.equal(added.intent, '新增：给课件插一页过渡页')
  assert.equal(added.action, '克隆相邻页再改字')
  assert.equal(added.outcome, 'success')
  assert.equal(Number(added.G), 0.8)
  assert.equal(added.hits, 1)
  assert.equal(added.verdict, 'decided')
  assert.equal(added.typeName, 'PPT / 课件')
  // 其它类型分片不动（慢路径 writeStore 会重写全部桶 → mtime 会变）
  const filesAfter = filesOf(dir)
  for (const [name, snapshot] of filesBefore) {
    if (name.startsWith('ty_5.')) continue // PPT 类型（ty_app 索引 5）
    const next = filesAfter.get(name)
    assert.ok(next !== undefined, `${name} 不该消失`)
    assert.equal(next.bytes, snapshot.bytes, `${name} 字节数必须不变`)
    assert.equal(next.mtimeMs, snapshot.mtimeMs, `${name} mtime 必须不变（定向写才可能）`)
  }
  // clusters 与全量重算逐字段相等（Lead 硬要求 #3）。manifest 侧允许有 typeId 索引字段（缓存写法）。
  const manifest = readManifest(dir)
  const fullStore = readStore(dir)
  ensureClusters(fullStore)
  const stripIndex = (clusters) => clusters.map(({ typeId, ...rest }) => rest)
  assert.deepEqual(stripIndex(manifest.clusters), fullStore.clusters, 'manifest.clusters 必须与全量 ensureClusters 逐字段相等')
})

check('partial 路由一致性：manifest.clusters 的 store 与全量 readStore 路由逐 intent 相同', () => {
  const dir = newDir()
  seed10x(dir)
  const manifest = readManifest(dir)
  const full = readStore(dir)
  ensureClusters(full)
  const manifestView = { version: manifest.version, types: manifest.types, clusters: manifest.clusters }
  const intents = []
  for (const type of manifest.types) {
    const rows = readShardRecordsOfTypes(dir, manifest, [type.id]).records
      .filter((row) => row && !row.deleted_at && !row.superseded_by && !row.retired_at)
    for (const row of rows.slice(0, 2)) intents.push({ typeId: type.id, intent: row.intent })
  }
  assert.ok(intents.length >= manifest.types.length * 2, '每个类型至少取 2 条真实 intent')
  let checked = 0
  for (const { typeId, intent } of intents) {
    const fromManifest = routeCluster(manifestView, intent)
    const fromFull = routeCluster(full, intent)
    assert.deepEqual(fromManifest, fromFull, `intent 路由必须一致（type=${typeId}）：${intent.slice(0, 30)}`)
    checked += 1
  }
  assert.ok(checked >= 14, `至少比对 14 条 intent（每个类型 2 条），实际 ${checked}`)
})

check('fast/slow 等价 #1：同类型近重复 → hits+1 等字段逐字段一致', () => {
  const run = (mode) => {
    const dir = newDir()
    const { experiences } = seedSmall(dir)
    const nearIntent = experiences[0].intent
    const nearAction = experiences[0].action
    const typeName = experiences[0].typeName
    if (mode === 'fast') {
      const engine = createEngine({ dataDir: dir, config: { autoBind: false, usageLog: false } })
      engine.record({ intent: nearIntent, action: nearAction, outcome: 'partial', type: typeName })
    } else {
      const store = readStore(dir)
      upsertExperience(store, { intent: nearIntent, action: nearAction, outcome: 'partial', type: typeName })
      writeStore(dir, store)
    }
    return readStore(dir)
  }
  const fast = run('fast')
  const slow = run('slow')
  const pick = (store) => store.experiences.find((row) => row.id === 'ex_seed_0')
  const left = pick(fast)
  const right = pick(slow)
  for (const key of ['hits', 'G', 'GOutcome', 'GSource', 'outcome', 'verdict', 'decidedBy', 'typeId', 'deleted_at', 'superseded_by']) {
    assert.deepEqual(left[key], right[key], `近重复字段 ${key} 必须一致`)
  }
  assert.deepEqual(left.feedback_log, right.feedback_log, 'feedback_log 必须一致')
  assert.equal(left.hits, 2)
  assert.deepEqual(
    fast.experiences.map((row) => `${row.intent}|${row.action}|${row.hits}|${row.G}`).sort(),
    slow.experiences.map((row) => `${row.intent}|${row.action}|${row.hits}|${row.G}`).sort(),
    '整库口径（意图/做法/hits/G）必须一致',
  )
})

check('fast/slow 等价 #2：近似替换 → superseded 链逐字段一致', () => {
  const run = (mode) => {
    const dir = newDir()
    seedSmall(dir)
    const storeBefore = readStore(dir)
    const target = storeBefore.experiences.find((row) => row.id === 'ex_seed_0')
    const newAction = '换了一种更快的做法：直接套模板'
    const intent = target.intent
    let receiptId = ''
    if (mode === 'fast') {
      const engine = createEngine({ dataDir: dir, config: { autoBind: false, usageLog: false } })
      const receipt = engine.record({ intent, action: newAction, outcome: 'success', type: target.typeName })
      receiptId = receipt.id
    } else {
      const store = readStore(dir)
      const result = upsertExperience(store, { intent, action: newAction, outcome: 'success', type: target.typeName })
      receiptId = result.experience.id
      writeStore(dir, store)
    }
    return { store: readStore(dir), receiptId, target }
  }
  const fast = run('fast')
  const slow = run('slow')
  const oldFast = fast.store.experiences.find((row) => row.id === fast.target.id)
  const oldSlow = slow.store.experiences.find((row) => row.id === slow.target.id)
  const newFast = fast.store.experiences.find((row) => row.id === fast.receiptId)
  const newSlow = slow.store.experiences.find((row) => row.id === slow.receiptId)
  assert.ok(oldFast.superseded_by && oldSlow.superseded_by, '旧条必须标 superseded_by')
  assert.equal(oldFast.superseded_by, newFast.id)
  assert.equal(oldSlow.superseded_by, newSlow.id)
  assert.equal(oldFast.supersedes, oldSlow.supersedes)
  assert.equal(newFast.supersedes, oldFast.id)
  assert.equal(newSlow.supersedes, oldSlow.id)
  for (const key of ['hits', 'G', 'GOutcome', 'outcome', 'verdict', 'typeId', 'deleted_at']) {
    assert.deepEqual(newFast[key], newSlow[key], `新条字段 ${key} 必须一致`)
    assert.deepEqual(oldFast[key], oldSlow[key], `旧条字段 ${key} 必须一致`)
  }
  assert.deepEqual(
    oldFast.history.map((event) => ({ type: event.type, reason: event.reason || null })),
    oldSlow.history.map((event) => ({ type: event.type, reason: event.reason || null })),
    '旧条 history 的类型/原因序列必须一致（at/by 是随机 id 与时间戳，不比）',
  )
  assert.deepEqual(oldFast.feedback_log, oldSlow.feedback_log)
})

check('触顶触发压缩：exp_record 写回时压缩只压 touched 类型，守恒且冷档正确', () => {
  const dir = newDir()
  // 造一个单类型大桶：类型 ty_code 下 40 行 × ~300B，用 1KiB 单桶闸触发
  const types = [{ id: 'ty_code', name: '代码 / 插件', description: '写代码', system: false }, { id: 'ty_ppt', name: 'PPT / 课件', description: '做课件', system: false }]
  const experiences = []
  const filler = body(120)
  for (let index = 0; index < 40; index += 1) {
    const intent = `任务 ${index} 给课件插页`
    const action = `做法 ${index} ${filler}`
    const G = index % 3 === 0 ? -0.5 : 0.8
    experiences.push({
      id: `ex_big_${index}`,
      taskId: `ex_big_${index}`,
      kind: 'task',
      intent,
      action,
      ts: at(index % 10),
      lastSeenAt: at(index % 10),
      hits: 1,
      G,
      GOutcome: G,
      GSource: 'outcome',
      outcome: G > 0 ? 'success' : 'failed',
      state: abstractState(intent, action),
      step_rewards: [G],
      typeId: index % 2 === 0 ? 'ty_code' : 'ty_ppt',
      typeName: index % 2 === 0 ? '代码 / 插件' : 'PPT / 课件',
      verdict: 'decided',
    })
  }
  writeStore(dir, { version: 1, types, experiences })
  const before = readStore(dir)
  const visibleBefore = before.experiences.filter((row) => !row.deleted_at && !row.superseded_by && !row.retired_at).length
  const engine = createEngine({ dataDir: dir, config: { autoBind: false, usageLog: false, compactShard: { maxBucketBytes: 2048, hotMaxBytes: 128 * 1024, nMax: 100000, maxRounds: 64 } } })
  engine.record({ intent: '压测新增 给课件插页', action: `压测新增做法 ${filler}`, outcome: 'success', type: '代码 / 插件' })
  const manifest = readManifest(dir)
  const hotBytes = manifest.buckets.reduce((sum, bucket) => sum + (Number(bucket.bytes) || 0), 0)
  // 只压 touched 类型（ty_code）；ty_ppt 没被写，保持原样是设计行为。
  // 「至少留一条」规则下，单条记录本身可能大于桶闸，所以单条桶单独放宽。
  const touchedBuckets = manifest.buckets.filter((bucket) => String(bucket.typeId) === 'ty_code')
  assert.ok(touchedBuckets.length > 0)
  for (const bucket of touchedBuckets) {
    const limit = bucket.count <= 1 ? 8192 : 2048
    assert.ok((Number(bucket.bytes) || 0) <= limit, `touched 类型单桶必须回到闸内，实际 ${bucket.bytes}（${bucket.count} 条）`)
  }
  assert.ok(hotBytes <= 128 * 1024, `热档总量必须回到闸内，实际 ${hotBytes}`)
  const after = readStore(dir)
  const cold = readStoreCold(dir)
  const hotVisible = after.experiences.filter((row) => !row.deleted_at && !row.superseded_by && !row.retired_at).length
  const coldVisible = cold.experiences.filter((row) => !row.deleted_at && !row.superseded_by && !row.retired_at).length
  assert.equal(hotVisible + coldVisible, visibleBefore + 1, '热+冷可见条数必须守恒（含本次新增）')
  assert.ok(cold.experiences.length > 0, '超闸必须真的下沉了记录')
  assert.ok(fs.existsSync(coldPath(dir)), '冷档文件必须存在')
  const backups = fs.existsSync(path.join(dir, '.locks'))
    ? fs.readdirSync(path.join(dir, '.locks')).filter((name) => name.startsWith('compact-') && name.endsWith('.bak'))
    : []
  assert.ok(backups.length > 0, '压缩前必须有备份')
  assert.ok(manifest.clusters.length === manifest.types.length)
})

check('不触顶：exp_record 不产生冷档文件', () => {
  const dir = newDir()
  seedSmall(dir)
  const engine = createEngine({ dataDir: dir, config: { autoBind: false, usageLog: false } })
  engine.record({ intent: '普通新增 给课件插页', action: '普通新增做法', outcome: 'success', type: '代码 / 插件' })
  assert.equal(fs.existsSync(coldPath(dir)), false, '没触顶不该有冷档目录')
  const manifest = readManifest(dir)
  assert.equal(manifest.cold.years.length, 0)
  assert.ok(manifest.buckets.every((bucket) => (Number(bucket.bytes) || 0) <= MAX_BUCKET_BYTES))
})

/** 读冷档（避免在这里引入 store.js 的 readColdStore 循环依赖考虑，直接按 manifest 登记读）。 */
function readStoreCold(dir) {
  const manifest = readManifest(dir)
  const rows = []
  for (const year of manifest.cold.years) {
    for (const file of year.files) {
      const text = fs.readFileSync(path.join(dir, file.file), 'utf8')
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue
        rows.push(JSON.parse(line))
      }
    }
  }
  return { experiences: rows }
}

console.log('')
console.log(`结果：通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exit(1)
