/**
 * P2 验收（0.14.0，计划书 §4.4 / §4.5 / §5 + D2/D4/D5）：
 *  1. 增量写局部性：改一条只重写它所属类型的分片，其它分片字节与 mtime 都不变；
 *  2. G4 writeTypeShards：只替换 touched 类型的分桶，其它文件不动；
 *  3. 压缩：超闸时先清墓碑/取代/退休，再按 G→hits→lastSeenAt 最差先下沉到冷档；
 *     守恒（热+冷可见条数不变）、单桶 ≤ 上限、热档总字节 ≤ 闸、文件数 ≤ 54、有备份；
 *  4. 冷档：`cold/<year>-<a|b|…>.jsonl` 按字母新开片、单片 ≤ COLD_MAX_BYTES；
 *  5. G1/G2/G3 定向读；G5 recent / G6 stats 落 manifest；
 *  6. exp_recall cold:true 能取回且字段完整，默认召回与提示段条数都不含冷档。
 *
 * 说明：主压缩用例把三闸按 1/128 缩小（8 KiB / 24 KiB / 60 条）来造「3×上限」数据，
 * 断言口径与真实参数完全一致；默认参数另有常量断言与「小库不误触发」用例。
 *
 * Run: node kernel/tests/shard-compact.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'

import {
  rankExperiences,
  readColdStore,
  readManifest,
  readStore,
  rebuildManifest,
  renderHint,
  visibleExperiences,
  writeStore,
} from '../store.js'
import {
  COLD_MAX_BYTES,
  HOT_MAX_BYTES,
  MAX_BUCKET_BYTES,
  N_MAX,
  SHARD_K,
  appendColdRecords,
  bucketsPath,
  coldPath,
  compactionNeeded,
  manifestPath,
  readColdRecords,
  readRecordsByIds,
  readShardRecordsOfTypes,
  recentEntries,
  shardBucketIndex,
  shardRelPath,
  statsEntries,
  storageFileCount,
  storageUsage,
  writeTypeShards,
} from '../shard-store.js'
import { createEngine } from '../engine.js'

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

const newDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'exp-shard-compact-'))
const now = Date.now()
const at = (days) => new Date(now - days * 86400000).toISOString()
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

function makeType(id, name) {
  return { id, name, description: `${name} 的描述`, system: false, createdAt: at(30), source: 'model-created' }
}

/**
 * 造库：`count` 条可见记录散在 types 里（G 有高有低，hits/lastSeenAt 不同，下沉顺序可断言），
 * 另带墓碑(40 天前) / 已被取代 / 已退休的不可见行，压缩时应被物理清掉。
 */
