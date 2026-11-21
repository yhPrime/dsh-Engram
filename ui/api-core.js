/**
 * exp-ui — Host 半里的公共件与通用路由。
 *
 * 公共件（json/fail/readBody、storeOf·storeReadOf·readOf、safeSkills·metaOf、空库回退）
 * 被 api-family / api-skill / api-settings / api-graph 共用；`createRequestHandler`
 * 持有唯一的按原顺序分派表，通用路由（health/state/experiences/usage/pending…）也在这里。
 * 领域路由由 ui/shell.js 注入，避免与领域模块互相 import 成环。
 */

import { createLiveSource, resolveLiveDataDir } from './live.js'
import { createMockSource } from './mock.js'
import { FEEDBACK_ETA, RECALL_PASSTHROUGH_KEYS, codedError, detailOf, emptyStore, listOf, numberParam, recallOf, statsOf, statsOfManifest, typesOf, typesOfManifest, usageSummary } from './data-source.js'
import fs from 'node:fs'
import path from 'node:path'
import { readUiConfig } from '../kernel/settings.js'
import { galleryHtml } from './icons-gallery.js'

/** 客户端调用前缀（与 client.js 拼的 URL 一致）。 */
export const API_PREFIX = '/exp-ui/api'
/** 外显名；与真实经验库（exp-lib）区分开。 */
export const APP_NAME = '经验库'

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 300

let cachedVersion = ''
/** 插件版本：读包根 package.json（老布局回退到 ui/package.json），读不到用 0.0.0。 */
export function pluginVersion() {
  if (cachedVersion !== '') return cachedVersion
  for (const url of [new URL('../package.json', import.meta.url), new URL('./package.json', import.meta.url)]) {
    try {
      const raw = JSON.parse(fs.readFileSync(url, 'utf8'))
      if (typeof raw.version === 'string' && raw.version !== '') {
        cachedVersion = raw.version
        return cachedVersion
      }
    } catch {
      // 试下一个位置
    }
  }
  cachedVersion = '0.0.0'
  return cachedVersion
}

/** 客户端半最近一次回打（诊断用；每次插件重载清空）。 */
let clientProbes = []

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
export function safeUsage(source, limit) {
  try {
    const rows = source.usageRows(limit)
    return Array.isArray(rows) ? rows : []
  } catch {
    return []
  }
}

/** 安全取固化技能：读不到 / 读坏都当空。 */
export function metaOf(source) {
  const src = source && typeof source === 'object' ? source : {}
  return { id: src.id, mode: src.mode, label: src.label, readOnly: src.readOnly === true }
}

export function readOf(source) {
  if (!source || typeof source.read !== 'function') return {}
  try {
    return source.read() || {}
  } catch {
    return {}
  }
}

/**
 * 取整库行，并把「读失败」作为结构化错误带出来（X3）。
 *
 * 为什么不让 storeOf 自己抛：列表/关系图要照常渲染（空页 + 横幅），只有详情页需要 503。
 * 所以这里统一成 `{ store, error }`：调用方自己决定是显示横幅还是回 503。
 */
export function storeReadOf(source) {
  if (source && typeof source.hot === 'function') {
    try {
      const hot = source.hot()
      if (hot && hot.store && typeof hot.store === 'object') {
        return { store: hot.store, error: hot.error === undefined ? null : hot.error }
      }
    } catch (error) {
      return { store: emptyStore(), error: storeErrorOf(error, source) }
    }
  }
  const read = readOf(source)
  if (read.store && typeof read.store === 'object') return { store: read.store, error: null }
  return { store: emptyStore(), error: null }
}

/** 把任意读取异常翻成统一错误形状（code/message/file）；不再向上抛。 */
export function storeErrorOf(error, source) {
  const read = readOf(source)
  return {
    code: 'store-unreadable',
    message: String((error && error.message) || error),
    file: String(read.file || ''),
  }
}

/** 取整库行（页面级）：live 的 read() 只给 manifest/storage（P3-A），行走 `hot()`。语义不变。 */
export function storeOf(source) {
  return storeReadOf(source).store
}

export function safeSkills(source) {
  try {
    const rows = source && typeof source.skills === 'function' ? source.skills() : []
    // 行数据畸形（null/缺 slug）不能把整个技能页打崩：过滤掉，页面照常渲染。
    return Array.isArray(rows)
      ? rows.filter((row) => row && typeof row === 'object' && (typeof row.slug === 'string' || typeof row.id === 'string'))
      : []
  } catch {
    return []
  }
}

