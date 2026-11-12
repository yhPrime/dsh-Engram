/**
 * 存储分片层验收（0.14.0 P1，计划书 §4.1–§4.7 / §8）：
 *  1. 迁移等价：迁移前后逐字段（G/hits/typeId/feedback_log/verdict…）相等；
 *  2. 幂等：连续迁移两次，第二次不写任何文件（mtime 不变）；
 *  3. 坏文件：旧库/manifest/分片损坏或分片丢失都抛错，绝不静默空库；
 *  4. 迁移失败：exp-lib.json 原样保留、不写 manifest；
 *  5. 文件数上界：类型打满也 ≤ 54；
 *  6. 分片规则：按 typeId 归桶、hash 稳定、空桶不落文件、count 与行数一致；
 *  7. manifest 簇缓存：删除类型只掉该类型条目，其它条目原样。
 *
 * Run: node kernel/tests/shard-store.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'

import {
  deleteType,
  migrateStore,
  readManifest,
  readStore,
  rebuildManifest,
  storeFile,
  writeStore,
} from '../store.js'
import {
  SHARD_K,
  bucketsPath,
  legacyPath,
  manifestPath,
  readManifestFile,
  shardBucketIndex,
  shardFileBudget,
  storageBytes,
  storageFileCount,
  storageUsage,
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

const newDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'exp-shard-'))
const now = Date.now()
const at = (days) => new Date(now - days * 86400000).toISOString()

/** 旧单库夹具：覆盖反馈日志 / 无日志 G=1 / 取代 / 墓碑 / 退休 / pending / skipped / 幽灵类型。 */
function legacyPayload() {
  const types = [
    { id: 'ty_code', name: '代码 / 插件', description: '写代码与插件', system: false, createdAt: at(30), source: 'model-created' },
    { id: 'ty_ppt', name: 'PPT / 课件', description: '做课件', system: false, createdAt: at(20), source: 'model-created' },
    { id: 'ty_other', name: '未分类', description: '兜底', system: true },
  ]
  const experiences = [
    {
      id: 'ex_ledger', taskId: 'ex_ledger', kind: 'task',
      intent: '给插件跑自动化测试', action: '先跑 npm test',
      ts: at(5), lastSeenAt: at(5), hits: 3,
      G: 0.5, outcome: 'success', GSource: 'feedback', expectedG: 0.8, predictionError: -0.3,
      feedback_log: [{ at: at(4), result: 'hurt', eta: 0.35 }, { at: at(3), result: 'helped', eta: 0.35 }],
      feedback: { helped: 1, hurt: 1, neutral: 0, lastAt: at(3), lastResult: 'helped' },
      state: { tokens: ['测试'], cgrams: [], artifacts: [] }, step_rewards: [0.5],
      typeId: 'ty_code', typeName: '代码 / 插件',
      verdict: 'decided', verdictAt: at(5), decidedBy: 'model',
      dimensions: ['测试'], artifacts: ['kernel/tests/x.test.mjs'], context: ['插件开发'],
      deleted_at: null, superseded_by: null,
    },
    {
      id: 'ex_pristine', taskId: 'ex_pristine', kind: 'task',
      intent: '整理 Excel', action: '先清洗再透视',
      ts: at(9), lastSeenAt: at(9), hits: 1,
      G: 1, outcome: 'success',
      state: { tokens: [], cgrams: [], artifacts: [] }, step_rewards: [1],
      typeId: 'ty_code', typeName: '代码 / 插件',
      verdict: 'skipped', deleted_at: null, superseded_by: null,
    },
    {
      id: 'ex_old', taskId: 'ex_old', kind: 'task',
      intent: '制作研学课六页PPT', action: '先定主题色再排版',
      ts: at(12), lastSeenAt: at(12), hits: 2,
      G: 0.8, GOutcome: 0.8, outcome: 'success',
      state: { tokens: [], cgrams: [], artifacts: [] }, step_rewards: [0.8],
      typeId: 'ty_ppt', typeName: 'PPT / 课件',
      verdict: 'decided', deleted_at: null, superseded_by: 'ex_new',
    },
    {
      id: 'ex_new', taskId: 'ex_old', kind: 'task',
      intent: '制作研学课六页PPT', action: '先排版再统一调色',
      ts: at(2), lastSeenAt: at(2), hits: 1,
      G: 0.3, GOutcome: 0.3, outcome: 'partial',
      state: { tokens: [], cgrams: [], artifacts: [] }, step_rewards: [0.3],
      typeId: 'ty_ppt', typeName: 'PPT / 课件', supersedes: 'ex_old',
      verdict: 'decided', deleted_at: null, superseded_by: null,
    },
    {
      id: 'ex_tomb', taskId: 'ex_tomb', kind: 'task',
      intent: '临时任务', action: '随手做', ts: at(40), lastSeenAt: at(40), hits: 1,
      G: -0.4, GOutcome: -0.4, outcome: 'failed',
      state: { tokens: [], cgrams: [], artifacts: [] }, step_rewards: [-0.4],
      typeId: 'ty_code', typeName: '代码 / 插件',
      verdict: 'decided', deleted_at: at(39), superseded_by: null,
    },
    {
      id: 'ex_retired', taskId: 'ex_retired', kind: 'step', stepIndex: 1, stepTotal: 2,
      intent: '给课件插页', action: '克隆相邻页', ts: at(8), lastSeenAt: at(8), hits: 2,
      G: -0.6, GOutcome: -0.6, outcome: 'failed',
      state: { tokens: [], cgrams: [], artifacts: [] }, step_rewards: [-0.6],
      typeId: 'ty_ppt', typeName: 'PPT / 课件',
      verdict: 'decided', retired_at: at(1), retired_reason: 'superseded-by-success',
      deleted_at: null, superseded_by: null,
    },
    {
      id: 'ex_pending', taskId: 'ex_pending', kind: 'task',
      intent: '把插件发布到 GitHub', action: '先打 tag 再推',
      ts: at(1), lastSeenAt: at(1), hits: 1, registeredAt: at(1),
      G: 0, GOutcome: 0, outcome: 'unknown',
      state: { tokens: [], cgrams: [], artifacts: [] }, step_rewards: [0],
      typeId: 'ty_other', typeName: '未分类',
      verdict: 'pending', verdictAt: null, decidedBy: null, sessionId: 's_1',
      deleted_at: null, superseded_by: null,
    },
    {
      id: 'ex_ghost', taskId: 'ex_ghost', kind: 'task',
      intent: '幽灵类型任务', action: '随便写',
      ts: at(3), lastSeenAt: at(3), hits: 1,
      G: 0.2, GOutcome: 0.2, outcome: 'accepted',
      state: { tokens: [], cgrams: [], artifacts: [] }, step_rewards: [0.2],
      typeId: 'ty_deleted_ghost', typeName: '幽灵',
      verdict: 'decided', deleted_at: null, superseded_by: null,
    },
  ]
  return { version: 1, updated_at: at(0), types, experiences }
}

