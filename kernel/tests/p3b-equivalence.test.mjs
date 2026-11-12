/**
 * P3-B 等价性判据（TDD）：能力探测 + SKIP。
 *
 * 目的：T1/T2/T4/U3 还没实装时全 SKIP；storage-core 把 G1/G2/G4/G5（及 G6）导出后，
 * 本文件自动从 SKIP 转成真跑，用「id 序列 + 分数（4 位小数）」这种可证伪的断言卡住等价性，
 * 不许用「条数差不多」这类弱断言。
 *
 * 探测方式：`import kernel/shard-store.js`，看有没有导出对应 API；缺就 SKIP 并打印等哪条。
 *
 * Run: node kernel/tests/p3b-equivalence.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createEngine, createTools } from '../engine.js'
import { listTypes, rankExperiences, readManifest, readStore, visibleExperiences, writeStore } from '../store.js'
import * as shard from '../shard-store.js'
import { API_PREFIX, handleRequest } from '../../ui/shell.js'
import { createLiveSource } from '../../ui/live.js'

let passed = 0
let failed = 0
let skipped = 0

async function check(name, fn) {
  try {
    const verdict = await fn()
    if (verdict !== null && verdict !== undefined && typeof verdict.skip === 'string') {
      skipped += 1
      console.log(`  SKIP ${name}`)
      console.log(`       等：${verdict.skip}`)
      return
    }
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}`)
    console.log(`       ${error && error.message ? error.message : error}`)
  }
}

const newDir = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'exp-p3b-')), '.exp')
const hasApi = (name) => typeof shard[name] === 'function'
const missingApis = (names) => names.filter((name) => !hasApi(name))

/** P3-B 的召回用固定配置：路由 on、不瘦身；autoBind 保持默认（认不出会话时 recent fail-closed，
 *  命中路径的下推条件才能成立；T1c 用 exec.agent.id 显式注入会话）。 */
function makeEngine(dataDir) {
  return createEngine({
    dataDir,
    config: { routing: 'on', slimRecall: false, pendingReceipt: false },
  })
}

const PPT = 'PPT / 课件'
const CODE = '代码 / 插件'

function seed(engine, rows) {
  for (const row of rows) engine.record(row)
}

/** 正常命中：PPT 类型 4 条（primary + ty_other ≥3），另加多种类型把总桶数拉开，
 *  这样「只读 1-2 个类型」与「全量读」在 readFileSync 次数上有可观测差异。 */
function normalRows() {
  const rows = [
    { intent: '给研学课 PPT 插一页', action: '先克隆相邻页再改字（pptx）', outcome: 'success', type: PPT },
    { intent: '给研学课 PPT 加过渡页', action: '新建一页居中大标题（pptx）', outcome: 'success', type: PPT },
    { intent: '把研学课 PPT 导出成 PDF', action: 'LibreOffice 无头转换 pptx', outcome: 'success', type: PPT },
    { intent: '改研学课 PPT 的页码样式', action: '母版里统一改页码域', outcome: 'partial', type: PPT },
    { intent: '给插件补一个工具', action: '写 tools.js 的 exp_type', outcome: 'success', type: CODE },
    { intent: '整理经验库文档', action: '重写 README 的存储章节', outcome: 'success', type: '文档 / 教案' },
  ]
  const extraTypes = ['环境 / 部署', '网络 / 心跳', '调研 / 资料', '标识 / 状态归属', '上下文 / 运行时', '图片 / 设计']
  for (const [index, type] of extraTypes.entries()) {
    rows.push({ intent: `与 PPT 无关的杂项任务 ${index}`, action: `独立做法 ${index}（${type}）`, outcome: 'success', type })
  }
  return rows
}

