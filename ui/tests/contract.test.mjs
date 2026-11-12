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
  for (const key of ['at', 'tool', 'ok', 'op', 'intent', 'action', 'feedback', 'id', 'error', 'limit', 'routeScore', 'ids']) {
    assert.ok(Object.prototype.hasOwnProperty.call(usage.payload.data.rows[0], key), `usage 行缺少 ${key}`)
  }
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

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