/** 技能状态分布（给面板顶部与页签用）。 */
export function skillSummaryOf(rows) {
  const summary = { total: rows.length, solid: 0, trial: 0, risky: 0, new: 0, blocked: 0 }
  for (const row of rows) {
    if (summary[row.status] !== undefined) summary[row.status] += 1
  }
  return summary
}

/** 从 manifest 的桶/簇/统计算 `/state` 的 totals（G6；字段名兼容几种写法）。 */
export function totalsOfManifest(manifest, types, skills) {
  const stats = manifest && manifest.stats !== null && typeof manifest.stats === 'object' ? manifest.stats : {}
  const buckets = Array.isArray(manifest && manifest.buckets) ? manifest.buckets : []
  const all = buckets.reduce((sum, bucket) => sum + (Number(bucket && bucket.count) || 0), 0)
  const visible = types.reduce((sum, type) => sum + (Number(type.count) || 0), 0)
  const numberOr = (keys, fallback) => {
    for (const key of keys) {
      const value = Number(stats[key])
      if (Number.isFinite(value)) return value
    }
    return fallback
  }
  return {
    all: numberOr(['all', 'total'], all),
    visible: numberOr(['visible'], visible),
    deleted: numberOr(['deleted', 'deletedInsights'], 0),
    superseded: numberOr(['superseded', 'supersededInsights'], 0),
    retired: numberOr(['retired', 'retiredInsights'], 0),
    types: types.length,
    skills: skills.length,
  }
}

/** 概览（`/state` 的 data）：有 manifest.stats 时只读 manifest（P3-A），否则退回全量行。 */
export function buildState(source) {
  const read = readOf(source)
  const manifest = read.manifest !== null && typeof read.manifest === 'object' ? read.manifest : null
  const storage = read.storage !== null && typeof read.storage === 'object' ? read.storage : null
  const skills = safeSkills(source)
  const bytes = Number(read.bytes) || (storage === null ? 0 : Number(storage.totalBytes) || 0)
  let cold = null
  if (source !== null && source !== undefined && typeof source.cold === 'function') {
    try {
      cold = source.cold()
    } catch (error) {
      // 冷档读坏不能让概览整页打不开：保留明确错误给界面显示。
      cold = { years: [], total: 0, samples: [], error: String((error && error.message) || error) }
    }
  }
  const base = {
    app: APP_NAME,
    version: pluginVersion(),
    source: metaOf(source),
    dataDir: String(read.dataDir || ''),
    file: String(read.file || ''),
    exists: Boolean(read.exists),
    bytes,
    updatedAt: read.updatedAt === null || read.updatedAt === undefined ? '' : String(read.updatedAt),
    notice: String(read.notice || ''),
    ...(storage !== null ? { storage } : {}),
    ...(cold !== null ? { cold } : {}),
    feedbackEta: FEEDBACK_ETA,
    skillSummary: skillSummaryOf(skills),
    usage: usageSummary(safeUsage(source, 500)),
  }
  if (manifest !== null && manifest.stats !== null && typeof manifest.stats === 'object') {
    const types = typesOfManifest(manifest)
    return {
      ...base,
      totals: totalsOfManifest(manifest, types, skills),
      stats: statsOfManifest(manifest, bytes),
      types,
    }
  }
  // 没有 manifest / G6 未落地 / mock：退回全量行，行为与 0.13.0 一致（不静默改语义）。
  const store = storeOf(source)
  const experiences = Array.isArray(store.experiences) ? store.experiences : []
  const types = typesOf(store)
  const stats = statsOf(store)
  return {
    ...base,
    totals: {
      all: experiences.length,
      visible: stats.totalInsights,
      deleted: experiences.filter((item) => item.deleted_at).length,
      superseded: experiences.filter((item) => item.superseded_by).length,
      retired: experiences.filter((item) => item.retired_at).length,
      types: types.length,
      skills: skills.length,
    },
    stats: { ...stats, dbSizeBytes: bytes },
    types,
  }
}

/** 类型目录：有 manifest 时只读 manifest（P3-A），否则退回整库行。 */
export function typeListOf(source, read = readOf(source)) {
  if (read && read.manifest !== null && typeof read.manifest === 'object') {
    const types = typesOfManifest(read.manifest)
    if (types.length > 0) return types
  }
  return typesOf(storeOf(source))
}