function writeLegacy(dir, payload) {
  writeLegacyFile(dir, JSON.stringify(payload))
}

function writeLegacyFile(dir, text) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(storeFile(dir), text, 'utf8')
}

const byId = (rows) => new Map(rows.map((row) => [row.id, row]))
const sortedById = (rows) => [...rows].sort((left, right) => String(left.id).localeCompare(String(right.id)))
const snapshotBuckets = (dir) => {
  const out = {}
  let names = []
  try {
    names = fs.readdirSync(bucketsPath(dir)).sort()
  } catch {
    names = []
  }
  for (const name of names) out[name] = fs.readFileSync(path.join(bucketsPath(dir), name), 'utf8')
  return out
}
const fileMtimes = (dir) => {
  const out = {}
  const add = (file) => {
    const key = path.relative(dir, file).replace(/\\/g, '/')
    try {
      out[key] = fs.statSync(file).mtimeMs
    } catch {
      out[key] = null
    }
  }
  add(manifestPath(dir))
  let names = []
  try {
    names = fs.readdirSync(bucketsPath(dir))
  } catch {
    names = []
  }
  for (const name of names) add(path.join(bucketsPath(dir), name))
  return out
}

check('迁移等价：逐字段（G/hits/typeId/feedback_log/verdict）相等 + 排序哈希相等', () => {
  const dir = newDir()
  writeLegacy(dir, legacyPayload())
  const before = readStore(dir)
  const outcome = migrateStore(dir)
  assert.equal(outcome.migrated, true)
  assert.equal(outcome.records, before.experiences.length)
  const after = readStore(dir)

  const left = byId(before.experiences)
  const right = byId(after.experiences)
  assert.deepEqual([...right.keys()].sort(), [...left.keys()].sort(), 'id 集合必须相同')
  for (const [id, row] of left) {
    const other = right.get(id)
    assert.deepEqual(other, row, `记录 ${id} 必须逐字段相等`)
    assert.equal(other.G, row.G)
    assert.equal(other.GOutcome, row.GOutcome)
    assert.equal(other.hits, row.hits)
    assert.equal(other.typeId, row.typeId)
    assert.equal(other.verdict, row.verdict)
    assert.deepEqual(other.feedback_log, row.feedback_log)
  }
  assert.deepEqual(after.types, before.types, 'types 逐字段相等')
  assert.deepEqual(after.clusters, before.clusters, '簇是派生视图，迁移后必须一致')
  // 排序后哈希：整库口径（记录 + 类型），与 §8.1 的判据对齐。
  const hashOf = (store) => createHash('sha1').update(JSON.stringify({
    version: store.version,
    types: store.types,
    experiences: [...store.experiences].sort((a, b) => String(a.id).localeCompare(String(b.id))),
  })).digest('hex')
  assert.equal(hashOf(after), hashOf(before), '迁移前后整库哈希必须相等')
  // 幽灵 typeId：两条读路径都归「未分类」。
  assert.equal(right.get('ex_ghost').typeId, 'ty_other')
})

