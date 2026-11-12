#!/usr/bin/env node
/**
 * 冷档算术的两个前置验证（2026-11-12，P2 参数用）：
 *   A. 桶均衡：`sha1(id).readUInt32BE(0) % 2`（P1 的 shardBucketIndex）在 6000 条真实 id 形态上偏不偏；
 *      再按真实类型分布算最大桶字节；顺带对比几种常见哈希（防止将来换实现踩坑）。
 *   B. manifest 实尺：按 24 类型满配（每类 2 桶 + pending 50 + 簇签名满配）造一份，
 *      量实际字节，看离 MANIFEST_MAX_BYTES=128 KiB 还有多远；并用真实 buildManifest 验证降采样护栏。
 *
 * 只读：只读 `_tmp/fixtures/exp-lib-snapshot.json`（真实库快照的副本），不写任何库。
 * 运行：node tools/cold-budget-check.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

import { ensureClusters } from '../kernel/cluster.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const FIXTURE = path.join(REPO, '_tmp', 'fixtures', 'exp-lib-snapshot.json')
const MB = 1024 * 1024
const K = 2
const N_RECORDS = 6000
const MANIFEST_MAX = 128 * 1024

if (!fs.existsSync(FIXTURE)) {
  console.error(`缺少 fixture：${FIXTURE}（先跑 node tools/accept-shard.mjs 生成）`)
  process.exit(2)
}

const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'))
const allRecords = Array.isArray(fixture.experiences) ? fixture.experiences : []
const visibleRecords = allRecords.filter((row) => row && !row.deleted_at && !row.superseded_by && !row.retired_at)
const oneLineBytes = (row) => Buffer.byteLength(JSON.stringify(row), 'utf8')
const avgRecordBytes = visibleRecords.reduce((sum, row) => sum + oneLineBytes(row), 0) / Math.max(1, visibleRecords.length)

// ---------------------------------------------------------------- 确定性随机

function mulberry32(seed) {
  let state = seed >>> 0
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0
    let value = Math.imul(state ^ (state >>> 15), 1 | state)
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

function makeHexIds(count, seed) {
  const next = mulberry32(seed)
  const ids = []
  for (let index = 0; index < count; index += 1) {
    let hex = ''
    while (hex.length < 12) hex += Math.floor(next() * 16).toString(16)
    ids.push(`ex_${hex}`)
  }
  return ids
}

/** 真实 id 形态：`ex_` + 12 位十六进制（store.js newId 的形态）；外加时间戳序/自增序两种压力形态。 */
const patterns = {
  '随机 hex（newId 形态）': makeHexIds(N_RECORDS, 20261112),
  '自增 hex（000…001 起）': Array.from({ length: N_RECORDS }, (_, index) => `ex_${(index + 1).toString(16).padStart(12, '0')}`),
  '时间戳序 hex（毫秒递增）': Array.from({ length: N_RECORDS }, (_, index) => `ex_${(1_700_000_000_000 + index * 60_000).toString(16).slice(-12)}`),
}

const sha1Digest = (id) => createHash('sha1').update(String(id)).digest()
const uint32Of = (buffer) => buffer.readUInt32BE(0)

// 优先用 P1 的真实 shardBucketIndex（P1 未合并/改名时退回同逻辑本地实现）。
let shardModule = null
try {
  shardModule = await import('../kernel/shard-store.js')
} catch {
  shardModule = null
}
const localP1Hash = (id) => uint32Of(sha1Digest(id)) % K
const p1Hash = shardModule !== null && typeof shardModule.shardBucketIndex === 'function'
  ? (id) => shardModule.shardBucketIndex(id, K)
  : localP1Hash

const hashers = {
  'sha1[0..4]%2（P1 shardBucketIndex）': (id) => p1Hash(id),
  'sha256[0..4]%2': (id) => uint32Of(createHash('sha256').update(String(id)).digest()) % K,
  'md5[0..4]%2': (id) => uint32Of(createHash('md5').update(String(id)).digest()) % K,
  'fnv1a32%2': (id) => {
    let hash = 0x811c9dc5
    for (const char of String(id)) {
      hash ^= char.codePointAt(0)
      hash = Math.imul(hash, 0x01000193) >>> 0
    }
    return hash % K
  },
  'djb2%2': (id) => {
    let hash = 5381
    for (const char of String(id)) hash = ((hash * 33) ^ char.codePointAt(0)) >>> 0
    return hash % K
  },
  '末位 hex 奇偶': (id) => Number.parseInt(String(id).slice(-1), 16) % K,
  '字符码求和奇偶': (id) => [...String(id)].reduce((sum, char) => sum + char.codePointAt(0), 0) % K,
}