/** `/experiences` 的 data。 */
export function buildExperiences(source, params) {
  const read = readOf(source)
  const storeRead = storeReadOf(source)
  const query = String((params && typeof params.get === 'function' ? params.get('query') : '') || '').trim()
  const meta = {
    source: metaOf(source),
    notice: String(read.notice || ''),
    storeError: storeRead.error,
  }
  if (query !== '') {
    const limit = numberParam(params && typeof params.get === 'function' ? params.get('limit') : null, 8, 50)
    if (source && typeof source.recall === 'function') {
      const recalled = source.recall({ intent: query, limit })
      return { ...meta, ...recalled, query }
    }
    return { ...meta, ...recallOf(storeRead.store, query, limit) }
  }
  return { ...meta, ...listOf(storeRead.store, params || new URLSearchParams()) }
}

/** `/experience` 的 data；找不到返回 null；坏档抛 store-unreadable（路由回 503）。 */
export function buildExperience(source, id) {
  const storeRead = storeReadOf(source)
  if (storeRead.error !== null) throw codedError('store-unreadable', storeRead.error.message)
  return detailOf(storeRead.store, id)
}

/** `/feedback` 的 data：delegates 到 data source（live 会抛 read-only）。 */
export function buildFeedback(source, id, result) {
  return source.feedback(id, result)
}

/** `/pending` 的 data：待判定队列（最多 5 条）。 */
export function buildPending(source) {
  return source && typeof source.pending === 'function' ? source.pending(5) : []
}

/** `/verdicts` 的 data：把回填交给 source（逐条返回 ok/失败原因）。 */
export function buildVerdicts(source, list) {
  if (!source || typeof source.verdicts !== 'function') throw new Error('当前数据源不支持判定回填')
  return source.verdicts(Array.isArray(list) ? list : [])
}

/** `/usage-summary` 的 data：调用次数与回执字符数汇总（token 账）。 */
export function buildUsageSummary(source) {
  return source && typeof source.usageSummary === 'function'
    ? source.usageSummary()
    : { calls: 0, chars: 0, avgChars: 0, byTool: {} }
}

/**
 * 控制台动作：召回 / 记录 / 沉淀 / 类型 / 校验 / 设置。
 * live 交给 kernel engine；mock 能做记录与简化召回，其余明确「示例模式不支持」。
 */
export function buildRecall(source, body = {}) {
  if (!source || typeof source.recall !== 'function') throw new Error('当前数据源不支持检索')
  const intent = String(body.intent || '').trim()
  if (intent === '') throw codedError('intent-required', '缺少 intent')
  const limit = Math.max(1, Math.min(50, Math.trunc(Number(body.limit) || 8)))
  const context = Array.isArray(body.context) ? body.context.map(String) : []
  const args = { intent, limit, context }
  // A4：高级参数原样透传（undefined 不传，否则会覆盖内核默认值）。
  for (const key of RECALL_PASSTHROUGH_KEYS) {
    if (body[key] !== undefined) args[key] = body[key]
  }
  return source.recall(args)
}

export function buildRecord(source, body = {}) {
  if (!source || typeof source.record !== 'function') throw codedError('read-only', '当前数据源不支持写入经验')
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw codedError('bad-request', '请求体必须是对象')
  const intent = String(body.intent === undefined || body.intent === null ? '' : body.intent).trim()
  if (intent === '') throw codedError('intent-required', '缺少 intent')
  const action = String(body.action === undefined || body.action === null ? '' : body.action).trim()
  if (action === '') throw codedError('action-required', '缺少 action')
  const outcome = String(body.outcome === undefined || body.outcome === null ? '' : body.outcome).trim()
  if (outcome !== '' && !['accepted', 'success', 'partial', 'unknown', 'failed', 'corrected', 'aborted'].includes(outcome)) {
    throw codedError('bad-outcome', `outcome 不合法：${outcome}`)
  }
  // 分步回报：非法值拒绝、越界夹到 [-1,1]（与 kernel 的 normalizeStepRewards 同口径）。
  const next = { ...body }
  if (body.stepRewards !== undefined && body.stepRewards !== null) {
    if (!Array.isArray(body.stepRewards)) throw codedError('bad-request', 'stepRewards 必须是数组')
    next.stepRewards = body.stepRewards.map((item, index) => {
      if (typeof item !== 'number' || !Number.isFinite(item)) {
        throw codedError('bad-request', `stepRewards[${index}] 必须是数字，收到：${JSON.stringify(item)}`)
      }
      return Math.max(-1, Math.min(1, item))
    })
  }
  return source.record(next)
}

