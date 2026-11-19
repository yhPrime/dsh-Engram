/**
 * 标签排序影子（P1 · 类型路由影子对比，只计算、不改默认召回）。
 *
 * 做什么：给定意图，从词表抽 queryTags，再按经验的标签覆盖度给候选排序。
 * 不做什么：
 *  - 不参与默认召回排序/过滤（只有 exp_recall 的 tagShadow=true 才计算）；
 *  - 不看经验的 typeId / typeName（类型完全不参与），用于和簇路由做对照；
 *  - 不改 G / Â / outcome / lifecycle，只读。
 *
 * 权重来自计划书 §5：动作 0.55 + 主题 0.30 + 对象 0.15；覆盖度在「查询实际带的面」上归一。
 * 质量分只复用现有 G（归一成 0..1），不写回历史；stale 经验照算但标注 stale。
 */
import { lifecycleOf } from './retrieval.js'
import { canonicalTag, readStore, readUsage, visibleExperiences } from './store.js'
import { ensureTagOverrides, extractQueryTags, facetOf, TAG_FACETS } from './tag-registry.js'

/** 面权重（总和 1）：动作 > 主题 > 对象。 */
// 0.32：对象面退出检索排序（用户拍板：对象另有他用，不参与标签/排序）。
export const TAG_FACET_WEIGHTS = Object.freeze({ action: 0.55, topic: 0.30, object: 0 })
/** 质量分在总分里的占比：score = coverage × (0.70 + 0.30 × quality)。 */
export const TAG_QUALITY_FLOOR = 0.70
export const TAG_QUALITY_SPAN = 0.30
/** 默认返回几条。 */
export const TAG_TOPN_DEFAULT = 5

const WEIGHTED_FACETS = ['action', 'topic', 'object']

function round4(value) {
  return Math.round(Number(value) * 1e4) / 1e4
}

/** 把任意来源的 queryTags 归成固定四面；别名统一成规范名，去重。 */
function normalizeQueryTags(input) {
  const out = { object: [], action: [], topic: [], quality: [] }
  for (const facet of TAG_FACETS) {
    const list = Array.isArray(input && input[facet]) ? input[facet] : []
    for (const value of list) {
      const name = canonicalTag(value)
      if (name === null) continue
      if (!out[facet].some((existing) => existing.toLowerCase() === name.toLowerCase())) out[facet].push(name)
    }
  }
  return out
}

/** 一条经验的标签集合（读时归一，不写回）。 */
function tagsOf(row) {
  const tags = []
  for (const value of Array.isArray(row && row.context) ? row.context : []) {
    const name = canonicalTag(value)
    if (name === null) continue
    if (!tags.some((existing) => existing.toLowerCase() === name.toLowerCase())) tags.push(name)
  }
  return tags
}

/** G 归一成 0..1 的质量分；没有 G 用 GOutcome，都没有按中性 0.5。 */
function qualityOf(row) {
  const raw = Number.isFinite(Number(row && row.G))
    ? Number(row.G)
    : (Number.isFinite(Number(row && row.GOutcome)) ? Number(row.GOutcome) : 0)
  return round4((Math.max(-1, Math.min(1, raw)) + 1) / 2)
}

/**
 * 标签覆盖度：按动作/主题/对象三面加权，只在「查询命中的面」上归一。
 * 质量面不参与权重（质量由 G 归一体现），但命中的质量标签仍记进 matchedTags。
 */
function coverageOf(tags, queryTags) {
  const tagSet = new Set(tags.map((tag) => tag.toLowerCase()))
  let weighted = 0
  let totalWeight = 0
  for (const facet of WEIGHTED_FACETS) {
    const wanted = queryTags[facet]
    if (wanted.length === 0) continue
    const weight = TAG_FACET_WEIGHTS[facet]
    totalWeight += weight
    const matched = wanted.filter((name) => tagSet.has(name.toLowerCase())).length
    weighted += weight * (matched / wanted.length)
  }
  return totalWeight === 0 ? 0 : round4(weighted / totalWeight)
}

