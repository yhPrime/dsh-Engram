/**
 * `GET /graph` summary / limit / degree 契约（P4 数据层硬化，0.19.0）。
 *
 * 独立运行：node ui/tests/graph-api.test.mjs
 * 覆盖：默认全量、summary 截断（骨架节点全留）、排序（weight→recent→lastSeenAt）、
 * limit 边界（0 / 负数 / 非数字 / 超 1200）、degree（O(N+E) 计数）、空库、坏桶。
 * 不碰真实经验库：live 数据源全部指向临时目录，mock 用内置示例数据。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { API_PREFIX, handleRequest } from '../shell.js'
import { createMockSource } from '../mock.js'
import { createLiveSource } from '../live.js'

// 隔离设置文件：否则 resolveEngramDataDir 会读用户真实的 ~/.dsh/engram/settings.json。
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-graph-api-home-'))
process.env.DSH_HOME = testHome
delete process.env.ENGRAM_DATA_DIR

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
    console.log(`       ${error && error.stack ? error.stack : error}`)
  }
}

function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value
    },
    end(body) {
      this.body = String(body === undefined ? '' : body)
    },
  }
}

function fakeReq(url, method = 'GET') {
  return {
    url,
    method,
    async *[Symbol.asyncIterator]() {},
  }
}

async function call(source, route, options = {}) {
  const res = fakeRes()
  await handleRequest(fakeReq(`${API_PREFIX}${route}`, options.method || 'GET'), res, source, options.deps)
  let payload = null
  try {
    payload = JSON.parse(res.body)
  } catch {
    payload = null
  }
  return { status: res.statusCode, headers: res.headers, payload }
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'engram-graph-'))
}

/** 一条最小可用的经验行（rowOf 会补齐其余字段）。 */
function expRow(id, G, lastSeenAt, typeId = 'ty_demo') {
  return {
    id,
    intent: `意图 ${id}`,
    action: `做法 ${id}`,
    typeId,
    typeName: '演示类型',
    outcome: 'success',
    G,
    ts: lastSeenAt,
    lastSeenAt,
  }
}

/** 假数据源：形状与 live/mock 一致（read + hot + skills），方便造边界数据。 */
function fakeSource(experiences, options = {}) {
  const store = {
    version: 1,
    types: options.types || [{ id: 'ty_demo', name: '演示类型', description: '', system: false }],
    experiences,
  }
  return {
    id: 'fake',
    mode: 'live',
    label: '测试数据',
    readOnly: true,
    read: () => ({
      dataDir: '',
      file: '',
      exists: true,
      updatedAt: '2026-01-01T00:00:00.000Z',
      notice: String(options.notice || ''),
    }),
    hot: () => ({ store, error: null }),
    skills: () => options.skills || [],
  }
}

const byKindOf = (nodes, kind) => nodes.filter((node) => node.kind === kind)
const degreeOf = (edges, id) => edges.filter((edge) => edge.source === id || edge.target === id).length

/** 图的基本不变量：边不悬空、degree 与边表一致、byKind 与节点一致、degree 总和 = 2 × 边数。 */
function assertGraphInvariants(data) {
  const ids = new Set(data.nodes.map((node) => node.id))
  assert.equal(ids.size, data.nodes.length, '节点 id 重复')
  for (const edge of data.edges) {
    assert.ok(ids.has(edge.source), `悬空边 source：${edge.source}`)
    assert.ok(ids.has(edge.target), `悬空边 target：${edge.target}`)
  }
  for (const node of data.nodes) {
    assert.equal(typeof node.degree, 'number', `${node.id} 缺 degree`)
    assert.ok(Number.isInteger(node.degree) && node.degree >= 0, `${node.id} degree 非法：${node.degree}`)
    assert.equal(node.degree, degreeOf(data.edges, node.id), `${node.id} degree 与边表不符`)
  }
  const counted = data.nodes.reduce((sum, node) => sum + node.degree, 0)
  assert.equal(counted, data.edges.length * 2, 'degree 总和应等于 2 × 边数')
  const kinds = {}
  for (const node of data.nodes) kinds[node.kind] = (kinds[node.kind] || 0) + 1
  assert.deepEqual(data.byKind, kinds, 'byKind 与返回节点不符')
  const nodeIds = (kind) => byKindOf(data.nodes, kind).map((node) => node.id).sort()
  return { nodeIds }
}

