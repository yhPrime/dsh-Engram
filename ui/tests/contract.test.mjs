/**
 * exp-ui 契约测试：API.md 里写了的，接口实际要给得到。
 * Run: node tests/contract.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { API_PREFIX, handleRequest } from '../shell.js'
import { createMockSource } from '../mock.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const doc = fs.readFileSync(path.join(root, 'API.md'), 'utf8')

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
    body: '',
    setHeader() {},
    end(body) {
      this.body = String(body === undefined ? '' : body)
    },
  }
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

async function call(source, route, options = {}) {
  const res = fakeRes()
  await handleRequest(fakeReq(`${API_PREFIX}${route}`, options.method || 'GET', options.body), res, source)
  return { status: res.statusCode, payload: JSON.parse(res.body) }
}

const source = createMockSource()

await check('API.md 覆盖全部路由与错误码', () => {
  for (const route of ['/health', '/state', '/experiences', '/experience', '/feedback', '/types', '/skills', '/usage', '/settings', '/sync', '/github', '/skill-global', '/skill-meta', '/skill-forget', '/chat-save']) {
    assert.ok(doc.includes(route), `文档缺少路由 ${route}`)
  }
  for (const code of ['id-required', 'bad-result', 'not-found', 'read-only', 'method-not-allowed', 'not-feedbackable', 'internal', 'bad-action', 'github', 'repo-required', 'slug-required', 'ids-required', 'turn-not-found']) {
    assert.ok(doc.includes(code), `文档缺少错误码 ${code}`)
  }
  assert.ok(doc.includes('source: mock'))
  assert.ok(doc.includes('source: live'))
  assert.ok(doc.includes('dataDir'))
})

await check('/state 返回文档里列的全部字段', async () => {
  const { payload } = await call(source, '/state')
  const data = payload.data
  for (const key of ['app', 'version', 'source', 'dataDir', 'file', 'exists', 'bytes', 'updatedAt', 'notice', 'totals', 'stats', 'types', 'usage']) {
    assert.ok(Object.prototype.hasOwnProperty.call(data, key), `state 缺少 ${key}`)
  }
  for (const key of ['id', 'mode', 'label', 'readOnly']) {
    assert.ok(Object.prototype.hasOwnProperty.call(data.source, key), `state.source 缺少 ${key}`)
  }
  for (const key of ['all', 'visible', 'deleted', 'superseded', 'retired', 'types', 'skills']) {
    assert.ok(Object.prototype.hasOwnProperty.call(data.totals, key), `state.totals 缺少 ${key}`)
  }
  assert.equal(typeof data.skillSummary, 'object')
  assert.equal(typeof data.skillSummary.total, 'number')
  for (const key of ['total', 'today', 'byTool', 'lastAt', 'lastTool']) {
    assert.ok(Object.prototype.hasOwnProperty.call(data.usage, key), `state.usage 缺少 ${key}`)
  }
})

await check('/experiences 列表行有文档里列的全部字段', async () => {
  const { payload } = await call(source, '/experiences')
  const data = payload.data
  assert.equal(data.mode, 'list')
  assert.ok(Array.isArray(data.rows) && data.rows.length > 0)
  const row = data.rows[0]
  for (const key of [
    'id', 'intent', 'action', 'typeId', 'typeName', 'outcome', 'G', 'GOutcome', 'GSource', 'hits',
    'note', 'origin', 'kind', 'taskId', 'stepIndex', 'stepTotal', 'createdAt', 'lastSeenAt', 'feedback', 'lifecycle',
  ]) {
    assert.ok(Object.prototype.hasOwnProperty.call(row, key), `rows[] 缺少 ${key}`)
  }
  for (const key of ['supersededBy', 'retiredAt', 'retiredReason', 'deletedAt']) {
    assert.ok(Object.prototype.hasOwnProperty.call(row.lifecycle, key), `lifecycle 缺少 ${key}`)
  }
})

await check('/experiences 检索态候选与证据字段齐全', async () => {
  const { payload } = await call(source, `/experiences?query=${encodeURIComponent('把 PPT 导出成 PDF')}`)
  const data = payload.data
  assert.ok(['advantage', 'evidence'].includes(data.mode))
  assert.ok(data.rows.length > 0)
  const candidate = data.rows[0]
  for (const key of ['action', 'typeName', 'advantage', 'advantageNorm', 'confidence', 'rankScore', 'support', 'meanSimilarity', 'evidenceStrength', 'evidence']) {
    assert.ok(Object.prototype.hasOwnProperty.call(candidate, key), `候选缺少 ${key}`)
  }
  const evidence = candidate.evidence[0]
  for (const key of ['id', 'intent', 'action', 'outcome', 'G', 'similarity', 'typeName', 'note', 'feedback', 'lifecycle']) {
    assert.ok(Object.prototype.hasOwnProperty.call(evidence, key), `证据缺少 ${key}`)
  }
})

await check('/experience 详情字段齐全', async () => {
  const { payload } = await call(source, '/experience?id=ex_mock_01')
  const data = payload.data
  assert.ok(data.row && Array.isArray(data.history) && Array.isArray(data.feedbackLog))
})

await check('/feedback 回执字段与文档一致', async () => {
  const local = createMockSource()
  const { payload } = await call(local, '/feedback', { method: 'POST', body: { id: 'ex_mock_01', result: 'helped' } })
  for (const key of ['id', 'result', 'G_before', 'G_after', 'changed', 'outcome', 'typeName', 'feedback', 'source']) {
    assert.ok(Object.prototype.hasOwnProperty.call(payload.data, key), `回执缺少 ${key}`)
  }
})

await check('/usage 行字段齐全、/types 字段齐全', async () => {
  const usage = await call(source, '/usage?limit=3')
  for (const key of ['at', 'tool', 'ok', 'op', 'intent', 'action', 'feedback', 'id', 'error', 'limit', 'routeScore', 'ids', 'chars']) {
    assert.ok(Object.prototype.hasOwnProperty.call(usage.payload.data.rows[0], key), `usage 行缺少 ${key}`)
  }
  assert.equal(typeof usage.payload.data.rows[0].chars, 'number')
  const types = await call(source, '/types')
  for (const key of ['id', 'name', 'description', 'system', 'count']) {
    assert.ok(Object.prototype.hasOwnProperty.call(types.payload.data.types[0], key), `type 缺少 ${key}`)
  }
})

await check('错误体形状与文档一致（code + message）', async () => {
  const { status, payload } = await call(source, '/nope')
  assert.equal(status, 404)
  assert.equal(payload.ok, false)
  assert.equal(typeof payload.error.code, 'string')
  assert.equal(typeof payload.error.message, 'string')
})

await check('/skills 返回文档里列的全部字段', async () => {
  const { payload } = await call(source, '/skills')
  const data = payload.data
  assert.equal(data.source.mode, 'mock')
  assert.equal(typeof data.total, 'number')
  assert.equal(typeof data.summary, 'object')
  assert.ok(Array.isArray(data.skills))
  const skill = data.skills[0]
  for (const key of [
    'id', 'name', 'description', 'body', 'typeName', 'context', 'triggers',
    'uses', 'helped', 'hurt', 'attempts', 'ratio', 'confident', 'status',
    'revisions', 'obstacleCount', 'openObstacleCount', 'resolvedCount',
    'derivedFrom', 'pendingCommit', 'lastUsedAt', 'updatedAt', 'path',
  ]) {
    assert.ok(Object.prototype.hasOwnProperty.call(skill, key), `skills[] 缺少 ${key}`)
  }
  for (const key of ['total', 'solid', 'trial', 'risky', 'new', 'blocked']) {
    assert.ok(Object.prototype.hasOwnProperty.call(data.summary, key), `summary 缺少 ${key}`)
  }
})

await check('A1 /experiences 行带情境/维度/预期回报/判定/提取次数', async () => {
  const { payload } = await call(source, '/experiences')
  const row = payload.data.rows.find((item) => item.id === 'ex_mock_01')
  assert.ok(row, '示例数据里应有 ex_mock_01')
  for (const key of ['context', 'dimensions', 'expectedG', 'verdict', 'retrievals']) {
    assert.ok(Object.prototype.hasOwnProperty.call(row, key), `rows[] 缺少 ${key}`)
  }
  assert.deepEqual(row.context, ['Windows / Office 2019', '课件交付'])
  assert.deepEqual(row.dimensions, ['排版', '字体'])
  assert.equal(row.expectedG, 0.9)
  assert.equal(typeof row.verdict, 'string')
  assert.equal(typeof row.retrievals, 'number')
  // 老记录没有这些字段时给安全默认（不能是 undefined 混进界面）
  const plain = payload.data.rows.find((item) => item.id === 'ex_mock_10')
  assert.deepEqual(plain.context, [])
  assert.deepEqual(plain.dimensions, [])
  assert.equal(plain.expectedG, null)
})

await check('X2 /cold：形状、分页、检索、年份过滤', async () => {
  const all = await call(source, '/cold')
  assert.equal(all.status, 200)
  const data = all.payload.data
  for (const key of ['source', 'notice', 'exists', 'total', 'offset', 'limit', 'years', 'rows', 'error']) {
    assert.ok(Object.prototype.hasOwnProperty.call(data, key), `/cold 缺少 ${key}`)
  }
  assert.equal(data.source.mode, 'mock')
  assert.equal(data.exists, true)
  assert.equal(data.error, null)
  assert.equal(data.total, 2)
  assert.equal(data.rows.length, 2)
  assert.equal(data.years[0].year, 2026)
  assert.equal(data.years[0].count, 2)
  assert.equal(typeof data.years[0].bytes, 'number')
  for (const key of ['id', 'intent', 'action', 'typeName', 'G', 'outcome', 'lastSeenAt']) {
    assert.ok(Object.prototype.hasOwnProperty.call(data.rows[0], key), `冷档行缺少 ${key}`)
  }
  assert.equal(typeof data.rows[0].G, 'number')
  assert.ok(data.rows[0].lastSeenAt >= data.rows[1].lastSeenAt, '冷档行按 lastSeenAt 降序')

  const page = await call(source, '/cold?offset=1&limit=1')
  assert.equal(page.payload.data.total, 2)
  assert.equal(page.payload.data.offset, 1)
  assert.equal(page.payload.data.limit, 1)
  assert.deepEqual(page.payload.data.rows.map((row) => row.id), ['ex_mock_cold_2'])

  const byQuery = await call(source, `/cold?query=${encodeURIComponent('旧版')}`)
  assert.equal(byQuery.payload.data.total, 2)
  const byType = await call(source, `/cold?query=${encodeURIComponent('文档')}`)
  assert.equal(byType.payload.data.total, 1)
  const miss = await call(source, `/cold?query=${encodeURIComponent('完全不存在的东西')}`)
  assert.equal(miss.payload.data.total, 0)
  assert.equal(miss.payload.data.rows.length, 0)

  assert.equal((await call(source, '/cold?year=2026')).payload.data.total, 2)
  assert.equal((await call(source, '/cold?year=2025')).payload.data.total, 0)
})

await check('X4 /state.usage.byDay：最近 7 天零填充、日期升序', async () => {
  const { payload } = await call(source, '/state')
  const usage = payload.data.usage
  assert.ok(Array.isArray(usage.byDay), 'usage.byDay 缺失')
  assert.equal(usage.byDay.length, 7)
  const now = new Date()
  const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  assert.equal(usage.byDay[6].date, todayKey, '最后一项必须是今天')
  for (const day of usage.byDay) {
    assert.match(day.date, /^\d{4}-\d{2}-\d{2}$/)
    assert.equal(typeof day.count, 'number')
    assert.equal(typeof day.chars, 'number')
  }
  assert.ok(usage.byDay[0].date < usage.byDay[6].date, '日期必须升序')
  const counted = usage.byDay.reduce((sum, day) => sum + day.count, 0)
  const chars = usage.byDay.reduce((sum, day) => sum + day.chars, 0)
  assert.ok(counted >= 1 && counted <= usage.total, `7 日计数 ${counted} 应在 1..${usage.total}`)
  assert.ok(chars > 0, 'byDay.chars 要把每行的字符数加进来')
})

await check('X3 坏档：列表/关系图给 storeError，详情 503', async () => {
  const broken = {
    id: 'broken',
    mode: 'live',
    label: '真实数据',
    readOnly: false,
    read() {
      return { file: 'D:/data/.exp/manifest.json', exists: true, notice: '' }
    },
    hot() {
      throw new Error('分片丢失：buckets/ty_ppt.0.jsonl')
    },
  }
  const list = await call(broken, '/experiences')
  assert.equal(list.status, 200)
  assert.equal(list.payload.data.storeError.code, 'store-unreadable')
  assert.match(list.payload.data.storeError.message, /分片丢失/)
  assert.equal(list.payload.data.rows.length, 0)

  const graph = await call(broken, '/graph')
  assert.equal(graph.status, 200)
  assert.equal(graph.payload.data.storeError.code, 'store-unreadable')

  const detail = await call(broken, '/experience?id=ex_1')
  assert.equal(detail.status, 503)
  assert.equal(detail.payload.ok, false)
  assert.equal(detail.payload.error.code, 'store-unreadable')
  assert.match(detail.payload.error.message, /分片丢失/)

  // 正常数据源不能凭空带错误
  assert.equal((await call(source, '/experiences')).payload.data.storeError, null)
  assert.equal((await call(source, '/graph')).payload.data.storeError, null)
})

await check('A4 /recall 透传 all/cold/cluster/detail/mark/verdicts', async () => {
  const seen = []
  const stub = {
    id: 'stub',
    mode: 'mock',
    label: 'stub',
    readOnly: false,
    recall(args) {
      seen.push(args)
      return { mode: 'evidence', rows: [], note: '', warning: null, brief: '', route: null, advantageSpread: 0 }
    },
  }
  const extra = { all: true, cold: true, cluster: '簇A', detail: true, mark: true, verdicts: [{ id: 'ex_1', outcome: 'helped' }] }
  const full = await call(stub, '/recall', { method: 'POST', body: { intent: '透传检查', limit: 2, context: ['课件'], ...extra } })
  assert.equal(full.status, 200)
  assert.equal(seen[0].intent, '透传检查')
  assert.equal(seen[0].limit, 2)
  assert.deepEqual(seen[0].context, ['课件'])
  for (const key of Object.keys(extra)) assert.deepEqual(seen[0][key], extra[key], `recall 没透传 ${key}`)
  // 没传的高级参数不能补 undefined（会覆盖内核默认值）
  await call(stub, '/recall', { method: 'POST', body: { intent: '只传基础参数' } })
  for (const key of Object.keys(extra)) {
    assert.equal(Object.prototype.hasOwnProperty.call(seen[1], key), false, `recall 多传了 ${key}`)
  }
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
