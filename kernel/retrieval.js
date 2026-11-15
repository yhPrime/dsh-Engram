/**
 * 召回层 v2：面向「中文短意图」的邻居检索。
 *
 * 与 kernel.js 的分工（重要，别再混）：
 *  - kernel.js 保持与 `jitrl_memory.py` 的逐字段对拍（论文数学：V̂ / Q̂ / Â / 乐观封顶），
 *    它的 `retrieve()` 仍用对称 Jaccard，用于黄金样例回归；
 *  - 本文件只回答「哪些历史条目算邻居、相似度怎么算」，不改 Â 公式。
 *
 * 为什么需要 v2（2026-10-29 实测）：
 *  对称 Jaccard 拿 5 个 token 的短意图去比 12+ token 的长 intent，分母被稀释，
 *  「做个研学课 PPT」过阈 0/17（最强 0.0375 < 0.05），只有近乎照抄库内长句才召得回。
 *  另外 artifact 只做字面包含：`ppt` ≠ `pptx`，`任务单` 根本不在旧表里。
 *
 * v2 的两处实质改动：
 *  1. 相似度里加「查询覆盖率」|Q∩D|/|Q|，短查询不再被长文档惩罚；
 *  2. artifact 归到语义组（ppt / doc / sheet / code …），`pptx`、`幻灯片`、`课件` 都算 ppt。
 */

import { abstractState, jaccard } from './kernel.js'

/* -------------------------------------------------------------------------- */
/* 时效治理（0.20 P0）：易腐层 / 新鲜度 / 生命周期 / 适用性                       */
/* -------------------------------------------------------------------------- */

/** 易腐层（计划书 §3.1）：只影响召回门控与展示，不改 G/Â。 */
export const VOLATILITY_LEVELS = Object.freeze(['stable', 'semi', 'perishable'])
/** 旧经验缺字段时按 semi 解释（计划书 §4.3）。 */
export const DEFAULT_VOLATILITY = 'semi'
/** 技能比经验更易腐（计划书 §7.1）：旧技能缺字段时按 perishable 解释。 */
export const DEFAULT_SKILL_VOLATILITY = 'perishable'
/** 半衰期（天）：freshness = 0.5 ^ (ageDays / halfLife)。 */
export const HALF_LIFE_DAYS = Object.freeze({ stable: 1095, semi: 180, perishable: 45 })
/** stale 候选的排序降权系数（计划书 §5.4）。 */
export const STALE_RANK_FACTOR = 0.55
/** applicability=partial（只有部分条件匹配）的降权系数。 */
export const PARTIAL_RANK_FACTOR = 0.85
/** 新鲜度在排序里的权重：rank = base × (0.70 + 0.30 × freshness)。 */
export const FRESHNESS_RANK_FLOOR = 0.70
export const FRESHNESS_RANK_SPAN = 0.30
/** 给模型的一句话：旧经验是参考，不是命令（计划书 §5.5）。 */
export const LIFECYCLE_NOTE = '历史经验，可能已过时；条件不匹配时直接忽略，不要为了遵守它牺牲更好的方案。'

const DAY_MS = 86400000

/** 归一化易腐层：非法值返回 ''（调用方决定默认值）。 */
export function normalizeVolatility(value) {
  const text = String(value === undefined || value === null ? '' : value).trim().toLowerCase()
  return VOLATILITY_LEVELS.includes(text) ? text : ''
}

/** 归一化 ISO 时间：非法/空返回 null（不把猜测写成时间）。 */
export function normalizeIsoDate(value) {
  if (value === undefined || value === null) return null
  const text = String(value).trim()
  if (text === '') return null
  const time = Date.parse(text)
  return Number.isFinite(time) ? new Date(time).toISOString() : null
}

