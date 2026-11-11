/**
 * 回执瘦身与计量。
 *
 * 目标：模型读到的每个字都要换来判断力。省 token 的三处：
 *   ① 去重复：candidate 的 action 与每条 evidence 的 action 是同一段文字；
 *   ② 去无效：note 截 300 等于没截、空字段照发、同一件事的多个度量字段；
 *   ③ 改按需：默认只回 2 条候选，要细节用 detail:true，要多条显式给 limit。
 *
 * 信息不删：detail:true 返回原始 payload。
 */

const CUT_NOTE = 200
const CUT_BRIEF = 120
const CUT_INTENT = 60
const CUT_ACTION = 100
const CUT_TEXT = 240

function cut(text, max) {
  const value = String(text === undefined || text === null ? '' : text).replace(/\s+/gu, ' ').trim()
  if (value === '') return ''
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`
}

function round(value, digits = 4) {
  const number = Number(value)
  if (!Number.isFinite(number)) return undefined
  const scale = 10 ** digits
  return Math.round(number * scale) / scale
}

/** 序列化长度（token 计量的近似口径：字符数）。 */
export function measure(value) {
  try {
    const text = JSON.stringify(value)
    return typeof text === 'string' ? text.length : 0
  } catch {
    return 0
  }
}

/** 递归去掉 null/undefined/空字符串/空数组/空对象，保留 false 与 0（它们有语义）。 */
export function compact(value) {
  if (Array.isArray(value)) return value.map((item) => compact(item)).filter((item) => item !== undefined)
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [key, raw] of Object.entries(value)) {
      const next = compact(raw)
      if (next === undefined) continue
      if (Array.isArray(next) && next.length === 0) continue
      out[key] = next
    }
    return Object.keys(out).length === 0 ? undefined : out
  }
  if (value === null || value === undefined || value === '') return undefined
  return value
}

function slimEvidence(evidence, first) {
  if (evidence === null || typeof evidence !== 'object') return null
  const out = {
    id: evidence.id,
    outcome: evidence.outcome,
    G: round(evidence.G),
    similarity: round(evidence.similarity),
  }
  // 同一候选的第 2 条证据只留可比较的最小字段（谁、结果、分数），细节看首条；
  // 但生命周期要带上——它正是「这条被取代/退休过」的提示。
  if (first !== true) {
    if (evidence.typeName) out.typeName = evidence.typeName
    if (evidence.stepIndex !== undefined && evidence.stepIndex !== null) out.stepIndex = evidence.stepIndex
    if (evidence.lifecycle !== undefined) out.lifecycle = evidence.lifecycle
    return compact(out)
  }
  if (evidence.typeName) out.typeName = evidence.typeName
  // 做法在候选级已经出现过，evidence 不再重复；只有首条带意图，便于对齐。
  if (first === true) {
    if (evidence.intent) out.intent = cut(evidence.intent, CUT_INTENT)
  }
  const note = cut(evidence.note, CUT_NOTE)
  if (note !== '') out.note = note
  if (evidence.context !== undefined) out.context = evidence.context
  if (evidence.dimensions !== undefined) out.dimensions = evidence.dimensions
  if (evidence.contextMatch !== undefined) out.contextMatch = evidence.contextMatch
  if (evidence.lifecycle !== undefined) out.lifecycle = evidence.lifecycle
  if (evidence.retrievals !== undefined && Number(evidence.retrievals) > 0) out.retrievals = Number(evidence.retrievals)
  if (evidence.taskId !== undefined && evidence.taskId !== evidence.id) out.taskId = evidence.taskId
  if (evidence.stepIndex !== undefined && evidence.stepIndex !== null) out.stepIndex = evidence.stepIndex
  if (evidence.stepTotal !== undefined && evidence.stepTotal !== null) out.stepTotal = evidence.stepTotal
  if (evidence.failedStep !== undefined && evidence.failedStep !== null) out.failedStep = evidence.failedStep
  if (evidence.expectedG !== undefined && evidence.expectedG !== null) {
    out.expectedG = evidence.expectedG
    out.predictionError = evidence.predictionError
  }
  const feedback = evidence.feedback
  if (feedback !== null && typeof feedback === 'object') {
    const helped = Number(feedback.helped) || 0
    const hurt = Number(feedback.hurt) || 0
    const neutral = Number(feedback.neutral) || 0
    if (helped + hurt + neutral > 0) {
      out.feedback = { helped, hurt, neutral, ...(feedback.window !== undefined ? { window: Number(feedback.window) || 0 } : {}) }
    }
  }
  if (evidence.kind === 'step') {
    out.kind = 'step'
    if (evidence.stepIndex !== null && evidence.stepIndex !== undefined) out.stepIndex = evidence.stepIndex
    if (evidence.stepTotal !== null && evidence.stepTotal !== undefined) out.stepTotal = evidence.stepTotal
    if (evidence.failedStep !== null && evidence.failedStep !== undefined) out.failedStep = evidence.failedStep
  }
  return compact(out)
}

function slimCandidate(candidate, index) {
  if (candidate === null || typeof candidate !== 'object') return null
  const out = {
    action: cut(candidate.action, CUT_ACTION),
    advantage: round(candidate.advantage),
    support: Number(candidate.support) || 0,
  }
  if (candidate.typeName) out.typeName = candidate.typeName
  if (candidate.mean_similarity !== undefined) out.mean_similarity = round(candidate.mean_similarity)
  if (candidate.contextMatch !== undefined) out.contextMatch = candidate.contextMatch
  const evidence = Array.isArray(candidate.evidence) ? candidate.evidence : []
  const kept = evidence.slice(0, 1)
  // 额外证据先保「正负对照」与「带生命周期」的（判断必需），再按顺序补到最多 4 条；
  // 新记的条常常排在后面，截太狠等于没记（行为模拟实测）。
  const rest = evidence.slice(1)
  const firstNegative = (Number((evidence[0] || {}).G) || 0) < 0
  const contrast = rest.find((item) => ((Number(item.G) || 0) < 0) !== firstNegative)
  const lifecycle = rest.find((item) => item.lifecycle !== undefined)
  for (const extra of [contrast, lifecycle]) {
    if (extra !== undefined && !kept.includes(extra)) kept.push(extra)
  }
  for (const extra of rest) {
    if (kept.length >= 4) break
    if (!kept.includes(extra)) kept.push(extra)
  }
  out.evidence = kept
    .map((item, itemIndex) => slimEvidence(item, itemIndex === 0))
    .filter((item) => item !== null && item !== undefined)
  return out
}

/**
 * 召回回执瘦身。
 * @param {object} payload - rankExperiences 的原始返回
 * @param {{limit?: number, detail?: boolean}} [options]
 */
export function slimRecall(payload, options = {}) {
  if (payload === null || typeof payload !== 'object') return payload
  if (options.detail === true) return payload
  const limit = Math.max(1, Math.min(8, Math.trunc(Number(options.limit) || 2)))
  const out = {}
  if (payload.intent) out.intent = cut(payload.intent, CUT_TEXT)
  out.mode = payload.mode
  if (payload.degenerate === true) out.degenerate = true
  if (payload.weak === true) {
    out.weak = true
    if (payload.topSimilarity !== undefined) out.topSimilarity = payload.topSimilarity
  }
  const brief = cut(payload.brief, CUT_BRIEF)
  if (brief !== '') out.brief = brief
  const note = cut(payload.note, CUT_NOTE)
  if (note !== '') out.note = note
  const warning = cut(payload.warning, CUT_TEXT)
  if (warning !== '') out.warning = warning
  // 簇路由只留三样（name / score / fallback）：整块 route 有 200+ 字符，模型用不到细节。
  const route = payload.route
  if (route !== null && typeof route === 'object') {
    const mini = {}
    if (typeof route.name === 'string' && route.name !== '') mini.name = route.name
    if (route.score !== undefined) mini.score = round(route.score)
    if (route.fallback !== undefined) mini.fallback = route.fallback === true
    if (Object.keys(mini).length > 0) out.route = mini
  }
  const candidates = Array.isArray(payload.candidates) ? payload.candidates.slice(0, limit) : []
  out.candidates = candidates.map(slimCandidate).filter((item) => item !== null)
  if (Array.isArray(payload.recent) && payload.recent.length > 0) out.recent = payload.recent.slice(0, 2)
  if (payload.consolidated !== undefined) out.consolidated = payload.consolidated
  const slim = compact(out)
  // candidates 必须始终存在（空数组也留），调用方会按 candidates[0] 取首条。
  const result = slim === undefined ? {} : slim
  if (!Array.isArray(result.candidates)) result.candidates = []
  return result
}

/** 任意回执的瘦身（去空字段），用于 exp_record / exp_feedback 的返回。 */
export function slimReceipt(receipt) {
  return compact(receipt)
}
