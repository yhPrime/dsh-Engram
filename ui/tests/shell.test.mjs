/**
 * exp-ui 外壳测试：HTTP 契约、mock/live 两种数据源、坏数据兜底。
 * Run: node tests/shell.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { API_PREFIX, handleRequest, pluginVersion, resolvePickedDirectory } from '../shell.js'
import { createMockSource } from '../mock.js'
import { createLiveSource } from '../live.js'
import { createSkill } from '../../kernel/skills.js'
import { galleryHtml } from '../icons-gallery.js'

// 把设置文件隔离到临时 HOME：否则会读到用户真实的 ~/.dsh/engram/settings.json
// （里面有 repoUrl/token），"未初始化""没 token" 这类断言就会随用户操作而飘。
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-shell-home-'))
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
  await handleRequest(fakeReq(`${API_PREFIX}${route}`, options.method || 'GET', options.body), res, source, options.deps)
  let payload = null
  try {
    payload = JSON.parse(res.body)
  } catch {
    payload = null
  }
  return { status: res.statusCode, headers: res.headers, payload }
}

/** 假的宿主目录选择服务：native 能力 + 指定返回值。 */
function fakePicker(picked, kind = 'native') {
  const service = {
    lastSignal: null,
    capability: () => (kind === 'native'
      ? {
        kind: 'native',
        pick: async (signal) => {
          service.lastSignal = signal
          return typeof picked === 'function' ? picked() : picked
        },
      }
      : { kind, list: async () => ({ crumbs: [], entries: [] }), createDirectory: async () => '' }),
  }
  return service
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'exp-ui-'))
}