function seedStore(dir, options = {}) {
  const types = [makeType('ty_alpha', '阿尔法类'), makeType('ty_beta', '贝塔类'), makeType('ty_gamma', '伽马类')]
  const experiences = []
  const count = Math.max(1, Math.trunc(Number(options.count) || 60))
  const bodySize = Math.max(20, Math.trunc(Number(options.bodySize) || 120))
  const filler = 'x'.repeat(bodySize)
  for (let index = 0; index < count; index += 1) {
    const type = types[index % types.length]
    // G 从 -1 到 1 铺开：最差的先下沉
    const G = Math.round(((index % 21) - 10) / 10 * 1000) / 1000
    experiences.push({
      id: `ex_${String(index).padStart(4, '0')}`,
      taskId: `ex_${String(index).padStart(4, '0')}`,
      kind: 'task',
      intent: `任务 ${index}：给课件插页 ${filler}`,
      action: `做法 ${index}：先克隆再改字 ${filler}`,
      ts: at(index % 20),
      lastSeenAt: at(index % 20),
      hits: (index % 4) + 1,
      G,
      GOutcome: G,
      GSource: 'outcome',
      outcome: G > 0 ? 'success' : G < 0 ? 'failed' : 'partial',
      state: { tokens: [], cgrams: [], artifacts: [] },
      step_rewards: [G],
      note: `备注 ${index} ${filler}`,
      typeId: type.id,
      typeName: type.name,
      verdict: 'decided',
      deleted_at: null,
      superseded_by: null,
    })
  }
  // 不可见行（压缩第一步要物理清掉）
  const invisible = [
    { id: 'ex_tomb_1', deleted_at: at(40), G: 0.1, hits: 1, typeId: 'ty_alpha' },
    { id: 'ex_tomb_2', deleted_at: at(45), G: 0.2, hits: 1, typeId: 'ty_beta' },
    { id: 'ex_super_1', superseded_by: 'ex_0000', G: 0.3, hits: 1, typeId: 'ty_alpha' },
    { id: 'ex_super_2', superseded_by: 'ex_0001', G: -0.3, hits: 2, typeId: 'ty_beta' },
    { id: 'ex_retire_1', retired_at: at(2), retired_reason: 'superseded-by-success', G: -0.5, hits: 1, typeId: 'ty_gamma' },
  ]
  for (const row of invisible) {
    const type = types.find((item) => item.id === row.typeId)
    experiences.push({
      id: row.id,
      taskId: row.id,
      kind: 'task',
      intent: `不可见任务 ${row.id}`,
      action: `不可见做法 ${row.id}`,
      ts: at(50),
      lastSeenAt: at(50),
      hits: row.hits,
      G: row.G,
      GOutcome: row.G,
      GSource: 'outcome',
      outcome: row.G >= 0 ? 'success' : 'failed',
      state: { tokens: [], cgrams: [], artifacts: [] },
      step_rewards: [row.G],
      note: '',
      typeId: row.typeId,
      typeName: type.name,
      verdict: 'decided',
      deleted_at: row.deleted_at || null,
      superseded_by: row.superseded_by || null,
      retired_at: row.retired_at || null,
    })
  }
  const store = { version: 1, types, experiences }
  writeStore(dir, store)
  return { store, types, experiences, invisible }
}

const filesOf = (dir) => {
  const out = new Map()
  for (const name of fs.readdirSync(bucketsPath(dir)).filter((item) => item.endsWith('.jsonl')).sort()) {
    const full = path.join(bucketsPath(dir), name)
    out.set(name, { mtimeMs: fs.statSync(full).mtimeMs, hash: createHash('sha1').update(fs.readFileSync(full, 'utf8')).digest('hex'), bytes: fs.statSync(full).size })
  }
  return out
}

const hotBytesOf = (manifest) => manifest.buckets.reduce((sum, bucket) => sum + (Number(bucket.bytes) || 0), 0)

const bucketLines = (dir, file) => fs.readFileSync(path.join(dir, file), 'utf8').split('\n').filter((line) => line.trim() !== '')

check('常量口径（D4/D5 + §7.10 安全阀上调）：单桶 2 MiB、热档闸 32 MiB、冷档单片 8 MiB、条数闸 20000', () => {
  assert.equal(MAX_BUCKET_BYTES, 2 * 1024 * 1024)
  assert.equal(HOT_MAX_BYTES, 32 * 1024 * 1024)
  assert.equal(COLD_MAX_BYTES, 8 * 1024 * 1024)
  assert.equal(N_MAX, 20000)
})

check('写入局部性：改一条只重写它所属类型的分片，其它分片字节与 mtime 不变', () => {
  const dir = newDir()
  seedStore(dir, { count: 30 })
  const before = filesOf(dir)
  const store = readStore(dir)
  const target = store.experiences.find((row) => row.typeId === 'ty_beta' && !row.deleted_at && !row.superseded_by && !row.retired_at)
  const typeId = target.typeId
  sleep(20)
  target.hits += 5
  target.note = '改过一条'
  writeStore(dir, store)
  const after = filesOf(dir)
  for (const [name, snapshot] of before) {
    if (name.startsWith(`${typeId}.`)) continue
    const next = after.get(name)
    assert.ok(next !== undefined, `${name} 不该消失`)
    assert.equal(next.bytes, snapshot.bytes, `${name}（未变更类型）字节数必须不变`)
    assert.equal(next.mtimeMs, snapshot.mtimeMs, `${name}（未变更类型）mtime 必须不变——写局部性`)
  }
  const touched = [...after.entries()].filter(([name]) => name.startsWith(`${typeId}.`))
  assert.ok(touched.some(([name, snapshot]) => snapshot.hash !== before.get(name).hash), '改过的那类分片内容必须变')
})

