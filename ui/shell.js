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

import { createLiveSource, resolveLiveDataDir } from './live.js'
import { createMockSource } from './mock.js'
import {
  FEEDBACK_ETA,
  codedError,
  detailOf,
  emptyStore,
  listOf,
  numberParam,
  recallOf,
  rowOf,
  visibleOf,
  statsOf,
  typesOf,
  usageSummary,
} from './data-source.js'
import fs from 'node:fs'

import { readEngineConfig, readSettings, readUiConfig, setCurrentRoot, writeEngineConfig, writeUiConfig } from '../kernel/settings.js'

/** 客户端调用前缀（与 client.js 拼的 URL 一致）。 */
export const API_PREFIX = '/exp-ui/api'
/** 外显名；与真实经验库（exp-lib）区分开。 */
export const APP_NAME = '经验库'

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 300

/** 设置页可编辑项（全部都在这里，未知键不落盘）。 */
export const SETTINGS_SPEC = {
  config: [
    { key: 'hint', label: '每轮提示段', type: 'boolean', hint: '关闭后不再向系统提示写经验库用法' },
    { key: 'usageLog', label: '用法日志', type: 'boolean', hint: '记录 exp_* 调用，用于使用记录页' },
    { key: 'usageLogMaxBytes', label: '日志上限（字节）', type: 'number' },
    { key: 'feedbackEta', label: '反馈学习率 η', type: 'number', hint: '0~1，默认 0.35' },
    { key: 'feedbackDecayDays', label: '反馈衰减（天）', type: 'number' },
    { key: 'routing', label: '簇路由', type: 'enum', values: ['on', 'shadow', 'off'] },
    { key: 'autoAssign', label: '自动归族', type: 'boolean' },
    { key: 'consolidation', label: '沉淀候选', type: 'boolean' },
    { key: 'consolidationMinSamples', label: '沉淀最少样本', type: 'number' },
    { key: 'induction', label: '归纳提示', type: 'boolean' },
    { key: 'inductionMinSamples', label: '归纳最少样本', type: 'number' },
    { key: 'maxTypes', label: '类型上限', type: 'number' },
    { key: 'newTypesPerDay', label: '每日新类型上限', type: 'number' },
    { key: 'mergeThreshold', label: '类型合并阈值', type: 'number' },
    { key: 'replaceThreshold', label: '经验取代阈值', type: 'number' },
    { key: 'typeSimilarity', label: '类型相似度阈值', type: 'number' },
  ],
  ui: [
    { key: 'source', label: '数据源', type: 'enum', values: ['live', 'mock'], hint: 'mock 仅用于界面演示' },
    { key: 'dataDir', label: '目录覆盖', type: 'string', hint: '留空则用「存储位置」里的当前根' },
    { key: 'graphTheme', label: '关系图主题', type: 'enum', values: ['personal', 'dream', 'knowledge', 'emotion', 'spacetime', 'collective', 'inspiration'], labels: { personal: '个人记忆碎片', dream: '梦境记忆轨迹', knowledge: '知识概念关联', emotion: '情绪记忆链路', spacetime: '时空记忆时间线', collective: '集体共享记忆', inspiration: '灵感思绪蛛网' } },
    { key: 'graphPalette', label: '关系图配色', type: 'enum', values: ['dsh', 'cyberpunk', 'aurora', 'blackgold', 'steampunk', 'qingmo', 'minimal', 'lava'], labels: { dsh: '跟随 DSH 主题', cyberpunk: '赛博朋克', aurora: '极光空灵', blackgold: '黑金科幻', steampunk: '蒸汽复古', qingmo: '青墨国风', minimal: '极简冷科技', lava: '熔岩炽热' } },
    { key: 'graphRotation', label: '自动旋转速度', type: 'number', hint: '弧度/秒，0 为关闭' },
    { key: 'graphBloom', label: '泛光 bloom', type: 'boolean' },
    { key: 'graphGlitch', label: '色散/毛刺', type: 'boolean' },
    { key: 'graphDust', label: '浮尘数量', type: 'number', hint: '0~240' },
  ],
}

function sanitizeSettings(input, fields) {
  const out = {}
  for (const field of fields) {
    if (input === null || typeof input !== 'object' || !Object.prototype.hasOwnProperty.call(input, field.key)) continue
    const value = input[field.key]
    if (field.type === 'boolean') out[field.key] = value === true
    else if (field.type === 'number') {
      const number = Number(value)
      out[field.key] = Number.isFinite(number) && value !== '' && value !== null ? number : null
    } else if (field.type === 'enum') {
      out[field.key] = field.values.includes(String(value)) ? String(value) : null
    } else {
      out[field.key] = value !== null && value !== undefined && String(value).trim() !== '' ? String(value).trim() : null
    }
  }
  return out
}

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