await check('默认全量：mock 12 条经验全在，无截断，带 total/byKind/degree', async () => {
  const source = createMockSource()
  const { status, payload } = await call(source, '/graph')
  assert.equal(status, 200)
  const data = payload.data
  assert.equal(data.total, 12)
  assert.equal(data.truncated, false)
  assert.equal(byKindOf(data.nodes, 'experience').length, 12)
  assert.equal(data.summary.experiences, 12, 'summary.experiences 仍应是全量口径')
  assertGraphInvariants(data)
  // root 的 degree = 从 root 出发的边数（类型根边 + 独立技能边）。
  assert.equal(data.nodes.find((node) => node.id === 'root').degree, data.edges.filter((edge) => edge.source === 'root').length)
})

await check('旧 client 兼容：只带 limit 不带 scope 仍返回全量', async () => {
  const source = createMockSource()
  const all = await call(source, '/graph?limit=3')
  assert.equal(all.status, 200)
  assert.equal(all.payload.data.truncated, false)
  assert.equal(byKindOf(all.payload.data.nodes, 'experience').length, 12)
})

await check('summary 截断：只裁经验，root/type/skill/suite 骨架全留', async () => {
  const source = createMockSource()
  const full = (await call(source, '/graph')).payload.data
  const summary = (await call(source, '/graph?scope=summary&limit=5')).payload.data
  assert.equal(summary.total, 12)
  assert.equal(summary.truncated, true)
  assert.equal(byKindOf(summary.nodes, 'experience').length, 5)
  assert.equal(summary.byKind.experience, 5)
  assert.equal(summary.summary.experiences, 12, 'summary.experiences 不随截断变')
  for (const kind of ['root', 'type', 'skill', 'suite']) {
    assert.deepEqual(
      byKindOf(summary.nodes, kind).map((node) => node.id).sort(),
      byKindOf(full.nodes, kind).map((node) => node.id).sort(),
      `${kind} 节点不该被裁`,
    )
  }
  assertGraphInvariants(summary)
  // 被裁掉的经验，其 type→exp / exp→skill 边也必须一起消失（不能留悬空边）。
  const kept = new Set(byKindOf(summary.nodes, 'experience').map((node) => node.id))
  for (const edge of summary.edges) {
    if (edge.target.startsWith('exp:') || edge.source.startsWith('exp:')) {
      assert.ok(kept.has(edge.source.startsWith('exp:') ? edge.source : edge.target), `残边：${edge.source} → ${edge.target}`)
    }
  }
})

await check('summary 默认 300：库大时也只给 300 条经验', async () => {
  const rows = Array.from({ length: 1300 }, (_, index) => expRow(`ex_${String(index).padStart(4, '0')}`, ((index % 21) - 10) / 20, '2025-01-01T00:00:00.000Z'))
  const source = fakeSource(rows)
  const data = (await call(source, '/graph?scope=summary')).payload.data
  assert.equal(data.total, 1300)
  assert.equal(data.truncated, true)
  assert.equal(byKindOf(data.nodes, 'experience').length, 300)
  assert.equal(data.byKind.experience, 300)
  assertGraphInvariants(data)
})