function matchedAndMissing(tags, queryTags) {
  const tagSet = new Set(tags.map((tag) => tag.toLowerCase()))
  const matched = []
  const missing = []
  // 顺序固定：动作 → 主题 → 对象 → 质量，便于稳定对比/测试。
  for (const facet of ['action', 'topic', 'object', 'quality']) {
    for (const name of queryTags[facet]) {
      if (tagSet.has(name.toLowerCase())) matched.push(name)
      else missing.push(name)
    }
  }
  return { matched, missing }
}

/**
 * 按标签给可见经验排序（影子用，不写库）。
 * @param {object} store - 聚合后的 store（`{types, experiences}`）
 * @param {string} intent - 当前任务意图
 * @param {{limit?: number, queryTags?: object}} [options]
 * @returns {{queryTags: object, top: object[], total: number, note?: string}}
 */
export function rankByTags(store, intent, options = {}) {
  const queryTags = normalizeQueryTags(options.queryTags || extractQueryTags(intent))
  const limit = Math.max(1, Math.min(50, Math.trunc(Number(options.limit) || TAG_TOPN_DEFAULT)))
  // 只有权重 > 0 的面才算「有加权查询」：对象面 0.32 起权重为 0，不能让它把全 0 分值伪装成排序结果。
  const weightedQuery = WEIGHTED_FACETS.some((facet) => TAG_FACET_WEIGHTS[facet] > 0 && queryTags[facet].length > 0)
  if (!weightedQuery) {
    return {
      queryTags,
      top: [],
      total: 0,
      // 只命中不计权重的面（对象权重 0、质量面永不加权）时，不能说「没命中标签」。
      note: (() => {
        const zeroFacets = Object.keys(queryTags).filter((facet) => queryTags[facet].length > 0 && !(TAG_FACET_WEIGHTS[facet] > 0))
        if (zeroFacets.length === 0) return '意图里没有命中动作/主题/对象标签，标签影子排序为空（只影响影子，不影响默认召回）。'
        const labels = { object: '对象', quality: '质量' }
        return `只命中了不计权重的${zeroFacets.map((facet) => labels[facet] || facet).join('/')}标签，加权查询为空（只影响影子，不影响默认召回）。`
      })(),
    }
  }
  const rows = visibleExperiences(store)
  const scored = []
  for (const row of rows) {
    const tags = tagsOf(row)
    if (tags.length === 0) continue
    const { matched, missing } = matchedAndMissing(tags, queryTags)
    if (matched.length === 0) continue
    const coverage = coverageOf(tags, queryTags)
    const quality = qualityOf(row)
    const lifecycle = lifecycleOf(row)
    scored.push({
      id: String(row.id || ''),
      intent: String(row.intent || ''),
      action: String(row.action || ''),
      coverage,
      quality,
      score: round4(coverage * (TAG_QUALITY_FLOOR + TAG_QUALITY_SPAN * quality)),
      matchedTags: matched,
      missingTags: missing,
      lifecycle,
      stale: lifecycle === 'stale',
      lastSeenAt: String(row.lastSeenAt || row.ts || ''),
    })
  }
  scored.sort((left, right) => (
    right.score - left.score
    || right.coverage - left.coverage
    || right.quality - left.quality
    || String(right.lastSeenAt).localeCompare(String(left.lastSeenAt))
    || String(left.id).localeCompare(String(right.id))
  ))
  return {
    queryTags,
    top: scored.slice(0, limit),
    total: scored.length,
  }
}

/**
 * P0 影子判据报表（0.25.0，只读）。
 *
 * 数据全部来自现成的东西：`usage.jsonl` 里 0.21.3 起落的 `shadow{overlapAt5}`、
 * 0.25.0 起落的 `shadow.tagRankApplied`，以及库本身的标签覆盖度——不新增埋点、不写盘。
 *
 * @returns {{samples:number, overlapMedian:number|null, tagRankSamples:number, coverage:{visible:number, objectAction:number, noTags:number, ratio:number|null}, thresholds:object}}
 */