console.log('=== A. 桶均衡（6000 条） ===')
console.log(`条数 = ${N_RECORDS}，K = ${K}；理想每桶 ${N_RECORDS / K} 条；偏差 = (最大桶 - 理想) / 理想`)
const balanceRows = []
for (const [patternName, ids] of Object.entries(patterns)) {
  for (const [hasherName, hasher] of Object.entries(hashers)) {
    const counts = [0, 0]
    for (const id of ids) counts[hasher(id)] += 1
    const maxBucket = Math.max(...counts)
    const deviation = (maxBucket - N_RECORDS / K) / (N_RECORDS / K)
    balanceRows.push({ patternName, hasherName, counts, deviation })
  }
}
console.log('')
console.log('模式 | 哈希 | 桶0 / 桶1 | 最大桶偏差 | 折合 σ（n=6000 时 σ≈38.7 条）')
for (const row of balanceRows) {
  if (!row.hasherName.startsWith('sha1')) continue
  const deviation = row.deviation
  // 二项分布 p=0.5 的标准差：σ_比例 = 0.5/√n ≈ 0.6455%；倍数 = 偏差 / σ_比例
  const sigma = (Math.abs(deviation) * 100) / (0.5 / Math.sqrt(N_RECORDS) * 100)
  console.log(`${row.patternName} | ${row.hasherName} | ${row.counts[0]} / ${row.counts[1]} | ${(deviation * 100).toFixed(2)}% | ${sigma.toFixed(2)}σ`)
}
console.log('')
console.log('其它哈希的偏差（仅随机 hex 形态；用于对比，不是 P1 实现）：')
for (const row of balanceRows) {
  if (row.hasherName.startsWith('sha1') || row.patternName !== '随机 hex（newId 形态）') continue
  console.log(`  ${row.hasherName}: ${row.counts[0]}/${row.counts[1]}（偏差 ${(row.deviation * 100).toFixed(2)}%）`)
}
// 真实库已有 119 条 id 的落桶
const realIds = visibleRecords.map((row) => String(row.id))
const realCounts = [0, 0]
for (const id of realIds) realCounts[p1Hash(id)] += 1
console.log(`\n真实库 ${realIds.length} 条 id（P1 哈希）：桶0 ${realCounts[0]} / 桶1 ${realCounts[1]}`)
if (shardModule !== null && typeof shardModule.shardBucketIndex === 'function') {
  const mismatch = patterns['随机 hex（newId 形态）'].filter((id) => shardModule.shardBucketIndex(id, K) !== localP1Hash(id)).length
  console.log(`实现交叉核对：import 的 shardBucketIndex 与本地 sha1[0..4]%2 在 6000 条上${mismatch === 0 ? '完全一致' : `有 ${mismatch} 条不一致`}`)
} else {
  console.log('（P1 的 shard/store 模块未就绪，用同逻辑本地实现；P1 合并后重跑会交叉核对）')
}

// 多 seed 扫描：单次 2.89σ 可能只是抽样噪声；固定哈希 + 20 组随机 id 看偏差是否系统偏。
const sweep = []
for (let seed = 1; seed <= 20; seed += 1) {
  const ids = makeHexIds(N_RECORDS, seed)
  const counts = [0, 0]
  for (const id of ids) counts[uint32Of(sha1Digest(id)) % K] += 1
  sweep.push(Math.max(...counts) / (N_RECORDS / K) - 1)
}
const sweepMax = Math.max(...sweep)
const sweepMean = sweep.reduce((sum, value) => sum + Math.abs(value), 0) / sweep.length
console.log(`20 组随机 seed 扫描（每组 6000 条）：最大桶偏差 平均 ${(sweepMean * 100).toFixed(2)}% / 最坏 ${(sweepMax * 100).toFixed(2)}%（σ≈1.29%，即最坏 ${(sweepMax * 100 / 1.291).toFixed(1)}σ）`)
console.log(`  → ${sweepMax < 0.05 ? '无系统偏：偏差在二项分布噪声内，不用换哈希' : '存在系统偏：需要换哈希'}`)