check('G4 writeTypeShards：只替换 touched 类型的分桶，其它文件 mtime 不变', () => {
  const dir = newDir()
  seedStore(dir, { count: 30 })
  const before = filesOf(dir)
  let manifest = readManifest(dir)
  const alpha = readShardRecordsOfTypes(dir, manifest, ['ty_alpha']).records
  alpha[0].note = '局部写改过'
  sleep(20)
  manifest = writeTypeShards(dir, manifest, {
    touchedTypeIds: ['ty_alpha'],
    rowsByType: { ty_alpha: alpha },
  })
  const after = filesOf(dir)
  for (const [name, snapshot] of before) {
    if (name.startsWith('ty_alpha.')) continue
    const next = after.get(name)
    assert.equal(next.bytes, snapshot.bytes, `${name} 字节数必须不变`)
    assert.equal(next.mtimeMs, snapshot.mtimeMs, `${name} mtime 必须不变（G4 只碰 touched 类型）`)
  }
  const alphaBucket = after.get([...after.keys()].find((name) => name.startsWith('ty_alpha.')))
  assert.ok(alphaBucket !== undefined)
  // manifest 只更新了 alpha 的登记
  const alphaEntry = manifest.buckets.find((bucket) => bucket.typeId === 'ty_alpha')
  assert.ok(alphaEntry !== undefined)
  assert.equal(bucketLines(dir, alphaEntry.file).length, alphaEntry.count, 'manifest 条数必须等于实际行数')
  assert.throws(() => writeTypeShards(dir, manifest, { touchedTypeIds: ['ty_alpha'], rowsByType: { ty_beta: [] } }), /不在 touchedTypeIds/)
})

check('G1/G2 定向读：只读指定类型 / 只读命中分片', () => {
  const dir = newDir()
  seedStore(dir, { count: 30 })
  const manifest = readManifest(dir)
  const only = readShardRecordsOfTypes(dir, manifest, ['ty_beta'])
  assert.ok(only.records.length > 0)
  assert.ok(only.records.every((row) => row.typeId === 'ty_beta'))
  assert.ok(only.files.every((file) => file.includes('ty_beta.')), `只该读 ty_beta 的分片：${only.files.join(',')}`)
  const all = readShardRecordsOfTypes(dir, manifest, [])
  assert.equal(all.records.length, manifest.buckets.reduce((sum, bucket) => sum + bucket.count, 0))
  const refs = all.records.slice(0, 5).map((row) => ({ id: row.id, typeId: row.typeId }))
  const byIds = readRecordsByIds(dir, manifest, refs)
  assert.deepEqual(byIds.map((row) => row.id), refs.map((ref) => ref.id), 'G2 顺序必须与 refs 一致')
  for (const row of byIds) assert.deepEqual(row, all.records.find((item) => item.id === row.id))
})