await check('summary 排序：weight 降序，其次 recent，再按 lastSeenAt', async () => {
  const now = new Date().toISOString()
  const old = '2020-01-01T00:00:00.000Z'
  const rows = [
    expRow('a', 0.9, now),
    expRow('b', 0.5, old),
    expRow('c', 0.5, now),
    expRow('d', 0, old),
    expRow('e', -0.2, old),
    expRow('f', 0.1, old),
  ]
  const source = fakeSource(rows)
  const data = (await call(source, '/graph?scope=summary&limit=4')).payload.data
  assert.deepEqual(byKindOf(data.nodes, 'experience').map((node) => node.id), ['exp:a', 'exp:c', 'exp:b', 'exp:e'])
  assert.equal(data.nodes.find((node) => node.id === 'exp:c').recent, true)
  assertGraphInvariants(data)
})

await check('limit 边界：0/负数夹到 1，非数字回默认 300，超上限夹到 1200', async () => {
  const bigRows = Array.from({ length: 1300 }, (_, index) => expRow(`ex_${index}`, 0.5, '2025-01-01T00:00:00.000Z'))
  const big = fakeSource(bigRows)
  const countOf = async (query) => byKindOf((await call(big, `/graph?scope=summary${query}`)).payload.data.nodes, 'experience').length

  assert.equal(await countOf('&limit=0'), 1, 'limit=0 应夹到 1')
  assert.equal(await countOf('&limit=-3'), 1, '负数应夹到 1')
  assert.equal(await countOf('&limit=abc'), 300, '非数字应回默认 300')
  assert.equal(await countOf('&limit='), 300, '空 limit 应回默认 300')
  assert.equal(await countOf('&limit=1'), 1)
  assert.equal(await countOf('&limit=99999'), 1200, '超上限应夹到 1200')
  assert.equal(await countOf(''), 300, '默认 300')
  assert.equal((await call(big, '/graph?scope=summary&limit=99999')).payload.data.truncated, true)

  const small = fakeSource([expRow('only', 0.2, '2025-01-01T00:00:00.000Z')])
  const smallData = (await call(small, '/graph?scope=summary&limit=50')).payload.data
  assert.equal(smallData.truncated, false, '经验数小于 limit 时不该标截断')
  assert.equal(byKindOf(smallData.nodes, 'experience').length, 1)
})

await check('空库：root + 系统类型，total 0、不截断、degree 0', async () => {
  const source = createLiveSource({ dataDir: tempDir() })
  const { status, payload } = await call(source, '/graph?scope=summary')
  assert.equal(status, 200)
  const data = payload.data
  assert.equal(data.total, 0)
  assert.equal(data.truncated, false)
  assert.equal(byKindOf(data.nodes, 'experience').length, 0)
  // 空库仍有系统兜底类型 ty_other：root → 类型 一条边，degree 各 1。
  assert.equal(data.edges.length, 1)
  assert.deepEqual(data.byKind, { root: 1, type: 1 })
  assert.equal(data.nodes.find((node) => node.id === 'root').degree, 1)
  assert.equal(data.nodes.find((node) => node.id === 'type:ty_other').degree, 1)
  assertGraphInvariants(data)
})

await check('坏桶：summary 也保持 200 + storeError，不假装成空库', async () => {
  const dir = tempDir()
  fs.writeFileSync(path.join(dir, 'exp-lib.json'), '{ 这不是 JSON', 'utf8')
  const source = createLiveSource({ dataDir: dir })
  for (const route of ['/graph', '/graph?scope=summary&limit=10']) {
    const { status, payload } = await call(source, route)
    assert.equal(status, 200, `${route} 应该 200（横幅而不是 500）`)
    assert.equal(payload.ok, true)
    assert.equal(payload.data.storeError.code, 'store-unreadable', `${route} 缺 storeError`)
    assert.ok(String(payload.data.storeError.message).length > 0)
    assert.equal(payload.data.total, 0)
    assert.equal(payload.data.truncated, false)
    assert.ok(payload.data.nodes.some((node) => node.kind === 'root'))
    assertGraphInvariants(payload.data)
  }
})

await check('POST /graph 仍是 405', async () => {
  const source = createMockSource()
  const { status, payload } = await call(source, '/graph', { method: 'POST' })
  assert.equal(status, 405)
  assert.equal(payload.ok, false)
})

fs.rmSync(testHome, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