/** merged<3：路由命中类型只有 1 条，pool 会退回全量（rankExperiences 的既定行为）。 */
function smallRows() {
  return [
    { intent: '给研学课 PPT 插一页', action: '克隆相邻页做 pptx', outcome: 'success', type: PPT },
    { intent: '修插件加载顺序', action: '读 shard-store.js 的 import', outcome: 'success', type: CODE },
  ]
}

/** 与 exp_recall 内部完全相同的全量 reference（rankExperiences 在 readStore 全量结果上跑）。 */
function referenceRecall(dataDir, intent, limit, options = {}) {
  const store = readStore(dataDir)
  const sessionId = options.sessionId === undefined ? '' : String(options.sessionId)
  const result = rankExperiences(store, intent, limit, {
    routing: 'on',
    clusterId: undefined,
    consolidation: undefined,
    consolidationMinSamples: undefined,
    context: undefined,
    explicitLimit: true,
    rankBlend: true,
    recent: true,
    recentAllSessions: options.recentAllSessions === true,
    sessionId,
  })
  // tools.js 在 weak + 低相似度时会把候选清空；reference 复刻同一后处理，保证同口径。
  if (result.weak === true && Number(result.topSimilarity || 0) < 0.2) result.candidates = []
  return result
}

/** 只比 id 序列 + rank_score（4 位小数）：等价性必须可证伪，不接受「条数差不多」。 */
function candidateShape(payload) {
  return (Array.isArray(payload && payload.candidates) ? payload.candidates : []).map((candidate) => {
    const evidence = Array.isArray(candidate && candidate.evidence) ? candidate.evidence[0] : null
    return [String((evidence && evidence.id) || ''), Number(candidate && candidate.rank_score).toFixed(4)]
  })
}

/**
 * 在 fn 执行期间数「实际读了几个桶文件」（fs.readFileSync 读到 buckets/*.jsonl 的次数）。
 * 用来证明路由命中路径真的只读了 1-2 个类型，而不是把全量读了一遍再算出一模一样的结果。
 */
function countBucketReads(fn) {
  const original = fs.readFileSync
  let count = 0
  fs.readFileSync = function patched(file, ...args) {
    if (typeof file === 'string' && file.endsWith('.jsonl') && file.includes(`${path.sep}buckets${path.sep}`)) count += 1
    return original.call(fs, file, ...args)
  }
  try {
    return { value: fn(), count }
  } finally {
    fs.readFileSync = original
  }
}

function bucketSignature(dataDir) {
  const out = {}
  const dir = path.join(dataDir, 'buckets')
  let names = []
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl'))
  } catch {
    names = []
  }
  for (const name of names) {
    const stat = fs.statSync(path.join(dir, name), { bigint: true })
    out[name] = `${stat.size}:${stat.mtimeNs}:${stat.ino}`
  }
  return out
}

function diffKeys(before, after) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  return [...keys].filter((key) => before[key] !== after[key]).sort()
}

function hasRecentIndex(dataDir) {
  if (hasApi('readRecentRows') || hasApi('readRecentBySession')) return true
  let manifest = null
  try {
    manifest = readManifest(dataDir)
  } catch {
    manifest = null
  }
  return manifest !== null && (Array.isArray(manifest.recent) || Array.isArray(manifest.recentBySession))
}

function fakeReq(url, method = 'GET') {
  return {
    url,
    method,
    async *[Symbol.asyncIterator]() {
      // GET 无 body
    },
  }
}

function fakeRes() {
  return {
    statusCode: 0,
    body: '',
    headers: {},
    setHeader(name, value) { this.headers[name] = value },
    end(text) { this.body = text },
  }
}

async function callRoute(source, route) {
  const res = fakeRes()
  await handleRequest(fakeReq(`${API_PREFIX}${route}`), res, source)
  return { status: res.statusCode, payload: JSON.parse(res.body) }
}

/* -------------------------------------------------------------------------- */
/* T1 召回等价（G1 按类型读分片；T1c 另外等 G5 recent 索引）                     */
/* -------------------------------------------------------------------------- */