check('压缩（缩小 1/128 口径）：清墓碑/取代/退休 + 最差先下沉 + 守恒 + 三闸 + 备份', () => {
  const dir = newDir()
  const { invisible } = seedStore(dir, { count: 210, bodySize: 150 })
  const gates = { maxBucketBytes: 8 * 1024, hotMaxBytes: 24 * 1024, nMax: 60, maxRounds: 64 }
  const beforeStore = readStore(dir)
  const visibleBefore = visibleExperiences(beforeStore).length
  // 这个库在缩小口径下必然超闸
  assert.equal(compactionNeeded(dir, readManifest(dir), gates).needed, true)
  // 用一次「全量持有」的写盘触发压缩（真实路径就是 writeStore）
  writeStore(dir, beforeStore, { compact: gates })
  const manifest = readManifest(dir)
  const hotBytes = hotBytesOf(manifest)
  assert.ok(hotBytes <= gates.hotMaxBytes, `热档总字节 ${hotBytes} 必须 ≤ ${gates.hotMaxBytes}`)
  for (const bucket of manifest.buckets) {
    assert.ok((Number(bucket.bytes) || 0) <= gates.maxBucketBytes, `${bucket.file} 单桶 ${bucket.bytes} 必须 ≤ ${gates.maxBucketBytes}`)
    assert.equal(bucketLines(dir, bucket.file).length, bucket.count, 'manifest 条数必须等于实际行数')
  }
  const cold = readColdStore(dir)
  const coldRecords = cold.experiences
  assert.ok(coldRecords.length > 0, '必须真的下沉了记录')
  // 守恒：热可见 + 冷可见 = 压缩前可见（被物理清掉的墓碑/取代/退休本来就不在可见集合里）
  const visibleAfter = visibleExperiences(readStore(dir)).length
  const visibleCold = coldRecords.filter((row) => !row.deleted_at && !row.superseded_by && !row.retired_at).length
  assert.equal(visibleAfter + visibleCold, visibleBefore, '热+冷可见条数必须守恒')
  // 不可见行必须被物理清掉（热档与冷档里都不该再有）
  const everywhere = new Set([...readStore(dir).experiences, ...coldRecords].map((row) => row.id))
  for (const row of invisible) assert.equal(everywhere.has(row.id), false, `${row.id} 应被压缩物理清掉`)
  // 备份到位
  const backups = fs.readdirSync(path.join(dir, '.locks')).filter((name) => name.startsWith('compact-') && name.endsWith('.bak'))
  assert.ok(backups.length > 0, '压缩前必须写 .locks/compact-<ts>.bak')
  // 冷档单片 ≤ 上限（默认 8 MiB，这里数据量远小于它）
  for (const year of manifest.cold.years) {
    for (const file of year.files) {
      assert.ok((Number(file.bytes) || 0) <= COLD_MAX_BYTES, `${file.file} 必须 ≤ COLD_MAX_BYTES`)
      assert.match(file.file, /^cold\/\d{4}-[a-z]+\.jsonl$/, '冷档命名必须是 cold/<year>-<a|b|…>.jsonl')
    }
  }
  assert.ok(manifest.cold.years[0].files !== undefined, 'manifest.cold.years[].files[] 必须登记')
  assert.equal(manifest.cold.years.reduce((sum, year) => sum + year.count, 0), coldRecords.length, '冷档登记条数必须与实际一致')
  // 文件数上界
  const files = storageFileCount(dir)
  assert.ok(files <= 54, `文件数 ${files} 必须 ≤ 54`)
})

check('压缩下沉顺序：被压的那个桶里，走的一定是最差的那批（G 升序先走）', () => {
  const dir = newDir()
  seedStore(dir, { count: 120, bodySize: 120 })
  // 只压一轮，这样冷档里的行全部来自同一个桶，能逐行比对顺序。
  const gates = { maxBucketBytes: 6 * 1024, hotMaxBytes: 18 * 1024, nMax: 40, maxRounds: 1 }
  const need = compactionNeeded(dir, readManifest(dir), gates)
  assert.equal(need.needed, true)
  const bucketFile = need.bucket.file
  writeStore(dir, readStore(dir), { compact: gates })
  const sunk = readColdStore(dir).experiences
  assert.ok(sunk.length > 0)
  // 剩下的同桶行
  const hot = readStore(dir).experiences
  const remaining = hot.filter((row) => shardRelPath(row.typeId, shardBucketIndex(row.id)) === bucketFile)
  const maxSunkG = Math.max(...sunk.map((row) => Number(row.G) || 0))
  const minRemainG = remaining.length === 0 ? Infinity : Math.min(...remaining.map((row) => Number(row.G) || 0))
  assert.ok(maxSunkG <= minRemainG, `下沉的最优 G（${maxSunkG}）不应高于同桶剩余的 G（${minRemainG}）`)
  // manifest 的条数合计必须等于热档实际行数（冷档/清掉的不算在热档）
  assert.equal(hot.length, readManifest(dir).buckets.reduce((sum, bucket) => sum + bucket.count, 0))
})