check('迁移后形态：manifest + buckets + legacy 就位，旧单文件消失', () => {
  const dir = newDir()
  writeLegacy(dir, legacyPayload())
  migrateStore(dir)
  assert.ok(fs.existsSync(manifestPath(dir)), 'manifest.json 必须存在')
  assert.ok(fs.existsSync(legacyPath(dir)), 'exp-lib.legacy.json 必须保留（回滚用）')
  assert.equal(fs.existsSync(storeFile(dir)), false, 'exp-lib.json 必须改名移走')
  const manifest = readManifest(dir)
  assert.equal(manifest.schema, 2)
  assert.equal(manifest.version, 1)
  assert.equal(manifest.migratedFrom, 'exp-lib.json')
  assert.ok(manifest.buckets.length > 0)
  assert.equal(manifest.types.length, 3)
})

check('幂等：第二次迁移不写任何文件（记录级 mtime 不变）', () => {
  const dir = newDir()
  writeLegacy(dir, legacyPayload())
  migrateStore(dir)
  const before = fileMtimes(dir)
  const again = migrateStore(dir)
  assert.equal(again.migrated, false)
  assert.equal(again.reason, 'manifest-exists')
  assert.deepEqual(fileMtimes(dir), before, '第二次迁移不能碰任何文件')
})

check('幂等：写盘重复两次内容一致（manifest 逐字节不变）', () => {
  const dir = newDir()
  writeLegacy(dir, legacyPayload())
  migrateStore(dir)
  const store = readStore(dir)
  writeStore(dir, store)
  const first = readManifestFile(dir)
  const firstText = fs.readFileSync(manifestPath(dir), 'utf8')
  writeStore(dir, readStore(dir))
  const second = readManifestFile(dir)
  assert.equal(fs.readFileSync(manifestPath(dir), 'utf8'), firstText, '同一数据集写两次，manifest 必须逐字节一致（不写时间戳）')
  assert.deepEqual(second.buckets, first.buckets, '同一数据集的分片登记必须完全一致')
  assert.deepEqual(second.clusters, first.clusters)
  assert.deepEqual(second.types, first.types)
})

check('坏旧库：readStore / migrateStore 都抛错，且旧文件原样、不写 manifest', () => {
  const dir = newDir()
  const broken = '{"version":1,"experiences":[{"id":"x"}'
  writeLegacyFile(dir, broken)
  assert.throws(() => readStore(dir), /读取失败/, 'readStore 必须抛错，不能当空库')
  assert.throws(() => migrateStore(dir), /读取失败/)
  assert.equal(fs.readFileSync(storeFile(dir), 'utf8'), broken, '旧文件必须原样保留')
  assert.equal(fs.existsSync(manifestPath(dir)), false, '失败时不能写 manifest')
  // writeStore 也不能把空快照写回去
  assert.throws(() => writeStore(dir, { types: [], experiences: [] }), /读取失败/)
  assert.equal(fs.readFileSync(storeFile(dir), 'utf8'), broken)
  assert.equal(fs.existsSync(manifestPath(dir)), false)
})

check('坏旧库：结构损坏（experiences 非数组）同样抛错且不迁移', () => {
  const dir = newDir()
  writeLegacyFile(dir, JSON.stringify({ version: 1, types: [], experiences: { bad: true } }))
  assert.throws(() => migrateStore(dir), /结构损坏/)
  assert.equal(fs.existsSync(manifestPath(dir)), false)
})