/** 在已迁移的分片库上手工登记一份冷档（模拟容量安全阀触发后的形态）。 */
function writeColdFixture(dataDir, rows) {
  fs.mkdirSync(path.join(dataDir, 'cold'), { recursive: true })
  const rel = 'cold/2026-a.jsonl'
  fs.writeFileSync(path.join(dataDir, rel), rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8')
  const manifestFile = path.join(dataDir, 'manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  manifest.cold = { years: [{ year: 2026, files: [{ file: rel, count: rows.length, bytes: fs.statSync(path.join(dataDir, rel)).size }] }] }
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

/** 只登记冷档、不落文件：用来验证「文件丢了」不能显示成「没有」。 */
function registerColdWithoutFile(dataDir) {
  const manifestFile = path.join(dataDir, 'manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  manifest.cold = { years: [{ year: 2026, files: [{ file: 'cold/2026-a.jsonl', count: 1, bytes: 10 }] }] }
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
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
    assert.ok(first.payload.data.spec.ui.some((field) => field.key === 'graphPalette'))
    await call(source, '/settings', { method: 'POST', body: { config: { feedbackEta: '' } } })
    const second = await call(source, '/settings')
    assert.equal(second.payload.data.config.feedbackEta, undefined)
  } finally {
    if (old === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = old
  }
})


await check('GET /graph：套件节点与父子边（总技能 + 组节点）', async () => {
  const dir = tempDir()
  createSkill(dir, { id: 'demo-suite', name: '套件总技能', description: '根', body: '# 何时用\n根', typeName: '代码 / 插件' })
  createSkill(dir, { id: 'demo-suite/a', name: '子甲', description: '甲', body: '# 何时用\n甲', typeName: '代码 / 插件' })
  createSkill(dir, { id: 'demo-suite/b', name: '子乙', description: '乙', body: '# 何时用\n乙', typeName: '代码 / 插件' })
  createSkill(dir, { id: 'group-only/x', name: '组内子', description: '组', body: '# 何时用\n组', typeName: '代码 / 插件' })
  const source = createLiveSource({ dataDir: dir })
  const { status, payload } = await call(source, '/graph')
  assert.equal(status, 200)
  const data = payload.data
  const rootSkill = data.nodes.find((node) => node.id === 'skill:demo-suite')
  assert.equal(rootSkill.kind, 'skill')
  assert.equal(rootSkill.childCount, 2)
  const group = data.nodes.find((node) => node.id === 'suite:group-only')
  assert.equal(group.kind, 'suite')
  assert.equal(group.count, 1)
  const rootSkillEdge = data.edges.find((edge) => edge.source === 'skill:demo-suite' && edge.target === 'skill:demo-suite/a')
  assert.equal(rootSkillEdge.kind, 'suite')
  const groupEdge = data.edges.find((edge) => edge.source === 'suite:group-only' && edge.target === 'skill:group-only/x')
  assert.equal(groupEdge.kind, 'suite')
  assert.equal(data.summary.suites, 2)
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
  assert.ok(data.nodes.filter((node) => node.kind !== 'root').every((node) => typeof node.weight === 'number' && node.weight > 0))
  assert.ok(data.edges.every((edge) => typeof edge.strength === 'number' && edge.strength > 0))
  assert.equal(data.summary.experiences, 12)
})

await check('GET /settings：spec 含 git 组，有歧义的项都带 tip', async () => {
  const source = createLiveSource({ dataDir: tempDir() })
  const { status, payload } = await call(source, '/settings')
  assert.equal(status, 200)
  assert.equal(payload.ok, true)
  const spec = payload.data.spec
  assert.ok(Array.isArray(spec.git) && spec.git.length >= 6, 'git 组缺失')
  const byKey = Object.fromEntries([...spec.config, ...spec.ui, ...spec.git].map((field) => [field.key, field]))
  for (const key of ['hint', 'usageLogMaxBytes', 'dataDir', 'feedbackDecayDays', 'mergeThreshold', 'typeSimilarity']) {
    assert.ok(byKey[key] && typeof byKey[key].tip === 'string' && byKey[key].tip.length > 8, `${key} 缺 tip`)
  }
  assert.equal(typeof payload.data.git, 'object')
  assert.equal(payload.data.git.branch, 'main')
  assert.equal(payload.data.git.autoBackupMinutes, 0)
})

await check('GET /sync：未初始化也返回完整状态；未知动作 400', async () => {
  const source = createLiveSource({ dataDir: tempDir() })
  const status = await call(source, '/sync')
  assert.equal(status.status, 200)
  const data = status.payload.data
  assert.equal(data.isRepo, false)
  assert.equal(data.configured, false)
  assert.equal(typeof data.dirtyCount, 'number')
  assert.equal(typeof data.ahead, 'number')
  const bad = await call(source, '/sync', { method: 'POST', body: { action: 'nope' } })
  assert.equal(bad.status, 400)
  assert.equal(bad.payload.ok, false)
  assert.equal(bad.payload.error.code, 'bad-action')
})

await check('POST /sync {action:"disconnect"}：只清仓库地址，本地库里什么都不会被删', async () => {
  const dir = tempDir()
  const source = createLiveSource({ dataDir: dir })
  const before = await call(source, '/sync', { method: 'POST', body: { action: 'disconnect' } })
  assert.equal(before.status, 200)
  assert.equal(before.payload.data.disconnected, true)
  const status = await call(source, '/sync')
  assert.equal(status.payload.data.configured, false)
  assert.equal(fs.existsSync(dir), true, '数据目录不该被删')
  const bad = await call(source, '/sync', { method: 'POST', body: { action: 'nope' } })
  assert.equal(bad.status, 400)
})
await check('图标候选页：6 个候选、每个三种尺寸、能给侧栏用的 currentColor 描边', () => {
  const html = galleryHtml()
  assert.match(html, /图标候选/)
  assert.equal((html.match(/<article/g) || []).length, 6)
  for (const key of ['A', 'B', 'C', 'D', 'E', 'F']) assert.match(html, new RegExp(`<span class="key">${key}</span>`))
  assert.match(html, /stroke="currentColor"/)
  assert.ok(html.length > 5000)
})

await check('POST /github：设备码没开始时轮询 400（不用 token）；没 token 登录 400；未知动作 400', async () => {
  const deviceSource = createLiveSource({ dataDir: tempDir() })
  const noSession = await call(deviceSource, '/github', { method: 'POST', body: { action: 'device-poll' } })
  assert.equal(noSession.status, 400)
  assert.match(noSession.payload.error.message, /没有正在进行的登录/)
  const source = createLiveSource({ dataDir: tempDir() })
  const noToken = await call(source, '/github', { method: 'POST', body: { action: 'login' } })
  assert.equal(noToken.status, 400)
  assert.equal(noToken.payload.ok, false)
  assert.equal(noToken.payload.error.code, 'github')
  assert.match(noToken.payload.error.message, /先填访问 token/)
  const bad = await call(source, '/github', { method: 'POST', body: { action: 'nope' } })
  assert.equal(bad.status, 400)
  assert.equal(bad.payload.error.code, 'bad-action')
})

await check('技能归经验库自己管：/skill-install 已下线（不写 DSH skills 目录）', async () => {
  const dir = tempDir()
  createSkill(dir, { slug: 'install-demo', name: '安装演示', description: '测试', body: '# 何时用\n测试', typeName: '代码 / 插件' })
  const source = createLiveSource({ dataDir: dir })
  const targetRoot = tempDir()
  const gone = await call(source, '/skill-install', { method: 'POST', body: { slug: 'install-demo', targetRoot } })
  assert.equal(gone.status, 404, '还留着会往 DSH skills 写文件的接口')
  assert.equal(fs.readdirSync(targetRoot).length, 0, '不该往目标目录写任何东西')
})

await check('POST /skill-global：注册到全局 / 取消注册；缺 slug、坏 action 各自 400', async () => {
  const dir = tempDir()
  createSkill(dir, { slug: 'global-api', name: '全局接口', description: '测试', body: '# 何时用\n测试', typeName: '代码 / 插件' })
  const source = createLiveSource({ dataDir: dir })
  const registered = await call(source, '/skill-global', { method: 'POST', body: { slug: 'global-api', action: 'register' } })
  assert.equal(registered.status, 200)
  assert.equal(registered.payload.data.registered, true)
  assert.equal(fs.existsSync(path.join(registered.payload.data.targetDir, 'SKILL.md')), true)
  const listed = await call(source, '/skills')
  const row = (listed.payload.data.skills || []).find((item) => item.id === 'global-api')
  assert.equal(row.globalRegistered, true, '/skills 没把注册状态带出来')
  const unregistered = await call(source, '/skill-global', { method: 'POST', body: { slug: 'global-api', action: 'unregister' } })
  assert.equal(unregistered.status, 200)
  assert.equal(unregistered.payload.data.registered, false)
  assert.equal(fs.existsSync(registered.payload.data.targetDir), false)
  assert.equal((await call(source, '/skill-global', { method: 'POST', body: {} })).payload.error.code, 'slug-required')
  assert.equal((await call(source, '/skill-global', { method: 'POST', body: { slug: 'global-api', action: 'nope' } })).payload.error.code, 'bad-action')
})

await check('POST /skills/import：技能套件文件夹 → 逐个导入并返回 items', async () => {
  const dir = tempDir()
  const suite = path.join(tempDir(), 'suite')
  fs.mkdirSync(path.join(suite, 'one'), { recursive: true })
  fs.mkdirSync(path.join(suite, 'two'), { recursive: true })
  fs.writeFileSync(path.join(suite, 'one', 'SKILL.md'), '---\nname: 套件一\ndescription: 一\n---\n\n# 一\n', 'utf8')
  fs.writeFileSync(path.join(suite, 'two', 'SKILL.md'), '---\nname: 套件二\ndescription: 二\n---\n\n# 二\n', 'utf8')
  const source = createLiveSource({ dataDir: dir })
  const out = await call(source, '/skills/import', { method: 'POST', body: { path: suite, categories: ['套件类'], notes: ['便签'] } })
  assert.equal(out.status, 200)
  assert.equal(out.payload.data.suite, true)
  assert.equal(out.payload.data.count, 2)
  assert.equal(out.payload.data.items.length, 2)
  const listed = await call(source, '/skills')
  assert.equal(listed.payload.data.skills.length, 2)
  assert.deepEqual([...listed.payload.data.skills[0].typeNames], ['套件类'])
})

await check('GET /skills 返回套件树；POST /skill-node 按子树注册/取消/删除', async () => {
  const dir = tempDir()
  const suite = path.join(tempDir(), 'node-suite')
  fs.mkdirSync(path.join(suite, 'alpha'), { recursive: true })
  fs.mkdirSync(path.join(suite, 'beta'), { recursive: true })
  fs.writeFileSync(path.join(suite, 'alpha', 'SKILL.md'), '---\nname: 节点甲\ndescription: 甲\n---\n\n# 甲\n', 'utf8')
  fs.writeFileSync(path.join(suite, 'beta', 'SKILL.md'), '---\nname: 节点乙\ndescription: 乙\n---\n\n# 乙\n', 'utf8')
  const source = createLiveSource({ dataDir: dir })
  const imported = await call(source, '/skills/import', { method: 'POST', body: { path: suite } })
  assert.equal(imported.status, 200)
  const listed = await call(source, '/skills')
  assert.equal(listed.status, 200)
  const tree = listed.payload.data.tree
  assert.equal(tree.length, 1)
  assert.equal(tree[0].path, 'node-suite')
  assert.equal(tree[0].kind, 'group')
  assert.equal(tree[0].skillCount, 2)
  assert.deepEqual(tree[0].children.map((node) => node.path).sort(), ['node-suite/alpha', 'node-suite/beta'])
  const row = listed.payload.data.skills.find((item) => item.id === 'node-suite/alpha')
  assert.equal(row.rootName, 'node-suite')
  assert.equal(row.depth, 1)

  const registered = await call(source, '/skill-node', { method: 'POST', body: { path: 'node-suite', action: 'register' } })
  assert.equal(registered.status, 200)
  assert.equal(registered.payload.data.total, 2)
  assert.equal(registered.payload.data.ok, 2)
  const unregistered = await call(source, '/skill-node', { method: 'POST', body: { path: 'node-suite', action: 'unregister' } })
  assert.equal(unregistered.status, 200)
  assert.equal(unregistered.payload.data.ok, 2)

  const mismatched = await call(source, '/skill-node', { method: 'POST', body: { path: 'node-suite', action: 'forget', expect: 1 } })
  assert.equal(mismatched.status, 400)
  assert.match(mismatched.payload.error.message, /数量不匹配/)
  const forgotten = await call(source, '/skill-node', { method: 'POST', body: { path: 'node-suite', action: 'forget', expect: 2 } })
  assert.equal(forgotten.status, 200)
  assert.equal(forgotten.payload.data.deleted, true)
  assert.equal((await call(source, '/skills')).payload.data.skills.length, 0)
})

await check('POST /skills/import：浏览器多选 SKILL.md（contents 数组）也能导入', async () => {
  const dir = tempDir()
  const source = createLiveSource({ dataDir: dir })
  const out = await call(source, '/skills/import', {
    method: 'POST',
    body: {
      contents: [
        '---\nname: 内容甲\ndescription: 甲\n---\n\n# 甲\n',
        '---\nname: 内容乙\ndescription: 乙\n---\n\n# 乙\n',
      ],
    },
  })
  assert.equal(out.status, 200, JSON.stringify(out.payload))
  assert.equal(out.payload.data.count, 2)
  const listed = await call(source, '/skills')
  assert.equal(listed.payload.data.skills.length, 2)
})
await check('POST /skill-meta：改分类与便签；缺 slug 400', async () => {
  const dir = tempDir()
  createSkill(dir, { slug: 'meta-demo', name: '元数据', description: '测试', body: '# 何时用\n测试', typeName: '代码 / 插件' })
  const source = createLiveSource({ dataDir: dir })
  const out = await call(source, '/skill-meta', { method: 'POST', body: { slug: 'meta-demo', typeNames: ['甲', '乙'], notes: ['备注一'] } })
  assert.equal(out.status, 200)
  assert.deepEqual([...out.payload.data.typeNames], ['甲', '乙'])
  const row = (await call(source, '/skills')).payload.data.skills.find((item) => item.id === 'meta-demo')
  assert.deepEqual([...row.notes], ['备注一'])
  assert.equal((await call(source, '/skill-meta', { method: 'POST', body: {} })).payload.error.code, 'slug-required')
})

await check('POST /skill-forget：删掉技能目录；缺 slug 400', async () => {
  const dir = tempDir()
  createSkill(dir, { slug: 'forget-me', name: '待忘技能', description: '测试', body: '# 何时用\n测试', typeName: '代码 / 插件' })
  const source = createLiveSource({ dataDir: dir })
  const out = await call(source, '/skill-forget', { method: 'POST', body: { slug: 'forget-me' } })
  assert.equal(out.status, 200)
  assert.equal(out.payload.data.deleted, true)
  assert.equal(fs.existsSync(path.join(dir, 'skills', 'forget-me')), false, '技能目录还在')
  assert.equal((await call(source, '/skills')).payload.data.skills.length, 0)
  assert.equal((await call(source, '/skill-forget', { method: 'POST', body: {} })).payload.error.code, 'slug-required')
})

await check('POST /pick-directory：弹宿主系统窗口，返回选的目录', async () => {
  const lib = tempDir()
  fs.writeFileSync(path.join(lib, 'exp-lib.json'), '{"experiences":[]}', 'utf8')
  const picker = fakePicker(lib)
  const out = await call(createMockSource(), '/pick-directory', {
    method: 'POST',
    deps: { getDirectoryPicker: () => picker },
  })
  assert.equal(out.status, 200, JSON.stringify(out.payload))
  assert.equal(out.payload.data.path, lib)
  assert.equal(out.payload.data.canceled, false)
  assert.equal(out.payload.data.note, '', '选中的就是经验库，不该多嘴')
  assert.ok(picker.lastSignal instanceof AbortSignal, '要传给窗口一个可中止的 signal')
  // 窗口是 GET 不了的
  const wrongMethod = await call(createMockSource(), '/pick-directory', { deps: { getDirectoryPicker: () => fakePicker(lib) } })
  assert.equal(wrongMethod.status, 405)
})

await check('POST /pick-directory：选到父级时顺手用里面的 .exp', async () => {
  const parent = tempDir()
  const lib = path.join(parent, '.exp')
  fs.mkdirSync(lib)
  fs.writeFileSync(path.join(lib, 'manifest.json'), '{}', 'utf8')
  const out = await call(createMockSource(), '/pick-directory', {
    method: 'POST',
    deps: { getDirectoryPicker: () => fakePicker(parent) },
  })
  assert.equal(out.payload.data.path, lib)
  assert.equal(out.payload.data.note, '用的是该文件夹下的 .exp')
})

await check('POST /pick-directory：取消 / 空目录 / 没窗口能力 / 只有浏览能力', async () => {
  const canceled = await call(createMockSource(), '/pick-directory', {
    method: 'POST',
    deps: { getDirectoryPicker: () => fakePicker(null) },
  })
  assert.equal(canceled.status, 200)
  assert.equal(canceled.payload.data.canceled, true)
  assert.equal(canceled.payload.data.path, null)

  const empty = await call(createMockSource(), '/pick-directory', {
    method: 'POST',
    deps: { getDirectoryPicker: () => fakePicker('   ') },
  })
  assert.equal(empty.payload.data.canceled, true)

  const noPicker = await call(createMockSource(), '/pick-directory', { method: 'POST', deps: {} })
  assert.equal(noPicker.payload.ok, false)
  assert.equal(noPicker.payload.error.code, 'picker-unavailable')

  const browseOnly = await call(createMockSource(), '/pick-directory', {
    method: 'POST',
    deps: { getDirectoryPicker: () => fakePicker('C:/tmp', 'browse') },
  })
  assert.equal(browseOnly.payload.error.code, 'picker-unavailable')
  assert.ok(String(browseOnly.payload.error.message).includes('browse'), '要说清是哪种能力')
})

await check('resolvePickedDirectory：是库就用、父级找 .exp、都没有就明说新建', () => {
  const bare = tempDir()
  const withLib = tempDir()
  fs.writeFileSync(path.join(withLib, 'exp-lib.legacy.json'), '{}', 'utf8')
  assert.equal(resolvePickedDirectory(withLib).path, withLib)
  assert.equal(resolvePickedDirectory('').path, '')
  const fresh = resolvePickedDirectory(bare)
  assert.equal(fresh.path, bare)
  assert.ok(fresh.note.includes('新建'), `空目录该提示会新建：${fresh.note}`)
})

await check('GET /pick-directory?probe=1：只回答能不能弹窗口，不弹窗', async () => {
  const ready = await call(createMockSource(), '/pick-directory?probe=1', {
    deps: { getDirectoryPicker: () => fakePicker('C:/x') },
  })
  assert.equal(ready.status, 200, JSON.stringify(ready.payload))
  assert.equal(ready.payload.data.available, true)
  assert.equal(ready.payload.data.kind, 'native')

  const missing = await call(createMockSource(), '/pick-directory?probe=1', { deps: {} })
  assert.equal(missing.payload.data.available, false)
  assert.equal(missing.payload.data.kind, null)
  assert.ok(String(missing.payload.data.message).includes('没有系统目录选择器'))

  const browseOnly = await call(createMockSource(), '/pick-directory?probe=1', {
    deps: { getDirectoryPicker: () => fakePicker('C:/x', 'browse') },
  })
  assert.equal(browseOnly.payload.data.available, false)
  assert.ok(String(browseOnly.payload.data.message).includes('browse'))
})

await check('GET /cold：mock 与 live 同一套分页/检索/年份', async () => {
  const mock = await call(createMockSource(), '/cold?limit=1')
  assert.equal(mock.status, 200)
  assert.equal(mock.payload.data.total, 2)
  assert.equal(mock.payload.data.rows.length, 1)
  for (const key of ['id', 'intent', 'action', 'typeName', 'G', 'outcome', 'lastSeenAt']) {
    assert.ok(Object.prototype.hasOwnProperty.call(mock.payload.data.rows[0], key), `冷档行缺少 ${key}`)
  }

  const dir = tempDir()
  const source = createLiveSource({ dataDir: dir })
  source.record({ intent: '冷档测试的热档一条', action: '普通记录', outcome: 'success', type: '代码 / 插件' })
  writeColdFixture(dir, [
    { id: 'ex_cold_1', intent: '旧任务一：给课件插页', action: '复制相邻页', typeName: 'PPT / 课件', outcome: 'failed', G: -0.6, lastSeenAt: '2026-01-08T09:30:00.000Z' },
    { id: 'ex_cold_2', intent: '旧任务二：整理文档', action: '逐段复述', typeName: '文档 / 教案', outcome: 'corrected', G: -0.4, lastSeenAt: '2026-01-05T14:10:00.000Z' },
  ])
  const all = await call(source, '/cold')
  assert.equal(all.status, 200)
  assert.equal(all.payload.data.source.mode, 'live')
  assert.equal(all.payload.data.exists, true)
  assert.equal(all.payload.data.total, 2)
  assert.deepEqual(all.payload.data.rows.map((row) => row.id), ['ex_cold_1', 'ex_cold_2'])
  assert.equal(all.payload.data.rows[0].action, '复制相邻页')
  assert.equal(all.payload.data.rows[0].G, -0.6)
  assert.equal((await call(source, '/cold?offset=1&limit=1')).payload.data.rows[0].id, 'ex_cold_2')
  assert.equal((await call(source, `/cold?query=${encodeURIComponent('文档')}`)).payload.data.total, 1)
  assert.equal((await call(source, '/cold', { method: 'POST' })).status, 405)
})

await check('GET /cold：冷档登记了但文件缺失 → 500 cold-unreadable', async () => {
  const dir = tempDir()
  const source = createLiveSource({ dataDir: dir })
  source.record({ intent: '登记冷档但文件丢了', action: '只改 manifest', outcome: 'success', type: '代码 / 插件' })
  registerColdWithoutFile(dir)
  const { status, payload } = await call(source, '/cold')
  assert.equal(status, 500)
  assert.equal(payload.ok, false)
  assert.equal(payload.error.code, 'cold-unreadable')
  assert.match(payload.error.message, /分片丢失|分片损坏/)
})

await check('X3 live 坏档：/experiences 带 storeError、/experience 503', async () => {
  const dir = tempDir()
  fs.writeFileSync(path.join(dir, 'exp-lib.json'), '{ 这不是 JSON', 'utf8')
  const source = createLiveSource({ dataDir: dir })
  const list = await call(source, '/experiences')
  assert.equal(list.status, 200)
  assert.equal(list.payload.data.storeError.code, 'store-unreadable')
  assert.ok(String(list.payload.data.storeError.file).length > 0)
  assert.equal(list.payload.data.rows.length, 0, '坏档要显示错误横幅，而不是「还没有经验」')
  const detail = await call(source, '/experience?id=ex_x')
  assert.equal(detail.status, 503)
  assert.equal(detail.payload.error.code, 'store-unreadable')
  const graph = await call(source, '/graph')
  assert.equal(graph.status, 200)
  assert.equal(graph.payload.data.storeError.code, 'store-unreadable')
})

await check('A4 /recall：mock 收到高级参数不报错', async () => {
  const source = createMockSource()
  const out = await call(source, '/recall', { method: 'POST', body: { intent: '把 PPT 导出成 PDF', all: true, cold: true, detail: true, mark: true } })
  assert.equal(out.status, 200)
  assert.ok(Array.isArray(out.payload.data.rows || out.payload.data.candidates))
})

fs.rmSync(testHome, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)