await check('T1a 召回等价（正常命中：候选 id 序列 + 4 位分数与全量一致）', () => {
  const missing = missingApis(['readShardRecordsOfTypes'])
  if (missing.length > 0) return { skip: `G1 ${missing.join(', ')}（等 P2/task-3 导出；P3-B 的 exp_recall 按类型下推要用）` }
  const dataDir = newDir()
  const engine = makeEngine(dataDir)
  seed(engine, normalRows())
  const intent = '给研学课 PPT 插一页'
  const reference = referenceRecall(dataDir, intent, 5)
  assert.equal(reference.route !== null && reference.route.fallback === false, true, '测试数据应命中簇（否则这不是「正常命中」场景）')
  const totalBuckets = (readManifest(dataDir) || { buckets: [] }).buckets.length
  const { value: tool, count: bucketReads } = countBucketReads(() => engine.recall({ intent, limit: 5 }))
  assert.deepEqual(candidateShape(tool), candidateShape(reference), '候选 id 序列/分数必须与全量路径逐位一致')
  // 等价不能靠「全量读一遍再算出一模一样」：必须真的只读了命中类型的分片。
  assert.ok(bucketReads > 0 && bucketReads < totalBuckets, `路由命中路径应只读部分桶（实际读了 ${bucketReads}/${totalBuckets} 个桶）`)
  return null
})

await check('T1b 召回等价（merged<3 回退全量：候选 id 序列 + 4 位分数一致）', () => {
  const missing = missingApis(['readShardRecordsOfTypes'])
  if (missing.length > 0) return { skip: `G1 ${missing.join(', ')}（等 P2/task-3 导出；P3-B 的 exp_recall 按类型下推要用）` }
  const dataDir = newDir()
  const engine = makeEngine(dataDir)
  seed(engine, smallRows())
  const intent = '给研学课 PPT 插一页'
  const reference = referenceRecall(dataDir, intent, 5)
  assert.equal(reference.route !== null && reference.route.fallback === false, true, '测试数据应命中簇（merged<3 但路由命中）')
  const full = readStore(dataDir)
  const routeTypeId = reference.route.clusterId
  const primaryRows = visibleExperiences(full).filter((row) => row.typeId === routeTypeId || row.typeId === 'ty_other').length
  assert.ok(primaryRows < 3, `这是 merged<3 场景，primary=${primaryRows}`)
  const tool = engine.recall({ intent, limit: 5 })
  assert.deepEqual(candidateShape(tool), candidateShape(reference), '回退全量时也必须与全量路径逐位一致')
  return null
})

await check('T1c 召回等价（recent 段存在时的默认路径）', () => {
  const missing = missingApis(['readShardRecordsOfTypes'])
  if (missing.length > 0) return { skip: `G1 ${missing.join(', ')}（等 P2/task-3 导出；P3-B 的 exp_recall 按类型下推要用）` }
  const dataDir = newDir()
  const engine = makeEngine(dataDir)
  seed(engine, normalRows())
  // 造出「有会话的最近记录」：把 PPT 的 4 条挂到一个会话上，写回后 manifest.recent 就有索引。
  const sessionId = 'sess-p3b'
  const store = readStore(dataDir)
  for (const row of store.experiences) {
    if (row.typeId !== undefined && String(row.intent || '').includes('PPT')) row.sessionId = sessionId
  }
  writeStore(dataDir, store)
  if (!hasRecentIndex(dataDir)) {
    return { skip: 'G5 recent 索引（manifest.recent / readManifest().recent）——加索引后本用例自动跑；否则默认召回路径的 recent 会漏其它类型' }
  }
  const intent = '给研学课 PPT 插一页'
  const reference = referenceRecall(dataDir, intent, 5, { sessionId })
  assert.ok(Array.isArray(reference.recent) && reference.recent.length > 0, '测试数据应产生 recent 段')
  // 走真实工具入口，exec.agent.id 提供会话（engine.recall 不能传 exec，所以这里用 createTools）。
  const tools = createTools({ dataDir, routing: 'on', slimRecall: false, pendingReceipt: false })
  const recallTool = tools.find((tool) => tool.name === 'exp_recall')
  assert.ok(recallTool !== undefined, '应有 exp_recall 工具')
  const tool = recallTool.execute({ intent, limit: 5 }, { agent: { id: sessionId } })
  assert.deepEqual(candidateShape(tool), candidateShape(reference), 'recent 存在时候选仍必须与全量一致')
  assert.deepEqual((tool.recent || []).map((row) => row.id), reference.recent.map((row) => row.id), 'recent 段 id 序列必须与全量一致')
  return null
})