/** `/review` 的 data：时效复核（due / verify / stale / retire / revive），经验与技能同一入口。 */
export function buildReview(source, body = {}) {
  if (!source || typeof source.review !== 'function') throw codedError('unsupported', '当前数据源不支持时效复核')
  const args = body !== null && typeof body === 'object' && !Array.isArray(body) ? body : {}
  const action = String(args.action === undefined || args.action === null ? '' : args.action).trim().toLowerCase()
  const reviewActions = ['due', 'verify', 'stale', 'retire', 'revive']
  if (!reviewActions.includes(action)) {
    throw codedError('bad-action', `action 只能是 ${reviewActions.join(' / ')}，收到：${action || '(空)'}`)
  }
  const id = String(args.id === undefined || args.id === null ? '' : args.id).trim()
  if (action !== 'due' && id === '') throw codedError('id-required', '缺少 id（经验 id 或 skill:<slug>）')
  const note = String(args.note === undefined || args.note === null ? '' : args.note).trim()
  if (action === 'revive' && note === '') throw codedError('reason-required', 'revive 需要 note 说明理由')
  const reviewAfter = String(args.reviewAfter === undefined || args.reviewAfter === null ? '' : args.reviewAfter).trim()
  if (reviewAfter !== '' && !Number.isFinite(Date.parse(reviewAfter))) {
    throw codedError('bad-request', `reviewAfter 不是合法时间：${reviewAfter}`)
  }
  try {
    return source.review({ ...args, action })
  } catch (error) {
    const message = String((error && error.message) || error)
    if (/没有这条经验|没有这个技能/.test(message)) throw codedError('not-found', message)
    if (/已被.*取代|已删除|已退休/.test(message)) throw codedError('not-feedbackable', message)
    if (/revive 需要 note/.test(message)) throw codedError('reason-required', message)
    if (/不是合法时间/.test(message)) throw codedError('bad-request', message)
    throw error
  }
}

export function buildConsolidate(source, body = {}) {
  const intent = String(body.intent || '').trim()
  if (intent === '') throw codedError('intent-required', '缺少 intent')
  if (typeof source.consolidate !== 'function') throw codedError('unsupported', '当前数据源不支持沉淀')
  return source.consolidate({ intent, context: Array.isArray(body.context) ? body.context.map(String) : [] })
}

export function buildValidate(source) {
  if (!source || typeof source.validate !== 'function') return { problems: [] }
  return { problems: source.validate() }
}

/** 一个目录「是经验库」的判定文件：分片布局 / 旧单文件 / 迁移留档 / 分片目录。 */
const LIBRARY_MARKERS = ['manifest.json', 'exp-lib.json', 'exp-lib.legacy.json', 'buckets']

/** 这个目录里有没有经验库的痕迹。 */
function looksLikeLibrary(dir) {
  try {
    return LIBRARY_MARKERS.some((name) => fs.existsSync(path.join(dir, name)))
  } catch {
    return false
  }
}

/**
 * 把「人选的文件夹」翻成「经验库根」。
 *
 * 经验库根就是含 `exp-lib.json` / `manifest.json` 的那个目录。人选到它的父级
 * （例如 `C:/Users/yh/WorkDeepSeek`）时，别在他那儿另起一份空库——顺手用里面的 `.exp`。
 */
export function resolvePickedDirectory(picked) {
  const dir = String(picked || '').trim()
  if (dir === '') return { path: '', note: '' }
  if (looksLikeLibrary(dir)) return { path: dir, note: '' }
  const nested = path.join(dir, '.exp')
  if (looksLikeLibrary(nested)) return { path: nested, note: '用的是该文件夹下的 .exp' }
  return { path: dir, note: '这里还没有经验库，选它等于从这个文件夹新建一份空库' }
}

/**
 * 宿主给的目录选择能力，能弹系统窗口就返回选目录方法，否则抛出原因。
 *
 * @param deps - `getDirectoryPicker()`：可选，返回宿主的目录选择服务。
 * @returns {{ pick: (signal?: AbortSignal) => Promise<string|null>, kind: string }}
 */
