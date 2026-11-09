/**
 * exp-ui 外壳测试：HTTP 契约、mock/live 两种数据源、坏数据兜底。
 * Run: node tests/shell.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { API_PREFIX, handleRequest, pluginVersion } from '../shell.js'
import { createMockSource } from '../mock.js'
import { createLiveSource } from '../live.js'

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
  let payload = null
  try {
    payload = JSON.parse(res.body)
  } catch {
    payload = null
  }
  return { status: res.statusCode, headers: res.headers, payload }
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'exp-ui-'))
}

async function mockCall(route, options) {
  return call(createMockSource(), route, options)
}

await check('GET /health：app=exp-ui、mock、可写', async () => {
  const { status, payload } = await mockCall('/health')
  assert.equal(status, 200)
  assert.equal(payload.ok, true)
  assert.equal(payload.data.app, '经验库')
  assert.equal(payload.data.version, pluginVersion())
  assert.equal(payload.data.source, 'mock')
  assert.equal(payload.data.readOnly, false)
})

await check('GET /state：15/12/6 与示例数据说明', async () => {
  const { status, payload } = await mockCall('/state')
  assert.equal(status, 200)
  const data = payload.data
  assert.equal(data.app, '经验库')
  assert.equal(data.source.mode, 'mock')
  assert.equal(data.source.label, '示例数据')
  assert.equal(data.source.readOnly, false)
  assert.equal(data.totals.all, 15)
  assert.equal(data.totals.visible, 12)
  assert.equal(data.totals.types, 6)
  assert.ok(data.notice.includes('示例数据'))
  assert.ok(data.bytes > 0)
  assert.ok(data.usage.total >= 1)
  assert.ok(Array.isArray(data.types))
})

await check('GET /experiences：列表 12 条，退休/被取代/已删除不出现', async () => {
  const { status, payload } = await mockCall('/experiences')
  assert.equal(status, 200)
  const data = payload.data
  assert.equal(data.mode, 'list')
  assert.equal(data.total, 12)
  assert.equal(data.rows.length, 12)
  const ids = data.rows.map((row) => row.id)
  for (const hidden of ['ex_mock_06', 'ex_mock_07', 'ex_mock_15']) {
    assert.equal(ids.includes(hidden), false, `${hidden} 不该出现在列表里`)
  }
  assert.equal(Object.values(data.counts).reduce((sum, count) => sum + count, 0), 12)
})

await check('GET /experiences：类型过滤、结果过滤、G 排序都生效', async () => {
  const byType = await mockCall('/experiences?type=ty_ppt')
  assert.ok(byType.payload.data.rows.length > 0)
  assert.ok(byType.payload.data.rows.every((row) => row.typeId === 'ty_ppt'))

  const byOutcome = await mockCall('/experiences?outcome=failed')
  assert.ok(byOutcome.payload.data.rows.length > 0)
  assert.ok(byOutcome.payload.data.rows.every((row) => row.outcome === 'failed'))

  const sorted = await mockCall('/experiences?sort=g')
  const gs = sorted.payload.data.rows.map((row) => row.G)
  assert.deepEqual(gs, [...gs].sort((a, b) => b - a))
})

await check('GET /experiences?query=：检索态给候选 + 证据 + 排序说明', async () => {
  const { status, payload } = await mockCall(`/experiences?query=${encodeURIComponent('把 PPT 导出成 PDF')}`)
  assert.equal(status, 200)
  const data = payload.data
  assert.ok(data.mode === 'advantage' || data.mode === 'evidence')
  assert.equal(data.query, '把 PPT 导出成 PDF')
  assert.ok(data.total > 0)
  assert.ok(data.note.length > 0)
  assert.ok(Array.isArray(data.rows))
  const candidate = data.rows[0]
  assert.equal(typeof candidate.action, 'string')
  assert.equal(typeof candidate.rankScore, 'number')
  assert.ok(candidate.evidence.length > 0)
  assert.equal(typeof candidate.evidence[0].id, 'string')
  assert.equal(typeof candidate.evidence[0].similarity, 'number')
})

await check('GET /experiences?query=：无命中时不报错，给空态说明', async () => {
  const { status, payload } = await mockCall(`/experiences?query=${encodeURIComponent('zzz 完全无关的关键词')}`)
  assert.equal(status, 200)
  assert.equal(payload.data.rows.length, 0)
  assert.ok(payload.data.note.length > 0)
})

await check('GET /experience：详情 / 缺 id 400 / 不存在 404', async () => {
  const ok = await mockCall('/experience?id=ex_mock_01')
  assert.equal(ok.status, 200)
  assert.equal(ok.payload.data.row.id, 'ex_mock_01')
  assert.ok(Array.isArray(ok.payload.data.history))
  assert.ok(Array.isArray(ok.payload.data.feedbackLog))

  const noId = await mockCall('/experience')
  assert.equal(noId.status, 400)
  assert.equal(noId.payload.error.code, 'id-required')

  const missing = await mockCall('/experience?id=nope')
  assert.equal(missing.status, 404)
  assert.equal(missing.payload.error.code, 'not-found')
})

await check('POST /feedback：mock 生效并落在这份内存数据里', async () => {
  const source = createMockSource()
  const before = await call(source, '/experience?id=ex_mock_01')
  const startG = before.payload.data.row.G
  const hurt = await call(source, '/feedback', { method: 'POST', body: { id: 'ex_mock_01', result: 'hurt' } })
  assert.equal(hurt.status, 200)
  assert.equal(hurt.payload.ok, true)
  assert.ok(hurt.payload.data.G_after < startG)
  assert.equal(hurt.payload.data.changed, true)

  const after = await call(source, '/experience?id=ex_mock_01')
  assert.equal(after.payload.data.row.G, hurt.payload.data.G_after)
  assert.ok(after.payload.data.feedbackLog.length >= 1)

  const bad = await call(source, '/feedback', { method: 'POST', body: { id: 'ex_mock_01', result: 'great' } })
  assert.equal(bad.status, 400)
  assert.equal(bad.payload.error.code, 'bad-result')

  const unknown = await call(source, '/feedback', { method: 'POST', body: { id: 'nope', result: 'helped' } })
  assert.equal(unknown.status, 404)

  const retired = await call(source, '/feedback', { method: 'POST', body: { id: 'ex_mock_06', result: 'helped' } })
  assert.equal(retired.status, 409)
  assert.equal(retired.payload.error.code, 'not-feedbackable')
})

await check('GET /types：6 个类型、计数加起来 12', async () => {
  const { status, payload } = await mockCall('/types')
  assert.equal(status, 200)
  assert.equal(payload.data.types.length, 6)
  assert.equal(payload.data.types.reduce((sum, type) => sum + type.count, 0), 12)
})

await check('GET /usage：新→旧、字段齐全', async () => {
  const { status, payload } = await mockCall('/usage?limit=5')
  assert.equal(status, 200)
  assert.ok(payload.data.rows.length <= 5)
  for (const row of payload.data.rows) {
    assert.equal(typeof row.at, 'string')
    assert.equal(typeof row.tool, 'string')
    assert.ok(Array.isArray(row.ids))
  }
  const ats = payload.data.rows.map((row) => row.at)
  assert.deepEqual(ats, [...ats].sort((a, b) => String(b).localeCompare(String(a))))
})

await check('未知路由 404、方法不对 405，错误体都有 code', async () => {
  const missing = await mockCall('/nope')
  assert.equal(missing.status, 404)
  assert.equal(missing.payload.ok, false)
  assert.equal(missing.payload.error.code, 'not-found')

  const wrong = await call(createMockSource(), '/state', { method: 'POST' })
  assert.equal(wrong.status, 405)
  assert.equal(wrong.payload.error.code, 'method-not-allowed')
})

await check('参数是垃圾值时仍 200（limit=abc / offset=-1 / type 未知）', async () => {
  const { status, payload } = await mockCall('/experiences?limit=abc&offset=-1&type=ty_unknown')
  assert.equal(status, 200)
  assert.ok(Array.isArray(payload.data.rows))
  assert.equal(payload.data.rows.length, 0)
})

await check('live：读真实库文件并可反馈（走 engine）', async () => {
  const dir = tempDir()
  fs.writeFileSync(path.join(dir, 'exp-lib.json'), JSON.stringify({
    version: 1,
    types: [{ id: 'ty_real', name: '真实类型', description: '来自 live 文件的类型' }],
    experiences: [{
      id: 'ex_real_1',
      intent: '真实的一条经验',
      action: '真实做法',
      typeId: 'ty_real',
      typeName: '真实类型',
      outcome: 'success',
      G: 1,
      ts: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    }],
  }), 'utf8')
  const source = createLiveSource({ dataDir: dir })
  const state = await call(source, '/state')
  assert.equal(state.payload.data.source.mode, 'live')
  assert.equal(state.payload.data.source.readOnly, false)
  assert.equal(state.payload.data.exists, true)
  assert.equal(state.payload.data.totals.visible, 1)

  const list = await call(source, '/experiences')
  assert.equal(list.payload.data.rows.length, 1)
  assert.equal(list.payload.data.rows[0].intent, '真实的一条经验')

  const feedback = await call(source, '/feedback', { method: 'POST', body: { id: 'ex_real_1', result: 'hurt' } })
  assert.equal(feedback.status, 200)
  assert.ok(feedback.payload.data.G_after < feedback.payload.data.G_before)
})

await check('live：文件不存在时 200 + 空库 + 说明，不报错', async () => {
  const dir = tempDir()
  const source = createLiveSource({ dataDir: dir })
  const state = await call(source, '/state')
  assert.equal(state.status, 200)
  assert.equal(state.payload.data.exists, false)
  assert.equal(state.payload.data.totals.visible, 0)
  assert.ok(state.payload.data.notice.includes('没有找到'))

  const list = await call(source, '/experiences')
  assert.equal(list.status, 200)
  assert.equal(list.payload.data.rows.length, 0)
})

await check('live：JSON 坏了也 200，按空库显示并说明', async () => {
  const dir = tempDir()
  fs.writeFileSync(path.join(dir, 'exp-lib.json'), '{ 这不是合法 JSON', 'utf8')
  const source = createLiveSource({ dataDir: dir })
  const state = await call(source, '/state')
  assert.equal(state.status, 200)
  assert.equal(state.payload.data.totals.visible, 0)
  assert.ok(state.payload.data.notice.includes('读不了'))
})

await check('live：没配 dataDir 时按默认/设置目录（无文件则空库+说明）', async () => {
  const old = process.env.DSH_HOME
  process.env.DSH_HOME = tempDir()
  try {
    const source = createLiveSource({})
    const state = await call(source, '/state')
    assert.equal(state.status, 200)
    assert.equal(state.payload.data.exists, false)
    assert.ok(state.payload.data.notice.includes('没有找到经验库文件'))
  } finally {
    if (old === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = old
  }
})

await check('POST /settings：切换 currentRoot 后 live 立刻读新目录', async () => {
  const old = process.env.DSH_HOME
  process.env.DSH_HOME = tempDir()
  try {
    const root = tempDir()
    fs.writeFileSync(path.join(root, 'exp-lib.json'), JSON.stringify({
      version: 1,
      types: [{ id: 'ty_engram', name: '真实类型' }],
      experiences: [{ id: 'ex_live_1', intent: '切换根后的经验', action: '读新目录', typeId: 'ty_engram', typeName: '真实类型', outcome: 'success', G: 1, ts: new Date().toISOString(), lastSeenAt: new Date().toISOString() }],
    }), 'utf8')
    const source = createLiveSource({})
    const saved = await call(source, '/settings', { method: 'POST', body: { currentRoot: root } })
    assert.equal(saved.status, 200)
    const next = createLiveSource({})
    const state = await call(next, '/state')
    assert.equal(state.payload.data.exists, true)
    assert.equal(state.payload.data.totals.visible, 1)
  } finally {
    if (old === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = old
  }
})

await check('GET /skills：示例数据 5 个技能、状态分布齐全', async () => {
  const { status, payload } = await mockCall('/skills')
  assert.equal(status, 200)
  const data = payload.data
  assert.equal(data.total, 5)
  assert.equal(data.skills.length, 5)
  assert.equal(data.summary.total, 5)
  assert.ok(data.summary.solid >= 1)
  assert.equal(data.summary.solid + data.summary.trial + data.summary.risky + data.summary.new + data.summary.blocked, 5)
  const skill = data.skills[0]
  for (const key of ['id', 'name', 'description', 'body', 'typeName', 'context', 'triggers', 'uses', 'helped', 'hurt', 'ratio', 'confident', 'status', 'derivedFrom', 'path']) {
    assert.ok(Object.prototype.hasOwnProperty.call(skill, key), `技能行缺少 ${key}`)
  }
})

await check('GET /state：totals.skills 与 skillSummary 与 /skills 对齐', async () => {
  const state = await mockCall('/state')
  assert.equal(state.payload.data.totals.skills, 5)
  assert.equal(state.payload.data.skillSummary.total, 5)
})

await check('live：读 <dataDir>/skills/<slug>/（SKILL.md + skill.json）', async () => {
  const dir = tempDir()
  const skillDir = path.join(dir, 'skills', 'ppt-export-pdf')
  fs.mkdirSync(skillDir, { recursive: true })
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), [
    '---',
    'name: 导出 PDF 前先查字体',
    'description: 导出前确认字体，导出后逐页看分页。',
    '---',
    '',
    '## 做法',
    '1. 先查字体。',
  ].join('\n'), 'utf8')
  fs.writeFileSync(path.join(skillDir, 'skill.json'), JSON.stringify({
    id: 'ppt-export-pdf',
    typeName: 'PPT / 课件',
    context: ['Windows'],
    triggers: ['导出 PDF'],
    confidence: { uses: 5, helped: 4, hurt: 1, lastUsedAt: new Date().toISOString() },
    revisions: 2,
    obstacles: { 'font-missing': { streak: 0 } },
    resolved: ['a', 'b'],
    derivedFrom: ['ex_1', 'ex_2', 'ex_3'],
    pendingCommit: false,
  }), 'utf8')

  const source = createLiveSource({ dataDir: dir })
  const { status, payload } = await call(source, '/skills')
  assert.equal(status, 200)
  assert.equal(payload.data.total, 1)
  const skill = payload.data.skills[0]
  assert.equal(skill.id, 'ppt-export-pdf')
  assert.equal(skill.name, '导出 PDF 前先查字体')
  assert.equal(skill.description, '导出前确认字体，导出后逐页看分页。')
  assert.equal(skill.typeName, 'PPT / 课件')
  assert.equal(skill.uses, 5)
  assert.equal(skill.attempts, 5)
  assert.equal(skill.confident, true)
  assert.equal(skill.status, 'solid')
  assert.equal(skill.derivedFrom.length, 3)
  assert.equal(skill.resolvedCount, 2)
  assert.ok(skill.path.includes('ppt-export-pdf'))

  const state = await call(source, '/state')
  assert.equal(state.payload.data.totals.skills, 1)
})

await check('live：skills 目录不存在返回空；坏 skill.json 仍按 SKILL.md 出条目', async () => {
  const empty = await call(createLiveSource({ dataDir: tempDir() }), '/skills')
  assert.equal(empty.status, 200)
  assert.equal(empty.payload.data.total, 0)

  const dir = tempDir()
  const skillDir = path.join(dir, 'skills', 'only-md')
  fs.mkdirSync(skillDir, { recursive: true })
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: 只有 SKILL.md\n---\n\n做法', 'utf8')
  fs.writeFileSync(path.join(skillDir, 'skill.json'), '{ 坏 JSON', 'utf8')
  const source = createLiveSource({ dataDir: dir })
  const { payload } = await call(source, '/skills')
  assert.equal(payload.data.total, 1)
  assert.equal(payload.data.skills[0].name, '只有 SKILL.md')
  assert.equal(payload.data.skills[0].status, 'new')
})

await check('live：skills 目录里的普通文件被忽略', async () => {
  const dir = tempDir()
  fs.mkdirSync(path.join(dir, 'skills'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'skills', 'README.txt'), 'not a skill', 'utf8')
  const { payload } = await call(createLiveSource({ dataDir: dir }), '/skills')
  assert.equal(payload.data.total, 0)
})


await check('POST /record + /recall：示例数据能记录并召回', async () => {
  const source = createMockSource()
  const made = await call(source, '/record', { method: 'POST', body: { intent: '控制台冒烟：记录一条', action: '先写表单再提交', outcome: 'success', type: '代码 / 插件' } })
  assert.equal(made.status, 200)
  assert.equal(made.payload.data.action, 'added')
  const recalled = await call(source, '/recall', { method: 'POST', body: { intent: '控制台冒烟：记录一条', limit: 5 } })
  assert.equal(recalled.status, 200)
  assert.ok((recalled.payload.data.candidates || recalled.payload.data.rows || []).length >= 1)
})

await check('GET /validate + /settings：结构齐全', async () => {
  const source = createMockSource()
  const validation = await call(source, '/validate')
  assert.equal(validation.status, 200)
  assert.deepEqual(validation.payload.data.problems, [])
  const settings = await call(source, '/settings')
  assert.equal(settings.status, 200)
  assert.equal(settings.payload.data.source.mode, 'mock')
  assert.equal(typeof settings.payload.data.version, 'string')
})

await check('live /record → /recall：走 kernel engine 真写真读', async () => {
  const dir = tempDir()
  const source = createLiveSource({ dataDir: dir })
  const made = await call(source, '/record', { method: 'POST', body: { intent: '控制台 live 冒烟', action: '走 engine 写入', outcome: 'success', type: '代码 / 插件' } })
  assert.equal(made.status, 200)
  const recalled = await call(source, '/recall', { method: 'POST', body: { intent: '控制台 live 冒烟' } })
  assert.equal(recalled.status, 200)
  assert.ok((recalled.payload.data.candidates || []).length >= 1)
})


await check('默认数据源是 live；只有显式 mock 才用示例数据', async () => {
  const { createSource } = await import('../shell.js')
  const live = createSource({ dataDir: tempDir() })
  assert.equal(live.mode, 'live')
  const mock = createSource({ source: 'mock' })
  assert.equal(mock.mode, 'mock')
})

await check('live 的 /experiences?query= 走 engine.recall（候选带 evidence）', async () => {
  const dir = tempDir()
  const source = createLiveSource({ dataDir: dir })
  source.record({ intent: '导出课件 PDF', action: '先嵌字体再导出', outcome: 'success', type: '环境 / 部署' })
  source.record({ intent: '导出课件 PDF', action: '直接导出不管字体', outcome: 'failed', type: '环境 / 部署' })
  const { status, payload } = await call(source, '/experiences?query=' + encodeURIComponent('导出课件 PDF'))
  assert.equal(status, 200)
  assert.notEqual(payload.data.mode, 'list')
  assert.ok((payload.data.candidates || []).some((item) => Array.isArray(item.evidence)), JSON.stringify(payload.data).slice(0, 200))
})


await check('POST /settings：内核参数落盘、可清空', async () => {
  const old = process.env.DSH_HOME
  process.env.DSH_HOME = tempDir()
  try {
    const source = createLiveSource({ dataDir: tempDir() })
    const saved = await call(source, '/settings', { method: 'POST', body: { config: { feedbackEta: 0.5, routing: 'off', hint: false } } })
    assert.equal(saved.status, 200)
    const first = await call(source, '/settings')
    assert.equal(first.payload.data.config.feedbackEta, 0.5)
    assert.equal(first.payload.data.config.routing, 'off')
    assert.equal(first.payload.data.config.hint, false)
    assert.ok(first.payload.data.spec.config.some((field) => field.key === 'feedbackEta'))
    await call(source, '/settings', { method: 'POST', body: { config: { feedbackEta: '' } } })
    const second = await call(source, '/settings')
    assert.equal(second.payload.data.config.feedbackEta, undefined)
  } finally {
    if (old === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = old
  }
})


await check('GET /graph：根/类型/经验/技能节点与边齐全', async () => {
  const source = createMockSource()
  const { status, payload } = await call(source, '/graph')
  assert.equal(status, 200)
  const data = payload.data
  assert.ok(data.nodes.some((node) => node.kind === 'root'))
  assert.ok(data.nodes.some((node) => node.kind === 'type'))
  assert.ok(data.nodes.some((node) => node.kind === 'experience'))
  assert.ok(data.nodes.some((node) => node.kind === 'skill'))
  assert.ok(data.edges.some((edge) => edge.kind === 'derived'))
  assert.equal(data.summary.experiences, 12)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)