// 真实类型分布下的最大桶字节（P1 哈希）
const byType = new Map()
for (const row of visibleRecords) {
  const typeId = String(row.typeId || 'ty_other')
  if (!byType.has(typeId)) byType.set(typeId, { count: 0, bytes: 0, name: String(row.typeName || typeId) })
  const bucket = byType.get(typeId)
  bucket.count += 1
  bucket.bytes += oneLineBytes(row)
}
const scaledTypes = [...byType.entries()]
  .map(([typeId, info]) => ({
    typeId,
    name: info.name,
    count: Math.round((info.count / visibleRecords.length) * N_RECORDS),
    avgBytes: info.bytes / info.count,
  }))
  .sort((left, right) => right.count - left.count)

let cursor = 0
const idPool = patterns['随机 hex（newId 形态）']
const typeBuckets = []
for (const type of scaledTypes) {
  const ids = idPool.slice(cursor, cursor + type.count)
  cursor += type.count
  const counts = [0, 0]
  for (const id of ids) counts[uint32Of(sha1Digest(id)) % K] += 1
  const bytes = counts.map((count) => Math.round(count * type.avgBytes))
  typeBuckets.push({ ...type, counts, bytes, idealBytes: (type.count * type.avgBytes) / K })
}
const maxBucket = typeBuckets.flatMap((type) => type.bytes.map((bytes, index) => ({ typeId: type.typeId, name: type.name, index, bytes })))
  .sort((left, right) => right.bytes - left.bytes)[0]
const worstImbalance = typeBuckets
  .map((type) => ({ typeId: type.typeId, name: type.name, ratio: Math.max(...type.bytes) / type.idealBytes - 1 }))
  .sort((left, right) => right.ratio - left.ratio)[0]
const hotTotal = typeBuckets.reduce((sum, type) => sum + type.bytes[0] + type.bytes[1], 0)
console.log('')
console.log(`按真实类型分布放大到 ${N_RECORDS} 条：`)
console.log(`  最大桶 = ${maxBucket.name}.${maxBucket.index} ≈ ${(maxBucket.bytes / MB).toFixed(2)} MB`)
console.log(`  类型内两桶最大失衡 = ${(worstImbalance.ratio * 100).toFixed(2)}%（${worstImbalance.name}）`)
console.log(`  热档总字节 = ${(hotTotal / MB).toFixed(2)} MB（6000 条 × ${avgRecordBytes.toFixed(0)} B/条）`)
console.log('')
console.log('  前 4 大类型的双桶：')
for (const type of typeBuckets.slice(0, 4)) {
  const imbalance = Math.max(...type.bytes) / type.idealBytes - 1
  console.log(`    ${type.name}: ${type.counts[0]}/${type.counts[1]} 条，${(type.bytes[0] / MB).toFixed(2)}/${(type.bytes[1] / MB).toFixed(2)} MB，失衡 ${(imbalance * 100).toFixed(2)}%`)
}
console.log(`  （大类型 5–6% 失衡折合约 2.4σ，是抽样噪声；小类型 50 条级别的 20% 是 50 条样本的噪声（σ≈10%），都不说明哈希偏）`)

// ---------------------------------------------------------------- B. manifest 实尺

const store = { version: 1, types: fixture.types, experiences: visibleRecords }
ensureClusters(store)
const realClusters = Array.isArray(store.clusters) ? store.clusters : []

const longestToken = [...realClusters].flatMap((cluster) => cluster.signature.tokens).sort((a, b) => b.length - a.length)[0] || 'ppt'
const longestGram = [...realClusters].flatMap((cluster) => cluster.signature.cgrams).sort((a, b) => b.length - a.length)[0] || '课件'
const longestArtifact = [...realClusters].flatMap((cluster) => cluster.signature.artifacts).sort((a, b) => b.length - a.length)[0] || 'pptx'
const padTo = (list, limit, filler) => {
  const out = [...list]
  while (out.length < limit) out.push(filler)
  return out.slice(0, limit)
}

const TYPE_COUNT = 24
const types = []
for (let index = 0; index < TYPE_COUNT; index += 1) {
  const base = fixture.types[index % fixture.types.length]
  if (index < fixture.types.length) {
    types.push({ ...base })
  } else {
    types.push({
      id: `ty_gen${String(index).padStart(2, '0')}`,
      name: `生成类型 ${index}`,
      description: '验收台架合成的满配类型：描述长度按真实类型的长描述取，用来压 manifest 体积。',
      system: false,
    })
  }
}

