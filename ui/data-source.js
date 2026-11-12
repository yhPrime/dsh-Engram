/**
 * exp-ui — 数据源无关的纯函数层。
 *
 * 这里的函数只认一个内存里的 `store` 结构（与真实经验库的
 * `<dataDir>/exp-lib.json` 同形：`{ version, types[], experiences[] }`），
 * 不碰 fs、不碰 HTTP。mock（内置示例数据）和 live（读真实库文件）都复用它，
 * 所以「外壳换成真实数据」不用改界面，只换 data source 实现。
 *
 * 排序说明：`recallOf` 是**简化实现**（分词 + Jaccard + 简单优势），
 * 只保证界面能拿到候选/证据/分数并稳定排序；真实 JitRL 排序等正式引擎接入后替换。
 */

/** 反馈 EMA 系数，与真实经验库一致。 */
export const FEEDBACK_ETA = 0.35

/** 建一个空库（读不到数据时用它兜底，界面不崩）。 */
export function emptyStore() {
  return { version: 1, types: [], experiences: [] }
}

/** 规范化 outcome → 单步回报。 */
export function scoreOf(outcome) {
  switch (String(outcome || '').toLowerCase()) {
    case 'success':
    case 'accepted':
      return 1
    case 'partial':
      return 0.5
    case 'failed':
    case 'corrected':
    case 'rejected':
      return -1
    default:
      return 0
  }
}

function round4(value) {
  return Math.round(Number(value) * 1e4) / 1e4
}

/** 分词：拉丁词 + 中文二元组；都小写。 */
export function tokenize(text) {
  const raw = String(text || '').normalize('NFKC').toLowerCase()
  const tokens = new Set()
  for (const word of raw.match(/[a-z0-9_+#.]{2,}/g) || []) tokens.add(word)
  const cjk = raw.replace(/[^\u3400-\u9fff]+/g, ' ')
  for (const run of cjk.split(/\s+/)) {
    if (run.length === 1) {
      tokens.add(run)
      continue
    }
    for (let i = 0; i < run.length - 1; i += 1) tokens.add(run.slice(i, i + 2))
  }
  return [...tokens].slice(0, 400)
}

function jaccard(left, right) {
  if (left.length === 0 || right.length === 0) return 0
  const a = new Set(left)
  const b = new Set(right)
  let shared = 0
  for (const token of a) if (b.has(token)) shared += 1
  const union = a.size + b.size - shared
  return union === 0 ? 0 : shared / union
}

/** 一条经验的展示行（字段全部是 JSON 值，界面直接可用）。 */
export function rowOf(experience) {
  const feedback = experience.feedback !== null && typeof experience.feedback === 'object' ? experience.feedback : null
  return {
    id: String(experience.id || ''),
    intent: String(experience.intent || ''),
    action: String(experience.action || ''),
    typeId: String(experience.typeId || ''),
    typeName: String(experience.typeName || '未分类'),
    outcome: String(experience.outcome || 'unknown'),
    G: Number(experience.G) || 0,
    GOutcome: Number(experience.GOutcome) || 0,
    GSource: String(experience.GSource || 'outcome'),
    hits: Math.max(1, Math.trunc(Number(experience.hits) || 1)),
    note: String(experience.note || ''),
    origin: String(experience.origin || 'manual'),
    kind: String(experience.kind || 'task'),
    taskId: String(experience.taskId || ''),
    stepIndex: Number.isFinite(Number(experience.stepIndex)) ? Number(experience.stepIndex) : null,
    stepTotal: Number.isFinite(Number(experience.stepTotal)) ? Number(experience.stepTotal) : null,
    createdAt: String(experience.ts || ''),
    lastSeenAt: String(experience.lastSeenAt || experience.ts || ''),
    feedback: feedback === null
      ? null
      : {
          helped: Math.max(0, Math.trunc(Number(feedback.helped) || 0)),
          hurt: Math.max(0, Math.trunc(Number(feedback.hurt) || 0)),
          neutral: Math.max(0, Math.trunc(Number(feedback.neutral) || 0)),
          window: Array.isArray(experience.feedback_log) ? experience.feedback_log.length : 0,
          lastAt: String(feedback.lastAt || ''),
          lastResult: String(feedback.lastResult || ''),
        },
    lifecycle: {
      supersededBy: String(experience.superseded_by || ''),
      retiredAt: String(experience.retired_at || ''),
      retiredReason: String(experience.retired_reason || ''),
      deletedAt: String(experience.deleted_at || ''),
    },
  }
}

/** 可见经验：未删、未被取代、未退休。 */
export function visibleOf(store) {
  const rows = Array.isArray(store && store.experiences) ? store.experiences : []
  return rows.filter((item) => item && typeof item === 'object' && !item.deleted_at && !item.superseded_by && !item.retired_at)
}

/** 排序（列表页）。 */
export function sortRows(rows, sort) {
  const list = [...rows]
  switch (String(sort || '')) {
    case 'g':
      return list.sort((a, b) => b.G - a.G || b.hits - a.hits)
    case 'hits':
      return list.sort((a, b) => b.hits - a.hits || b.G - a.G)
    case 'type':
      return list.sort((a, b) => a.typeName.localeCompare(b.typeName, 'zh') || b.G - a.G)
    case 'recent':
    default:
      return list.sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)) || b.G - a.G)
  }
}