/** 归一化适用范围 `{ models, tools, environment }`；全空返回 null（=未声明）。 */
export function normalizeAppliesTo(value) {
  if (value === null || value === undefined) return null
  const raw = typeof value === 'object' && !Array.isArray(value) ? value : {}
  const listOf = (input) => {
    const raw = Array.isArray(input) ? input : (typeof input === 'string' && input.trim() !== '' ? [input] : [])
    return raw.map((item) => String(item).trim()).filter((item) => item !== '').slice(0, 12)
  }
  const models = listOf(raw.models)
  const tools = listOf(raw.tools)
  const environment = String(raw.environment === undefined || raw.environment === null ? '' : raw.environment).trim().slice(0, 120)
  if (models.length === 0 && tools.length === 0 && environment === '') return null
  return { models, tools, environment }
}

export function volatilityOf(row) {
  return normalizeVolatility(row && row.volatility) || DEFAULT_VOLATILITY
}

export function lastVerifiedOf(row) {
  return normalizeIsoDate(row && row.lastVerifiedAt)
}

/**
 * 新鲜度锚点：lastVerifiedAt → lastSeenAt → ts/registeredAt/lastUsedAt。
 * 没有 lastVerifiedAt 不等于「已验证」：只有锚点，用来算「多久没确认过」。
 */
export function freshnessAnchorOf(row) {
  const raw = row && (row.lastVerifiedAt || row.lastSeenAt || row.ts || row.registeredAt || row.lastUsedAt)
  const time = Date.parse(String(raw || ''))
  return Number.isFinite(time) ? time : NaN
}

/** 建议复核时间：显式 reviewAfter 优先；否则 锚点 + 半衰期（读时推算，不写回）。 */
export function reviewAfterOf(row) {
  const explicit = normalizeIsoDate(row && row.reviewAfter)
  if (explicit !== null) return explicit
  const anchor = freshnessAnchorOf(row)
  if (!Number.isFinite(anchor)) return null
  return new Date(anchor + HALF_LIFE_DAYS[volatilityOf(row)] * DAY_MS).toISOString()
}

/** 新鲜度 0–1：半衰期指数衰减（计划书 §5.4）。 */
export function freshnessOf(row, options = {}) {
  const anchor = freshnessAnchorOf(row)
  if (!Number.isFinite(anchor)) return 1
  const now = options.now instanceof Date ? options.now.getTime() : (Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now())
  const ageDays = Math.max(0, (now - anchor) / DAY_MS)
  const halfLife = HALF_LIFE_DAYS[volatilityOf(row)] || HALF_LIFE_DAYS[DEFAULT_VOLATILITY]
  return Math.round((0.5 ** (ageDays / halfLife)) * 1e4) / 1e4
}

/** 是否到期待复核：显式 stale_at 也算；否则按 reviewAfter 是否已过。 */
export function reviewDueOf(row, options = {}) {
  if (row && row.stale_at) return true
  const reviewAfter = reviewAfterOf(row)
  if (reviewAfter === null) return false
  const now = options.now instanceof Date ? options.now.getTime() : (Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now())
  return Date.parse(reviewAfter) <= now
}

/**
 * 生命周期状态：deleted > superseded > retired > stale > active。
 * retired_at / superseded_by 语义不变，新字段不覆盖它们（计划书 §4.3）。
 */
export function lifecycleOf(row, options = {}) {
  if (!row || typeof row !== 'object') return 'deleted'
  if (row.deleted_at) return 'deleted'
  if (row.superseded_by) return 'superseded'
  if (row.retired_at) return 'retired'
  if (reviewDueOf(row, options)) return 'stale'
  return 'active'
}

function normalizeCurrentPart(list) {
  return (Array.isArray(list) ? list : []).map((item) => String(item).trim().toLowerCase()).filter((item) => item !== '')
}

/**
 * 适用性：unscoped（未声明/当前环境不可比）| match | partial | mismatch。
 * 当前环境信息拿不到时一律 unscoped——不硬拦，也不假装匹配过。
 */