check('迁移失败：目标 buckets 位置不可用 → 抛错、旧库原样、无 manifest、仍可读到旧数据', () => {
  const dir = newDir()
  const payload = legacyPayload()
  writeLegacy(dir, payload)
  // 用一个同名文件占住 buckets 目录名，让写分片必然失败（确定性注入，不依赖权限）。
  fs.writeFileSync(bucketsPath(dir), 'not a directory', 'utf8')
  assert.throws(() => migrateStore(dir), /EEXIST|ENOTDIR|not a directory|mkdir|rename|占用/i)
  assert.equal(fs.readFileSync(storeFile(dir), 'utf8'), JSON.stringify(payload), '旧库必须逐字节原样')
  assert.equal(fs.existsSync(manifestPath(dir)), false, '失败时不能写 manifest')
  const store = readStore(dir)
  assert.equal(store.experiences.length, payload.experiences.length, '失败后仍能按旧库读')
})

check('坏分片：单行损坏 → readStore 抛错（不静默少读）', () => {
  const dir = newDir()
  writeLegacy(dir, legacyPayload())
  migrateStore(dir)
  const manifest = readManifest(dir)
  const file = path.join(dir, manifest.buckets[0].file)
  fs.appendFileSync(file, '{ 这不是合法 JSON\n', 'utf8')
  assert.throws(() => readStore(dir), /分片损坏/)
})

check('D3：manifest 声明 count>0 的分片被删 → 明确报错，不再静默自愈少行', () => {
  const dir = newDir()
  writeLegacy(dir, legacyPayload())
  migrateStore(dir)
  const victim = readManifestFile(dir).buckets[0]
  const victimPath = path.join(dir, victim.file)
  const original = fs.readFileSync(victimPath)
  fs.unlinkSync(victimPath)
  let message = ''
  try {
    readStore(dir)
  } catch (error) {
    message = String(error.message || '')
  }
  assert.match(message, /分片丢失|分片损坏/, '已声明分片被删必须明确报错')
  assert.ok(message.includes(victim.file), '错误应定位到被删的分片文件')
  // 不许用少行结果重建 manifest（事故被抹平）。
  const stillListed = readManifestFile(dir).buckets.some((bucket) => bucket.file === victim.file)
  assert.equal(stillListed, true, '报错时 manifest 不能被重写成「没这个分片」')
  // 恢复文件后应能正常读（错误是可恢复的，不是永久损坏）。
  fs.writeFileSync(victimPath, original)
  const healed = readStore(dir)
  assert.equal(healed.experiences.length, readManifestFile(dir).buckets.reduce((sum, bucket) => sum + bucket.count, 0))
})

check('D1：manifest 写坏 → 自动重建，不抛错也不读空', () => {
  const dir = newDir()
  writeLegacy(dir, legacyPayload())
  migrateStore(dir)
  const before = readStore(dir)
  const bucketsBefore = snapshotBuckets(dir)
  fs.writeFileSync(manifestPath(dir), '{"schema":2,"types":', 'utf8')
  const after = readStore(dir)
  assert.equal(after.experiences.length, before.experiences.length, '坏缓存不能让库读空')
  assert.deepEqual(sortedById(after.experiences), sortedById(before.experiences))
  assert.deepEqual(snapshotBuckets(dir), bucketsBefore, '重建只改 manifest，分片一个字节都不许动')
  const healed = readManifestFile(dir)
  assert.equal(healed.schema, 2)
  JSON.parse(fs.readFileSync(manifestPath(dir), 'utf8')) // 必须是合法 JSON
})

check('D1：删掉 manifest 后 readStore 等价（manifest 只是缓存）', () => {
  const dir = newDir()
  writeLegacy(dir, legacyPayload())
  migrateStore(dir)
  const before = readStore(dir)
  const bucketsBefore = snapshotBuckets(dir)
  fs.unlinkSync(manifestPath(dir))
  const rebuilt = rebuildManifest(dir)
  assert.equal(rebuilt.schema, 2)
  assert.ok(rebuilt.buckets.length > 0)
  const after = readStore(dir)
  // 等价口径（计划书 §8.1）：id 集合 + 每条全字段（按 id 排序后逐条比）。
  assert.deepEqual(sortedById(after.experiences), sortedById(before.experiences))
  assert.deepEqual(snapshotBuckets(dir), bucketsBefore, '重建前后 buckets 必须逐字节不变')
})