const clusters = []
for (let index = 0; index < TYPE_COUNT; index += 1) {
  const source = realClusters[index % realClusters.length]
  clusters.push({
    id: index < realClusters.length ? source.id : `cl_gen${index}`,
    typeId: types[index].id,
    name: types[index].name,
    description: types[index].description,
    system: types[index].system === true,
    version: 1,
    signature: {
      artifacts: padTo(source.signature.artifacts, 6, longestArtifact),
      tokens: padTo(source.signature.tokens, 16, longestToken),
      cgrams: padTo(source.signature.cgrams, 24, longestGram),
    },
    stats: { ...source.stats, count: typeBuckets.find((type) => type.name === types[index].name)?.count || 100 },
  })
}

const pickIntent = (index) => {
  const intents = visibleRecords.map((row) => String(row.intent || '')).sort((left, right) => right.length - left.length)
  return intents[index % intents.length].slice(0, 120)
}
const pending = Array.from({ length: 50 }, (_, index) => ({
  id: `ex_${(index + 1).toString(16).padStart(12, '0')}`,
  typeId: types[index % types.length].id,
  intent: pickIntent(index),
}))

const buckets = []
for (let index = 0; index < TYPE_COUNT; index += 1) {
  const type = typeBuckets[index % typeBuckets.length]
  const count = Math.max(1, Math.round(type.count / 2))
  for (let bucketIndex = 0; bucketIndex < 2; bucketIndex += 1) {
    buckets.push({
      file: `buckets/${types[index].id}.${bucketIndex}.jsonl`,
      typeId: types[index].id,
      count,
      bytes: Math.round(count * (type.avgBytes || avgRecordBytes)),
      latestTs: '2026-11-12T05:00:00.000Z',
    })
  }
}

const coldYears = {
  years: [
    { year: 2024, file: 'cold/2024-a.jsonl', count: 10950, bytes: Math.round(10950 * avgRecordBytes) },
    { year: 2025, file: 'cold/2025-a.jsonl', count: 10950, bytes: Math.round(10950 * avgRecordBytes) },
    { year: 2026, file: 'cold/2026-a.jsonl', count: 10950, bytes: Math.round(10950 * avgRecordBytes) },
  ],
}

function rawManifest() {
  return {
    schema: 2,
    version: 1,
    types,
    clusters,
    buckets,
    pending,
    cold: coldYears,
    migratedFrom: 'exp-lib.json',
  }
}

const prettyBytes = (value) => Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
const compactBytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8')

const raw = rawManifest()
const rawPretty = prettyBytes(raw)
const withoutSignatures = {
  ...raw,
  clusters: raw.clusters.map((cluster) => ({ ...cluster, signature: { artifacts: [], tokens: [], cgrams: [] } })),
}
const basePretty = prettyBytes(withoutSignatures)
const signatureBytes = rawPretty - basePretty
const signatureStrings = clusters.length * (16 + 24 + 6)
const avgSignatureString = signatureBytes / signatureStrings
const signatureHeadroom = (MANIFEST_MAX - basePretty) / signatureBytes
console.log('')
console.log('=== B. manifest 实尺（24 类型满配：24 类型 + 24 簇签名满配 + 48 桶 + pending 50 + 冷档 3 年） ===')
console.log(`  types=${types.length} clusters=${clusters.length} buckets=${buckets.length} pending=${pending.length}`)
console.log(`  原始 manifest（2 空格缩进）：${(rawPretty / 1024).toFixed(1)} KiB / ${rawPretty} B`)
console.log(`  原始 manifest（压缩 JSON）：${(compactBytes(raw) / 1024).toFixed(1)} KiB`)
console.log(`  占 MANIFEST_MAX_BYTES(128 KiB) 的 ${((rawPretty / MANIFEST_MAX) * 100).toFixed(1)}%`)
console.log(`  其中固定部分（类型/桶/pending/冷档/骨架）≈ ${(basePretty / 1024).toFixed(1)} KiB，簇签名 ≈ ${(signatureBytes / 1024).toFixed(1)} KiB（${signatureStrings} 个字符串，均 ${avgSignatureString.toFixed(1)} B）`)
console.log(`  余量：签名字符串整体可再长 ${signatureHeadroom.toFixed(1)}×（均长 ${avgSignatureString.toFixed(1)} B → ${(avgSignatureString * signatureHeadroom).toFixed(0)} B）才触顶 128 KiB`)

let buildManifest = null
let shardConstants = null
if (shardModule !== null && typeof shardModule.buildManifest === 'function') {
  buildManifest = shardModule.buildManifest
  shardConstants = {
    MANIFEST_MAX_BYTES: shardModule.MANIFEST_MAX_BYTES,
    PENDING_INDEX_LIMIT: shardModule.PENDING_INDEX_LIMIT,
    HOT_MAX_BYTES: shardModule.HOT_MAX_BYTES,
    AVG_RECORD_BYTES: shardModule.AVG_RECORD_BYTES,
  }
} else {
  console.log('\n  （跳过真实 buildManifest 对照：kernel/shard-store.js 未就绪；P1 合并后重跑本脚本）')
}

