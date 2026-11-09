/**
 * exp-ui — Host 半（HTTP 外壳）。
 *
 * 一个前缀路由 `/exp-ui/api`，客户端半只认这里的返回值；data source 可换
 * （mock = 内置示例数据，live = 读真实经验库文件），路由与返回形状不变。
 * 这样「外壳测试通过 → 接真实经验库」只是换 config，不是改界面。
 *
 * 响应envelope：
 *   成功 { ok: true, data: … }
 *   失败 { ok: false, error: { code, message } }
 */

import { createLiveSource } from './live.js'
import { createMockSource } from './mock.js'
import {
  FEEDBACK_ETA,
  codedError,
  detailOf,
  emptyStore,
  listOf,
  numberParam,
  recallOf,
  statsOf,
  typesOf,
  usageSummary,
} from './data-source.js'
import fs from 'node:fs'

/** 客户端调用前缀（与 client.js 拼的 URL 一致）。 */
export const API_PREFIX = '/exp-ui/api'
/** 外显名；与真实经验库（exp-lib）区分开。 */
export const APP_NAME = 'exp-ui'

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 300

let cachedVersion = ''
/** 插件版本：读 package.json，读不到用 0.0.0。 */
export function pluginVersion() {
  if (cachedVersion !== '') return cachedVersion
  try {
    const raw = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
    cachedVersion = typeof raw.version === 'string' ? raw.version : '0.0.0'
  } catch {
    cachedVersion = '0.0.0'
  }
  return cachedVersion
}

/** 同一 config 复用同一个 data source（mock 的反馈状态才不会每请求丢一次）。 */
const sources = new Map()

export function sourceKeyOf(config = {}) {
  const mode = String(config.source || 'mock').toLowerCase() === 'live' ? 'live' : 'mock'
  return `${mode}|${mode === 'live' ? String(config.dataDir || '') : ''}`
}

/** 按 config 取 data source。 */
export function createSource(config = {}) {
  const key = sourceKeyOf(config)
  const existing = sources.get(key)
  if (existing !== undefined) return existing
  const mode = String(config.source || 'mock').toLowerCase() === 'live' ? 'live' : 'mock'
  const source = mode === 'live' ? createLiveSource(config) : createMockSource()
  sources.set(key, source)
  return source
}

/** 测试用：清掉 source 缓存（包括 mock 反馈状态）。 */
export function resetSourceCache() {
  sources.clear()
}

/** 安全取用法日志：任何异常都当空。 */
function safeUsage(source, limit) {
  try {
    const rows = source.usageRows(limit)
    return Array.isArray(rows) ? rows : []
  } catch {
    return []
  }
}

/** 安全取固化技能：读不到 / 读坏都当空。 */
function safeSkills(source) {
  try {
    const rows = source.skills()
    return Array.isArray(rows) ? rows : []
  } catch {
    return []
  }
}

/** 技能状态分布（给面板顶部与页签用）。 */
function skillSummaryOf(rows) {
  const summary = { total: rows.length, solid: 0, trial: 0, risky: 0, new: 0, blocked: 0 }
  for (const row of rows) {
    if (summary[row.status] !== undefined) summary[row.status] += 1
  }
  return summary
}

/** 概览（`/state` 的 data）。 */
export function buildState(source) {
  const read = source.read() || {}
  const store = read.store && typeof read.store === 'object' ? read.store : emptyStore()
  const experiences = Array.isArray(store.experiences) ? store.experiences : []
  const types = typesOf(store)
  const stats = statsOf(store)
  const skills = safeSkills(source)
  const bytes = Number(read.bytes) || 0
  return {
    app: APP_NAME,
    version: pluginVersion(),
    source: { id: source.id, mode: source.mode, label: source.label, readOnly: source.readOnly === true },
    dataDir: String(read.dataDir || ''),
    file: String(read.file || ''),
    exists: Boolean(read.exists),
    bytes,
    updatedAt: String(read.updatedAt || ''),
    notice: String(read.notice || ''),
    feedbackEta: FEEDBACK_ETA,
    totals: {
      all: experiences.length,
      visible: stats.totalInsights,
      deleted: experiences.filter((item) => item.deleted_at).length,
      superseded: experiences.filter((item) => item.superseded_by).length,
      retired: experiences.filter((item) => item.retired_at).length,
      types: types.length,
      skills: skills.length,
    },
    skillSummary: skillSummaryOf(skills),
    stats: { ...stats, dbSizeBytes: bytes },
    types,
    usage: usageSummary(safeUsage(source, 500)),
  }
}

/** `/experiences` 的 data。 */
export function buildExperiences(source, params) {
  const read = source.read() || {}
  const store = read.store && typeof read.store === 'object' ? read.store : emptyStore()
  const query = String(params.get('query') || '').trim()
  const meta = {
    source: { id: source.id, mode: source.mode, label: source.label, readOnly: source.readOnly === true },
    notice: String(read.notice || ''),
  }
  if (query !== '') {
    const limit = numberParam(params.get('limit'), 20, 50)
    return { ...meta, ...recallOf(store, query, limit) }
  }
  return { ...meta, ...listOf(store, params) }
}

/** `/experience` 的 data；找不到返回 null。 */
export function buildExperience(source, id) {
  const read = source.read() || {}
  const store = read.store && typeof read.store === 'object' ? read.store : emptyStore()
  return detailOf(store, id)
}

/** `/feedback` 的 data：delegates 到 data source（live 会抛 read-only）。 */
export function buildFeedback(source, id, result) {
  return source.feedback(id, result)
}