/** 解析非负整数查询参数：空串不能当 0。 */
export function numberParam(value, fallback, max) {
  if (value === null || value === undefined || String(value).trim() === '') return fallback
  const parsed = Math.trunc(Number(value))
  if (!Number.isFinite(parsed) || parsed < 0) return fallback
  return Math.min(parsed, max)
}

/** 列表页数据（`/experiences` 非检索态）。 */
export function listOf(store, params) {
  const limit = numberParam(params.get('limit'), 100, 300)
  const offset = numberParam(params.get('offset'), 0, Number.MAX_SAFE_INTEGER)
  const typeFilter = String(params.get('type') || '')
  const outcomeFilter = String(params.get('outcome') || '')
  const sort = String(params.get('sort') || 'recent')
  const all = visibleOf(store).map(rowOf)
  const counts = {}
  for (const row of all) counts[row.typeId] = (counts[row.typeId] || 0) + 1
  const rows = all
    .filter((row) => typeFilter === '' || row.typeId === typeFilter)
    .filter((row) => outcomeFilter === '' || row.outcome === outcomeFilter)
  const sorted = sortRows(rows, sort)
  return {
    mode: 'list',
    total: rows.length,
    rows: sorted.slice(offset, offset + limit),
    counts,
    note: '',
    warning: null,
    brief: '',
    route: null,
    advantageSpread: 0,
  }
}

