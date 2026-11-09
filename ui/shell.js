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

import { readEngineConfig, readGitConfig, readSettings, readUiConfig, resolveEngramDataDir, setCurrentRoot, writeEngineConfig, writeGitConfig, writeUiConfig } from '../kernel/settings.js'
import { gitInit, gitPull, gitPush, gitStatus } from '../kernel/git-sync.js'
import { githubCreateRepo, githubLogin, githubRepos } from '../kernel/github.js'
import { pollDeviceFlow, startDeviceFlow } from '../kernel/github-device.js'

/** 客户端调用前缀（与 client.js 拼的 URL 一致）。 */
export const API_PREFIX = '/exp-ui/api'
/** 外显名；与真实经验库（exp-lib）区分开。 */
export const APP_NAME = '经验库'

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 300

/** 设置页可编辑项（全部都在这里，未知键不落盘）。 */
export const SETTINGS_SPEC = {
  config: [
    { key: 'hint', label: '每轮提示段', type: 'boolean', hint: '关闭后不再向系统提示写经验库用法', tip: '开启时，每轮系统提示里会多一段以「【经验库】」开头的说明（条数/类型目录/用法）。关掉后要重载插件才会撤掉已经注册的那一段——保存后提示段不会立刻消失。' },
    { key: 'usageLog', label: '用法日志', type: 'boolean', hint: '记录 exp_* 调用，用于使用记录页', tip: '把每次 exp_record / exp_recall / exp_feedback 的调用写进 <数据目录>/usage.jsonl，零 token 开销；关掉后「使用记录」页就没有新数据。' },
    { key: 'usageLogMaxBytes', label: '日志上限（字节）', type: 'number', tip: 'usage.jsonl 超过这个大小就轮转成 usage.jsonl.1（只保留一份旧文件）。内部有 1024 字节下限：填 1 也按 1024 生效。' },
    { key: 'feedbackEta', label: '反馈学习率 η', type: 'number', hint: '0~1，默认 0.35', tip: '每次「有帮助/没帮上」把 G 往 +1 / -1 拉的幅度。η 越大改得越快；默认 0.35。' },
    { key: 'feedbackDecayDays', label: '反馈衰减（天）', type: 'number', tip: '它不是「G 随时间自然衰减」，而是「超过天数的旧反馈事件折叠进基准 GOutcome」——折叠后 G 值不变，只是日志变短（压缩）。填 0 表示不折叠。' },
    { key: 'routing', label: '簇路由', type: 'enum', values: ['on', 'shadow', 'off'], tip: 'on：召回先用簇路由收窄候选；shadow：只记录路由结果不实际收窄（用来对比效果）；off：全库检索。' },
    { key: 'autoAssign', label: '自动归族', type: 'boolean', tip: '记录经验时没写类型，就按簇路由自动归到某个类型；关掉后一律落「未分类」。' },
    { key: 'consolidation', label: '沉淀候选', type: 'boolean', tip: '召回结果里附带一条「候选规则」：同族样本够多、且正负对照都有时才给，用来提示可以沉淀成技能。不写库、不花 token。' },
    { key: 'consolidationMinSamples', label: '沉淀最少样本', type: 'number', tip: '同族至少多少条才给「候选规则」（默认 3，且必须同时有正回报和负回报）。' },
    { key: 'induction', label: '归纳提示', type: 'boolean', tip: '召回到同族多条时，额外给一段「原料」让模型自己归纳共性；它明确写着「别当结论」，只是提示。' },
    { key: 'inductionMinSamples', label: '归纳最少样本', type: 'number', tip: '同族至少多少条才给归纳提示（默认 3）。' },
    { key: 'maxTypes', label: '类型上限', type: 'number', tip: '用户类型最多几个（不含系统「未分类」）。超限后新类型名会归到「未分类」并把原因写进 exp_record 的回执。' },
    { key: 'newTypesPerDay', label: '每日新类型上限', type: 'number', tip: '一天最多新建几个类型，防止类型爆炸；超了同样归「未分类」。' },
    { key: 'mergeThreshold', label: '类型合并阈值', type: 'number', tip: '重记一条「没写类型」的经验时，若同做法的旧经验相似度达到这个阈值，就继承它的类型。注意：类型名互相包含（如「文档写作」/「文档写作文案」）会直接合并，不受这个阈值影响。' },
    { key: 'replaceThreshold', label: '经验取代阈值', type: 'number', tip: '新记录与旧经验意图相似度达到这个阈值时，旧条标记为「被取代」（保留历史但不再参与召回）。' },
    { key: 'typeSimilarity', label: '类型相似度阈值', type: 'number', tip: '新建类型时，名字与已有类型的相似度（二元组 Jaccard）达到这个值就并入已有类型，不新建。' },
  ],
  ui: [
    { key: 'source', label: '数据源', type: 'enum', values: ['live', 'mock'], hint: 'mock 仅用于界面演示', tip: 'live：读真实经验库；mock：读内置示例数据（只用于看界面效果，不写真实库）。' },
    { key: 'dataDir', label: '目录覆盖', type: 'string', hint: '留空则用「存储位置」里的当前根', tip: '只影响「控制台读哪份库」，不影响工具写入。工具始终写到「存储位置」里的当前根；两边可以指向不同目录——看起来「数据不一致」时先来这里检查。' },
    { key: 'graphTheme', label: '关系图主题', type: 'enum', values: ['personal', 'dream', 'knowledge', 'emotion', 'spacetime', 'collective', 'inspiration'], labels: { personal: '个人记忆碎片', dream: '梦境记忆轨迹', knowledge: '知识概念关联', emotion: '情绪记忆链路', spacetime: '时空记忆时间线', collective: '集体共享记忆', inspiration: '灵感思绪蛛网' }, tip: '只改关系图的外形（布局密度、节点形状、漂移方式），不改颜色。' },
    { key: 'graphPalette', label: '关系图配色', type: 'enum', values: ['dsh', 'cyberpunk', 'aurora', 'blackgold', 'steampunk', 'qingmo', 'minimal', 'lava'], labels: { dsh: '跟随 DSH 主题', cyberpunk: '赛博朋克', aurora: '极光空灵', blackgold: '黑金科幻', steampunk: '蒸汽复古', qingmo: '青墨国风', minimal: '极简冷科技', lava: '熔岩炽热' }, tip: '默认「跟随 DSH 主题」会实时读取当前主题色（换主题自动变）；选其他配色则固定那套色。' },
    { key: 'graphRotation', label: '自动旋转速度', type: 'number', hint: '弧度/秒，0 为关闭', tip: '关系图自动旋转的速度（弧度/秒）；0 = 不转。拖动时暂停，松手继续。' },
    { key: 'graphBloom', label: '泛光 bloom', type: 'boolean', tip: '给亮节点叠一层柔光，暗色主题下更明显；关掉更省绘制。' },
    { key: 'graphGlitch', label: '色散/毛刺', type: 'boolean', tip: '给高亮节点/连线加一点 RGB 分离的故障感；关掉更干净。' },
    { key: 'graphDust', label: '浮尘数量', type: 'number', hint: '0~240', tip: '背景里漂浮的尘埃粒子数量（0~240）；太吃性能就调低。' },
  ],
  git: [
    { key: 'repoUrl', label: '远端仓库', type: 'string', hint: 'https://… 或 git@host:path 或本机绝对路径', tip: '经验库会以这个仓库为备份目标。https 推公开/私有仓库都行；地址里不要写账号密码，token 填在下面。' },
    { key: 'branch', label: '分支', type: 'string', hint: '默认 main', tip: '推送到哪个分支；不存在会自动建。' },
    { key: 'token', label: '访问 token（可选）', type: 'string', hint: '设备登录成功后自动填；也可手动贴 PAT', tip: '优先用上面的「用 GitHub 登录」（设备码，免 token）。这里只作后备：手动贴 GitHub PAT（classic 勾 repo），或设备登录后自动写入。它只存在本机 ~/.dsh/engram/settings.json，推送时走 http.extraHeader，错误信息里打码。' },
    { key: 'authorName', label: '提交作者名', type: 'string', hint: '留空用全局 git 身份', tip: '写进 commit 的作者名；留空就用你机器上的 git 全局配置。' },
    { key: 'authorEmail', label: '提交作者邮箱', type: 'string', hint: '留空用全局 git 身份', tip: '写进 commit 的邮箱；留空用全局 git 配置。' },
    { key: 'autoBackupMinutes', label: '自动备份间隔（分钟）', type: 'number', hint: '0 = 关闭；最小 15', tip: '开启后插件会按这个间隔自动 commit + push（没有改动就跳过）。0 表示只手动推送；最小 15 分钟，避免频繁推。' },
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

/** 设备码登录的临时会话（只存在内存，不落盘；成功换到 token 才写 settings）。 */
let deviceSession = null

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
        if (body && body.git !== undefined) writeGitConfig(sanitizeSettings(body.git, SETTINGS_SPEC.git))
        resetSourceCache()
        return json(res, 200, { ok: true, data: { action: 'saved' } })
      }
      if (method !== 'GET') return fail(res, 405, 'method-not-allowed', '只用 GET/POST')
      return json(res, 200, { ok: true, data: { ...buildSettings(active), config: readEngineConfig(), ui: readUiConfig(), git: readGitConfig(), spec: SETTINGS_SPEC } })
    }
    if (route === '/sync') {
      const dataDir = String((active.read && active.read().dataDir) || '').trim() || resolveEngramDataDir()
      const config = readGitConfig()
      if (method === 'GET') return json(res, 200, { ok: true, data: await gitStatus(dataDir, config) })
      if (method !== 'POST') return fail(res, 405, 'method-not-allowed', '只用 GET/POST')
      const body = await readBody(req)
      const action = String((body && body.action) || 'push').trim().toLowerCase()
      if (!['init', 'push', 'pull', 'status'].includes(action)) return fail(res, 400, 'bad-action', `未知动作：${action}`)
      if (action === 'status') return json(res, 200, { ok: true, data: await gitStatus(dataDir, config) })
      if (action === 'init') return json(res, 200, { ok: true, data: await gitInit(dataDir, config) })
      if (action === 'pull') return json(res, 200, { ok: true, data: await gitPull(dataDir, config) })
      return json(res, 200, { ok: true, data: await gitPush(dataDir, config, { message: body && body.message }) })
    }
    if (route === '/github') {
      if (method !== 'POST') return fail(res, 405, 'method-not-allowed', '只用 POST')
      const body = await readBody(req)
      const action = String((body && body.action) || 'login').trim().toLowerCase()
      // 设备码登录：不需要用户先贴 token。
      if (action === 'device-start') {
        const flow = await startDeviceFlow({ clientId: readGitConfig().oauthClientId })
        deviceSession = { deviceCode: flow.deviceCode, expiresAt: Date.now() + flow.expiresIn * 1000, interval: flow.interval }
        return json(res, 200, {
          ok: true,
          data: {
            userCode: flow.userCode,
            verificationUri: flow.verificationUri,
            expiresIn: flow.expiresIn,
            interval: flow.interval,
          },
        })
      }
      if (action === 'device-poll') {
        if (deviceSession === null) return fail(res, 400, 'github', '没有正在进行的登录：先点「用 GitHub 登录」')
        if (Date.now() > deviceSession.expiresAt) {
          deviceSession = null
          return json(res, 200, { ok: true, data: { status: 'expired' } })
        }
        const polled = await pollDeviceFlow({ deviceCode: deviceSession.deviceCode, clientId: readGitConfig().oauthClientId })
        if (polled.status === 'authorized') {
          writeGitConfig({ token: polled.token })
          deviceSession = null
          let user = null
          try {
            user = await githubLogin(polled.token)
          } catch {
            user = null
          }
          return json(res, 200, { ok: true, data: { status: 'authorized', user } })
        }
        if (polled.status === 'expired' || polled.status === 'denied') deviceSession = null
        if (polled.status === 'slow-down' && deviceSession !== null) deviceSession.interval += 5
        return json(res, 200, { ok: true, data: { status: polled.status, interval: deviceSession === null ? 0 : deviceSession.interval } })
      }
      if (action === 'device-cancel') {
        deviceSession = null
        return json(res, 200, { ok: true, data: { status: 'cancelled' } })
      }
      // 允许临时传 token（第一次登录），传了就顺手存下来，后面不用再贴。
      const provided = String((body && body.token) || '').trim()
      if (provided !== '') writeGitConfig({ token: provided })
      const git = readGitConfig()
      const token = provided !== '' ? provided : git.token
      if (!['login', 'repos', 'create', 'select'].includes(action)) return fail(res, 400, 'bad-action', `未知动作：${action}`)
      const dataDir = String((active.read && active.read().dataDir) || '').trim() || resolveEngramDataDir()
      if (action === 'login') return json(res, 200, { ok: true, data: await githubLogin(token) })
      if (action === 'repos') return json(res, 200, { ok: true, data: await githubRepos(token) })
      if (action === 'create') {
        const created = await githubCreateRepo(token, { name: body && body.name, private: body ? body.private !== false : true })
        writeGitConfig({ repoUrl: created.repo.cloneUrl, branch: created.repo.defaultBranch || git.branch })
        const nextConfig = readGitConfig()
        const init = await gitInit(dataDir, nextConfig)
        if (!init.ok) return json(res, 200, { ok: true, data: { action: 'create', repo: created.repo, init, sync: null } })
        const sync = await gitPush(dataDir, nextConfig, { message: body && body.message })
        return json(res, 200, { ok: true, data: { action: 'create', repo: created.repo, init, sync } })
      }
      // select：选中已有仓库 → 存地址 + 初始化 + 推送
      const repoUrl = String((body && body.repoUrl) || '').trim()
      if (repoUrl === '') return fail(res, 400, 'repo-required', '缺少 repoUrl')
      writeGitConfig({ repoUrl })
      const nextConfig = readGitConfig()
      const init = await gitInit(dataDir, nextConfig)
      const sync = init.ok ? await gitPush(dataDir, nextConfig, { message: body && body.message }) : null
      return json(res, 200, { ok: true, data: { action: 'select', repoUrl, init, sync } })
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