export function shadowReport(dataDir) {
  const dir = String(dataDir === undefined || dataDir === null ? '' : dataDir).trim()
  if (dir === '') {
    return {
      samples: 0,
      overlapMedian: null,
      overlapRatio: null,
      tagRankSamples: 0,
      tagHitRate: null,
      tagReadyRate: null,
      coverage: { visible: 0, objectAction: 0, noTags: 0, ratio: null },
      thresholds: { samples: 20, overlap: 0.6, coverage: 0.8 },
      noDataDir: true,
    }
  }
  // 报表要按自己的目录加载词表：否则覆盖率随「上一次 exp_recall 加载过哪个目录」漂移。
  try {
    ensureTagOverrides(dir)
  } catch {
    // 词表读坏时按内建词表算，报表不抛错。
  }
  const rows = readUsage(dir, 5000)
  const overlaps = []
  let overlapping = 0
  let tagRankSamples = 0
  let tagReady = 0
  for (const row of Array.isArray(rows) ? rows : []) {
    const shadow = row && row.shadow
    if (shadow === null || typeof shadow !== 'object') continue
    // 只认 0–5 的真数字：null/''/false 以前会被 Number() 当 0（虚增样本、拉低中位数），越界值会把比例推出 0–1。
    const overlap = shadow.overlapAt5
    if (typeof overlap === 'number' && Number.isFinite(overlap) && overlap >= 0 && overlap <= 5) {
      overlaps.push(overlap)
      if (overlap > 0) overlapping += 1
    }
    // 只有「非 null、非数组的对象」才算一条影子样本：null/字符串/数字/数组都是坏行，跳过。
    if (shadow.tagRankApplied !== null && typeof shadow.tagRankApplied === 'object' && !Array.isArray(shadow.tagRankApplied)) {
      tagRankSamples += 1
      if (Array.isArray(shadow.tagRankApplied.queryTags) && shadow.tagRankApplied.queryTags.length > 0) tagReady += 1
    }
  }
  const sorted = overlaps.slice().sort((left, right) => left - right)
  const overlapMedian = sorted.length === 0
    ? null
    : (sorted.length % 2 === 1
      ? sorted[(sorted.length - 1) / 2]
      : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2)
  const coverage = { visible: 0, objectAction: 0, noTags: 0, ratio: null }
  let storeError = ''
  try {
    const visible = visibleExperiences(readStore(dir))
    coverage.visible = visible.length
    for (const row of visible) {
      const tags = Array.isArray(row.context) ? row.context : []
      if (tags.length === 0) coverage.noTags += 1
      const facets = new Set(tags.map((tag) => facetOf(tag)).filter((facet) => facet !== null))
      if (facets.has('object') && facets.has('action')) coverage.objectAction += 1
    }
    coverage.ratio = coverage.visible === 0 ? null : round4(coverage.objectAction / coverage.visible)
  } catch (error) {
    // 坏库要能区分「读不出来」和「覆盖率 0」：带上 storeError，别把丢了显示成没有。
    storeError = String((error && error.message) || error)
  }
  return {
    samples: overlaps.length,
    // overlapAt5 是「交集条数（0–5）」：中位数要除以 5 才能和阈值 0.6 比，别拿条数直接比。
    overlapMedian,
    overlapRatio: overlapMedian === null ? null : round4(overlapMedian / 5),
    tagRankSamples,
    // 标签命中率：标签排序与类型路由 Top5 有交集的样本占比；标签可用率：抽得出标签的 shadow 样本占比。
    tagHitRate: overlaps.length === 0 ? null : round4(overlapping / overlaps.length),
    tagReadyRate: tagRankSamples === 0 ? null : round4(tagReady / tagRankSamples),
    coverage,
    thresholds: { samples: 20, overlap: 0.6, coverage: 0.8 },
    ...(storeError === '' ? {} : { storeError }),
  }
}