function nativePickerOf(deps = {}) {
  const picker = typeof deps.getDirectoryPicker === 'function' ? deps.getDirectoryPicker() : null
  if (picker === null || picker === undefined) {
    throw codedError('picker-unavailable', '这个宿主没有系统目录选择器（桌面版才有），请手动填路径')
  }
  const capability = typeof picker.capability === 'function' ? picker.capability() : null
  if (capability === null || capability === undefined || capability.kind !== 'native') {
    const kind = capability && capability.kind ? String(capability.kind) : '未知'
    throw codedError('picker-unavailable', `当前目录选择器是 ${kind} 版，打不开系统窗口，请手动填路径`)
  }
  return { pick: (signal) => capability.pick(signal), kind: 'native' }
}

/**
 * 只读探针：这个宿主能不能弹系统选目录窗口（不弹，只回答）。
 * 界面「?」与出问题时自查都用它——别靠点一下猜。
 */
export function describeDirectoryPicker(deps = {}) {
  try {
    const picker = nativePickerOf(deps)
    return { available: true, kind: picker.kind, message: '能弹系统选目录窗口' }
  } catch (error) {
    return { available: false, kind: null, message: String((error && error.message) || error) }
  }
}

/**
 * 在宿主屏幕上弹系统自带的选目录窗口，返回人选的那个路径（取消则 null）。
 *
 * 用的是宿主自己的 `ctx.directoryPicker`（桌面版是 Windows 的 IFileOpenDialog，
 * 跟「选工作区目录」是同一个窗口）。远程浏览器那种组合只有 browse 能力，
 * 这里如实拒绝，让界面退回手填路径，不假装弹出过窗口。
 *
 * @param deps - `getDirectoryPicker()`：可选，返回宿主的目录选择服务。
 * @param signal - 调用方生命周期；中止就关掉窗口。
 */
export async function pickDirectory(deps = {}, signal) {
  const picker = nativePickerOf(deps)
  const picked = await picker.pick(signal)
  if (picked === null || picked === undefined || String(picked).trim() === '') return { path: null, canceled: true, note: '' }
  return { canceled: false, ...resolvePickedDirectory(picked) }
}

/** 统一 JSON 回执。 */
export function json(res, status, payload) {
  const body = JSON.stringify(payload)
  if (typeof res.setHeader === 'function') {
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
  }
  res.end(body)
}

export function fail(res, status, code, message, details) {
  return json(res, status, { ok: false, error: { code, message, ...(details === undefined ? {} : { details }) } })
}