export function applicabilityOf(row, current = {}) {
  const appliesTo = normalizeAppliesTo(row && row.appliesTo)
  if (appliesTo === null) return 'unscoped'
  const currents = {
    models: normalizeCurrentPart(current && current.models),
    tools: normalizeCurrentPart(current && current.tools),
    environment: String((current && current.environment) || '').trim().toLowerCase(),
  }
  let compared = 0
  let matched = 0
  let mismatched = 0
  if (appliesTo.models.length > 0 && currents.models.length > 0) {
    compared += 1
    if (appliesTo.models.some((item) => currents.models.includes(item.toLowerCase()))) matched += 1
    else mismatched += 1
  }
  if (appliesTo.tools.length > 0 && currents.tools.length > 0) {
    compared += 1
    if (appliesTo.tools.some((item) => currents.tools.includes(item.toLowerCase()))) matched += 1
    else mismatched += 1
  }
  if (appliesTo.environment !== '' && currents.environment !== '') {
    compared += 1
    if (appliesTo.environment.toLowerCase() === currents.environment) matched += 1
    else mismatched += 1
  }
  if (compared === 0) return 'unscoped'
  if (mismatched === 0) return 'match'
  return matched > 0 ? 'partial' : 'mismatch'
}

/**
 * 一条记录的时效视图（读时计算，绝不写回；旧记录缺字段就是默认值）。
 * @param {object} row - 经验行或技能 meta。
 * @param {{now?: Date|number, current?: object}} [options]
 */
export function lifecycleMetaOf(row, options = {}) {
  const now = options.now
  return {
    lifecycle: lifecycleOf(row, { now }),
    volatility: volatilityOf(row),
    freshness: freshnessOf(row, { now }),
    lastVerifiedAt: lastVerifiedOf(row),
    reviewAfter: reviewAfterOf(row),
    reviewDue: reviewDueOf(row, { now }),
    applicability: applicabilityOf(row, options.current),
    appliesTo: normalizeAppliesTo(row && row.appliesTo),
    staleAt: normalizeIsoDate(row && row.stale_at),
    staleReason: String((row && row.stale_reason) || ''),
    reviewNote: String((row && row.review_note) || ''),
    retiredAt: normalizeIsoDate(row && row.retired_at),
    retiredReason: String((row && row.retired_reason) || ''),
  }
}

/** 召回门控权重：stale ×0.55，partial ×0.85；active/match 不降权。 */
export function lifecycleWeightOf(meta) {
  if (meta === null || meta === undefined) return 1
  const stale = meta.lifecycle === 'stale' ? STALE_RANK_FACTOR : 1
  const partial = meta.applicability === 'partial' ? PARTIAL_RANK_FACTOR : 1
  return stale * partial
}

/**
 * artifact 语义组：组内任一别名命中即算该组。
 * 顺序无关；一个文本可命中多组（如「PPT 课件」命中 ppt）。
 */
export const ARTIFACT_GROUPS = Object.freeze({
  ppt: ['ppt', 'pptx', '幻灯片', '演示文稿', '课件', '汇报'],
  doc: ['doc', 'docx', 'word', '文档', '教案', '讲义', '任务单', '任务卡', '学习单', '记录单'],
  sheet: ['xls', 'xlsx', 'excel', 'csv', '表格', '报表', '数据表'],
  pdf: ['pdf'],
  code: ['代码', '脚本', '插件', '程序', '固件', 'js', 'ts', 'py', 'python', 'node'],
  html: ['html', '网页', '网站', 'h5'],
  image: ['图片', '图标', '海报', '视觉'],
  web: ['抓取', '爬取', '浏览器'],
  robot: ['机器人', '动作', 'aelos', '舞蹈'],
  git: ['git', 'github', '仓库', '分支', '提交'],
  env: ['沙箱', '环境', '部署', '安装', '依赖'],
})

/** 相似度权重：覆盖率占主导，保证短意图召得回；artifact 命中几乎等于定了类型。 */
export const SIMILARITY_WEIGHTS = Object.freeze({
  coverage: 0.4,
  jaccard: 0.25,
  artifact: 0.2,
  bigram: 0.15,
})

/** 邻居门槛：低于它的条目直接不参与估计（0.12 由 12 条自然意图 + 5 条噪声意图标定）。 */
export const RECALL_MIN_SIMILARITY = 0.12