check('exp_recall cold:true：能取回下沉记录且字段完整；默认召回与提示段不含冷档', () => {
  const dir = newDir()
  const { experiences } = seedStore(dir, { count: 150, bodySize: 140 })
  const gates = { maxBucketBytes: 6 * 1024, hotMaxBytes: 18 * 1024, nMax: 40, maxRounds: 64 }
  writeStore(dir, readStore(dir), { compact: gates })
  const sunk = readColdStore(dir).experiences.filter((row) => !row.deleted_at && !row.superseded_by && !row.retired_at)
  assert.ok(sunk.length > 0)
  const target = sunk[0]
  const before = experiences.find((row) => row.id === target.id)
  assert.ok(before !== undefined, '下沉记录必须来自原库')
  const engine = createEngine({ dataDir: dir, config: { autoBind: false, usageLog: false } })
  // 1) cold:true 取回
  const coldOut = engine.recall({ intent: target.intent, cold: true, detail: true, limit: 8 })
  const ids = (coldOut.candidates || []).flatMap((candidate) => (candidate.evidence || []).map((evidence) => evidence.id))
  assert.ok(coldOut.cold === true, 'cold 模式回执必须标 cold:true')
  assert.ok(ids.includes(target.id), `cold:true 应能取回 ${target.id}，实际 ${ids.join(',')}`)
  const evidence = (coldOut.candidates || []).flatMap((candidate) => candidate.evidence || []).find((item) => item.id === target.id)
  assert.equal(evidence.intent, before.intent, '字段必须完整（intent）')
  assert.equal(evidence.action, before.action, '字段必须完整（action）')
  assert.equal(evidence.outcome, before.outcome)
  assert.equal(Number(evidence.G), Number(before.G))
  // 2) 默认召回取不到
  const hotOut = engine.recall({ intent: target.intent, detail: true, limit: 8 })
  const hotIds = (hotOut.candidates || []).flatMap((candidate) => (candidate.evidence || []).map((item) => item.id))
  assert.equal(hotIds.includes(target.id), false, '默认召回不能返回冷档记录')
  // 3) 提示段「共 N 条」不计冷档
  const hint = renderHint({ dataDir: dir, hintMode: 'slim', hintSkills: false }, 1400)
  const visibleHot = visibleExperiences(readStore(dir)).length
  assert.ok(hint.includes(`共 ${visibleHot} 条`), `提示段条数应只算热档（${visibleHot}）：${hint}`)
  // 4) 关系图也不含冷档
  assert.equal(readStore(dir).experiences.some((row) => row.id === target.id), false)
})

check('冷档按字母新开片（D2/D5）：超 1 KiB 就开下一片，命名 <year>-a/b/…', () => {
  const dir = newDir()
  fs.mkdirSync(dir, { recursive: true })
  const rows = []
  for (let index = 0; index < 12; index += 1) {
    rows.push({
      id: `ex_cold_${index}`,
      intent: `冷档任务 ${index}`,
      action: `冷档做法 ${index} ${'y'.repeat(120)}`,
      outcome: 'success',
      G: 0.5,
      hits: 1,
      ts: '2026-03-01T00:00:00.000Z',
      lastSeenAt: '2026-03-01T00:00:00.000Z',
      typeId: 'ty_other',
      typeName: '未分类',
    })
  }
  const first = appendColdRecords(dir, { years: [] }, rows.slice(0, 6), { coldMaxBytes: 1024 })
  const second = appendColdRecords(dir, first.cold, rows.slice(6), { coldMaxBytes: 1024 })
  const files = fs.readdirSync(coldPath(dir)).sort()
  assert.ok(files.length >= 2, `超上限必须新开片，实际 ${files.join(',')}`)
  for (const name of files) {
    assert.match(name, /^2026-[a-z]+\.jsonl$/, `命名必须是 <year>-<letter>.jsonl：${name}`)
    assert.ok(fs.statSync(path.join(coldPath(dir), name)).size <= 1024, `${name} 必须 ≤ 单片上限`)
  }
  assert.equal(second.cold.years.length, 1)
  assert.ok(second.cold.years[0].files.length >= 2, 'years[].files[] 必须登记每一片')
  assert.equal(second.cold.years[0].count, 12)
  // 冷档读取走 manifest.cold 登记：登记表里没有该年 → 读空，而不是扫目录。
  assert.equal(readColdRecords(dir, { buckets: [], types: [], cold: { years: [] } }).length, 0)
})