await check('T1d mark 写回局部性：只重写候选所在类型的分片', () => {
  const missing = missingApis(['readShardRecordsOfTypes', 'writeTypeShards'])
  if (missing.length > 0) return { skip: `${missing.join(', ')}（等 P2/task-3 导出；mark 写回要走 writeTypeShards）` }
  const dataDir = newDir()
  const engine = makeEngine(dataDir)
  seed(engine, normalRows())
  const before = bucketSignature(dataDir)
  const tool = engine.recall({ intent: '给研学课 PPT 插一页', limit: 5, mark: true })
  assert.ok(Number(tool.marked) > 0, 'mark 应至少命中 1 条候选')
  const full = readStore(dataDir)
  const typeOf = new Map(full.experiences.map((row) => [String(row.id), String(row.typeId || 'ty_other')]))
  const recalledTypes = new Set()
  for (const candidate of tool.candidates || []) {
    for (const evidence of candidate.evidence || []) {
      const typeId = typeOf.get(String(evidence.id))
      if (typeId !== undefined) recalledTypes.add(typeId)
    }
  }
  const changed = diffKeys(before, bucketSignature(dataDir))
  assert.ok(changed.length >= 1, '候选所在类型的分片应至少有一个变化')
  const unexpected = changed.filter((name) => ![...recalledTypes].some((typeId) => name.startsWith(`${typeId}.`)))
  assert.deepEqual(unexpected, [], `mark 不能重写非候选类型的桶：${unexpected.join(', ')}`)
  const marked = readStore(dataDir).experiences.filter((row) => (Number(row.retrievals) || 0) > 0).length
  assert.ok(marked > 0, 'retrievals 应落盘')
  return null
})

await check('T1e 待判定写回局部性：partial 召回只重写 pending 所在类型', () => {
  const missing = missingApis(['readShardRecordsOfTypes', 'writeTypeShards'])
  if (missing.length > 0) return { skip: `${missing.join(', ')}（等 P2/task-3 导出；pending 提醒写回要走 writeTypeShards）` }
  const dataDir = newDir()
  const tools = createTools({ dataDir, routing: 'on', slimRecall: false, pendingReceipt: true })
  const recordTool = tools.find((tool) => tool.name === 'exp_record')
  const recallTool = tools.find((tool) => tool.name === 'exp_recall')
  const exec = { agent: { id: 'sess-pending' } }
  recordTool.execute({ intent: '给研学课 PPT 插一页', action: '克隆相邻页再改字 pptx', outcome: 'success', type: PPT }, exec)
  recordTool.execute({ intent: '给研学课 PPT 加过渡页', action: '新建一页大标题 pptx', outcome: 'success', type: PPT }, exec)
  recordTool.execute({ intent: '把研学课 PPT 导出成 PDF', action: 'LibreOffice 无头转换 pptx', outcome: 'success', type: PPT }, exec)
  recordTool.execute({ intent: '给研学课 PPT 改页码', action: '母版里统一改页码域', type: PPT }, exec) // 无 outcome → pending
  const manifestBefore = readManifest(dataDir)
  assert.ok(Array.isArray(manifestBefore.pending) && manifestBefore.pending.length >= 1, '应有 pending 索引')
  const before = bucketSignature(dataDir)
  const out = recallTool.execute({ intent: '给研学课 PPT 插一页', limit: 5 }, exec)
  assert.ok(Array.isArray(out.pending) && out.pending.length >= 1, '回执应带出本会话的 pending')
  const pendingTypes = new Set((manifestBefore.pending || []).map((entry) => String(entry.typeId || 'ty_other')))
  const changed = diffKeys(before, bucketSignature(dataDir))
  const unexpected = changed.filter((name) => ![...pendingTypes].some((typeId) => name.startsWith(`${typeId}.`)))
  assert.deepEqual(unexpected, [], `pending 写回不能碰其它类型：${unexpected.join(', ')}`)
  return null
})