function withUiConfig(config = {}) {
  const ui = readUiConfig()
  const merged = { ...config }
  if (ui.source !== undefined) merged.source = ui.source
  if (ui.dataDir !== undefined) merged.dataDir = ui.dataDir
  return merged
}

export function sourceKeyOf(config = {}) {
  const merged = withUiConfig(config)
  const mode = String(merged.source || 'live').toLowerCase() === 'mock' ? 'mock' : 'live'
  return `${mode}|${mode === 'live' ? resolveLiveDataDir(merged) : ''}`
}

/** 按 config 取 data source。 */
export function createSource(config = {}) {
  const effective = withUiConfig(config)
  const key = sourceKeyOf(effective)
  const existing = sources.get(key)
  if (existing !== undefined) return existing
  const mode = String(effective.source || 'live').toLowerCase() === 'mock' ? 'mock' : 'live'
  const source = mode === 'live' ? createLiveSource(effective) : createMockSource()
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
    const limit = numberParam(params.get('limit'), 8, 50)
    if (typeof source.recall === 'function') {
      const recalled = source.recall({ intent: query, limit })
      return { ...meta, ...recalled, query }
    }
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

/**
 * 控制台动作：召回 / 记录 / 沉淀 / 类型 / 校验 / 设置。
 * live 交给 kernel engine；mock 能做记录与简化召回，其余明确「示例模式不支持」。
 */
export function buildRecall(source, body = {}) {
  const intent = String(body.intent || '').trim()
  if (intent === '') throw codedError('intent-required', '缺少 intent')
  const limit = Math.max(1, Math.min(50, Math.trunc(Number(body.limit) || 8)))
  const context = Array.isArray(body.context) ? body.context.map(String) : []
  if (typeof source.recall === 'function') return source.recall({ intent, limit, context })
  const store = source.read().store || emptyStore()
  return recallOf(store, intent, limit)
}

export function buildRecord(source, body = {}) {
  if (typeof source.record !== 'function') throw codedError('read-only', '当前数据源不支持写入经验')
  return source.record(body)
}

export function buildConsolidate(source, body = {}) {
  const intent = String(body.intent || '').trim()
  if (intent === '') throw codedError('intent-required', '缺少 intent')
  if (typeof source.consolidate !== 'function') throw codedError('unsupported', '当前数据源不支持沉淀')
  return source.consolidate({ intent, context: Array.isArray(body.context) ? body.context.map(String) : [] })
}

export function buildSkillFeedback(source, body = {}) {
  const slug = String(body.slug || '').trim()
  const result = String(body.result || '').trim().toLowerCase()
  if (slug === '') throw codedError('slug-required', '缺少技能 slug')
  if (!['helped', 'hurt', 'neutral'].includes(result)) throw codedError('bad-result', 'result 只能是 helped / hurt / neutral')
  if (typeof source.skillFeedback !== 'function') throw codedError('unsupported', '当前数据源不支持技能反馈')
  return source.skillFeedback(slug, result)
}

export function buildTypeOp(source, body = {}) {
  if (typeof source.typeOp !== 'function') throw codedError('unsupported', '当前数据源不支持类型管理')
  return source.typeOp(body)
}

export function buildValidate(source) {
  if (typeof source.validate !== 'function') return { problems: [] }
  return { problems: source.validate() }
}

export function buildSettings(source) {
  const read = source.read() || {}
  const extra = typeof source.settings === 'function' ? source.settings() : {}
  return {
    source: { id: source.id, mode: source.mode, label: source.label, readOnly: source.readOnly === true },
    dataDir: String(read.dataDir || ''),
    file: String(read.file || ''),
    exists: Boolean(read.exists),
    bytes: Number(read.bytes) || 0,
    updatedAt: String(read.updatedAt || ''),
    currentRoot: String(extra.currentRoot || ''),
    version: pluginVersion(),
  }
}

/** 关系图数据：根 → 类型 → 经验 → 技能（derivedFrom）。 */
export function buildGraph(source) {
  const read = source.read() || {}
  const store = read.store && typeof read.store === 'object' ? read.store : emptyStore()
  const rows = visibleOf(store).map(rowOf)
  const types = typesOf(store)
  const skills = typeof source.skills === 'function' ? source.skills() : []
  const nodes = [{ id: 'root', kind: 'root', label: '经验库' }]
  const edges = []
  const knownTypes = new Set()
  for (const type of types) {
    nodes.push({ id: `type:${type.id}`, kind: 'type', label: type.name, count: type.count || 0, weight: Math.min(1, 0.35 + (type.count || 0) / 12), system: type.system === true })
    edges.push({ source: 'root', target: `type:${type.id}`, kind: 'root', strength: 0.3 + Math.min(0.4, (type.count || 0) / 30) })
    knownTypes.add(type.id)
  }
  const expIds = new Set()
  for (const row of rows) {
    const typeId = row.typeId || 'ty_other'
    if (!knownTypes.has(typeId)) {
      nodes.push({ id: `type:${typeId}`, kind: 'type', label: row.typeName || '未分类', count: 0 })
      edges.push({ source: 'root', target: `type:${typeId}`, kind: 'root' })
      knownTypes.add(typeId)
    }
    const lastSeen = Date.parse(String(row.lastSeenAt || row.ts || '')) || 0
    nodes.push({ id: `exp:${row.id}`, kind: 'experience', label: row.intent || row.action || row.id, action: row.action || '', outcome: row.outcome, G: row.G, typeId, lastSeenAt: row.lastSeenAt || row.ts || '', weight: Math.min(1, 0.3 + Math.abs(Number(row.G) || 0) * 0.35), recent: lastSeen > 0 && Date.now() - lastSeen < 7 * 24 * 3600 * 1000 })
    edges.push({ source: `type:${typeId}`, target: `exp:${row.id}`, kind: 'type', strength: 0.25 + Math.min(0.5, Math.abs(Number(row.G) || 0) * 0.25) })
    expIds.add(row.id)
  }
  for (const skill of skills) {
    const id = String(skill.id || '')
    nodes.push({ id: `skill:${id}`, kind: 'skill', label: skill.name, status: skill.status, uses: skill.uses || 0, helped: skill.helped || 0, hurt: skill.hurt || 0, weight: Math.min(1, 0.45 + (skill.uses || 0) / 12) })
    const derived = Array.isArray(skill.derivedFrom) ? skill.derivedFrom : []
    const linked = derived.filter((experienceId) => expIds.has(String(experienceId)))
    for (const experienceId of linked) edges.push({ source: `exp:${experienceId}`, target: `skill:${id}`, kind: 'derived', strength: 0.5 + Math.min(0.45, (skill.uses || 0) / 12) })
    if (linked.length === 0) edges.push({ source: 'root', target: `skill:${id}`, kind: 'derived', strength: 0.55 })
  }
  return {
    notice: String(read.notice || ''),
    nodes,
    edges,
    summary: { types: types.length, experiences: rows.length, skills: skills.length },
    updatedAt: String(read.updatedAt || ''),
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
    if (route === '/recall') {
      if (method !== 'POST') return fail(res, 405, 'method-not-allowed', '只用 POST')
      return json(res, 200, { ok: true, data: buildRecall(active, await readBody(req)) })
    }
    if (route === '/record') {
      if (method !== 'POST') return fail(res, 405, 'method-not-allowed', '只用 POST')
      return json(res, 200, { ok: true, data: buildRecord(active, await readBody(req)) })
    }
    if (route === '/consolidate') {
      if (method !== 'POST') return fail(res, 405, 'method-not-allowed', '只用 POST')
      return json(res, 200, { ok: true, data: buildConsolidate(active, await readBody(req)) })
    }
    if (route === '/skill-feedback') {
      if (method !== 'POST') return fail(res, 405, 'method-not-allowed', '只用 POST')
      return json(res, 200, { ok: true, data: buildSkillFeedback(active, await readBody(req)) })
    }
    if (route === '/type') {
      if (method !== 'POST') return fail(res, 405, 'method-not-allowed', '只用 POST')
      return json(res, 200, { ok: true, data: buildTypeOp(active, await readBody(req)) })
    }
    if (route === '/graph') {
      if (method !== 'GET') return fail(res, 405, 'method-not-allowed', '只用 GET')
      return json(res, 200, { ok: true, data: buildGraph(active) })
    }
    if (route === '/validate') {
      if (method !== 'GET') return fail(res, 405, 'method-not-allowed', '只用 GET')
      return json(res, 200, { ok: true, data: buildValidate(active) })
    }
    if (route === '/settings') {
      if (method === 'POST') {
        const body = await readBody(req)
        if (body && Object.prototype.hasOwnProperty.call(body, 'currentRoot')) setCurrentRoot(String(body.currentRoot || '').trim())
        if (body && body.config !== undefined) writeEngineConfig(sanitizeSettings(body.config, SETTINGS_SPEC.config))
        if (body && body.ui !== undefined) writeUiConfig(sanitizeSettings(body.ui, SETTINGS_SPEC.ui))
        resetSourceCache()
        return json(res, 200, { ok: true, data: { action: 'saved' } })
      }
      if (method !== 'GET') return fail(res, 405, 'method-not-allowed', '只用 GET/POST')
      return json(res, 200, { ok: true, data: { ...buildSettings(active), config: readEngineConfig(), ui: readUiConfig(), spec: SETTINGS_SPEC } })
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
    const status = code === 'unsupported'
      ? 501
      : code === 'read-only' || code === 'not-feedbackable'
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