check('G3 冷档按年份过滤', () => {
  const dir = newDir()
  fs.mkdirSync(dir, { recursive: true })
  const rows = [
    { id: 'ex_y25', intent: '旧年记录', action: '旧做法', outcome: 'success', G: 0.1, hits: 1, lastSeenAt: '2025-06-01T00:00:00.000Z', typeId: 'ty_other', typeName: '未分类' },
    { id: 'ex_y26', intent: '今年记录', action: '新做法', outcome: 'success', G: 0.2, hits: 1, lastSeenAt: '2026-06-01T00:00:00.000Z', typeId: 'ty_other', typeName: '未分类' },
  ]
  const { cold } = appendColdRecords(dir, { years: [] }, rows, {})
  const manifest = { buckets: [], types: [], cold }
  assert.deepEqual(readColdRecords(dir, manifest).map((row) => row.id).sort(), ['ex_y25', 'ex_y26'])
  assert.deepEqual(readColdRecords(dir, manifest, { years: [2025] }).map((row) => row.id), ['ex_y25'])
})

check('G5/G6：manifest.recent 每会话 ≤5、总 ≤100；stats 字段齐全且 ≤3 KiB', () => {
  const dir = newDir()
  const types = [makeType('ty_alpha', '阿尔法类')]
  const experiences = []
  for (let index = 0; index < 12; index += 1) {
    experiences.push({
      id: `ex_rec_${index}`,
      intent: `会话记录 ${index}`,
      action: `做法 ${index}`,
      outcome: 'success',
      G: 0.5,
      hits: 1,
      ts: at(index % 5),
      lastSeenAt: at(index % 5),
      typeId: 'ty_alpha',
      typeName: '阿尔法类',
      verdict: 'decided',
      sessionId: index < 8 ? 's_one' : 's_two',
    })
  }
  // 一条墓碑 + 一条被取代，验证 stats 计数
  experiences.push({ id: 'ex_rec_del', intent: '删掉的', action: '删', outcome: 'failed', G: -0.5, hits: 1, ts: at(9), lastSeenAt: at(9), typeId: 'ty_alpha', typeName: '阿尔法类', verdict: 'decided', deleted_at: at(9) })
  experiences.push({ id: 'ex_rec_sup', intent: '被取代的', action: '旧做法', outcome: 'success', G: 0.2, hits: 1, ts: at(9), lastSeenAt: at(9), typeId: 'ty_alpha', typeName: '阿尔法类', verdict: 'decided', superseded_by: 'ex_rec_0' })
  // 多步任务：同 taskId 两行（同类型）——tasksByType 只能算 1 个任务，visible 算 2 行
  experiences.push({ id: 'ex_step_a', taskId: 'task_multi', kind: 'step', stepIndex: 1, intent: '多步任务第一步', action: '先做甲', outcome: 'success', G: 0.8, GOutcome: 0.8, hits: 1, ts: at(3), lastSeenAt: at(3), typeId: 'ty_alpha', typeName: '阿尔法类', verdict: 'decided' })
  experiences.push({ id: 'ex_step_b', taskId: 'task_multi', kind: 'step', stepIndex: 2, intent: '多步任务第二步', action: '再做乙', outcome: 'success', G: 0.8, GOutcome: 0.8, hits: 1, ts: at(2), lastSeenAt: at(2), typeId: 'ty_alpha', typeName: '阿尔法类', verdict: 'decided' })
  writeStore(dir, { version: 1, types, experiences })
  const manifest = readManifest(dir)
  assert.ok(Array.isArray(manifest.recent))
  const perSession = new Map()
  for (const item of manifest.recent) {
    assert.deepEqual(Object.keys(item).sort(), ['at', 'id', 'intent', 'sessionId', 'typeId'], 'recent 每条必须带 typeId（P3 定向取行要用）')
    assert.equal(typeof item.typeId, 'string')
    perSession.set(item.sessionId, (perSession.get(item.sessionId) || 0) + 1)
  }
  for (const [sessionId, count] of perSession) assert.ok(count <= 5, `会话 ${sessionId} 的 recent 条数 ${count} 必须 ≤5`)
  assert.ok(manifest.recent.length <= 100)
  assert.deepEqual(manifest.recent.filter((item) => item.sessionId === 's_one').map((item) => item.id)[0], 'ex_rec_0', 'recent 按时间倒序，同秒按稳定顺序')
  assert.equal(manifest.recent.find((item) => item.id === 'ex_rec_0').typeId, 'ty_alpha', 'recent.typeId 必须是记录自己的类型')
  const stats = manifest.stats
  for (const key of ['all', 'visible', 'deleted', 'superseded', 'retired']) assert.equal(typeof stats[key], 'number', `stats.${key} 必须是数字`)
  assert.equal(stats.all, experiences.length)
  assert.equal(stats.visible, experiences.length - 2)
  assert.equal(stats.deleted, 1)
  assert.equal(stats.superseded, 1)
  assert.equal(stats.retired, 0)
  assert.ok(Array.isArray(stats.topEntities) && stats.topEntities.length <= 8)
  const byTypeVisible = Object.values(stats.byType).reduce((sum, entry) => sum + (Number(entry.visible) || 0), 0)
  assert.equal(byTypeVisible, stats.visible, 'byType.visible 合计必须等于 visible')
  // tasksByType：按 taskId 去重（12 条各自成任务 + 多步任务 1 个 = 13）
  assert.equal(typeof stats.tasksByType, 'object', 'stats.tasksByType 必须存在（exp_type list 的 count 用）')
  assert.equal(stats.tasksByType.ty_alpha, 13, `tasksByType 必须按 taskId 去重，实际 ${stats.tasksByType.ty_alpha}`)
  // 每类型统计必须带分项（增量重算 stats 靠它拼全局计数，task-6）
  assert.deepEqual(Object.keys(stats.byType.ty_alpha).sort(), ['count', 'deleted', 'retired', 'superseded', 'topTokens', 'visible'])
  assert.ok(Array.isArray(stats.byType.ty_alpha.topTokens))
  assert.ok(Buffer.byteLength(JSON.stringify(stats), 'utf8') <= 3 * 1024, 'stats 必须 ≤3 KiB')
})