/* -------------------------------------------------------------------------- */
/* T2 定向写局部性（G4 writeTypeShards）                                        */
/* -------------------------------------------------------------------------- */

await check('T2 定向写局部性：exp_record 后其它类型的桶 mtime/字节不变', () => {
  const missing = missingApis(['writeTypeShards'])
  if (missing.length > 0) return { skip: `G4 ${missing.join(', ')}（等 P2/task-3；P3-B 的 exp_record 定向写要用；P1 的 writeStore 是分片全量重写）` }
  const dataDir = newDir()
  const engine = makeEngine(dataDir)
  seed(engine, [
    { intent: '给研学课 PPT 插一页', action: '克隆相邻页 pptx', outcome: 'success', type: PPT },
    { intent: '给研学课 PPT 加过渡页', action: '新建一页 pptx', outcome: 'success', type: PPT },
    { intent: '给插件补一个工具', action: '写 tools.js', outcome: 'success', type: CODE },
  ])
  const before = bucketSignature(dataDir)
  engine.record({ intent: '给插件修一个工具', action: '改 exp_type 的分支', outcome: 'success', type: CODE })
  const manifest = readManifest(dataDir)
  assert.ok(manifest !== null && Array.isArray(manifest.types), '写完应有 manifest')
  const codeType = manifest.types.find((type) => type.name === CODE)
  assert.ok(codeType !== undefined, '应能找到「代码 / 插件」类型')
  const after = bucketSignature(dataDir)
  const changed = diffKeys(before, after)
  assert.ok(changed.length >= 1, '目标类型的分片至少应有一个变化')
  const unexpected = changed.filter((name) => !name.startsWith(`${codeType.id}.`))
  assert.deepEqual(unexpected, [], `其它类型的桶不能被顺带重写：${unexpected.join(', ')}`)
  return null
})

/* -------------------------------------------------------------------------- */
/* T4 类型操作等价（exp_type list/create 只读 manifest == 全量读）              */
/* -------------------------------------------------------------------------- */

await check('T4 exp_type list/create：manifest 结果与全量读逐字段一致', () => {
  const missing = missingApis(['readShardRecordsOfTypes'])
  if (missing.length > 0) return { skip: `${missing.join(', ')}（等 P2/task-3 导出；T4 随 P3-B 落地，用 G1 的可用性作为批次信号）` }
  const dataDir = newDir()
  const engine = makeEngine(dataDir)
  seed(engine, normalRows())
  const full = readStore(dataDir)
  const expectedTypes = listTypes(full)
  const listed = engine.types({ action: 'list' })
  assert.deepEqual(listed.types, expectedTypes, 'exp_type list 的类型/条数必须与全量读一致')
  const created = engine.types({ action: 'create', name: 'P3B 临时类型', typeDescription: '等价性测试用' })
  assert.ok(typeof created.created === 'string' && created.created !== '', 'create 应有回执')
  const manifest = readManifest(dataDir)
  assert.ok(manifest.types.some((type) => type.name === 'P3B 临时类型'), '新类型应进 manifest')
  assert.ok(readStore(dataDir).types.some((type) => type.name === 'P3B 临时类型'), '新类型应能全量读到')
  const expectedAfter = listTypes(readStore(dataDir))
  assert.deepEqual(engine.types({ action: 'list' }).types, expectedAfter, 'create 之后的 list 也必须与全量一致')
  return null
})

