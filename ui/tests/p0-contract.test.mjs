/**
 * P0 HTTP 契约黑盒测试：用 mock data source + handleRequest 断言
 * X1 `/usage.chars`、X2 `GET /cold`、X4 `/state.usage.byDay`、A4 `/recall` 透传、A1 `context/dimensions`。
 * 契约：_tmp/ui-0.15/contracts.md §1/§3/§4/§5/§7。
 * 不联网、不起宿主、不写真实 .exp（mock 只在内存里）。
 * Run: node ui/tests/p0-contract.test.mjs
 */
import assert from 'node:assert/strict'

import { API_PREFIX, handleRequest } from '../shell.js'
import { createMockSource } from '../mock.js'

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

function fakeReq(url, method, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  return {
    url,
    method,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

async function call(route, options = {}) {
  const res = fakeRes()
  const source = options.source || createMockSource()
  await handleRequest(fakeReq(`${API_PREFIX}${route}`, options.method || 'GET', options.body), res, source)
  let payload = null
  try {
    payload = JSON.parse(res.body)
  } catch {
    payload = null
  }
  return { status: res.statusCode, payload }
}

function has(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key)
}

/** 本机本地日期 YYYY-MM-DD（契约 §4：按本机本地日期，不按 UTC 截断）。 */
function localDate(date) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/* -------------------------------------------------------------------------- */
/* X1 · GET /usage 每行有 chars                                               */
/* -------------------------------------------------------------------------- */

await check('X1 GET /usage：每行都有数字 chars', async () => {
  const { status, payload } = await call('/usage?limit=5')
  assert.equal(status, 200)
  assert.ok(payload && payload.ok === true)
  const rows = payload.data.rows
  assert.ok(Array.isArray(rows) && rows.length > 0, 'usage rows 为空')
  for (const row of rows) {
    assert.equal(typeof row.chars, 'number', `usage 行缺数字 chars：${JSON.stringify(row).slice(0, 160)}`)
    assert.ok(Number.isFinite(row.chars) && row.chars >= 0, `chars 不是非负有限数：${row.chars}`)
  }
  assert.ok(rows.some((row) => row.chars > 0), '每行 chars 都是 0，映射可能没把源值带出来')
})

/* -------------------------------------------------------------------------- */
/* X2 · GET /cold                                                             */
/* -------------------------------------------------------------------------- */

await check('X2 GET /cold?limit=1&offset=0：形状齐全、rows[0] 字段齐全', async () => {
  const { status, payload } = await call('/cold?limit=1&offset=0')
  assert.equal(status, 200, `/cold 未实现或报错：${JSON.stringify(payload)}`)
  const data = payload.data
  for (const key of ['source', 'total', 'offset', 'limit', 'years', 'rows']) {
    assert.ok(has(data, key), `/cold 缺少 ${key}`)
  }
  assert.equal(typeof data.total, 'number')
  assert.equal(data.offset, 0)
  assert.equal(data.limit, 1)
  assert.ok(Array.isArray(data.years), 'years 不是数组')
  assert.ok(Array.isArray(data.rows), 'rows 不是数组')
  assert.equal(data.rows.length, 1, 'limit=1 应只回 1 行')

  const row = data.rows[0]
  for (const key of ['id', 'intent', 'action', 'typeName', 'G', 'outcome', 'lastSeenAt']) {
    assert.ok(has(row, key), `rows[0] 缺少 ${key}`)
  }
  for (const key of ['id', 'intent', 'action', 'typeName', 'outcome', 'lastSeenAt']) {
    assert.equal(typeof row[key], 'string', `rows[0].${key} 应是字符串`)
  }
  assert.equal(typeof row.G, 'number', 'rows[0].G 应是数字')

  // 契约 §3 的 source 形状：{ id, mode, label, readOnly }
  assert.equal(typeof data.source, 'object', 'source 应是对象')
  assert.equal(typeof data.source.id, 'string', 'source.id 应是字符串')
  assert.equal(typeof data.source.mode, 'string', 'source.mode 应是字符串')
})

await check('X2 GET /cold?query=：能按 query 过滤（大小写不敏感，匹配 intent/action/id/typeName）', async () => {
  const hit = await call(`/cold?query=${encodeURIComponent('研学课')}`)
  assert.equal(hit.status, 200)
  const rows = hit.payload.data.rows
  assert.ok(Array.isArray(rows) && rows.length === 1, `query=研学课 应命中 1 条 mock 冷档，实际 ${rows && rows.length}`)
  assert.equal(hit.payload.data.total, 1, 'query 过滤后 total 应是过滤后的条数')
  for (const row of rows) {
    const haystack = [row.id, row.intent, row.action, row.typeName].map((value) => String(value || '')).join(' ').toLowerCase()
    assert.ok(haystack.includes('研学课'), `命中行不含 query：${JSON.stringify(row).slice(0, 160)}`)
  }

  const lower = await call('/cold?query=ppt')
  assert.equal(lower.status, 200)
  assert.ok(lower.payload.data.rows.length >= 1, '大小写不敏感匹配 typeName 失败（query=ppt 没命中）')

  const none = await call('/cold?query=zzz-不存在-zzz')
  assert.equal(none.status, 200)
  assert.equal(none.payload.data.rows.length, 0, '无关 query 应是空结果')
  assert.equal(none.payload.data.total, 0)
})

await check('X2 GET /cold：offset/limit 能翻页', async () => {
  const all = await call('/cold?limit=50&offset=0')
  assert.equal(all.status, 200)
  const rows = all.payload.data.rows
  assert.ok(Array.isArray(rows) && rows.length >= 2, `mock 冷档应至少 2 条，实际 ${rows && rows.length}`)

  const page0 = await call('/cold?limit=1&offset=0')
  const page1 = await call('/cold?limit=1&offset=1')
  assert.equal(page0.status, 200)
  assert.equal(page1.status, 200)
  assert.equal(page1.payload.data.offset, 1)
  assert.equal(page1.payload.data.limit, 1)
  assert.equal(page1.payload.data.rows.length, 1)
  assert.equal(page0.payload.data.rows[0].id, rows[0].id)
  assert.equal(page1.payload.data.rows[0].id, rows[1].id)
  assert.notEqual(page0.payload.data.rows[0].id, page1.payload.data.rows[0].id, 'offset=1 翻到了同一行')
})

/* -------------------------------------------------------------------------- */
/* X4 · GET /state.usage.byDay                                                */
/* -------------------------------------------------------------------------- */

await check('X4 GET /state：usage.byDay 是 7 项、date 升序、含 count/chars', async () => {
  const { status, payload } = await call('/state')
  assert.equal(status, 200)
  const usage = payload.data.usage
  assert.ok(usage && typeof usage === 'object', '/state.usage 不存在')
  const byDay = usage.byDay
  assert.ok(Array.isArray(byDay), '/state.usage.byDay 不存在')
  assert.equal(byDay.length, 7, `byDay 应是 7 项，实际 ${byDay.length}`)
  for (const item of byDay) {
    assert.match(String(item.date), /^\d{4}-\d{2}-\d{2}$/, `byDay.date 不是 YYYY-MM-DD：${item.date}`)
    assert.equal(typeof item.count, 'number', `byDay.count 不是数字：${item.date}`)
    assert.ok(Number.isFinite(item.count) && item.count >= 0, `byDay.count 不合法：${item.count}`)
    assert.equal(typeof item.chars, 'number', `byDay.chars 不是数字：${item.date}`)
    assert.ok(Number.isFinite(item.chars) && item.chars >= 0, `byDay.chars 不合法：${item.chars}`)
  }
  const dates = byDay.map((item) => item.date)
  assert.deepEqual(dates, [...dates].sort(), `byDay.date 不是升序：${dates.join(', ')}`)
  assert.equal(dates[6], localDate(new Date()), `byDay 最后一项不是今天（本地日期）：${dates[6]}`)
})

/* -------------------------------------------------------------------------- */
/* A4 · POST /recall 透传 all / cold                                          */
/* -------------------------------------------------------------------------- */

await check('A4 POST /recall {all:true}：透传 all 且不报错', async () => {
  const base = createMockSource()
  const seen = []
  const spy = {
    ...base,
    recall(args) {
      seen.push(args)
      return base.recall(args)
    },
  }
  const { status, payload } = await call('/recall', {
    source: spy,
    method: 'POST',
    body: { intent: '给研学课 PPT 插一页过渡页', all: true },
  })
  assert.equal(status, 200, `/recall all:true 报错：${JSON.stringify(payload)}`)
  assert.equal(payload.ok, true)
  assert.ok(payload.data && typeof payload.data === 'object', 'recall data 不是对象')
  assert.equal(seen.length, 1, 'shell 没把请求交给数据源 recall')
  assert.equal(seen[0].all, true, 'all:true 没透传给数据源（契约 §5）')
})

await check('A4 POST /recall {cold:true}：透传 cold、不 500', async () => {
  const base = createMockSource()
  const seen = []
  const spy = {
    ...base,
    recall(args) {
      seen.push(args)
      return base.recall(args)
    },
  }
  const { status, payload } = await call('/recall', {
    source: spy,
    method: 'POST',
    body: { intent: '整理经验库文档的存储章节', cold: true },
  })
  assert.equal(status, 200, `/recall cold:true 报错：${JSON.stringify(payload)}`)
  assert.equal(payload.ok, true)
  assert.equal(seen.length, 1, 'shell 没把请求交给数据源 recall')
  assert.equal(seen[0].cold, true, 'cold:true 没透传给数据源（契约 §5）')
  const data = payload.data || {}
  // 契约两种实现都接受：显式回 cold:true，或按普通召回形状回空/非空结果（evidence 模式是 rows）。
  assert.ok(
    data.cold === true || Array.isArray(data.candidates) || Array.isArray(data.rows),
    `cold:true 既没回 cold:true，也没给 candidates/rows 数组：${JSON.stringify(data).slice(0, 200)}`,
  )
})

/* -------------------------------------------------------------------------- */
/* A1 · GET /experiences 行带 context / dimensions                            */
/* -------------------------------------------------------------------------- */

await check('A1 GET /experiences：rows[0] 有 context/dimensions 数组', async () => {
  const { status, payload } = await call('/experiences')
  assert.equal(status, 200)
  const rows = payload.data.rows
  assert.ok(Array.isArray(rows) && rows.length > 0, 'experiences rows 为空')
  assert.ok(Array.isArray(rows[0].context), 'rows[0].context 不是数组')
  assert.ok(Array.isArray(rows[0].dimensions), 'rows[0].dimensions 不是数组')
})

await check('A1 GET /experiences：mock 里 context/dimensions 有真实值（不是全空数组）', async () => {
  const { status, payload } = await call('/experiences?limit=100')
  assert.equal(status, 200)
  const rows = payload.data.rows
  assert.ok(rows.some((row) => Array.isArray(row.context) && row.context.length > 0), '没有任何一行带非空 context')
  assert.ok(rows.some((row) => Array.isArray(row.dimensions) && row.dimensions.length > 0), '没有任何一行带非空 dimensions')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