/** `/skills` 的 data：固化技能列表 + 状态分布。 */
export function buildSkills(source) {
  const read = source.read() || {}
  const rows = safeSkills(source)
  return {
    source: { id: source.id, mode: source.mode, label: source.label, readOnly: source.readOnly === true },
    notice: String(read.notice || ''),
    total: rows.length,
    summary: skillSummaryOf(rows),
    skills: rows,
  }
}

/** 统一 JSON 回执。 */
function json(res, status, payload) {
  const body = JSON.stringify(payload)
  if (typeof res.setHeader === 'function') {
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
  }
  res.end(body)
}

function fail(res, status, code, message) {
  return json(res, status, { ok: false, error: { code, message } })
}

/** 读请求体（上限 1MB）。 */
async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 1024 * 1024) throw codedError('body-too-large', '请求体超过 1MB')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  return text.trim() === '' ? {} : JSON.parse(text)
}

/** 处理一条请求；测试可直接调用（不必起宿主）。 */
export async function handleRequest(req, res, source) {
  try {
    const url = new URL(req.url || '/', 'http://dsh.internal')
    const route = url.pathname.slice(API_PREFIX.length) || '/'
    const method = String(req.method || 'GET').toUpperCase()
    const active = source || createSource({})

    if (route === '/health') {
      if (method !== 'GET') return fail(res, 405, 'method-not-allowed', '只用 GET')
      return json(res, 200, {
        ok: true,
        data: {
          ok: true,
          app: APP_NAME,
          version: pluginVersion(),
          source: active.id,
          readOnly: active.readOnly === true,
        },
      })
    }
    if (route === '/state') {
      if (method !== 'GET') return fail(res, 405, 'method-not-allowed', '只用 GET')
      return json(res, 200, { ok: true, data: buildState(active) })
    }
    if (route === '/experiences') {
      if (method !== 'GET') return fail(res, 405, 'method-not-allowed', '只用 GET')
      return json(res, 200, { ok: true, data: buildExperiences(active, url.searchParams) })
    }
    if (route === '/experience') {
      if (method !== 'GET') return fail(res, 405, 'method-not-allowed', '只用 GET')
      const id = String(url.searchParams.get('id') || '').trim()
      if (id === '') return fail(res, 400, 'id-required', '缺少 id 参数')
      const detail = buildExperience(active, id)
      if (detail === null) return fail(res, 404, 'not-found', `没有这条经验：${id}`)
      return json(res, 200, { ok: true, data: detail })
    }
    if (route === '/types') {
      if (method !== 'GET') return fail(res, 405, 'method-not-allowed', '只用 GET')
      const read = active.read() || {}
      const store = read.store && typeof read.store === 'object' ? read.store : emptyStore()
      return json(res, 200, { ok: true, data: { types: typesOf(store) } })
    }
    if (route === '/skills') {
      if (method !== 'GET') return fail(res, 405, 'method-not-allowed', '只用 GET')
      return json(res, 200, { ok: true, data: buildSkills(active) })
    }
    if (route === '/usage') {
      if (method !== 'GET') return fail(res, 405, 'method-not-allowed', '只用 GET')
      const limit = numberParam(url.searchParams.get('limit'), 100, 500)
      const rows = safeUsage(active, limit).slice(-limit).reverse().map((row) => ({
        at: String(row.at || ''),
        tool: String(row.tool || ''),
        ok: row.ok === undefined ? null : row.ok === true,
        op: String(row.op || ''),
        intent: String(row.intent || ''),
        action: String(row.action || ''),
        feedback: row.feedback === undefined || row.feedback === null ? null : String(row.feedback),
        id: row.id === undefined ? '' : String(row.id),
        error: String(row.error || ''),
        limit: row.limit === undefined ? null : Number(row.limit),
        routeScore: row.route_score === undefined ? null : Number(row.route_score),
        ids: Array.isArray(row.ids) ? row.ids.map(String) : [],
      }))
      return json(res, 200, { ok: true, data: { rows } })
    }
    if (route === '/feedback') {
      if (method !== 'POST') return fail(res, 405, 'method-not-allowed', '只用 POST')
      const body = await readBody(req)
      const id = String((body && body.id) || '').trim()
      const result = String((body && body.result) || '').trim().toLowerCase()
      if (id === '') return fail(res, 400, 'id-required', '缺少 id')
      if (!['helped', 'hurt', 'neutral'].includes(result)) {
        return fail(res, 400, 'bad-result', 'result 只能是 helped / hurt / neutral')
      }
      const receipt = buildFeedback(active, id, result)
      return json(res, 200, { ok: true, data: receipt })
    }
    return fail(res, 404, 'not-found', `没有这个路由：${route}`)
  } catch (error) {
    const code = error && typeof error.code === 'string' ? error.code : 'internal'
    const message = String((error && error.message) || error)
    const status = code === 'read-only' || code === 'not-feedbackable'
      ? 409
      : code === 'not-found'
        ? 404
        : code === 'internal'
          ? 500
          : 400
    return fail(res, status, code, message)
  }
}

/**
 * 造一个绑定 config 的请求处理器（index.js 用它挂到 webServer）。
 * @param {object} config - 插件行 config（`source` / `dataDir`）。
 * @returns {(req: any, res: any) => Promise<void>}
 */
export function createApi(config = {}) {
  return (req, res) => handleRequest(req, res, createSource(config))
}