check('task-6 writeTypeShards 自维护 stats/recent：只改一个类型后与全量重算逐字段相等', () => {
  const dir = newDir()
  seedStore(dir, { count: 60, bodySize: 80 })
  const before = readManifest(dir)
  const targetType = 'ty_beta'
  const otherTypes = ['ty_alpha', 'ty_gamma']
  const touchedRows = readShardRecordsOfTypes(dir, before, [targetType]).records
  // 改动 1：一条可见行被取代；改动 2：新增一条 pending（带 sessionId，进 recent）
  const victim = touchedRows.find((row) => !row.deleted_at && !row.superseded_by && !row.retired_at)
  victim.superseded_by = 'ex_head_new'
  touchedRows.push({
    id: 'ex_head_new',
    taskId: 'task_head_new',
    kind: 'task',
    intent: '新任务：给课件补一页',
    action: '新做法：先克隆再改字',
    ts: at(0), lastSeenAt: at(0),
    hits: 1,
    G: 0.8, GOutcome: 0.8, GSource: 'outcome',
    outcome: 'success',
    state: { tokens: [], cgrams: [], artifacts: [] }, step_rewards: [0.8],
    note: '',
    typeId: targetType, typeName: '贝塔类',
    verdict: 'pending', verdictAt: null, decidedBy: null,
    registeredAt: at(0), sessionId: 's_task6',
    deleted_at: null, superseded_by: null,
  })
  const untouchedBefore = new Map()
  for (const bucket of before.buckets) {
    if (otherTypes.includes(String(bucket.typeId))) untouchedBefore.set(bucket.file, JSON.stringify(bucket))
  }
  const filesBefore = filesOf(dir)
  const after = writeTypeShards(dir, before, { touchedTypeIds: [targetType], rowsByType: { [targetType]: touchedRows } })

  // 期望值：与「全量 readStore 后重算」逐字段相等（task-6 的判据）
  const fullStore = readStore(dir)
  assert.deepEqual(after.stats, statsEntries(fullStore), 'stats 必须与全量 readStore 重算逐字段相等（单一真相）')
  assert.deepEqual(after.recent, recentEntries(fullStore), 'recent 必须与全量 readStore 重算逐字段相等')
  assert.equal(after.stats.tasksByType[targetType], statsEntries(fullStore).tasksByType[targetType])
  // 未触碰类型的 manifest 条目与分片文件逐字节/逐 mtime 不变
  for (const bucket of after.buckets) {
    if (!otherTypes.includes(String(bucket.typeId))) continue
    assert.equal(JSON.stringify(bucket), untouchedBefore.get(bucket.file), `${bucket.file} 的 manifest 条目必须原样`)
  }
  const filesAfter = filesOf(dir)
  for (const [name, snapshot] of filesBefore) {
    if (name.startsWith(`${targetType}.`)) continue
    assert.equal(filesAfter.get(name).mtimeMs, snapshot.mtimeMs, `${name} mtime 必须不变`)
    assert.equal(filesAfter.get(name).bytes, snapshot.bytes, `${name} 字节必须不变`)
  }
  // pending 不传就保持旧值（task-6 的口径）
  assert.deepEqual(after.pending, before.pending, 'pending 不传时应保持')
})

