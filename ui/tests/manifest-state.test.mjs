/**
 * P3-A 控制台轻量读测试：概览（/state）与设置页只读 manifest + storage，不加载全量经验；
 * 需要行的页面（经验列表/详情/关系图）走 source.hot()。mock 数据源保持旧路径。
 *
 * 另含 P3-B 前的「统计口径」守门：同一份数据在单文件布局 / 分片布局下，/state 的
 * totals/stats/types 必须逐字段相等（统计只允许 kernel statsEntries 一个来源）。
 *
 * Run: node ui/tests/manifest-state.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { API_PREFIX, handleRequest } from '../shell.js'
import { createMockSource } from '../mock.js'
import { createLiveSource } from '../live.js'
import { migrateStore } from '../../kernel/store.js'

let passed = 0
let failed = 0

async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}`)
    console.log(`       ${error && error.message ? error.message : error}`)
  }
}

const manifest = {
  schema: 2,
  version: 1,
  types: [{ id: 'ty_code', name: '代码 / 插件', description: '写代码', system: false }],
  clusters: [{
    id: 'cl_code',
    typeId: 'ty_code',
    name: '代码 / 插件',
    description: '写代码',
    signature: { artifacts: ['code'], tokens: ['npm'], cgrams: ['代码'] },
    stats: { count: 2, success: 1, fail: 1 },
  }],
  buckets: [{ file: 'buckets/ty_code.0.jsonl', typeId: 'ty_code', count: 2, bytes: 200, latestTs: '2026-11-12T00:00:00.000Z' }],
  pending: [],
  cold: { years: [] },
  stats: { all: 2, visible: 2, deleted: 0, superseded: 0, retired: 0, byType: { ty_code: { count: 2, visible: 2 } }, topEntities: [{ entity: 'npm', count: 2 }] },
}

const storage = {
  manifestBytes: 120,
  bucketBytes: 200,
  bucketFiles: 1,
  coldBytes: 0,
  coldFiles: 0,
  legacy: { exists: true, bytes: 80 },
  fileCount: 3,
  totalBytes: 400,
  updatedAt: null,
}

const rows = [
  { id: 'ex_1', intent: '给插件跑测试', action: '先跑 npm test', outcome: 'success', G: 0.8, GOutcome: 0.8, GSource: 'outcome', hits: 1, typeId: 'ty_code', typeName: '代码 / 插件', ts: '2026-11-12T00:00:00.000Z', lastSeenAt: '2026-11-12T00:00:00.000Z', note: '', origin: 'manual', kind: 'task' },
  { id: 'ex_2', intent: '给插件写测试', action: '补一个用例', outcome: 'success', G: 0.8, GOutcome: 0.8, GSource: 'outcome', hits: 1, typeId: 'ty_code', typeName: '代码 / 插件', ts: '2026-11-11T00:00:00.000Z', lastSeenAt: '2026-11-11T00:00:00.000Z', note: '', origin: 'manual', kind: 'task' },
]

function makeLightSource() {
  const stats = { hotCalls: 0, readCalls: 0 }
  const source = {
    id: 'live',
    mode: 'live',
    label: '真实数据',
    readOnly: false,
    read() {
      stats.readCalls += 1
      return {
        manifest,
        storage,
        dataDir: 'D:/x/.exp',
        file: 'D:/x/.exp/manifest.json',
        exists: true,
        bytes: storage.totalBytes,
        updatedAt: null,
        notice: '',
      }
    },
    hot() {
      stats.hotCalls += 1
      return { store: { version: 1, types: manifest.types, experiences: rows } }
    },
    skills: () => [],
    usageRows: () => [],
    skillsList: () => [],
    pending: () => [],
  }
  return { source, stats }
}

function fakeReq(url, method = 'GET', body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  return {
    url,
    method,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
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

async function call(source, route, options = {}) {
  const res = fakeRes()
  await handleRequest(fakeReq(`${API_PREFIX}${route}`, options.method || 'GET', options.body), res, source)
  return { status: res.statusCode, payload: JSON.parse(res.body) }
}

// ---------------------------------------------------------------- 轻量路径

const light = makeLightSource()

await check('/state 轻路径：只读 manifest+storage，不调 hot()', async () => {
  const { payload } = await call(light.source, '/state')
  assert.equal(payload.ok, true)
  const data = payload.data
  assert.equal(light.stats.hotCalls, 0, '/state 不该加载全量经验')
  assert.equal(data.totals.all, 2)
  assert.equal(data.totals.visible, 2)
  assert.equal(data.totals.deleted, 0)
  assert.equal(data.totals.types, 1)
  assert.equal(data.stats.dbSizeBytes, 400)
  assert.deepEqual(data.stats.topEntities, [{ entity: 'npm', count: 2 }])
  // G6 的 byType 是 {tyId:{count,visible}}，界面口径要归一化成 {类型名: 条数}
  assert.deepEqual(data.stats.byCategory, { '代码 / 插件': 2 })
  assert.equal(data.types.length, 1)
  assert.equal(data.types[0].count, 2)
  assert.equal(data.storage.totalBytes, 400)
  for (const key of ['app', 'version', 'source', 'dataDir', 'file', 'exists', 'bytes', 'updatedAt', 'notice', 'totals', 'stats', 'types', 'usage']) {
    assert.ok(Object.prototype.hasOwnProperty.call(data, key), `state 缺少 ${key}`)
  }
})

await check('/settings 轻路径：storage 分项 + legacy 标记', async () => {
  const { payload } = await call(light.source, '/settings')
  assert.equal(payload.ok, true)
  const data = payload.data
  assert.equal(light.stats.hotCalls, 0, '/settings 不该加载全量经验')
  assert.equal(data.bytes, 400)
  assert.ok(String(data.file).endsWith('manifest.json'))
  assert.equal(data.storage.legacy.exists, true)
  assert.equal(data.storage.bucketFiles, 1)
})

await check('/types 轻路径：只读 manifest 的类型目录', async () => {
  const { payload } = await call(light.source, '/types')
  assert.equal(payload.ok, true)
  assert.equal(light.stats.hotCalls, 0)
  assert.equal(payload.data.types.length, 1)
  assert.equal(payload.data.types[0].id, 'ty_code')
})

await check('/experiences 需要行 → 走 hot()，内容不变', async () => {
  const before = light.stats.hotCalls
  const { payload } = await call(light.source, '/experiences')
  assert.equal(payload.ok, true)
  assert.equal(light.stats.hotCalls, before + 1)
  assert.equal(payload.data.mode, 'list')
  assert.equal(payload.data.rows.length, 2)
})

await check('/experience 详情走 hot()', async () => {
  const { payload } = await call(light.source, '/experience?id=ex_1')
  assert.equal(payload.ok, true)
  assert.equal(payload.data.row.id, 'ex_1')
})

await check('/graph 保持全量行（只验不改），节点/边照旧生成', async () => {
  const { payload } = await call(light.source, '/graph')
  assert.equal(payload.ok, true)
  const data = payload.data
  assert.ok(data.nodes.some((node) => node.kind === 'root'))
  assert.ok(data.nodes.some((node) => node.kind === 'type' && node.id === 'type:ty_code'))
  assert.equal(data.nodes.filter((node) => node.kind === 'experience').length, 2)
  assert.ok(data.edges.length >= 2)
})

// ---------------------------------------------------------------- 兼容路径

await check('mock 数据源仍走全量行（行为与 0.13.0 一致）', async () => {
  const { payload } = await call(createMockSource(), '/state')
  const data = payload.data
  assert.ok(data.totals.visible > 0)
  assert.ok(data.stats.topEntities.length > 0)
  const exp = await call(createMockSource(), '/experiences')
  assert.ok(exp.payload.data.rows.length > 0)
})

await check('manifest 没有 stats 时退回全量行（G6 未落地的兼容路径）', async () => {
  const withoutStats = { ...manifest, stats: undefined }
  const { source } = makeLightSource()
  source.read = () => ({
    manifest: withoutStats,
    storage,
    dataDir: 'D:/x/.exp',
    file: 'D:/x/.exp/manifest.json',
    exists: true,
    bytes: storage.totalBytes,
    updatedAt: null,
    notice: '',
  })
  const { payload } = await call(source, '/state')
  assert.equal(payload.ok, true)
  assert.ok(payload.data.totals.visible > 0, '没有 manifest.stats 时应能靠 hot() 兜底')
})

await check('坏 read（没有 manifest 也没有 store）不崩：概览按空库显示', async () => {
  const source = {
    id: 'live', mode: 'live', label: '真实数据', readOnly: false,
    read: () => ({ manifest: null, storage: null, dataDir: '', file: '', exists: false, bytes: 0, updatedAt: null, notice: 'x' }),
    skills: () => [], usageRows: () => [],
  }
  const { payload } = await call(source, '/state')
  assert.equal(payload.ok, true)
  assert.equal(payload.data.totals.visible, 0)
})

await check('迁移不改诊断：单文件 vs 分片布局的 /state totals/stats/types 逐字段相等', async () => {
  const now = '2026-11-12T00:00:00.000Z'
  const store = {
    version: 1,
    types: [
      { id: 'ty_code', name: '代码 / 插件', description: '写代码', system: false },
      { id: 'ty_ppt', name: 'PPT / 课件', description: '做课件', system: false },
      { id: 'ty_other', name: '未分类', description: '兜底', system: true },
    ],
    experiences: [
      { id: 'ex_m1', ts: now, lastSeenAt: now, hits: 2, intent: '给研学课 PPT 插一页', action: '克隆相邻页再改字 pptx', outcome: 'success', G: 0.8, GOutcome: 0.8, GSource: 'outcome', typeId: 'ty_ppt', typeName: 'PPT / 课件' },
      { id: 'ex_m2', ts: now, lastSeenAt: now, hits: 1, intent: '给研学课 PPT 加过渡页', action: '新建一页大标题 pptx', outcome: 'failed', G: -0.8, GOutcome: -0.8, GSource: 'outcome', typeId: 'ty_ppt', typeName: 'PPT / 课件' },
      { id: 'ex_m3', ts: now, lastSeenAt: now, hits: 1, intent: '给插件补一个工具', action: '写 tools.js 的 exp_type', outcome: 'success', G: 0.8, GOutcome: 0.8, GSource: 'outcome', typeId: 'ty_code', typeName: '代码 / 插件' },
      { id: 'ex_m4', ts: now, lastSeenAt: now, hits: 1, intent: '整理经验库文档', action: '重写 README 的存储章节', outcome: 'partial', G: 0.3, GOutcome: 0.3, GSource: 'outcome', typeId: 'ty_code', typeName: '代码 / 插件' },
      { id: 'ex_m5', ts: now, lastSeenAt: now, hits: 1, intent: '给研学课 PPT 插一页', action: '旧做法（已被取代）', outcome: 'failed', G: -0.8, GOutcome: -0.8, GSource: 'outcome', typeId: 'ty_ppt', typeName: 'PPT / 课件', superseded_by: 'ex_m1' },
      { id: 'ex_m6', ts: now, lastSeenAt: now, hits: 1, intent: '已删除的任务', action: '删除的做法', outcome: 'success', G: 0.8, GOutcome: 0.8, GSource: 'outcome', typeId: 'ty_code', typeName: '代码 / 插件', deleted_at: now },
    ],
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-state-mig-'))
  const singleDir = path.join(root, 'single')
  const shardedDir = path.join(root, 'sharded')
  for (const dir of [singleDir, shardedDir]) {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'exp-lib.json'), `${JSON.stringify(store, null, 2)}\n`, 'utf8')
  }
  migrateStore(shardedDir)

  const single = await call(createLiveSource({ dataDir: singleDir }), '/state')
  const sharded = await call(createLiveSource({ dataDir: shardedDir }), '/state')
  assert.equal(single.payload.ok, true)
  assert.equal(sharded.payload.ok, true)
  const a = single.payload.data
  const b = sharded.payload.data
  assert.equal(a.exists, true)
  assert.equal(b.exists, true)
  assert.ok(String(a.file).endsWith('exp-lib.json'))
  assert.ok(String(b.file).endsWith('manifest.json'))
  // 布局会改变「文件/字节」这类存储事实，但诊断口径不能变。
  assert.deepEqual(b.totals, a.totals, 'totals 不许因迁移而变')
  assert.deepEqual(b.types, a.types, '类型目录/计数不许因迁移而变')
  const stripSize = (stats) => {
    const { dbSizeBytes, ...rest } = stats
    return rest
  }
  assert.deepEqual(stripSize(b.stats), stripSize(a.stats), 'stats（totalInsights/deleted/superseded/retired/topEntities/byCategory）不许因迁移而变')
  assert.deepEqual(b.stats.topEntities, a.stats.topEntities, 'topEntities 必须同一口径、同一结果')
  assert.equal(a.stats.dbSizeBytes, a.bytes)
  assert.equal(b.stats.dbSizeBytes, b.bytes)
  assert.deepEqual(b.usage, a.usage)
})

console.log('')
console.log(`结果：通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exit(1)