/** 读请求体（上限 1MB）。 */
export async function readBody(req) {
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

/**
 * 造请求处理器（`handleRequest`）：通用路由在本文件，领域路由由 shell.js 注入。
 *
 * 注入而不是直接 import 领域模块：领域模块反过来要用本文件的公共件，
 * 直接互 import 会成环。分派顺序与原实现逐条一致——顺序即早退顺序，禁止重排。
 *
 * @param domains - `{ family, skill, settings, graph }`，各自导出本领域的路由函数。
 */
export function createRequestHandler(domains = {}) {
  const family = domains.family || {}
  const skill = domains.skill || {}
  const settings = domains.settings || {}
  const graph = domains.graph || {}

  /** 处理一条请求；测试可直接调用（不必起宿主）。 */
  return async function handleRequest(req, res, source, deps = {}) {
    try {
      const url = new URL(req.url || '/', 'http://dsh.internal')
      const route = url.pathname.slice(API_PREFIX.length) || '/'
      const method = String(req.method || 'GET').toUpperCase()
      const active = source || createSource({})
      const ctx = { req, res, active, url, method, deps }

      // 逐条分派：顺序即原实现的早退顺序（禁止重排）。
      // 必须 `return await`：领域 handler 多为 async，裸 return promise 时它的 rejection
      // 会绕过下面的 catch，状态码就不再是 400/409/503 那套映射（0.44 拆分时的真 bug）。
      if (route === '/icons') return await handleIcons(ctx)
      if (route === '/health') return await handleHealth(ctx)
      if (route === '/state') return await handleState(ctx)
      if (route === '/experiences') return await handleExperiences(ctx)
      if (route === '/experience') return await handleExperience(ctx)
      if (route === '/cold') return await graph.handleCold(ctx)
      if (route === '/tag-registry') return await family.handleTagRegistry(ctx)
      if (route === '/tag-tree') return await family.handleTagTree(ctx)
      if (route === '/families') return await family.handleFamilies(ctx)
      if (route === '/objects') return await graph.handleObjects(ctx)
      if (route === '/families/backfill') return await family.handleFamiliesBackfill(ctx)
      if (route === '/families/manage') return await family.handleFamiliesManage(ctx)
      if (route === '/retrieval-policy') return await family.handleRetrievalPolicy(ctx)
      if (route === '/types') return await family.handleTypes(ctx)
      if (route === '/skills') return await skill.handleSkills(ctx)
      if (route === '/usage') return await handleUsage(ctx)
      if (route === '/pending') return await handlePending(ctx)
      if (route === '/verdicts') return await handleVerdicts(ctx)
      if (route === '/usage-summary') return await handleUsageSummary(ctx)
      if (route === '/recall') return await handleRecall(ctx)
      if (route === '/record') return await handleRecord(ctx)
      if (route === '/review') return await handleReview(ctx)
      if (route === '/consolidate') return await handleConsolidate(ctx)
      if (route === '/skills/import') return await skill.handleSkillsImport(ctx)
      if (route === '/skill-feedback') return await skill.handleSkillFeedback(ctx)
      if (route === '/skill-global') return await skill.handleSkillGlobal(ctx)
      if (route === '/skill-node') return await skill.handleSkillNode(ctx)
      if (route === '/skill-meta') return await skill.handleSkillMeta(ctx)
      if (route === '/skill-forget') return await skill.handleSkillForget(ctx)
      if (route === '/type') return await family.handleType(ctx)
      if (route === '/classify-diag') return await family.handleClassifyDiag(ctx)
      if (route === '/classify') return await family.handleClassify(ctx)
      if (route === '/graph') return await graph.handleGraph(ctx)
      if (route === '/shadow-report') return await graph.handleShadowReport(ctx)
      if (route === '/graph-perf') return await graph.handleGraphPerf(ctx)
      if (route === '/validate') return await handleValidate(ctx)
      if (route === '/pick-directory') return await settings.handlePickDirectory(ctx)
      if (route === '/settings') return await settings.handleSettings(ctx)
      if (route === '/sync') return await settings.handleSync(ctx)
      if (route === '/chat-save-probe') return await settings.handleChatSaveProbe(ctx)
      if (route === '/chat-save') return await settings.handleChatSave(ctx)
      if (route === '/github') return await settings.handleGithub(ctx)
      if (route === '/feedback') return await handleFeedback(ctx)
      return fail(res, 404, 'not-found', `没有这个路由：${route}`)
    } catch (error) {
      // 请求体解析失败是调用方错误，不是内部错误；否则所有坏 JSON 都会被压成 500。
      if (error instanceof SyntaxError) return fail(res, 400, 'bad-request', '请求体不是合法 JSON')
      const code = error && typeof error.code === 'string' ? error.code : 'internal'
      const message = String((error && error.message) || error)
      const status = code === 'unsupported'
        ? 501
        : code === 'read-only' || code === 'not-feedbackable'
          ? 409
        : code === 'store-unreadable'
          ? 503
        : code === 'not-found'
          ? 404
          : code === 'internal'
            ? 500
            : 400
      return fail(res, status, code, message)
    }
  }
}

export function handleIcons(ctx) {
  const { req, res, active, url, method, deps } = ctx
  if (method !== 'GET') return fail(res, 405, 'method-not-allowed', '只用 GET')
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(galleryHtml())
  return
}

export function handleHealth(ctx) {
  const { req, res, active, url, method, deps } = ctx
  if (method !== 'GET') return fail(res, 405, 'method-not-allowed', '只用 GET')
  // 客户端半加载后会带 ?client=1 回打一次：用来区分「客户端没加载」与「加载了但没注册」。
  if (url.searchParams.get('client') === '1') {
    clientProbes.push({
      at: new Date().toISOString(),
      phase: String(url.searchParams.get('phase') || ''),
      id: String(url.searchParams.get('id') || ''),
      panels: Number(url.searchParams.get('panels')) || 0,
      errors: String(url.searchParams.get('errors') || ''),
      note: String(url.searchParams.get('note') || '').slice(0, 500),
    })
    if (clientProbes.length > 8) clientProbes = clientProbes.slice(-8)
  }
  return json(res, 200, {
    ok: true,
    data: {
      ok: true,
      app: APP_NAME,
      version: pluginVersion(),
      source: active.id,
      readOnly: active.readOnly === true,
      client: clientProbes,
    },
  })
}

export function handleState(ctx) {
  const { req, res, active, url, method, deps } = ctx
  if (method !== 'GET') return fail(res, 405, 'method-not-allowed', '只用 GET')
  return json(res, 200, { ok: true, data: buildState(active) })
}

export function handleExperiences(ctx) {
  const { req, res, active, url, method, deps } = ctx
  if (method !== 'GET') return fail(res, 405, 'method-not-allowed', '只用 GET')
  return json(res, 200, { ok: true, data: buildExperiences(active, url.searchParams) })
}

export function handleExperience(ctx) {
  const { req, res, active, url, method, deps } = ctx
  if (method !== 'GET') return fail(res, 405, 'method-not-allowed', '只用 GET')
  const id = String(url.searchParams.get('id') || '').trim()
  if (id === '') return fail(res, 400, 'id-required', '缺少 id 参数')
  const detail = buildExperience(active, id)
  if (detail === null) return fail(res, 404, 'not-found', `没有这条经验：${id}`)
  return json(res, 200, { ok: true, data: detail })
}

export function handleUsage(ctx) {
  const { req, res, active, url, method, deps } = ctx
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
    chars: row.chars === undefined ? 0 : Number(row.chars) || 0,
    // 技能命中三态（0.21.0 P2）：不给白名单客户端就永远看不到。
    // session 只以 8 位短哈希落盘（内核写），这里不透传；reuseReason 同理暂不外露。
    skill: String(row.skill || ''),
    reused: String(row.reused || ''),
    bodyHash: String(row.bodyHash || ''),
  }))
  return json(res, 200, { ok: true, data: { rows } })
}