/** 文本 → artifact 语义组。 */
export function canonicalArtifacts(text) {
  const lowered = String(text || '').toLowerCase()
  const found = []
  for (const [group, aliases] of Object.entries(ARTIFACT_GROUPS)) {
    if (aliases.some((alias) => lowered.includes(alias))) found.push(group)
  }
  return found.sort()
}

/** 文本 → 检索状态（tokens / cgrams 用 kernel 的分词，artifacts 用语义组）。 */
export function stateOf(intent, action = '') {
  const text = `${intent || ''} ${action || ''}`
  const base = abstractState(text)
  return {
    tokens: base.tokens,
    cgrams: base.cgrams,
    artifacts: canonicalArtifacts(text),
  }
}

function mainSet(state) {
  const set = new Set()
  for (const token of state.tokens || []) set.add(`t:${token}`)
  for (const artifact of state.artifacts || []) set.add(`a:${artifact}`)
  return set
}

function intersectionSize(left, right) {
  let count = 0
  for (const item of left) if (right.has(item)) count += 1
  return count
}

/** v2 相似度：0.4 查询覆盖 + 0.25 对称 Jaccard + 0.2 artifact 覆盖 + 0.15 二元组 Jaccard。 */
export function similarityV2(query, candidate) {
  const qMain = mainSet(query || {})
  const cMain = mainSet(candidate || {})
  if (qMain.size === 0 && cMain.size === 0) return 0
  const shared = intersectionSize(qMain, cMain)
  const coverage = qMain.size === 0 ? 0 : shared / qMain.size
  const symmetric = jaccard(qMain, cMain)

  const qArtifacts = new Set(query.artifacts || [])
  const cArtifacts = new Set(candidate.artifacts || [])
  const artifact = qArtifacts.size === 0 ? 0 : intersectionSize(qArtifacts, cArtifacts) / qArtifacts.size

  const gram = jaccard(new Set(query.cgrams || []), new Set(candidate.cgrams || []))
  const w = SIMILARITY_WEIGHTS
  return w.coverage * coverage + w.jaccard * symmetric + w.artifact * artifact + w.bigram * gram
}

/**
 * 是否共享「有信息量」的信号：中文二元组、artifact 组、或 2 字符以上的拉丁词。
 *
 * 只共享单个汉字不算（如「翻译一段英文合同」与史实条目共享「一/段」），
 * 否则短查询会靠虚词拼出一个假分数（实测 0.215，虽过阈值但明显不相关）。
 */
export function sharesSignal(query, candidate) {
  const qArtifacts = new Set(query.artifacts || [])
  if ((candidate.artifacts || []).some((artifact) => qArtifacts.has(artifact))) return true
  const cGrams = new Set(candidate.cgrams || [])
  if ((query.cgrams || []).some((gram) => cGrams.has(gram))) return true
  const cTokens = new Set((candidate.tokens || []).filter((token) => token.length >= 2))
  return (query.tokens || []).some((token) => token.length >= 2 && cTokens.has(token))
}

/**
 * 取与 intent 最相似的 k 条历史经验。
 * @param {object[]} experiences - 可见经验。
 * @param {string} intent - 当前任务意图。
 * @param {{k?: number, minSimilarity?: number}} [options]
 * @returns {Array<{experience: object, similarity: number}>}
 */
export function retrieveV2(experiences, intent, options = {}) {
  const list = Array.isArray(experiences) ? experiences : []
  if (list.length === 0) return []
  const k = Math.max(1, Math.trunc(Number(options.k) || 8))
  const minSimilarity = Number.isFinite(Number(options.minSimilarity))
    ? Number(options.minSimilarity)
    : RECALL_MIN_SIMILARITY
  const query = stateOf(intent)
  const scored = []
  for (const experience of list) {
    const candidate = stateOf(experience.intent, experience.action)
    const similarity = similarityV2(query, candidate)
    if (similarity >= minSimilarity && sharesSignal(query, candidate)) scored.push({ experience, similarity })
  }
  scored.sort((left, right) => (
    right.similarity - left.similarity
    || String(right.experience.ts || '').localeCompare(String(left.experience.ts || ''))
    || String(left.experience.id).localeCompare(String(right.experience.id))
  ))
  return scored.slice(0, k)
}