/** 检索态数据（简化的 JitRL 风味排序，真实引擎接入后替换）。 */
export function recallOf(store, query, limit) {
  const size = Math.max(1, Math.min(50, Math.trunc(Number(limit) || 20)))
  const queryTokens = tokenize(query)
  const pool = visibleOf(store)
  const scored = pool
    .map((experience) => ({
      experience,
      similarity: jaccard(queryTokens, tokenize(`${experience.intent || ''} ${experience.action || ''} ${experience.note || ''} ${experience.typeName || ''}`)),
    }))
    .filter((entry) => entry.similarity > 0.05)

  if (scored.length === 0) {
    return {
      mode: 'evidence',
      query,
      total: 0,
      rows: [],
      note: '没有相近的历史示例经验：换成更具体的意图再试，或在真实经验里先记一条。',
      warning: null,
      brief: '',
      route: null,
      advantageSpread: 0,
      neighborCount: 0,
    }
  }

  const weightSum = scored.reduce((sum, entry) => sum + entry.similarity, 0)
  const value = scored.reduce((sum, entry) => sum + (Number(entry.experience.G) || 0) * entry.similarity, 0) / (weightSum || 1)

  const grouped = new Map()
  for (const entry of scored) {
    const action = String(entry.experience.action || '').trim() || '(无做法)'
    const bucket = grouped.get(action) || { action, items: [] }
    bucket.items.push(entry)
    grouped.set(action, bucket)
  }

  const candidates = [...grouped.values()].map((bucket) => {
    const items = bucket.items.sort((a, b) => b.similarity - a.similarity)
    const support = items.length
    const meanSimilarity = items.reduce((sum, entry) => sum + entry.similarity, 0) / support
    const meanG = items.reduce((sum, entry) => sum + (Number(entry.experience.G) || 0), 0) / support
    const advantage = meanG - value
    const confidence = support / (support + 2)
    return {
      action: bucket.action,
      typeName: String(items[0].experience.typeName || '未分类'),
      advantage: round4(advantage),
      advantageNorm: round4(Math.max(0, advantage)),
      confidence: round4(confidence),
      rankScore: round4(advantage * confidence),
      support,
      meanSimilarity: round4(meanSimilarity),
      evidenceStrength: 0,
      evidence: items.slice(0, 5).map((entry) => {
        const row = rowOf(entry.experience)
        return {
          id: row.id,
          intent: row.intent,
          action: row.action,
          outcome: row.outcome,
          G: row.G,
          similarity: round4(entry.similarity),
          typeName: row.typeName,
          note: row.note,
          feedback: row.feedback,
          lifecycle: row.lifecycle,
        }
      }),
    }
  })

  const advantages = candidates.map((item) => item.advantage)
  const spread = candidates.length > 1 ? round4(Math.max(...advantages) - Math.min(...advantages)) : 0
  const degenerate = candidates.length < 2 || spread < 0.05
  for (const candidate of candidates) {
    const meanG = candidate.evidence.reduce((sum, item) => sum + (Number(item.G) || 0), 0) / Math.max(1, candidate.evidence.length)
    candidate.evidenceStrength = round4(candidate.meanSimilarity * (0.5 + candidate.support / 4) * ((1 + meanG) / 2))
  }
  candidates.sort((a, b) => (
    degenerate
      ? b.evidenceStrength - a.evidenceStrength || b.support - a.support || b.meanSimilarity - a.meanSimilarity
      : b.rankScore - a.rankScore || b.advantage - a.advantage || b.meanSimilarity - a.meanSimilarity
  ))
  if (degenerate) for (const candidate of candidates) candidate.rankScore = candidate.evidenceStrength

  const allNegative = candidates.length > 0 && candidates.every((candidate) => candidate.evidence.every((item) => (Number(item.G) || 0) < 0))
  return {
    mode: degenerate ? 'evidence' : 'advantage',
    query,
    total: Math.min(size, candidates.length),
    rows: candidates.slice(0, size),
    note: degenerate
      ? `无成败对照（advantage 极差 ${spread}），Â 不具区分度；按「相似度 × 支持度 × 证据质量」排序。`
      : `按 JitRL 优势排序（简化实现；Â 极差 ${spread}）。`,
    warning: allNegative ? '候选全是负回报：没有可推荐的做法，别照着做。' : null,
    brief: '',
    route: null,
    advantageSpread: spread,
    neighborCount: scored.length,
  }
}

/** 单条详情：找得到就返回 `{ row, history, feedbackLog }`，否则 null。 */
export function detailOf(store, id) {
  const rows = Array.isArray(store && store.experiences) ? store.experiences : []
  const experience = rows.find((item) => item && typeof item === 'object' && String(item.id) === String(id))
  if (experience === undefined) return null
  return {
    row: rowOf(experience),
    history: Array.isArray(experience.history) ? experience.history.slice(-20) : [],
    feedbackLog: Array.isArray(experience.feedback_log) ? experience.feedback_log.slice(-20) : [],
  }
}