/* -------------------------------------------------------------------------- */
/* U3 轻路径一致（G6 manifest.stats）                                          */
/* -------------------------------------------------------------------------- */

await check('U3 /state 轻路径：hotCalls=0 且 totals/stats 与全量算出来的逐字段相等', async () => {
  const dataDir = newDir()
  const engine = makeEngine(dataDir)
  seed(engine, normalRows())
  const manifest = readManifest(dataDir)
  if (manifest === null || manifest.stats === null || typeof manifest.stats !== 'object') {
    return { skip: 'G6 manifest.stats（等 P2/task-3 的 buildManifest；/state 轻路径靠它出 totals/stats）' }
  }
  if (!hasApi('statsEntries')) {
    return { skip: 'G6 statsEntries（存储层从全量算 stats 的同一函数；没有它，「与全量逐字段相等」没有唯一口径）' }
  }
  const source = createLiveSource({ dataDir })
  let hotCalls = 0
  const originalHot = typeof source.hot === 'function' ? source.hot.bind(source) : null
  source.hot = (...args) => {
    hotCalls += 1
    return originalHot === null ? { store: { version: 1, types: [], experiences: [] } } : originalHot(...args)
  }
  const { payload } = await callRoute(source, '/state')
  assert.equal(payload.ok, true)
  assert.equal(hotCalls, 0, '/state 不该加载全量经验（hotCalls 必须为 0）')
  const full = readStore(dataDir)
  const visible = visibleExperiences(full)
  const expectedTotals = {
    all: full.experiences.length,
    visible: visible.length,
    deleted: full.experiences.filter((row) => row.deleted_at).length,
    superseded: full.experiences.filter((row) => row.superseded_by).length,
    retired: full.experiences.filter((row) => row.retired_at).length,
    types: full.types.length,
    skills: 0,
  }
  assert.deepEqual(payload.data.totals, expectedTotals, 'totals 必须与全量读一致')

  // 用存储层自己的 statsEntries（全量算）作为唯一口径：manifest.stats 就是它在写入时的结果。
  const expected = shard.statsEntries(full)
  const stats = payload.data.stats
  assert.equal(stats.totalInsights, expected.visible, 'totalInsights 必须等于全量可见数')
  assert.equal(stats.deletedInsights, expected.deleted, 'deletedInsights 必须与全量一致')
  assert.equal(stats.supersededInsights, expected.superseded, 'supersededInsights 必须与全量一致')
  assert.equal(stats.retiredInsights, expected.retired, 'retiredInsights 必须与全量一致')
  assert.equal(stats.dbSizeBytes, payload.data.bytes, 'dbSizeBytes 应等于 storage.totalBytes')
  assert.deepEqual(stats.topEntities, expected.topEntities, 'topEntities 必须与全量 statsEntries 逐条一致')
  // byType 是 {typeId:{count,visible}}：界面口径是「类型名 → 可见条数」。
  const nameOf = new Map(full.types.map((type) => [String(type.id), String(type.name || '未分类')]))
  const expectedByCategory = {}
  for (const [typeId, entry] of Object.entries(expected.byType || {})) {
    const count = Number(entry && entry.visible) || 0
    if (count <= 0) continue
    const name = nameOf.get(String(typeId)) || String(typeId)
    expectedByCategory[name] = (expectedByCategory[name] || 0) + count
  }
  assert.deepEqual(stats.byCategory, expectedByCategory, 'byCategory 必须与全量 statsEntries 的可见计数一致')
  return null
})

console.log('')
console.log(`结果：通过 ${passed} 项，跳过 ${skipped} 项，失败 ${failed} 项`)
if (failed > 0) process.exit(1)