check('D1：manifest 条数被改错 → 缓存自愈，记录一条不丢', () => {
  const dir = newDir()
  writeLegacy(dir, legacyPayload())
  migrateStore(dir)
  const before = readStore(dir)
  const raw = readManifestFile(dir)
  raw.buckets[0].count = 0
  fs.writeFileSync(manifestPath(dir), `${JSON.stringify(raw, null, 2)}\n`, 'utf8')
  const after = readStore(dir)
  assert.equal(after.experiences.length, before.experiences.length)
  const healed = readManifestFile(dir)
  assert.equal(healed.buckets.reduce((sum, bucket) => sum + bucket.count, 0), before.experiences.length, '条数必须被回正')
})

check('分片规则：按 typeId 归桶、hash 稳定、空桶不落文件、count 与行数一致', () => {
  const dir = newDir()
  writeLegacy(dir, legacyPayload())
  migrateStore(dir)
  const manifest = readManifest(dir)
  const typeIds = new Set(manifest.types.map((type) => type.id))
  for (const bucket of manifest.buckets) {
    assert.ok(bucket.count > 0, '空桶不该登记')
    assert.equal(bucket.file.startsWith('buckets/'), true, `分片路径应在 buckets/ 下：${bucket.file}`)
    const file = path.join(dir, bucket.file)
    const text = fs.readFileSync(file, 'utf8')
    const lines = text.split('\n').filter((line) => line.trim() !== '')
    assert.equal(lines.length, bucket.count, `${bucket.file} 的 count 必须等于实际行数`)
    assert.equal(Buffer.byteLength(text, 'utf8'), bucket.bytes, 'bytes 必须等于实际字节数')
    for (const line of lines) {
      const row = JSON.parse(line)
      const expectedTypeId = typeIds.has(String(row.typeId)) ? String(row.typeId) : 'ty_other'
      assert.ok(bucket.file.startsWith(`buckets/${expectedTypeId}.`), `${row.id} 应落在 ${expectedTypeId} 的分片里`)
      assert.equal(shardBucketIndex(row.id), Number(bucket.file.split('.').at(-2)), `${row.id} 的桶号必须与 hash 一致`)
    }
  }
  // 没有登记的散落分片（空桶 / 旧桶）
  const onDisk = fs.readdirSync(bucketsPath(dir)).filter((name) => name.endsWith('.jsonl')).sort()
  assert.deepEqual(onDisk, manifest.buckets.map((bucket) => path.basename(bucket.file)).sort(), '磁盘上的分片必须与 manifest 一一对应')
})

check('文件数上界：类型打满（24 业务 + 未分类）也不超过 54 个文件', () => {
  const dir = newDir()
  const types = [{ id: 'ty_other', name: '未分类', description: '兜底', system: true }]
  const experiences = []
  for (let index = 0; index < 24; index += 1) {
    const id = `ty_t${index}`
    types.push({ id, name: `类型${index}`, description: `第 ${index} 类`, system: false })
    for (let row = 0; row < 4; row += 1) {
      experiences.push({
        id: `ex_t${index}_${row}`, taskId: `ex_t${index}_${row}`, kind: 'task',
        intent: `任务 ${index}-${row}`, action: `做法 ${index}-${row}`,
        ts: at(row), lastSeenAt: at(row), hits: 1,
        G: 0.8, GOutcome: 0.8, outcome: 'success',
        state: { tokens: [], cgrams: [], artifacts: [] }, step_rewards: [0.8],
        typeId: id, typeName: `类型${index}`, verdict: 'decided',
        deleted_at: null, superseded_by: null,
      })
    }
  }
  writeStore(dir, { version: 1, types, experiences })
  const manifest = readManifest(dir)
  // 空桶不落文件：4 条/类型时 hash 可能全撞进同一个桶，所以只能断言上界与非空。
  assert.ok(manifest.buckets.length > 0)
  assert.ok(manifest.buckets.length <= (24 + 1) * SHARD_K, `分片数 ${manifest.buckets.length} 不能超过类型数 × K`)
  assert.ok(manifest.buckets.every((bucket) => bucket.count > 0))
  const files = storageFileCount(dir)
  assert.ok(files <= shardFileBudget(24) + 1, `文件数 ${files} 必须 ≤ ${shardFileBudget(24) + 1}`)
  assert.ok(files <= 54, `文件数 ${files} 必须 ≤ 54`)
  assert.equal(readStore(dir).experiences.length, experiences.length, '一个都不能少')
})