/** 类型目录（含可见条数，系统类型排最后）。 */
export function typesOf(store) {
  const rows = visibleOf(store)
  const counts = new Map()
  for (const item of rows) {
    const key = String(item.typeId || '')
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  const types = Array.isArray(store && store.types) ? store.types : []
  return types
    .map((type) => ({
      id: String(type.id || ''),
      name: String(type.name || '未分类'),
      description: String(type.description || ''),
      system: type.system === true,
      count: counts.get(String(type.id || '')) || 0,
    }))
    .sort((a, b) => Number(a.system) - Number(b.system) || b.count - a.count || a.name.localeCompare(b.name, 'zh'))
}

/** 统计（面板顶部四格 + 类型分布）。 */
export function statsOf(store) {
  // null/非对象行（自定义或 mock 数据源）不能打崩统计：先过滤，再计数。
  const all = (Array.isArray(store && store.experiences) ? store.experiences : [])
    .filter((item) => item && typeof item === 'object')
  const visible = visibleOf(store)
  const byCategory = {}
  for (const item of visible) {
    const key = String(item.typeName || '未分类')
    byCategory[key] = (byCategory[key] || 0) + 1
  }
  const tokens = new Map()
  for (const item of visible) for (const token of new Set(tokenize(item.intent))) tokens.set(token, (tokens.get(token) || 0) + 1)
  return {
    totalInsights: visible.length,
    deletedInsights: all.filter((item) => item.deleted_at).length,
    supersededInsights: all.filter((item) => item.superseded_by).length,
    retiredInsights: all.filter((item) => item.retired_at).length,
    edgeCount: all.filter((item) => item.superseded_by).length,
    dbSizeBytes: 0,
    byCategory,
    topEntities: [...tokens.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([entity, count]) => ({ entity, count })),
  }
}

/** 用后反馈：改 G（EMA 重放）+ 计数 + 历史；找不到 / 不可反馈时抛带 code 的错误。 */
export function applyFeedbackTo(store, id, result, now = new Date()) {
  const rows = Array.isArray(store && store.experiences) ? store.experiences : []
  const experience = rows.find((item) => item && typeof item === 'object' && String(item.id) === String(id))
  if (experience === undefined) throw codedError('not-found', `没有这条经验：${String(id)}`)
  if (experience.deleted_at) throw codedError('not-feedbackable', '这条经验已删除，不能再反馈')
  if (experience.superseded_by) throw codedError('not-feedbackable', '这条经验已被取代，请给新条反馈')
  if (experience.retired_at) throw codedError('not-feedbackable', '这条经验已退休，不再参与召回')
  const outcome = String(result || '').toLowerCase()
  if (!['helped', 'hurt', 'neutral'].includes(outcome)) {
    throw codedError('bad-result', 'result 只能是 helped / hurt / neutral')
  }
  const at = (now instanceof Date ? now : new Date()).toISOString()
  const before = round4(Number(experience.G) || 0)
  const base = Number.isFinite(Number(experience.GOutcome)) ? Number(experience.GOutcome) : scoreOf(experience.outcome)
  experience.GOutcome = round4(base)
  const log = Array.isArray(experience.feedback_log) ? [...experience.feedback_log] : []
  log.push({ at, result: outcome, eta: FEEDBACK_ETA })
  const kept = log.slice(-20)
  experience.feedback_log = kept
  const target = { helped: 1, hurt: -1, neutral: null }[outcome]
  let G = experience.GOutcome
  if (target !== null) {
    for (const event of kept) {
      const stepTarget = { helped: 1, hurt: -1 }[event && event.result]
      if (stepTarget === undefined) continue
      G = G + FEEDBACK_ETA * (stepTarget - G)
    }
    experience.GSource = 'feedback'
  }
  experience.G = round4(G)
  experience.feedback = {
    helped: 0,
    hurt: 0,
    neutral: 0,
    ...(experience.feedback !== null && typeof experience.feedback === 'object' ? experience.feedback : {}),
    lastAt: at,
    lastResult: outcome,
  }
  experience.feedback[outcome] = Math.max(0, Math.trunc(Number(experience.feedback[outcome]) || 0)) + 1
  experience.lastFeedbackAt = at
  experience.history = [
    ...(Array.isArray(experience.history) ? experience.history : []),
    { type: 'feedback', at, result: outcome },
  ].slice(-50)
  return {
    id: String(experience.id),
    result: outcome,
    G_before: before,
    G_after: experience.G,
    changed: experience.G !== before,
    outcome: String(experience.outcome || 'unknown'),
    typeName: String(experience.typeName || '未分类'),
    feedback: { ...experience.feedback },
    source: 'feedback',
  }
}

/** 构造带 code 的错误（外壳按 code 回 HTTP 状态与错误体）。 */
export function codedError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/** 用法日志摘要。 */
export function usageSummary(rows) {
  const list = Array.isArray(rows) ? rows : []
  const today = new Date().toISOString().slice(0, 10)
  const byTool = {}
  for (const row of list) {
    const tool = String(row.tool || 'unknown')
    byTool[tool] = (byTool[tool] || 0) + 1
  }
  const last = list.length > 0 ? list[list.length - 1] : null
  return {
    total: list.length,
    today: list.filter((row) => String(row.at || '').slice(0, 10) === today).length,
    byTool,
    lastAt: last === null ? '' : String(last.at || ''),
    lastTool: last === null ? '' : String(last.tool || ''),
  }
}

/* -------------------------------------------------------------------------- */
/* 固化技能（exp-lib 0.29+ 的 .exp/skills/<slug>/）                             */
/* -------------------------------------------------------------------------- */

/** 技能状态：与 exp-lib 的 highConfidence 同规则（uses = helped + hurt）。 */
export function skillStatusOf(input = {}) {
  const helped = Math.max(0, Math.trunc(Number(input.helped) || 0))
  const hurt = Math.max(0, Math.trunc(Number(input.hurt) || 0))
  const attempts = helped + hurt
  const ratio = attempts === 0 ? 0 : helped / attempts
  const openObstacles = Math.max(0, Math.trunc(Number(input.openObstacles) || 0))
  const confident = attempts >= 3 && ratio >= 0.8 && openObstacles === 0
  let status = 'trial'
  if (attempts === 0) status = 'new'
  else if (openObstacles > 0) status = 'blocked'
  else if (confident) status = 'solid'
  else if (attempts >= 3 && ratio < 0.5) status = 'risky'
  return { attempts, ratio: round4(ratio), confident, status }
}

/** 把一条技能（来自 mock 或 live 目录）压成界面要的行。 */
export function skillRowOf(input = {}) {
  const helped = Math.max(0, Math.trunc(Number(input.helped) || 0))
  const hurt = Math.max(0, Math.trunc(Number(input.hurt) || 0))
  const openObstacles = Math.max(0, Math.trunc(Number(input.openObstacles) || 0))
  const state = skillStatusOf({ helped, hurt, openObstacles })
  return {
    id: String(input.id || ''),
    path: String(input.path || input.id || ''),
    depth: Math.max(0, Math.trunc(Number(input.depth) || 0)),
    parentPath: String(input.parentPath || ''),
    rootName: String(input.rootName || ''),
    childCount: Math.max(0, Math.trunc(Number(input.childCount) || 0)),
    name: String(input.name || input.id || '未命名技能'),
    description: String(input.description || ''),
    body: String(input.body || ''),
    typeName: String(input.typeName || '未分类'),
    typeNames: Array.isArray(input.typeNames) ? input.typeNames.map(String) : [],
    notes: Array.isArray(input.notes) ? input.notes.map(String) : [],
    packageFiles: Math.max(0, Math.trunc(Number(input.packageFiles) || 0)),
    packageBytes: Math.max(0, Math.trunc(Number(input.packageBytes) || 0)),
    packageDirs: Array.isArray(input.packageDirs) ? input.packageDirs.map(String) : [],
    context: Array.isArray(input.context) ? input.context.map(String) : [],
    triggers: Array.isArray(input.triggers) ? input.triggers.map(String) : [],
    order: Math.max(0, Math.min(100, Math.trunc(Number(input.order) || 0))),
    files: Array.isArray(input.files) ? input.files.map(String) : [],
    uses: Math.max(0, Math.trunc(Number(input.uses) || 0)),
    helped,
    hurt,
    attempts: state.attempts,
    ratio: state.ratio,
    confident: state.confident,
    status: state.status,
    revisions: Math.max(0, Math.trunc(Number(input.revisions) || 0)),
    obstacleCount: Math.max(0, Math.trunc(Number(input.obstacleCount) || 0)),
    openObstacleCount: openObstacles,
    resolvedCount: Math.max(0, Math.trunc(Number(input.resolvedCount) || 0)),
    derivedFrom: Array.isArray(input.derivedFrom) ? input.derivedFrom.map(String) : [],
    pendingCommit: input.pendingCommit === true,
    globalRegistered: input.globalRegistered === true,
    globalPath: String(input.globalPath || ''),
    lastUsedAt: String(input.lastUsedAt || ''),
    updatedAt: String(input.updatedAt || ''),
    dir: String(input.dir || ''),
  }
}