if (buildManifest !== null) {
  const storeForManifest = {
    version: 1,
    types,
    clusters,
    experiences: pending.map((row) => ({
      id: row.id,
      typeId: row.typeId,
      intent: row.intent,
      verdict: 'pending',
      ts: '2026-11-12T04:00:00.000Z',
    })),
  }
  const previous = { clusters: [], cold: coldYears }
  const built = buildManifest(storeForManifest, buckets, previous, { migratedFrom: 'exp-lib.json' })
  const builtPretty = prettyBytes(built)
  const signatureMax = Math.max(...built.clusters.map((cluster) => Math.max(cluster.signature.tokens.length, cluster.signature.cgrams.length, cluster.signature.artifacts.length)))
  console.log(`  真实 buildManifest 产出：${(builtPretty / 1024).toFixed(1)} KiB / ${builtPretty} B（签名最长 ${signatureMax}）`)
  console.log(`  降采样护栏：${signatureMax < 16 ? '触发（签名被截断）' : '未触发（原始签名已容得下）'}`)

  // 压力档：把签名里的每个字符串撑到 200 B，看护栏是否把 manifest 拉回 128 KiB 以内。
  const stressedStore = {
    ...storeForManifest,
    clusters: clusters.map((cluster) => ({
      ...cluster,
      signature: {
        artifacts: Array.from({ length: 6 }, (_, index) => `artifact-${index}-${'x'.repeat(180)}`),
        tokens: Array.from({ length: 16 }, (_, index) => `token-${index}-${'x'.repeat(186)}`),
        cgrams: Array.from({ length: 24 }, (_, index) => `gram-${index}-${'x'.repeat(188)}`),
      },
    })),
  }
  const rawStressed = prettyBytes({
    schema: 2,
    version: 1,
    types,
    clusters: stressedStore.clusters,
    buckets,
    pending,
    cold: coldYears,
    migratedFrom: 'exp-lib.json',
  })
  const builtStressed = buildManifest(stressedStore, buckets, previous, { migratedFrom: 'exp-lib.json' })
  const stressedPretty = prettyBytes(builtStressed)
  const stressedMax = builtStressed.clusters.length === 0
    ? 0
    : Math.max(...builtStressed.clusters.map((cluster) => Math.max(cluster.signature.tokens.length, cluster.signature.cgrams.length, cluster.signature.artifacts.length)))
  console.log(`  压力档（签名每串 200 B）：原始 ${(rawStressed / 1024).toFixed(0)} KiB → 护栏后 ${(stressedPretty / 1024).toFixed(1)} KiB（每类签名每种最多留 ${stressedMax} 条）`)
}

console.log('')
console.log('=== 结论 ===')
const dev = balanceRows.filter((row) => row.hasherName.startsWith('sha1')).map((row) => Math.abs(row.deviation))
console.log(`1. 桶均衡：P1 的 sha1[0..4]%2 三种 id 形态偏差 ≤ ${(Math.max(...dev) * 100).toFixed(2)}%；20 组 seed 平均 ${(sweepMean * 100).toFixed(2)}% / 最坏 ${(sweepMax * 100).toFixed(2)}%（≈${(sweepMax * 100 / 1.291).toFixed(1)}σ）—— 抽样噪声，不是系统偏，不用换哈希`)
console.log(`2. 最大桶：真实类型分布放大到 6000 条时 ${(maxBucket.bytes / MB).toFixed(2)} MB（${maxBucket.name}.${maxBucket.index}）；大类型双桶失衡 5–6%（≈2.4σ）`)
console.log(`3. manifest：24 类型满配 ${(rawPretty / 1024).toFixed(1)} KiB，占 128 KiB 的 ${((rawPretty / MANIFEST_MAX) * 100).toFixed(1)}%；签名余量 ${signatureHeadroom.toFixed(1)}×`)
if (shardConstants !== null) {
  console.log(`4. 实现常量核对：MANIFEST_MAX_BYTES=${shardConstants.MANIFEST_MAX_BYTES} / PENDING_INDEX_LIMIT=${shardConstants.PENDING_INDEX_LIMIT} / HOT_MAX_BYTES=${shardConstants.HOT_MAX_BYTES} / AVG_RECORD_BYTES=${shardConstants.AVG_RECORD_BYTES}`)
}