check('簇缓存增量：删除类型只掉该类型条目，其它条目原样', () => {
  const dir = newDir()
  writeLegacy(dir, legacyPayload())
  migrateStore(dir)
  const before = readManifest(dir).clusters
  assert.ok(before.some((cluster) => cluster.typeId === 'ty_ppt'))
  const store = readStore(dir)
  const removed = deleteType(store, 'PPT / 课件')
  assert.equal(removed.moved, 3, 'PPT 的 3 条（含已被取代/退休的）都要改挂')
  writeStore(dir, store)
  const after = readManifest(dir).clusters
  assert.equal(after.some((cluster) => cluster.typeId === 'ty_ppt'), false, '被删类型的簇条目必须移除')
  const codeBefore = before.find((cluster) => cluster.typeId === 'ty_code')
  const codeAfter = after.find((cluster) => cluster.typeId === 'ty_code')
  assert.deepEqual(codeAfter, codeBefore, '没变的类型不能重算/改写')
  // 记录改挂到「未分类」后，未分类的簇统计要跟着涨。
  const fallback = after.find((cluster) => cluster.typeId === 'ty_other')
  assert.ok(fallback.stats.count >= 3, `未分类应收到 2 条改挂记录，实际 ${fallback.stats.count}`)
})

check('提示段索引：manifest.pending 只登记待判定，且不带正文之外的字段', () => {
  const dir = newDir()
  writeLegacy(dir, legacyPayload())
  migrateStore(dir)
  const manifest = readManifest(dir)
  assert.equal(manifest.pending.length, 1)
  assert.equal(manifest.pending[0].id, 'ex_pending')
  assert.equal(manifest.pending[0].typeId, 'ty_other')
  assert.deepEqual(Object.keys(manifest.pending[0]).sort(), ['id', 'intent', 'typeId'])
})

check('返回形状：readStore 仍是 {version, types, experiences, clusters}', () => {
  const dir = newDir()
  writeLegacy(dir, legacyPayload())
  migrateStore(dir)
  const store = readStore(dir)
  assert.deepEqual(Object.keys(store).sort(), ['clusters', 'experiences', 'types', 'version'])
  assert.ok(Array.isArray(store.experiences))
  assert.ok(Array.isArray(store.types))
  assert.ok(Array.isArray(store.clusters))
})

check('无旧库、无 manifest：空库且不落盘（读路径不写文件）', () => {
  const dir = newDir()
  const store = readStore(dir)
  assert.equal(store.experiences.length, 0)
  assert.deepEqual(migrateStore(dir), { migrated: false, reason: 'no-legacy' })
  assert.equal(fs.existsSync(manifestPath(dir)), false)
})

check('G7 storageUsage：口径统一（fileCount / totalBytes 都含 legacy）', () => {
  const dir = newDir()
  writeLegacy(dir, legacyPayload())
  migrateStore(dir)
  const usage = storageUsage(dir)
  assert.equal(usage.legacy.exists, true)
  assert.ok(usage.manifestBytes > 0)
  assert.ok(usage.bucketFiles > 0 && usage.bucketBytes > 0)
  assert.equal(usage.coldFiles, 0)
  assert.equal(usage.coldBytes, 0)
  assert.equal(usage.updatedAt, null, 'D1 之后不编更新时间')
  assert.equal(usage.fileCount, 1 + usage.bucketFiles + usage.coldFiles + (usage.legacy.exists ? 1 : 0))
  assert.equal(usage.totalBytes, usage.manifestBytes + usage.bucketBytes + usage.coldBytes + usage.legacy.bytes)
  // 热档口径（storageBytes）不含 legacy；文件数口径（storageFileCount）含 legacy —— 两者对得上
  assert.equal(storageBytes(dir), usage.totalBytes - usage.legacy.bytes)
  assert.equal(storageFileCount(dir), usage.fileCount)
})

check('迁移后写入局部一致：写一版（改一条）再读，内容与预期一致', () => {
  const dir = newDir()
  writeLegacy(dir, legacyPayload())
  migrateStore(dir)
  const store = readStore(dir)
  const target = store.experiences.find((row) => row.id === 'ex_pristine')
  target.hits = 9
  target.G = 0.4
  writeStore(dir, store)
  const back = readStore(dir)
  assert.equal(back.experiences.find((row) => row.id === 'ex_pristine').hits, 9)
  const manifest = readManifest(dir)
  const total = manifest.buckets.reduce((sum, bucket) => sum + bucket.count, 0)
  assert.equal(total, back.experiences.length, 'manifest 条数合计必须等于读回条数')
})

console.log('')
console.log(`结果：通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exit(1)