check('recentRows：partial store 也能看到其它类型的「最近」，排序仍在 store 内', () => {
  const dir = newDir()
  const types = [makeType('ty_a', 'A类'), makeType('ty_b', 'B类')]
  const row = (id, typeId, typeName, intent, action, days) => ({
    id, taskId: id, kind: 'task', intent, action,
    outcome: 'success', G: 0.8, GOutcome: 0.8, GSource: 'outcome',
    hits: 1, ts: at(days), lastSeenAt: at(days),
    state: { tokens: [], cgrams: [], artifacts: [] }, step_rewards: [0.8],
    typeId, typeName, verdict: 'decided', sessionId: 's1',
    deleted_at: null, superseded_by: null,
  })
  const experiences = [
    row('ex_a', 'ty_a', 'A类', '给课件插页', '克隆相邻页', 1),
    row('ex_b', 'ty_b', 'B类', '改 PPT 页码', '用页脚工具', 0),
  ]
  writeStore(dir, { version: 1, types, experiences })
  const full = readStore(dir)
  const partial = { ...full, experiences: full.experiences.filter((item) => item.typeId === 'ty_a') }
  const withRows = rankExperiences(partial, '改 PPT 页码', 3, { recent: true, sessionId: 's1', recentRows: full.experiences })
  assert.deepEqual(withRows.recent.map((item) => item.id), ['ex_b', 'ex_a'], 'recentRows 让 partial store 也能看到别的类型，按时间倒序')
  const without = rankExperiences(partial, '改 PPT 页码', 3, { recent: true, sessionId: 's1' })
  assert.deepEqual(without.recent.map((item) => item.id), ['ex_a'], '不传 recentRows 就只用 store 里的行（partial 会漏）')
})

check('默认参数：小库不误触发压缩（无 .locks 备份、无冷档），且分片数符合类型数×K', () => {
  const dir = newDir()
  seedStore(dir, { count: 300, bodySize: 80 })
  const manifest = readManifest(dir)
  assert.equal(compactionNeeded(dir, manifest).needed, false, '小库不该触发压缩')
  assert.equal(fs.existsSync(path.join(dir, '.locks')), false, '没有压缩就不该有 .locks')
  assert.equal(fs.existsSync(coldPath(dir)), false)
  assert.ok(manifest.buckets.length <= 3 * SHARD_K)
  const usage = storageUsage(dir)
  assert.ok(usage.totalBytes > 0 && usage.coldFiles === 0)
})

check('压缩后 manifest 自愈仍与分片一致（缓存口径）', () => {
  const dir = newDir()
  seedStore(dir, { count: 120, bodySize: 120 })
  const gates = { maxBucketBytes: 6 * 1024, hotMaxBytes: 18 * 1024, nMax: 40, maxRounds: 64 }
  writeStore(dir, readStore(dir), { compact: gates })
  const before = readStore(dir)
  const coldBefore = readColdStore(dir).experiences.map((row) => row.id).sort()
  fs.unlinkSync(manifestPath(dir))
  const rebuilt = rebuildManifest(dir)
  assert.equal(rebuilt.schema, 2)
  const after = readStore(dir)
  assert.deepEqual(after.experiences.map((row) => row.id).sort(), before.experiences.map((row) => row.id).sort())
  assert.deepEqual(readColdStore(dir).experiences.map((row) => row.id).sort(), coldBefore, '重建 manifest 不能丢冷档登记')
  // 备份仍在 / 文件数仍合上界
  assert.ok(storageFileCount(dir) <= 54)
})

console.log('')
console.log(`结果：通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exit(1)