export function handlePending(ctx) {
  const { req, res, active, url, method, deps } = ctx
  if (method !== 'GET') return fail(res, 405, 'method-not-allowed', '只用 GET')
  return json(res, 200, { ok: true, data: buildPending(active) })
}

export async function handleVerdicts(ctx) {
  const { req, res, active, url, method, deps } = ctx
  if (method !== 'POST') return fail(res, 405, 'method-not-allowed', '只用 POST')
  const body = await readBody(req)
  try {
    return json(res, 200, { ok: true, data: buildVerdicts(active, body && body.verdicts) })
  } catch (error) {
    return fail(res, 400, 'verdict-failed', String((error && error.message) || error))
  }
}

export function handleUsageSummary(ctx) {
  const { req, res, active, url, method, deps } = ctx
  if (method !== 'GET') return fail(res, 405, 'method-not-allowed', '只用 GET')
  return json(res, 200, { ok: true, data: buildUsageSummary(active) })
}

export async function handleRecall(ctx) {
  const { req, res, active, url, method, deps } = ctx
  if (method !== 'POST') return fail(res, 405, 'method-not-allowed', '只用 POST')
  return json(res, 200, { ok: true, data: buildRecall(active, await readBody(req)) })
}

export async function handleRecord(ctx) {
  const { req, res, active, url, method, deps } = ctx
  if (method !== 'POST') return fail(res, 405, 'method-not-allowed', '只用 POST')
  return json(res, 200, { ok: true, data: buildRecord(active, await readBody(req)) })
}

export async function handleReview(ctx) {
  const { req, res, active, url, method, deps } = ctx
  if (method !== 'POST') return fail(res, 405, 'method-not-allowed', '只用 POST')
  return json(res, 200, { ok: true, data: buildReview(active, await readBody(req)) })
}

export async function handleConsolidate(ctx) {
  const { req, res, active, url, method, deps } = ctx
  if (method !== 'POST') return fail(res, 405, 'method-not-allowed', '只用 POST')
  return json(res, 200, { ok: true, data: buildConsolidate(active, await readBody(req)) })
}

export function handleValidate(ctx) {
  const { req, res, active, url, method, deps } = ctx
  if (method !== 'GET') return fail(res, 405, 'method-not-allowed', '只用 GET')
  return json(res, 200, { ok: true, data: buildValidate(active) })
}

export async function handleFeedback(ctx) {
  const { req, res, active, url, method, deps } = ctx
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
