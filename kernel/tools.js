/**
 * 工具面：exp_record / exp_recall / exp_feedback / exp_type。
 *
 * 同一份数据、同一套语义；写入只走 exp_record（Provider 的通用 remember 被禁用）。
 * SDK 由 index.js 注入，测试用桩。
 */
import fs from 'node:fs'

import path from 'node:path'
import {
  FEEDBACK_ETA,
  REVIEW_ACTIONS,
  REVIEW_NOTE_LIMIT,
  REVIEW_REASONS,
  SYSTEM_TYPE,
  applyFeedback,
  assignType,
  buildInduction,
  createType,
  deleteType,
  dueReviewRows,
  findType,
  listTypes,
  logUsage,
  mergeTypes,
  nextReviewAfter,
  normalizeContext,
  pendingTasks,
  rankExperiences,
  reviewExperience,
  tagCatalog,
  readColdStore,
  readManifest,
  readStore,
  resolveTypeForRecord,
  resolveVerdicts,
  visibleExperiences,
  renameType,
  scoreOf,
  taskKeyOf,
  withStoreLock,
  upsertExperience,
  writeStore,
} from './store.js'
import {
  lifecycleMetaOf,
  normalizeIsoDate,
  normalizeVolatility,
} from './retrieval.js'
import { readFamilyByName, readRecordsByIds, readShardRecordsOfTypes, recordShardWrite, taskIndexOf, writeTypeShards } from './shard-store.js'
import { findActiveSession, findRecordBinding, userMessageForRecord } from './session.js'
import { measure, slimRecall, slimReceipt } from './token-budget.js'
import { rankByTags } from './tag-rank.js'
import { extractQueryTags, ensureTagOverrides } from './tag-registry.js'
import { pendingBrief } from './brief.js'
import { summarizeUserEdits } from './artifact-diff.js'
import { AUTO_ROUTE_MIN_SCORE, ensureClusters, routeCluster } from './cluster.js'
import { resolveEngramDataDir, readRuntimeEnv, mergeRuntimeEnv } from './settings.js'
import { applySkillObstacle, applySkillOutcome, attachSkillFiles, buildReuseReceipt, catalogConfigOf, clipSkillBody, confidenceReason, createSkill, deriveSkillDraft, listSkills, listSkillsCached, matchSkill, readSkillBySlug, resolveSkillId, sessionHashOf, sessionIdOfAgent, skillCatalogUsageOf, skillGiveDecision, skillGroupsOf, skillRuntimeOf, updateSkillMeta } from './skills.js'
// 标签词表（0.20.0 P0）：写入侧的面校验与命名规则都在 registry，工具层只负责「什么时候用哪条规则」。
import { TAG_FACETS, TAG_FACET_HINTS, TAG_FACET_LABELS, TAG_MAX_COUNT, TAG_REQUIRED_FACETS, facetOf, groupByFacet, inferTagFacet, saveTagOverride, validateNewTagName, validateTagSet } from './tag-registry.js'
import { familyOf, hasFamilyLayout, markFamilyTypeCreated, removeFamilyTypeDir, syncFamilyTypeName } from './shard-store.js'
import { manageFamilies, readCreatedFamilies, syncCreatedFamilies } from './family-tools.js'
import { GENERIC_FAMILY_NAMES, normalizeFamilyName } from './family-name.js'
import {
  dropFamilyEntry,
  ensureFamilyEntry,
  familyIdByName,
  familyIdSetOf,
  mergeFamilyEntries,
  readFamilyRegistry,
  renameFamilyEntry,
  resolveFamilyRef,
  writeFamilyRegistry,
} from './family-registry.js'
import {
  addBranch,
  appendChain,
  appendToObject,
  buildSteps,
  chainReferences,
  createObject,
  findObject,
  objectView,
  promotionHints,
  readObjects,
  writeObjects,
} from './objects.js'

const OUTPUT_SCHEMA = { type: 'object', additionalProperties: true }
// 试用技能的门槛：略高于正式匹配下限，避免把不相关技能当试用塞给模型
const TRIAL_MIN_SIMILARITY = 0.18

/**
 * 自动记录的类型兜底（0.24.x）：标签字面 → 预设主分类名。
 *
 * 自动记录没有模型参与，只能靠引擎。簇路由命中就用簇；没命中时如果标签里已经出现
 * 「DSH插件 / 课件 / 代码……」，档案柜不该还挂在「未分类」上。
 * 0.37 起 object 面已删除，这些词不再是登记标签，但模型/旧数据仍可能原样传进来，
 * 所以这里按**字面**匹配（不查 facetOf），映射不到就保持原样——宁可未分类，也不凭空造分类。
 */
const AUTO_TYPE_BY_OBJECT_TAG = {
  DSH插件: '开发', 代码: '开发', 脚本: '开发', 网页应用: '开发', Agent: '开发', 智能体平台: '开发',
  PPT: '办公', Word: '办公', Excel: '办公', WPS: '办公', 课件: '办公', 任务卡: '办公', 版式: '办公', 插页: '办公',
}

/** 用标签里的对象面挑一个已存在的类型名；挑不到返回 ''。 */
function autoTypeFromTags(tags, types) {
  const list = Array.isArray(types) ? types : []
  for (const tag of Array.isArray(tags) ? tags : []) {
    const wanted = AUTO_TYPE_BY_OBJECT_TAG[tag]
    if (wanted === undefined) continue
    const hit = list.find((type) => type && String(type.name).toLowerCase() === wanted.toLowerCase())
    if (hit !== undefined) return String(hit.name)
  }
  return ''
}

/**
 * 查询标签：把 `extractQueryTags` 的分面结果摊平成数组。
 * 0.25.0 P1 复用点：抽词只跑一次，结果直接喂给既有 `contextMatch`，不新增排序代码。
 * 面内顺序按排序权重（动作 0.55 > 主题 0.30 > 对象 0.15 > 质量）：截到 8 个时先保动作/主题，
 * 否则「对象面词多」的意图会把动作信号整体挤掉。
 */
/**
 * 分类目录对账（0.27.0 分族布局）：exp_type 的 create/rename/delete/merge 之后调用。
 * - 不在 store.types 里的目录删掉；在 types 里的同步 _type.json 名字；
 * - 没有行的业务分类标 created:true（重建时保留），系统类型不建目录。
 */
function reconcileFamilyTypeDirs(dataDir, store) {
  if (!hasFamilyLayout(dataDir)) return
  const known = new Map((Array.isArray(store.types) ? store.types : []).map((type) => [String(type.id), String(type.name || '')]))
  const root = path.join(String(dataDir), 'library')
  let dirs = []
  try { dirs = fs.readdirSync(root) } catch { dirs = [] }
  for (const typeId of dirs) {
    if (known.has(typeId)) continue
    // R9 缺陷：只清「像分类目录」的项（有 _type/_index 或 ty_* 名）；用户自建目录/文件不删。
    if (typeId.startsWith('.')) continue
    let isClassDir = false
    try { isClassDir = fs.statSync(path.join(root, typeId)).isDirectory() } catch { isClassDir = false }
    if (!isClassDir) continue
    let hasMeta = false
    try { hasMeta = fs.existsSync(path.join(root, typeId, '_index.json')) || fs.existsSync(path.join(root, typeId, '_type.json')) } catch { hasMeta = false }
    if (!hasMeta && !/^ty_/i.test(typeId)) continue
    removeFamilyTypeDir(dataDir, typeId)
  }
  const withRows = new Set((Array.isArray(store.experiences) ? store.experiences : []).map((row) => String((row && row.typeId) || 'ty_other')))
  for (const [typeId, name] of known) {
    if (typeId === 'ty_other') continue
    if (!withRows.has(typeId)) markFamilyTypeCreated(dataDir, typeId, name)
    else syncFamilyTypeName(dataDir, typeId, name)
  }
}
function flattenQueryTags(queryTags) {
  if (queryTags === null || typeof queryTags !== 'object') return []
  const out = []
  for (const facet of ['action', 'topic', 'quality']) {
    for (const name of Array.isArray(queryTags[facet]) ? queryTags[facet] : []) {
      if (typeof name === 'string' && name !== '' && !out.includes(name)) out.push(name)
    }
  }
  return out.slice(0, TAG_MAX_COUNT)
}

function renderJson(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

/** 可选时间字段：未给=null；给了但解析不了就明确报错，不能静默改走推算。 */
function checkedIsoDate(value, field) {
  if (value === undefined || value === null || String(value).trim() === '') return undefined
  if (normalizeIsoDate(value) === null) throw new Error(`${field} 不是合法时间（请用 ISO，例如 2026-12-31T00:00:00.000Z）`)
  return value
}

/**
 * 宿主真实执行上下文（task-7 B7）：dsh-tools 以 `tool.execute(args, exec)` 调用工具，
 * `exec.agent` 是发起调用的 Agent——`agent.id` 就是 session id，工作区在
 * `agent.session.header.cwd`（真实 v4 会话首事件同源）。这样不依赖 config.cwd 注入，
 * 也不靠文件 mtime 猜身份。拿不到（headless/脚本直调）返回空，调用方退回扫描会话文件。
 */
function hostSessionOf(exec) {
  try {
    const agent = exec && exec.agent
    if (!agent) return { sessionId: '', cwd: '' }
    const session = agent.session || null
    // 会话键解析统一走 skills.js 的 sessionIdOfAgent（pre-step 目录钩子用同一个函数），
    // 避免「工具记进 session.id 桶、钩子取空键」两处漂移。
    const sessionId = sessionIdOfAgent(agent)
    const cwd = session && session.header && typeof session.header.cwd === 'string' ? session.header.cwd : ''
    return { sessionId, cwd }
  } catch {
    return { sessionId: '', cwd: '' }
  }
}

/** 宿主会话对象（含 surface/events）：拿不到返回 null，三态判定会因此降级为每次全文。 */
function hostSessionObjectOf(exec) {
  try {
    return (exec && exec.agent && exec.agent.session) || null
  } catch {
    return null
  }
}

/** 会话可见面（`session.surface.nodes`）→ Set<seq>；宿主没暴露返回 null（方向安全：宁可重给全文）。 */
function visibleSeqsOf(exec) {
  try {
    const session = hostSessionObjectOf(exec)
    const nodes = session && session.surface && session.surface.nodes
    if (!Array.isArray(nodes)) return null
    return new Set(nodes)
  } catch {
    return null
  }
}

/** 把记录按 typeId 分组（写回 touched 类型时 rowsByType 必须是该类型的全部行，含 tombstone）。 */
function groupRowsByType(rows) {
  const out = {}
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) continue
    const typeId = String(row.typeId || SYSTEM_TYPE.id)
    if (out[typeId] === undefined) out[typeId] = []
    out[typeId].push(row)
  }
  return out
}

/**
 * 只读 manifest 的类型目录（T4）：count 用 `stats.tasksByType` 的唯一 taskId 数，与 `listTypes` 同口径。
 * 返回 null 表示 manifest 还没有统计（G6 缺失）→ 调用方回退全量读，不要在这里现算。
 */
function typesFromManifest(manifest) {
  if (manifest === null || manifest === undefined) return null
  const stats = manifest.stats !== null && typeof manifest.stats === 'object' ? manifest.stats : null
  const taskCounts = stats !== null && stats.tasksByType !== null && typeof stats.tasksByType === 'object' ? stats.tasksByType : null
  if (taskCounts === null) return null
  const types = Array.isArray(manifest.types) ? manifest.types : []
  // 类型声明漂移（R6 缺陷 D3）：`stats.tasksByType` 还引用 `manifest.types` 里没有的 typeId，
  // 说明 manifest 只取到了一边 / 类型声明被手删而分片旧行仍在。逐项取数会把那些行整条算丢
  // （实测「未分类:0」而可见 2 行）——与「stats 缺失」同属「计数不可信」，返回 null 让调用方
  // 回退全量读 + listTypes；发生一次写盘后 manifest 就自愈了。
  const knownTypeIds = new Set(types.map((type) => String((type && type.id) || '')))
  if (Object.keys(taskCounts).some((typeId) => !knownTypeIds.has(String(typeId)))) return null
  return types
    .map((type) => ({
      id: type.id,
      name: type.name,
      description: type.description || '',
      system: type.system === true || type.id === SYSTEM_TYPE.id,
      source: type.source || 'preset',
      createdAt: type.createdAt || '',
      count: Number(taskCounts[type.id]) || 0,
    }))
    .sort((left, right) => Number(left.system) - Number(right.system) || right.count - left.count || left.name.localeCompare(right.name, 'zh'))
}

/**
 * `manifest.taskIndex` 是否能用来回答「这个键下有没有别的类型的旧条」（R6 缺陷 D1 / R7 缺陷 D1）。
 *
 * 三种情况：
 *  - 键在索引里、值全是 typeId：可信（但键在 `taskIndexDropped` 名单里时，它的行被截断甩过、
 *    类型覆盖可能不全 → 不可信）；
 *  - 键不在索引、也不在 `taskIndexDropped` 名单、且名单**精确存在**：确实是新键 → 可信；
 *  - 键不在索引、名单缺失（truncated 但没有 dropped 名单，记不清了）→ 不可信。
 *
 * 值被手改/冲突写成 `[]` / `null` / `''` / 数字 / 布尔 / 对象 / 数字数组 / 超长垃圾串时一律不可信：
 * 解析不出**全部**是 typeId 就退回慢路径（与「缺索引 / 空键」同一收口），由写盘的
 * `mergeTaskIndex` 重建索引。R7 缺陷 R7-D1：原来只判「有非空片段」，于是 `0` / `true` /
 * `[1,2]` / 5000 字符垃圾都被当成可信，快路径照旧把同一条重开。typeId 口径是本仓库统一的
 * `ty_[A-Za-z0-9_-]{1,64}`（预设 `ty_dev`、新建 `ty_<8hex>`、分片名同口径清洗）。
 * 键不存在仍视为可信（确实没有别的类型挂这个键）；值里是旧 typeId 也照旧用——那个类型的分片
 * 还在盘上就仍能定位到旧条（R5 ④a 的既有契约：类型声明漂移不牵连分片读取）。
 */
const TASK_INDEX_TYPE_ID_RE = /^ty_[A-Za-z0-9_-]{1,64}$/
function isTypeIdList(raw) {
  if (typeof raw !== 'string') return false
  const candidates = raw.split(',').map((typeId) => typeId.trim())
  return candidates.length > 0 && candidates.every((typeId) => TASK_INDEX_TYPE_ID_RE.test(typeId))
}

function fastIndexTrusted(manifest, taskKey) {
  if (manifest === null || manifest === undefined || taskKey === '') return true
  const taskIndex = taskIndexOf(manifest)
  if (taskIndex === null) return true
  const raw = taskIndex[taskKey]
  const dropped = Array.isArray(manifest.taskIndexDropped) ? manifest.taskIndexDropped : null
  // 这个键有行被 600 键上限甩掉过：索引里即使还留着它，typeId 覆盖也可能不全 → 退慢。
  if (dropped !== null && dropped.includes(taskKey)) return false
  if (raw === undefined) {
    // 有精确 dropped 名单 → 不在名单里就是新键，可放心走快路径；
    // 只有 truncated 标记、没有名单（超预算记不清）→ 缺键一律不可信。
    return manifest.taskIndexTruncated !== true || dropped !== null
  }
  return isTypeIdList(raw)
}

/**
 * @param {Function} defineTool - `@deepseek-ai/dsh-tools` 的 defineTool
 * @param {{dataDir?: string, mergeThreshold?: number, replaceThreshold?: number}} config
 */
export function buildTools(defineTool, config = {}) {
  // 0.11.0：工具面统一走 settings 的 resolveEngramDataDir（dataDir → currentRoot → 默认）。
  const dataDirOf = () => resolveEngramDataDir(config)
  // 用法日志（零 token）：只回答「召回到底有没有被用起来」；config.usageLog=false 可关。
  const usageOptions = { enabled: config.usageLog !== false, maxBytes: config.usageLogMaxBytes }
  // 手改摘要（P3）：有 artifacts 就对比「上次提交版 vs 用户版」，压成 ≤80 字放进 brief。
  const pendingEdit = (item) => {
    if (item === undefined || item === null || !Array.isArray(item.artifacts) || item.artifacts.length === 0) return ''
    const cwd = String(item.cwd || config.cwd || '').trim()
    if (cwd === '') return ''
    try {
      return summarizeUserEdits({ cwd, artifacts: item.artifacts }).summary
    } catch {
      return ''
    }
  }
  // 回填结果的回执：只报「成功几条 + 失败明细」，不把入参原样回显（省 token，模型知道自己传了什么）。
  const verdictSummary = (results) => {
    if (!Array.isArray(results) || results.length === 0) return undefined
    const failed = results.filter((item) => item.ok !== true).map((item) => ({ id: item.id, error: String(item.error || '').slice(0, 60) }))
    return { ok: results.length - failed.length, ...(failed.length > 0 ? { failed } : {}) }
  }
  const pendingQuote = (item) => {
    const stored = item && item.evidence && typeof item.evidence.quote === 'string' ? item.evidence.quote : ''
    if (stored !== '') return stored
    if (item === undefined || item === null || !item.sessionId || item.turn === undefined || item.turn === null) return ''
    try {
      return userMessageForRecord({ sessionId: item.sessionId, turn: item.turn }, { sessionsRoot: config.sessionsRoot, dataDir: dataDirOf() })
    } catch {
      return ''
    }
  }

  const record = defineTool({
    name: 'exp_record',
    description: '记录一条工作经验（做法 + 结果）。同一做法会就地更新 hits，近似替换会写新条并标记旧条被取代。标签（context/labels，≤8）请凑出「至少 1 个动作 + 1 个主题」：动作如 提交/推送/校验/验收，主题如 研学课/课件/布局；0.37 起对象面已删除，别再打「代码/PPT/DSH插件」这类对象标签。只写大类会回 tagWarning。标签只写类型不写实例名（yxjd-explib 这类仓库名会被丢弃并记 tagsRejected）。',
    parameters: {
      intent: { type: 'string', required: true, description: '要做的任务/意图。' },
      action: { type: 'string', required: true, description: '采取的做法或方案名。' },
      outcome: { type: 'string', enum: ['accepted', 'success', 'partial', 'unknown', 'failed', 'corrected', 'aborted'], description: '结果；影响回报 G。' },
      // 不叫 type：与 JSON Schema 的 type 关键字同名时，provider 严格校验会把参数当关键字读。
      typeName: { type: 'string', description: '这条经验该归哪个主分类。先自己判断；实在判断不出来才留空，留空即落「未分类」。填了新名字会按需新建类型（受上限与近似合并限制）。' },
      typeDescription: { type: 'string', description: '新建类型时的描述（≤120 字）：这个类型收什么、召回时怎么用。复用已有类型时忽略。' },
      note: { type: 'string', description: '关键步骤、为什么有效、踩了什么坑。' },
      taskId: { type: 'string', description: '可选：多步任务的任务 id。同 taskId 的步骤会归到同一任务，统计按任务算一次。' },
      kind: { type: 'string', enum: ['task', 'step'], description: '可选：这条是整条任务（默认）还是任务里的一步。' },
      stepIndex: { type: 'number', description: 'kind=step 时的步骤序号（1 起）。' },
      stepTotal: { type: 'number', description: '该任务共几步。' },
      failedStep: { type: 'number', description: '整条记录时，失败发生在第几步（1 起）。' },
      stepRewards: { type: 'array', description: '分步回报（数字数组）；整条记录时可用它代替单一 G。' },
      expectedOutcome: { type: 'string', enum: ['accepted', 'success', 'partial', 'unknown', 'failed', 'corrected', 'aborted'], description: '可选：做之前预期会怎样（结果词）。用于算预测误差。' },
      expectedG: { type: 'number', description: '可选：预期回报（-1..1），优先于 expectedOutcome。' },
      context: { type: 'array', description: '可选：情境线索/次级分类（如产物/课程类型/工作区标签），≤8 个；召回时用于编码特异性匹配。' },
      labels: { type: 'array', description: '可选：次级分类标签（≤8），与 context 合并；优先用 exp_type action=labels 列出的已有标签，已有无法满足才新建。' },
      artifacts: { type: 'array', description: '可选：本次产物的路径（工作区相对路径，≤5）。给用户手改学习留锚点。' },
      dimensions: { type: 'array', description: '可选：能力维度（≤3 个短标签，如「布局」「语义理解」）；只存不校验。' },
      family: { type: 'string', description: '可选：具体动作族（如 git 推送/跑 npm 测试/改 React 页面）；不填则落未分族。裸泛词（执行/其它动作/校验）会被拒。' },
      force: { type: 'boolean', description: '可选：强制记录（覆盖记录门槛）。只在你确认这条经验重学成本高、但门槛误判时用。' },
      // 时效治理（0.20 P0）：全部可选；不填就是旧行为（读时按 semi 解释）。
      volatility: { type: 'string', enum: ['stable', 'semi', 'perishable'], description: '可选：易腐层。stable=偏好/硬约束，semi=判断原则（默认），perishable=具体步骤/命令/API。只影响召回降权与复核，不改 G。' },
      appliesTo: { type: 'object', description: '可选：适用范围 { models?: string[], tools?: string[], environment?: string }；不声明=unscoped（不硬拦）。', properties: { models: { type: 'array', items: { type: 'string' } }, tools: { type: 'array', items: { type: 'string' } }, environment: { type: 'string' } }, additionalProperties: false },
      reviewAfter: { type: 'string', description: '可选：建议下次复核时间（ISO）；不填则按 lastVerifiedAt/创建时间 + 半衰期推算。' },
      reviewNote: { type: 'string', description: '可选：复核结论（≤240 字）。' },
      verdicts: { type: 'array', description: '可选：回填回执里的 pending，[{id,outcome,dimensions?}]；一次可回填多条。' },
      cwd: { type: 'string', description: '可选：工作区路径（headless/脚本调用时给；给了才能对手改产物做 diff）。' },
      skillId: { type: 'string', description: '可选：本次使用的技能（技能 id 或 skill:<slug>）；记录后更新技能 confidence/障碍并提交。' },
      blockedBy: { type: 'string', description: '可选：本次撞到的障碍原文；给了就按签名计数，连续 3 次覆盖技能。' },
      blockedByList: { type: 'array', description: '可选：一次撞到多个障碍时传数组，各签名分别计数（与 blockedBy 二选一）。' },
    },
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    execute(args = {}, exec) {
      const dataDir = dataDirOf()
      return withStoreLock(dataDir, () => {
      // P3.5（task-9）：记录路径走 partial 读 + 定向写。manifest 是入口；老库（无 manifest）仍走全量。
      const manifest = readManifest(dataDir)
      const host = hostSessionOf(exec)
      const hostCwd = host.cwd !== '' ? host.cwd : (config.cwd || process.cwd())
      // 标签写入规则（0.20.0 P0）：别名归一 + 命名校验 + 面覆盖。
      // 违规的标签**不落盘**（新记录不能保存项目实例名，计划书 §13-P0 验收），但也不整条拒收：
      // 记录本身是主要产物，标签问题以 tagWarning 回执给模型补（计划书 §3.4「不静默通过」）。
      //
      // context 与 labels 必须**各自**校验、各自回填：store 的重复分支里
      // `context` 是「替换」而 `labels` 是「追加」，把两者合并成一个字段会改掉重记语义。
      //
      // 校验提前到路由之前（0.24.x）：自动记录的簇路由没命中时，要用标签的对象面兜底选类型。
      const ctxGiven = args.context !== undefined
      const lblGiven = args.labels !== undefined
      const reviewAfterInput = checkedIsoDate(args.reviewAfter, 'reviewAfter')
      const contextProvidedNonEmpty = Array.isArray(args.context)
        ? args.context.length > 0
        : (typeof args.context === 'string' && args.context.trim() !== '')
      const ctxCheck = validateTagSet(args.context)
      const lblCheck = validateTagSet(args.labels)
      const allTags = [...ctxCheck.tags, ...lblCheck.tags]
        .filter((name, index, list) => list.findIndex((other) => other.toLowerCase() === name.toLowerCase()) === index)
      const rejectedTags = [...ctxCheck.rejected, ...lblCheck.rejected]
      // 0.34 记录门槛（平衡：严谨四条 + 复用）：通用单步成功、纯任务过程不记。
      // 放行：负面结果、多步（≥3 步或 ≥2 个命令分隔）、用户口径、force；拒记返回
      // { skipped, reason, suggestion }，不静默丢（计划书 §1）。
      const gateText = String(args.action || '')
      const gateOutcome = String(args.outcome || '').toLowerCase()
      const gateNegative = ['failed', 'corrected', 'partial', 'aborted'].includes(gateOutcome) || /(失败|报错|错误|被拒|不通过|不可用|error|failed|exception|超时|中断)/iu.test(String(args.note || ''))
      const gateSteps = gateText.split(/\s*(?:→|->|=>|；|;|\n|然后|接着)\s*/u).filter((part) => part.trim() !== '')
      const gateSeparatorCount = (gateText.match(/→|->|=>|；|;|\n|然后|接着/gu) || []).length
      const gateMulti = gateSteps.length >= 3 || gateSeparatorCount >= 2
      const gateUser = /(用户|口径|以后都|约定|偏好|不要|必须)/u.test(String(args.intent || '') + String(args.note || ''))
      // 通用单步：整条动作都是「查/看/装/切目录」这类命令（允许「跑/执行/运行/调用」前缀），
      // 且不是多步。多步命令链（git add; commit; push）按 §1.3 放行，别把真实交付当通用单步拒掉。
      const gateGenericStep = /^(?:跑|执行|运行|调用|打开)?\s*(?:git\s+(?:status|add|diff|log|show|pull|fetch|rev-parse|branch|remote)|npm\s+(?:install|i|test)|pnpm\s+(?:install|test|add)|yarn\s+install|pwd|ls|dir|cd|cat|get-content|get-childitem|open|echo|test-path|where|which|set-location)\b/iu
      const gateGeneric = !gateMulti && gateSteps.length > 0 && gateSteps.every((step) => gateGenericStep.test(step))
      const rawFamily = typeof args.family === 'string' ? args.family.trim() : ''
      const normalizedFamily = rawFamily === '' ? '' : normalizeFamilyName(rawFamily)
      const familyGeneric = normalizedFamily !== '' && GENERIC_FAMILY_NAMES.includes(normalizedFamily)
      // 空动作没有可记录内容（store 也会拒），force 也不放行；其余门槛 force 可覆盖。
      if (gateText.trim() === '') {
        return {
          skipped: true,
          reason: '没有可执行动作信息',
          suggestion: '补一句「动词+对象」的具体动作再记；动作写不出就说明这条还不值得记',
        }
      }
      if (args.force !== true && !gateNegative && !gateUser && (gateGeneric || familyGeneric)) {
        return {
          skipped: true,
          reason: familyGeneric
            ? '族名太泛，不能单独成为动作族'
            : '通用单步操作，模型本来就会，重学成本低',
          suggestion: familyGeneric ? '改用「动词+对象」，例如 git 推送 / 跑 npm 测试 / 改 React 页面' : '只记失败、非显然、多步或用户口径；确需记录可传 force:true',
        }
      }

      // 0.26.0：写入即登记（计划书 §11.6）。以前 exp_record 只查形态不登记，历史库 213 个标签里 170 个未登记，
      // 查询侧 extractQueryTags 抽不到，标签等于白写。未知词按粗判给一个面并登记，失败不阻断记录。
      for (const name of allTags) {
        if (facetOf(name) !== null) continue
        try {
          saveTagOverride(dataDir, { name, facet: inferTagFacet(name), description: '写入时自动登记（0.26.0）' })
        } catch {
          // 已登记/内建/词表写失败：记录照常落库，不因词表失败阻断。
        }
      }
      // 主分类由模型负责（0.21.3 计划书 §0.1 D1）：手动调用**不再自动归族**——没给就落「未分类」，
      // 回执里给 typeWarning 提示模型补；分不出来保持原样也允许（D2：不阻断保存）。
      // 只有自动记录（`args.origin==='auto'`，由 auto-record.js 传入）才用词面路由兜底，
      // 且用独立门槛 autoRouteMinScore（默认 0.08，比召回路由的 0.17 松），见 §0.1 D3。
      // 路由只用 manifest 的 clusters 缓存（与全量重算的一致性有测试守着）。
      const isAutoRecord = String(args.origin || '').toLowerCase() === 'auto'
      // 门槛只认 (0, 1]（0.21.3 R1 健壮性缺陷 4）：`Number('')`=0 / 负数 / null / NaN 都会让门槛失效，
      // 自动记录于是把 score=0 的无关意图也归族。非法值一律回落 AUTO_ROUTE_MIN_SCORE。
      const rawAutoRouteMinScore = Number(config.autoRouteMinScore)
      const autoRouteMinScore = Number.isFinite(rawAutoRouteMinScore) && rawAutoRouteMinScore > 0 && rawAutoRouteMinScore <= 1
        ? rawAutoRouteMinScore
        : AUTO_ROUTE_MIN_SCORE
      const autoAssign = isAutoRecord && config.autoAssign !== false && config.routing !== 'off'
      let typeName = args.typeName !== undefined ? args.typeName : args.type
      const typeNameGiven = !(typeName === undefined || typeName === null || String(typeName).trim() === '')
      let routedCluster = null
      let typeFromTags = false
      if (!typeNameGiven && autoAssign && manifest !== null) {
        const route = routeCluster({ types: manifest.types, clusters: manifest.clusters }, String(args.intent || ''), { minScore: autoRouteMinScore })
        if (!route.fallback) {
          typeName = route.name
          routedCluster = { clusterId: route.clusterId, name: route.name, score: route.score }
        } else {
          // 簇路由也没接住时，用写入口自带的标签兜底（0.24.x）：自动记录没有模型补分类，
          // 对象面已经认出「这是 DSH插件 / 课件 / 代码」的就别再挂「未分类」。
          const byTag = autoTypeFromTags(ctxCheck.tags, manifest.types)
          if (byTag !== '') {
            typeName = byTag
            typeFromTags = true
          }
        }
      }
      // 绑定会话 turn：读最近会话里的 tool/call，把本条记录挂到它所在的回合（只读，失败就跳过）。
      let binding = null
      if (config.autoBind !== false) {
        try {
          binding = findRecordBinding({ intent: args.intent, action: args.action }, { sessionsRoot: config.sessionsRoot, cwd: hostCwd, dataDir })
          // 宿主给出确切会话时，绑定必须属于同一会话；否则宁可不用（别把别的窗口的 turn 挂上来）。
          if (binding !== null && host.sessionId !== '' && binding.sessionId !== host.sessionId) binding = null
        } catch {
          binding = null
        }
      }
      // 认不出唯一 turn 时至少要有会话归属，保证 pending/回填有主：
      // 宿主给了确切 agent/session id 就直接用；否则退回「本工作区最近写入的会话」。
      // 一个会话都读不到 → undefined，后续 strict 路径不显示 pending、回填一律拒绝。
      let activeSession = null
      if (config.autoBind !== false) {
        try {
          activeSession = host.sessionId !== ''
            ? { sessionId: host.sessionId, file: '', cwd: host.cwd }
            : findActiveSession({ sessionsRoot: config.sessionsRoot, cwd: hostCwd, tool: 'exp_record', intent: args.intent, dataDir })
        } catch {
          activeSession = null
        }
      }
      const sessionId = binding !== null ? binding.sessionId : (activeSession === null ? undefined : activeSession.sessionId)
      // 写入口的入参/选项：fast / slow 两条路径共用（保证语义只在一处定义）。
      const upsertInput = {
        intent: args.intent,
        action: args.action,
        outcome: args.outcome,
        verdict: (args.outcome === undefined || args.outcome === null || String(args.outcome).trim() === '') ? 'pending' : 'decided',
        // 用上面算好的 sessionId：binding 为 null 时退回「最近写入会话」，
        // 否则 tool/call 尚未落盘（宿主约 5s 才刷盘）会让本行 sessionId=undefined，成为谁也算不到的孤儿 pending。
        sessionId,
        turn: binding === null ? undefined : binding.turn,
        cwd: (typeof args.cwd === 'string' && args.cwd.trim() !== '') ? args.cwd.trim() : (binding === null ? (host.cwd !== '' ? host.cwd : undefined) : binding.cwd),
        // 来源（0.21.1 P0）：auto-record 钩子给的 origin='auto'；模型/控制台手动记录不带，落 manual。
        origin: args.origin,
        artifacts: args.artifacts,
        dimensions: args.dimensions,
        type: typeName,
        // 这个类型是引擎按簇路由 / 标签兜底给的（不是模型补的）：store 不能用它触发跨类型就地改写。
        typeFromRoute: routedCluster !== null || typeFromTags,
        typeDescription: args.typeDescription,
        note: args.note,
        volatility: args.volatility,
        appliesTo: args.appliesTo,
        reviewAfter: reviewAfterInput,
        reviewNote: args.reviewNote,
        taskId: args.taskId,
        kind: args.kind,
        stepIndex: args.stepIndex,
        stepTotal: args.stepTotal,
        failedStep: args.failedStep,
        stepRewards: args.stepRewards,
        expectedOutcome: args.expectedOutcome,
        expectedG: args.expectedG,
        // 显式给空数组=清空；给了非空但全部被拒=保留旧标签，避免“只写了一个实例名”把旧标签静默清空。
        context: ctxGiven
          ? (ctxCheck.tags.length === 0 && contextProvidedNonEmpty ? undefined : ctxCheck.tags)
          : undefined,
        labels: lblGiven ? lblCheck.tags : undefined,
        // 0.27.0 族键：显式 family 优先，否则取第一个动作标签；没有动作标签 → 不写（落未分族）。
        // 只传显式 family；自动推导放在 store 建行时做（R4 缺陷：就在更新时不能拿推导值覆盖用户显式族）。
        family: (typeof args.family === 'string' && args.family.trim() !== '') ? (normalizeFamilyName(args.family) || args.family.trim()) : undefined,
        skillId: args.skillId,
      }
      const upsertOptions = {
        mergeThreshold: config.mergeThreshold,
        replaceThreshold: config.replaceThreshold,
        maxTypes: config.maxTypes,
        newTypesPerDay: config.newTypesPerDay,
        typeSimilarity: config.typeSimilarity,
        feedbackDecayDays: config.feedbackDecayDays,
      }
      const haveVerdicts = Array.isArray(args.verdicts) && args.verdicts.length > 0
      let verdictResults = []
      let pendingOut = { rows: [], skipped: [] }
      let result = null
      let activeCount = 0

      // 快路径（task-9）：有 manifest 且不需要跨类型回填时，只读目标类型（+ pending 所在类型）的行，
      // upsert 后走 recordShardWrite（定向写 + 压缩触发）。partial store 绝不交给 writeStore。
      //
      // 同做法键索引（0.21.3 R1 缺陷 1/3）是部分读的前提：没有它就不知道「别的类型下还有没有
      // 同 intent+action 的旧条」。老 manifest 缺这份索引时宁可退回慢路径一次（写盘时补齐），
      // 也不能在看不到旧条的情况下新开一条——那等于把「补 typeName 就地纠正」变成永远的新增。
      const taskIndex = taskIndexOf(manifest)
      // 同做法键（显式给类型时才需要）：用来在 taskIndex 里定位**别的类型**下的同键旧条。
      const fastTaskKey = typeNameGiven ? taskKeyOf(args.intent, args.action) : ''
      // 0.21.3 R5 缺陷 D2（R4 修复的副作用）：控制字符-only 的 intent 算出空键、不进 taskIndex（R4 有意为之），
      // 快路径因此定位不到跨类型旧条；partial store 看不到别的类型的分片，upsert 只会新开一条——
      // 与慢路径的「就地改类型」分裂。空键时无从定位，退回慢路径。
      const fastKeyUsable = !(typeNameGiven && fastTaskKey === '')
      // 索引值可信度（R6 缺陷 D1）：值被写坏（空数组/null/空串）时解析不出候选类型、定位不到
      // 别的类型下的旧条，退回慢路径就地纠正，不能新开一条。缺失键仍可信。
      const fastIndexUsable = !typeNameGiven || fastIndexTrusted(manifest, fastTaskKey)
      // 分片重复 id（R6 缺陷 D2）：重建 manifest 时看到过同一条的多份副本（duplicates>0）。
      // 副本可能躺在**任何**类型的分片里，partial 读看不全，快路径写回只能在 touched 类型内收敛，
      // 别的分片里那份会留着。这时退回全量读—改—写（writeStore 重写所有类型，副本一次清干净）。
      const fastDuplicateFree = !(manifest !== null && Number(manifest.duplicates) > 0)
      // 快路径自己 resolve 一次类型（可能要新建），upsert 里二次 resolve 时类型已存在 → created=false。
      // 所以「本次是否新建类型」要在快路径这一层记下来，否则快/慢两条入口的回执不一致（R3 缺陷 2）。
      let fastTypeCreated = false
      if (manifest !== null && !haveVerdicts && taskIndex !== null && fastKeyUsable && fastIndexUsable && fastDuplicateFree) {
        const typeStore = {
          version: manifest.version,
          types: (Array.isArray(manifest.types) ? manifest.types : []).map((type) => ({ ...type })),
          experiences: [],
          clusters: manifest.clusters,
        }
        // 自动记录归族：路由簇名就是目标类型，快路径要按它 resolve（否则会解析成「未分类」而被
        // needsCrossTypeInheritance 退回慢路径，R1 的分片快路径等于没被自动记录用上，R3 缺陷 3）。
        const resolved = resolveTypeForRecord(
          typeStore,
          typeNameGiven ? String(typeName) : (routedCluster === null ? '' : String(typeName)),
          {
            typeDescription: args.typeDescription,
            maxTypes: config.maxTypes,
            newTypesPerDay: config.newTypesPerDay,
            similarity: config.typeSimilarity,
          },
        )
        // 没给显式类型、又落到「未分类」时，upsert 会跨类型继承归属——partial store 看不到别的类型，走慢路径。
        // 路由给的类型不需要继承（它自带归属），所以只有「模型没给 + 没路由」才退慢路径。
        const needsCrossTypeInheritance = !typeNameGiven && routedCluster === null
          && resolved.type !== undefined && resolved.type !== null
          && resolved.type.id === SYSTEM_TYPE.id
        if (resolved.type !== undefined && resolved.type !== null && !needsCrossTypeInheritance) {
          fastTypeCreated = resolved.created === true
          const targetTypeId = String(resolved.type.id)
          if (!typeNameGiven && routedCluster === null) {
            typeName = resolved.type.name
            upsertInput.type = typeName
          }
          // pending 提醒/TTL 要跨类型：按 manifest.pending 的 typeId 定向读，别加载全库。
          const pendingRefs = (Array.isArray(manifest.pending) ? manifest.pending : [])
            .map((entry) => ({ id: String((entry && entry.id) || ''), typeId: String((entry && entry.typeId) || SYSTEM_TYPE.id) }))
            .filter((ref) => ref.id !== '')
          const loadedTypeIds = new Set([targetTypeId])
          for (const ref of pendingRefs) loadedTypeIds.add(ref.typeId)
          // 类型纠正：显式给了 typeName，而同一个「同做法键」在**别的类型**下也有行 →
          // 那些类型的分片必须一起读进来，否则 upsert 看不到旧条，只会新开一条。
          if (typeNameGiven) {
            // 空键在 gate 处已退回慢路径（R5 缺陷 D2），这里只处理非空键。
            const listed = fastTaskKey === '' ? '' : String(taskIndex[fastTaskKey] === undefined || taskIndex[fastTaskKey] === null ? '' : taskIndex[fastTaskKey])
            for (const typeId of listed.split(',')) {
              const candidate = typeId.trim()
              if (candidate !== '' && candidate !== targetTypeId) loadedTypeIds.add(candidate)
            }
          }
          const loadedRows = readShardRecordsOfTypes(dataDir, manifest, [...loadedTypeIds]).records
          // 错分片（R7 缺陷 R7-D3）：读到的行如果声明了没被读进来的类型，说明它是「跨类型新 id 的
          // 唯一副本躺在别的类型分片里」（外部追加/Git 合并取错边）。快路径只写 touched 类型，
          // groupRowsByType 会把它分到没写的类型 → 整行从盘上消失，而 mergeTypeStats 还保留该类型
          // 旧计数（stats.visible 永久多 1，桶声明与实际一致所以不自愈）。退回慢路径让 writeStore
          // 按行自己的 typeId 归位重写；正常数据里行 typeId 必在 loadedTypeIds 内，不触发。
          const loadedTypeSet = new Set(loadedTypeIds)
          const misplacedRow = loadedRows.some((row) => !loadedTypeSet.has(String((row && row.typeId) || SYSTEM_TYPE.id)))
          if (!misplacedRow) {
            const store = { version: manifest.version, types: typeStore.types, clusters: manifest.clusters, experiences: loadedRows }
            pendingOut = pendingTasks(store, 2, { pendingTtl: config.pendingTtl, sessionId, strict: config.autoBind !== false })
            // skipClusters：partial store 上重算簇没有意义（别的类型没有行），由 recordShardWrite 按
            // touched 类型重算（签名走 state 快速路径，成本很小）。
            result = upsertExperience(store, upsertInput, { ...upsertOptions, skipClusters: true })
            // 写回：touched = 读过的类型 + upsert 实际落到/新建的类型；每类都要给**全部行**（含墓碑）。
            const rowsByType = groupRowsByType(store.experiences)
            const touched = [...new Set([...loadedTypeIds, String(result.experience.typeId || targetTypeId)])]
            const rowsPayload = {}
            for (const typeId of touched) rowsPayload[typeId] = rowsByType[typeId] || []
            const updated = recordShardWrite(dataDir, manifest, {
              touchedTypeIds: touched,
              rowsByType: rowsPayload,
              types: store.types,
              compact: config.compactShard,
            })
            activeCount = Number.isFinite(Number(updated.stats && updated.stats.visible)) ? Number(updated.stats.visible) : 0
          }
        }
      }

      // 慢路径（老库 / 带 verdicts 回填 / 需要跨类型继承）：保持 0.13 的全量读—改—写。
      if (result === null) {
        const store = readStore(dataDir)
        if (!typeNameGiven && autoAssign && routedCluster === null && !typeFromTags) {
          const route = routeCluster(store, String(args.intent || ''), { minScore: autoRouteMinScore })
          if (!route.fallback) {
            typeName = route.name
            routedCluster = { clusterId: route.clusterId, name: route.name, score: route.score }
            upsertInput.type = typeName
            // 老库没有 manifest 时自动记录只能走慢路径：路由类型同样不算模型给的分类。
            upsertInput.typeFromRoute = true
          } else {
            // 与快路径同一口径：簇路由接不住时用标签的对象面兜底（0.24.x）。
            const byTag = autoTypeFromTags(ctxCheck.tags, store.types)
            if (byTag !== '') {
              typeName = byTag
              typeFromTags = true
              upsertInput.type = typeName
              upsertInput.typeFromRoute = true
            }
          }
        }
        // 回填（0.13.0）：模型把上一条 pending 的判定带回来；插件只写回，不判断。
        // 只允许回填本会话自己的待判定（以前 B 会话能改 A 会话的行）。
        verdictResults = haveVerdicts
          ? resolveVerdicts(store, args.verdicts, { sessionId, requireSession: config.autoBind !== false })
          : []
        // 待判定队列在写入本条之前取：刚记的这条不算「提醒过一次」，下一轮才出现。
        pendingOut = pendingTasks(store, 2, { pendingTtl: config.pendingTtl, sessionId, strict: config.autoBind !== false })
        result = upsertExperience(store, upsertInput, upsertOptions)
        writeStore(dataDir, store)
        activeCount = visibleExperiences(store).length
      }
      // 回执自洽（0.21.3 R4 缺陷 1）：pending 快照取在 upsert 之前（「本轮新记的 pending 不当轮提醒」），
      // 而 outcome 合并会在 upsert 里把同一行就地置 decided。同一份回执不能既报 verdict=decided
      // 又把它列进 pending（否则模型会对已判定行重复回填，resolveVerdicts 不拒已判定行）。
      // 快路径/慢路径的行对象都是 store 内的引用，按 upsert 后的真实状态过滤即可。
      // R7 缺陷 D2：被取代（superseded_by）/退休/删除的行 verdict 仍是 pending，只判 verdict
      // 会把「本轮刚被取代」的 p1 又列成待判定（回执自相矛盾，模型还会重复回填）。按可见性一起滤。
      pendingOut = {
        rows: pendingOut.rows.filter((item) => item !== null && typeof item === 'object'
          && item.verdict === 'pending'
          && !item.superseded_by && !item.retired_at && !item.deleted_at),
        skipped: pendingOut.skipped,
      }
      // 技能账本：用了技能就回填结果；撞到障碍就按签名计数（连续 3 次覆盖并归档）。
      let skillResult = null
      let skillWarning = null
      if (typeof args.skillId === 'string' && args.skillId.trim() !== '') {
        // 与 exp_feedback 同口径：裸 slug 也要解析套件前缀；解析不了要明确告知，不能静默 missing。
        let slug = ''
        try {
          slug = resolveSkillId(dataDir, args.skillId)
        } catch (error) {
          skillResult = { action: 'missing', slug: args.skillId.trim().replace(/^skill:/, '') }
          skillWarning = String((error && error.message) || error)
        }
        if (slug !== '') {
          const rawBlocked = Array.isArray(args.blockedByList) ? args.blockedByList : args.blockedBy
          const blocked = Array.isArray(rawBlocked)
            ? rawBlocked.filter((item) => typeof item === 'string' && item.trim() !== '')
            : (typeof rawBlocked === 'string' && rawBlocked.trim() !== '' ? [rawBlocked] : [])
          if (blocked.length > 1) {
            skillResult = {
              action: 'multi',
              results: blocked.map((item) => applySkillObstacle(dataDir, slug, { blockedBy: item, label: args.note, intent: args.intent })),
            }
          } else if (blocked.length === 1) {
            skillResult = applySkillObstacle(dataDir, slug, { blockedBy: blocked[0], label: args.note, intent: args.intent })
          } else {
            // 未判定（pending）的技能使用不记 helped：G=0 只是「还没结论」，记成功会虚抬置信度。
            const skillVerdict = result.experience.verdict === 'pending'
              ? 'neutral'
              : (Number(result.experience.G) < 0 ? 'hurt' : 'helped')
            skillResult = applySkillOutcome(dataDir, slug, skillVerdict, { intent: args.intent })
          }
          const warning = skillResult.action === 'multi'
            ? (skillResult.results.find((item) => typeof item.warning === 'string') || {}).warning
            : skillResult.warning
          if (typeof warning === 'string') skillWarning = warning
        }
      }
      const typeInfo = result.type || {}
      const sanitized = result.sanitized || {}
      // 回执必须说实际落盘的标签：store.normalizeContext 会去重/截到 8 个，
      // 不能把调用方传的 9 个原样报成成功。
      const savedTags = normalizeContext(result.experience.context)
      const savedFacets = groupByFacet(savedTags)
      const savedMissingFacets = TAG_REQUIRED_FACETS.filter((facet) => savedFacets[facet].length === 0)
      const overflowTags = allTags.filter((tag) => !savedTags.some((saved) => saved.toLowerCase() === tag.toLowerCase()))
      const finalTagWarning = (ctxGiven || lblGiven)
        ? [
          ...savedMissingFacets.map((facet) => TAG_FACET_HINTS[facet]),
          ...rejectedTags.map((item) => `已忽略「${item.value}」：${item.reason}`),
          overflowTags.length > 0
            ? `标签最多保留 ${TAG_MAX_COUNT} 个，已保留：${savedTags.join('、')}；被截断/丢弃：${overflowTags.join('、')}`
            : '',
        ].filter(Boolean).join('；')
        : ''
      const pending = config.pendingReceipt === false
        ? []
        : pendingOut.rows.map((item) => ({ id: item.id, brief: pendingBrief(item, { quote: pendingQuote(item), edit: pendingEdit(item) }) }))
      const receipt = slimReceipt({
        action: result.action,
        id: result.experience.id,
        verdict: result.experience.verdict,
        hits: result.experience.hits,
        outcome: result.experience.outcome,
        G: result.experience.G,
        typeName: result.experience.typeName,
        dimensions: Array.isArray(result.experience.dimensions) && result.experience.dimensions.length > 0 ? result.experience.dimensions : undefined,
        typeCreated: typeInfo.created === true || fastTypeCreated === true ? true : undefined,
        typeMergedInto: typeInfo.mergedInto || undefined,
        // 未分类不再静默（0.21.3 D2）：类型被拒或被判「没有类型」都要回执告诉模型。
        // 自动记录不谈「补一次 typeName」（那条回执不给模型看），只留 rejected 的说法。
        typeWarning: typeInfo.rejected
          ? `${typeInfo.reason}（已归「未分类」）`
          : !isAutoRecord && ['no-type', 'generic-name', 'invalid-name'].includes(String(typeInfo.reason || ''))
            ? '本条未分类——能分就再补一次 typeName，分不出来就保持原样。'
            : undefined,
        typeRecoveredFromNote: result.typeRecoveredFromNote === true ? true : undefined,
        noteSanitized: sanitized.note === true || sanitized.intent === true || sanitized.action === true ? true : undefined,
        routedCluster,
        supersededId: result.supersededId || undefined,
        retired: Array.isArray(result.retired) && result.retired.length > 0 ? result.retired : undefined,
        count: activeCount,
        // outcome 与分步回报反号时明确提示：G 取最弱一步，统计会按 G 记失败（2026-11-07）。
        signWarning: result.signMismatch === true
          ? `outcome（${result.experience.outcome}）与分步回报反号：G=${result.experience.G} 取最弱一步，统计会按 G 记失败。`
          : undefined,
        verdicts: verdictSummary(verdictResults),
        pending: pending.length > 0 ? pending : undefined,
        // 标签：归一后的清单 + 被丢弃的原文 + 缺面提示。模型看到 tagWarning 就能当场补一个动作标签。
        tags: savedTags.length > 0 ? savedTags : undefined,
        tagsRejected: rejectedTags.length > 0 ? rejectedTags.map((item) => item.value) : undefined,
        tagWarning: finalTagWarning === '' ? undefined : finalTagWarning,
        ...(skillResult === null ? {} : { skill: skillResult }),
        ...(skillWarning === null ? {} : { skillWarning }),
      })
      logUsage(dataDir, {
        tool: 'exp_record',
        op: result.action,
        id: result.experience.id,
        intent: result.experience.intent,
        action: result.experience.action,
        outcome: result.experience.outcome,
        verdict: result.experience.verdict,
        typeName: result.experience.typeName,
        hits: result.experience.hits,
        chars: measure(receipt),
        ...(skillResult === null ? {} : {
          skill: {
            action: skillResult.action,
            ...(typeof skillResult.slug === 'string' ? { slug: skillResult.slug } : {}),
            ...(typeof skillResult.signature === 'string' ? { signature: skillResult.signature } : {}),
            commit: skillResult.commit === true,
            warned: typeof skillWarning === 'string',
          },
        }),
      }, usageOptions)
      return receipt
      })
    },
  })

  const recall = defineTool({
    name: 'exp_recall',
    description: '按任务意图召回历史经验。默认先做簇路由（确定性的簇内检索，无同族回退全库）；返回 brief（记忆简报）、route（路由结果）与 candidates。mode=advantage：按 JitRL 优势排序；mode=evidence：无成败对照，Â 不具区分度，改按相似度×证据强度排序。',
    parameters: {
      intent: { type: 'string', description: '当前任务意图。写「对象+任务+关键约束」（如「给研学课 PPT 插一页（深蓝色调）」）；只写「再来一页」这种省略句会因相似度不足召回不到。用 skill 直接取技能时可省略。' },
      skill: { type: 'string', description: '可选：直接取这个技能（slug 或 id；可带 skill: 前缀，也可原样用目录条目名 engram:<slug>，两种前缀都剥）。给了就跳过检索，按本会话三态决定给全文还是复用回执；找不到返回 no-such-skill，不退回普通召回。' },
      group: { type: 'string', description: '可选：按技能组取名字（组名 = skills/ 顶层目录名，如「动画」「ai-base-tools」；根下独立技能组名「未分组」）。返回组内技能名 + 一句话描述，不含正文；组不存在明确报错。' },
      family: { type: 'string', description: '可选：按动作族取经验（族名见提示段「经验族」行，如「写断言」「未分族」）。只读该族分片、不扫全库；族内 >8 条按相似度排，否则按最近使用倒序直接给；族不存在明确报错。' },
      load: { type: 'boolean', description: '可选：true 时强制给全文（忽略复用态）。配合 skill 做「对不上锚点/压缩后重取」。' },
      limit: { type: 'number', description: '返回几条候选做法，默认 3；显式给就按给的值（≤8，簇内也不截到 4）。改稿/纠错要看「上次那条」时给 5~6。' },
      cluster: { type: 'string', description: '可选：直接指定簇（类型名或 id），跳过路由。' },
      context: { type: 'array', description: '可选：当前任务的情境线索；给了就优先召回情境匹配的经验。' },
      mark: { type: 'boolean', description: '可选：把这次召回记为一次「主动提取」（累加 retrievals，用于证据展示，不改排序）。' },
      all: { type: 'boolean', description: '可选：强制全库检索，忽略路由。' },
      cold: { type: 'boolean', description: '可选：查冷档（超出容量上限被下沉的老经验，默认不参与召回）。只读，不写盘。' },
      detail: { type: 'boolean', description: '可选：返回完整回执（含全部字段与长 note）；默认瘦身档省 token。' },
      includeMismatched: { type: 'boolean', description: '可选：appliesTo 明确不匹配当前环境的经验默认不返回；传 true 时返回并标注 applicability=mismatch。' },
      currentEnv: { type: 'object', description: '可选：本次调用覆盖设置里的运行环境 { models?: string[], tools?: string[], environment?: string }；未给的字段沿用设置。', properties: { models: { type: 'array', items: { type: 'string' } }, tools: { type: 'array', items: { type: 'string' } }, environment: { type: 'string' }, model: { type: 'string' }, tool: { type: 'string' } }, additionalProperties: false },
      tagShadow: { type: 'boolean', description: '可选：只计算标签排序的影子对照（tagShadow 元数据：queryTags / tagTop 前 5 / 当前候选前 5 / overlapAt5），不改变 candidates 的顺序与数量；默认关闭，也可由 config.tagShadow 打开。' },
      verdicts: { type: 'array', description: '可选：顺手回填回执里的 pending，[{id,outcome,dimensions?}]。' },
    },
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    execute(args = {}, exec) {
      const dataDir = dataDirOf()
      // cold:true 只查冷档（P2）：冷档默认不参与召回，这是显式入口；cold 模式只读、不写盘。
      const coldMode = args.cold === true
      // 显式按技能取（0.21.0 P0）：`exp_recall({skill:'<slug>', load:true})`。
      // 给了 skill 就跳过检索，直接按本会话三态决定给全文还是复用回执；找不到明确报错，不静默退回普通召回。
      const explicitSkill = args.skill === undefined || args.skill === null ? '' : String(args.skill).trim()
      if (explicitSkill !== '') {
        return withStoreLock(dataDir, () => {
          const host = hostSessionOf(exec)
          // 技能名前缀：显式 id 用 skill:，会话技能目录里的条目名是 engram:<slug>（计划书 §3.2），
          // 两种都剥；模型照目录清单原样回填也必须能命中，否则压缩恢复第一跳就断。
          const raw = explicitSkill.replace(/^(?:skill|engram):/i, '').trim()
          let skill = null
          try {
            skill = readSkillBySlug(dataDir, resolveSkillId(dataDir, raw))
          } catch {
            skill = null
          }
          // 全局注册过的技能不在 listSkills({onlyLocal:true}) 里，裸 slug 直接读一次兜底。
          if (skill === null) {
            try {
              skill = readSkillBySlug(dataDir, raw)
            } catch {
              skill = null
            }
          }
          if (skill === null) return { error: 'no-such-skill', tried: explicitSkill }
          const intent = String(args.intent || '')
          const cfg = catalogConfigOf(config)
          const rawBody = String(skill.body || '')
          // 总开关 false：完全退回 0.20.9 行为（不记账、不判定、每次全文）。
          const decision = cfg.enabled
            ? skillGiveDecision({
              sessionId: host.sessionId,
              session: hostSessionObjectOf(exec),
              slug: skill.slug,
              body: rawBody,
              visible: visibleSeqsOf(exec),
              load: args.load === true,
              reuseReceipt: cfg.reuseReceipt,
              maxGiven: cfg.maxSkills,
            })
            : null
          const runtime = skillRuntimeOf(skill)
          const catalogUsage = skillCatalogUsageOf(host.sessionId, config)
          // 复用命中只记 usage 行：绝不改 uses/lastUsedAt（uses === helped + hurt 是硬不变量）。
          if (decision !== null && decision.state === 'reuse') {
            const receipt = buildReuseReceipt({ slug: skill.slug, entry: decision.entry, skillFile: runtime === null ? '' : runtime.skillFile })
            logUsage(dataDir, {
              tool: 'exp_recall',
              intent,
              mode: 'skill-reuse',
              skill: skill.slug,
              hit: true,
              reused: 'reuse',
              reuseReason: decision.reason,
              ...(host.sessionId === '' ? {} : { session: sessionHashOf(host.sessionId) }),
              bodyHash: decision.bodyHash,
              ...catalogUsage,
              chars: measure(receipt),
            }, usageOptions)
            return receipt
          }
          const bodyMode = String(config.skillBodyMode || '').toLowerCase() === 'clip' ? 'clip' : 'full'
          const bodyCap = bodyMode === 'clip' ? 6000 : Math.max(6000, Number(config.skillBodyMaxChars) || 30000)
          const clipped = clipSkillBody(rawBody, bodyCap)
          const payload = {
            mode: 'skill',
            intent,
            skill: {
              id: skill.slug,
              name: skill.name,
              description: skill.description,
              body: clipped.truncated
                ? `${clipped.text}\n…（正文过长已截断，共 ${rawBody.length} 字符；完整内容用 read 读 ${runtime !== null ? runtime.skillFile : '技能目录下的 SKILL.md'}）`
                : clipped.text,
              ...(clipped.truncated ? { bodyTruncated: true, bodyChars: rawBody.length } : {}),
              runtime,
              context: skill.meta.context,
              files: (skill.meta.files || []).map((item) => item.path),
              confidence: { ...skill.meta.confidence, reason: confidenceReason(skill.meta) },
            },
            candidates: [],
            recent: [],
            pendingSkills: 0,
            note: '按 skill 指定直接取正文：照做；成功用 exp_feedback 回填，遇阻记 skillId+blockedBy。'
              + (runtime !== null && runtime.scripts.length > 0 ? ` ${runtime.usage}` : ''),
            ...(decision === null ? {} : {
              give: { state: decision.state, reason: decision.reason },
              ...(decision.reason === 'shadowed' ? { regiveNote: '上文版本可能已被压缩，以此为准。' } : {}),
            }),
          }
          logUsage(dataDir, {
            tool: 'exp_recall',
            intent,
            mode: 'skill',
            skill: skill.slug,
            hit: true,
            ...(decision === null ? {} : {
              reused: decision.state,
              reuseReason: decision.reason,
              bodyHash: decision.bodyHash,
              ...(host.sessionId === '' ? {} : { session: sessionHashOf(host.sessionId) }),
              ...catalogUsage,
            }),
            chars: measure(payload),
          }, usageOptions)
          return payload
        })
      }
      // 0.37 P2：按组取名字（L1）。只给名字与一句话，不给正文；正文走 {skill}。
      const explicitGroup = args.group === undefined || args.group === null ? '' : String(args.group).trim()
      if (explicitGroup !== '') {
        const grouped = skillGroupsOf(listSkillsCached(dataDir, { onlyLocal: true }))
        const wanted = explicitGroup.toLowerCase()
        // 真实组优先：「未分组」本身是伪组名，若盘上恰好有同名目录，不能让伪组把它遮住（首轮健壮性抓到）。
        const realGroup = grouped.groups.find((item) => item.name === explicitGroup)
          || grouped.groups.find((item) => item.name.toLowerCase() === wanted)
          || null
        const pickedGroup = realGroup !== null
          ? realGroup
          : (explicitGroup === '未分组' || wanted === 'ungrouped'
            ? { name: '未分组', skills: grouped.ungrouped }
            : null)
        if (pickedGroup === null) {
          const names = [...grouped.groups.map((item) => item.name), '未分组'].join('、')
          throw new Error(`没有这个技能组：${explicitGroup}（现有：${names}）`)
        }
        const rows = pickedGroup.skills.map((skill) => ({
          name: String(skill.slug || skill.id || ''),
          description: String(skill.description || '').replace(/\s+/gu, ' ').trim().slice(0, 80),
        }))
        const payload = {
          mode: 'skill-group',
          group: pickedGroup.name,
          count: rows.length,
          skills: rows,
          note: '组内技能名与一句话描述（不含正文）。要用哪个就 exp_recall({skill:"<name>"}) 取正文。',
        }
        logUsage(dataDir, {
          tool: 'exp_recall',
          intent: String(args.intent || ''),
          mode: 'skill-group',
          group: pickedGroup.name,
          skills: rows.length,
          hit: rows.length > 0,
          chars: measure(payload),
        }, usageOptions)
        return payload
      }
      // 0.37 P6：按动作族取经验（E1）。分片本来就按族存，只读那一个文件，不扫全库。
      const explicitFamily = args.family === undefined || args.family === null ? '' : String(args.family).trim()
      if (explicitFamily !== '') {
        const manifest = readManifest(dataDir)
        const rows = readFamilyByName(dataDir, explicitFamily)
        const visibleRows = rows.filter((row) => !row.deleted_at && !row.superseded_by && !row.retired_at)
        const familyLimit = Math.max(1, Math.min(8, Math.trunc(Number(args.limit) || 3)))
        const FAMILY_RANK_THRESHOLD = 8
        // 两个分支的候选形状必须一致（首轮白盒抓到的缺陷）：都扁平成 {id,intent,action,outcome,G,lastSeenAt}。
        // rankExperiences 的候选把行字段包在 evidence[0] 里，扁平化时按「顶层优先、evidence 兜底」取。
        const flatCandidate = (row) => {
          const source = (Array.isArray(row.evidence) && row.evidence[0]) || {}
          return {
            id: row.id || source.id || '',
            intent: row.intent !== undefined ? row.intent : (source.intent !== undefined ? source.intent : ''),
            action: row.action !== undefined ? row.action : (source.action !== undefined ? source.action : ''),
            outcome: row.outcome !== undefined ? row.outcome : source.outcome,
            G: row.G !== undefined ? row.G : source.G,
            lastSeenAt: row.lastSeenAt || row.ts || source.lastSeenAt || source.ts || '',
          }
        }
        // 族内 >8 条才排序；没给 intent 时没有相似度可算，退回「最近使用倒序」（首轮黑盒抓到的 note 与行为不符）。
        const wantRank = visibleRows.length > FAMILY_RANK_THRESHOLD && String(args.intent || '').trim() !== ''
        const candidates = wantRank
          ? (rankExperiences({ types: manifest !== null ? manifest.types : [], experiences: visibleRows }, String(args.intent || ''), familyLimit).candidates || [])
            .map(flatCandidate)
          : visibleRows
            .slice()
            .sort((left, right) => String(right.lastSeenAt || right.ts || '').localeCompare(String(left.lastSeenAt || left.ts || '')))
            .slice(0, familyLimit)
            .map(flatCandidate)
        const payload = {
          mode: 'family',
          family: explicitFamily,
          count: visibleRows.length,
          candidates,
          note: wantRank
            ? '族内超过 8 条，按相似度排了前几条；要别的做法换 intent 或给 limit。'
            : (visibleRows.length > FAMILY_RANK_THRESHOLD
              ? '族内超过 8 条但没给 intent，按最近使用倒序给前几条；要相似度排序请带 intent。'
              : '族内不足 8 条，按最近使用倒序直接给，没算相似度。'),
        }
        logUsage(dataDir, {
          tool: 'exp_recall',
          intent: String(args.intent || ''),
          mode: 'family',
          family: explicitFamily,
          candidates: candidates.length,
          hit: candidates.length > 0,
          chars: measure(payload),
        }, usageOptions)
        return payload
      }
      if (String(args.intent || '').trim() === '') {
        throw new Error('exp_recall 需要 intent（或用 skill 直接取某个技能）')
      }
      return withStoreLock(dataDir, () => {
      // P3-B（T1）：manifest 是只读路径入口；需要全量时再懒读，避免「命中簇也读全库」。
      const manifest = coldMode ? null : readManifest(dataDir)
      let fullStoreCache = null
      const fullStore = () => {
        if (fullStoreCache === null) fullStoreCache = coldMode ? readColdStore(dataDir) : readStore(dataDir)
        return fullStoreCache
      }
      const host = hostSessionOf(exec)
      const hostCwd = host.cwd !== '' ? host.cwd : (config.cwd || process.cwd())
      // 召回也要拿到当前会话：pending 只发本会话的，回填也只能结自己的账。
      // 宿主给了确切 agent/session id 就直接用；否则退回本工作区最近写入的会话。
      let activeSession = null
      if (config.autoBind !== false) {
        try {
          activeSession = host.sessionId !== ''
            ? { sessionId: host.sessionId, file: '', cwd: host.cwd }
            : findActiveSession({ sessionsRoot: config.sessionsRoot, cwd: hostCwd, tool: 'exp_recall', intent: args.intent, dataDir })
        } catch {
          activeSession = null
        }
      }
      const sessionId = coldMode ? undefined : (activeSession === null ? undefined : activeSession.sessionId)
      // 回填（0.13.0）：召回时顺手把上一条 pending 结掉，模型不必为判定新开一次调用。
      // cold 模式只读：不结账、不写盘（否则会把冷档子集当成整库写回去）。
      const verdictResults = !coldMode && Array.isArray(args.verdicts) && args.verdicts.length > 0
        ? resolveVerdicts(fullStore(), args.verdicts, { sessionId, requireSession: config.autoBind !== false })
        : []
      // 技能优先：高确定技能命中时只返回技能本身，不再列具体经验。
      // 只拿还没全局注册的技能：注册过的交给 DSH 当普通技能用，经验库不再排序它
      // cold 模式不参与技能匹配：查冷档就是查冷档，别被技能正文盖掉。
      // 0.37 P0：走 mtime 签名缓存，28 个技能从 175ms 降到 <5ms；目录一变当次可见。
      const skills = coldMode ? [] : listSkillsCached(dataDir, { onlyLocal: true })
      const pendingSkills = skills.filter((skill) => skill.meta.pendingCommit === true).length
      const routing = coldMode || args.all === true
        ? 'off'
        : (config.routing === 'shadow' ? 'shadow' : config.routing === 'off' ? 'off' : 'on')
      let clusterId
      if (args.cluster !== undefined && args.cluster !== null && String(args.cluster).trim() !== '') {
        const type = findType(manifest !== null ? manifest.types : fullStore().types, String(args.cluster))
        if (type === null) throw new Error(`没有这个簇：${String(args.cluster)}（用 exp_type list 看现有类型）`)
        clusterId = type.id
      }
      const recallLimit = Math.max(1, Math.min(8, Math.trunc(Number(args.limit) || Number(config.recallLimitDefault) || 3)))
      const recentRequested = !coldMode && config.recent !== false
      const recentAllSessions = config.autoBind === false
      const sessionIdText = sessionId === undefined ? '' : String(sessionId)

      /**
       * 命中簇时只读「主簇 + 次簇(≥0.7×主) + 未分类」的分片，再走同一个 rankExperiences。
       * 回退全量的条件（任一命中）：无 manifest / 冷档 / routing≠on / 有 verdicts 回写 /
       * recent 需要跨全部会话却没有索引 / 路由 fallback / 收窄后不足 3 条（rankExperiences 此时本来就会退回全量 pool）。
       * 写回（mark / pending 提醒）走 writeTypeShards + touched 类型的全部行；
       * 红线：partial store 绝不交给 writeStore。
       */
      const canDownPush = manifest !== null && !coldMode && routing === 'on'
        && verdictResults.length === 0
        && !(recentRequested && recentAllSessions && sessionIdText === '')
      let store = null
      let usedPartial = false
      let recentRows = null
      if (canDownPush) {
        const route = clusterId !== undefined
          ? { clusterId, candidates: [], fallback: false, score: 1 }
          : routeCluster({ types: manifest.types, clusters: manifest.clusters }, String(args.intent || ''))
        if (route !== null && route.fallback !== true && typeof route.clusterId === 'string' && route.clusterId !== '') {
          const typeIds = new Set([String(route.clusterId), SYSTEM_TYPE.id])
          const second = Array.isArray(route.candidates) ? route.candidates[1] : undefined
          const secondUsable = second !== undefined && second !== null && String(second.clusterId || '') !== ''
            && String(second.clusterId) !== String(route.clusterId)
            && Number(second.score) >= Number(route.score) * 0.7
          if (secondUsable) typeIds.add(String(second.clusterId))
          const loaded = readShardRecordsOfTypes(dataDir, manifest, [...typeIds])
          const visibleRows = loaded.records.filter((row) => row && !row.deleted_at && !row.superseded_by && !row.retired_at && row.verdict !== 'skipped')
          const primaryRows = visibleRows.filter((row) => String(row.typeId) === String(route.clusterId) || String(row.typeId) === SYSTEM_TYPE.id)
          const secondaryRows = secondUsable ? visibleRows.filter((row) => String(row.typeId) === String(second.clusterId)) : []
          if (primaryRows.length + secondaryRows.length >= 3) {
            store = { version: manifest.version, types: manifest.types, clusters: manifest.clusters, experiences: loaded.records }
            usedPartial = true
            if (recentRequested) {
              if (sessionIdText === '' && !recentAllSessions) {
                // recent 默认 fail-closed：没有会话就没有 recent，命中路径给空数组即可。
                recentRows = []
              } else {
                const entries = (Array.isArray(manifest.recent) ? manifest.recent : [])
                  .filter((entry) => entry !== null && typeof entry === 'object' && String(entry.id || '') !== ''
                    && (sessionIdText === '' || String(entry.sessionId || '') === sessionIdText))
                recentRows = readRecordsByIds(dataDir, manifest, entries.map((entry) => ({ id: String(entry.id), typeId: String(entry.typeId || SYSTEM_TYPE.id) })))
              }
            }
          }
        }
      }
      if (store === null) store = fullStore()
      // autoBind=false 是显式「不绑会话」模式（headless/脚本/运维）：发 recentAllSessions 拿全量。
      // 默认模式认不出会话时 recent 默认 fail-closed（store.js），绝不跨会话泄漏。
      // 运行环境（P1）：设置里的 currentModel/currentTool/currentEnvironment 为默认，
      // 本次调用的 currentEnv 字段级覆盖；都没有时是空环境 → applicability=unscoped（不硬拦）。
      const currentEnv = mergeRuntimeEnv(readRuntimeEnv(config), args.currentEnv)
      // 0.25.0 P1：标签进查询（复用 contextMatch，不新增排序代码）。
      // - on：把自动抽出的 queryTags 并进 context（显式传的 context 在前、自动的补充）；
      // - shadow：照常召回，只把「会加什么标签」记进 usage，不改候选；
      // - off：完全不抽（退回 0.24.x 行为）。
      const tagRankMode = coldMode ? 'off' : (config.tagRank === 'on' ? 'on' : (config.tagRank === 'off' ? 'off' : 'shadow'))
      // 显式 context 统一清洗（off 档也用清洗后的值，影子才与 off 完全一致）：先滤掉 String() 会抛错的项，
      // 再去掉空串、先滤后切 8 个——先切后滤会丢掉「前 8 项全是空值」里的第 9 个合法标签。
      const explicitProvided = args.context !== undefined && args.context !== null
      const explicitTags = normalizeContext(
        Array.isArray(args.context)
          ? args.context
            .filter((tag) => {
              try {
                String(tag)
              } catch {
                return false
              }
              return typeof tag === 'string' && tag.trim() !== ''
            })
            .slice(0, TAG_MAX_COUNT)
          : args.context,
      )
      let rankContext = explicitProvided ? explicitTags : args.context
      let tagRankShadow = null
      // 声明放在块外：weak 清空判断在 if 块外读它（R3 缺陷：块内 const 在块外不可见，弱相关召回必崩）。
      let tagRankAppliedNow = false
      let tagQuery = null
      if (tagRankMode !== 'off') {
        try {
          ensureTagOverrides(dataDir)
        } catch {
          // 词表覆盖读坏不拖垮召回：按内建词表抽词。
        }
        // 抽词只看前 12000 字：标签是短词，2MB 意图没必要整段扫描（超长文本会拖慢召回）。
        const queryFacets = extractQueryTags(String(args.intent || '').slice(0, 12000))
        const autoTags = flattenQueryTags(queryFacets)
        // 显式优先：contextMatch 的分母是「查询标签数」，合并会稀释显式标签的命中（2/2 变 2/7），
        // 所以只要调用方给了 context（哪怕是空数组/全非法），就只用显式；完全没给才用自动抽的标签。
        const mergedTags = explicitProvided ? explicitTags : autoTags
        // on：自动标签走「对象→动作 软优先」（tagScore 按 IDF 加权，只加分不筛池），不再占用 contextMatch；
        // 显式 context 仍按老口径（调用方明确要情境优先，行为不变）。
        if (tagRankMode === 'on' && !explicitProvided) {
          tagQuery = { action: queryFacets.action.slice() }
          tagRankAppliedNow = tagQuery.action.length > 0
          rankContext = []
        } else {
          tagRankAppliedNow = tagRankMode === 'on' && mergedTags.length > 0
          if (tagRankMode === 'on') rankContext = mergedTags
        }
        if (tagRankMode === 'shadow') tagRankShadow = { mode: 'shadow', queryTags: autoTags, action: queryFacets.action.length, explicit: explicitTags.length, merged: mergedTags.length }
      }
      const rankOptions = { routing, clusterId, consolidation: config.consolidation, consolidationMinSamples: config.consolidationMinSamples, context: rankContext, tagBonusOnly: tagRankAppliedNow && tagQuery !== null, tagQuery, explicitLimit: Number(args.limit) > 0, rankBlend: config.rankBlend !== false, recent: recentRequested, recentAllSessions, sessionId: coldMode ? '' : sessionIdText, includeMismatched: args.includeMismatched === true, current: currentEnv }
      if (Array.isArray(recentRows)) rankOptions.recentRows = recentRows
      const result = rankExperiences(store, String(args.intent || ''), recallLimit, rankOptions)
      // 类型路由影子（P1）：只在显式 tagShadow / config.tagShadow 时计算；只读、不碰 candidates。
      const tagShadowEnabled = args.tagShadow === true || config.tagShadow === true
      const buildTagShadow = (routingCandidates = result.candidates) => {
        // 用户覆盖词表（<dataDir>/tag-registry.json）也参与影子；按目录缓存，读一次。
        try {
          ensureTagOverrides(dataDir)
        } catch {
          // 覆盖文件读坏不拖垮召回：影子按内建词表算。
        }
        const ranked = rankByTags(fullStore(), String(args.intent || ''), { limit: 5 })
        const typeRoutingTop = (routingCandidates || [])
          .map((candidate) => ((candidate.evidence || [])[0] || {}).id)
          .filter((id) => typeof id === 'string' && id !== '')
          .slice(0, 5)
        const tagTopIds = ranked.top.map((item) => item.id)
        return {
          queryTags: ranked.queryTags,
          tagTop: ranked.top,
          typeRoutingTop,
          overlapAt5: tagTopIds.filter((id) => typeRoutingTop.includes(id)).length,
          ...(ranked.note === undefined ? {} : { note: ranked.note }),
        }
      }
      // 相似度低于 0.20 且判 weak：不展示噪声候选（无关任务时避免「1 条沾边候选」被当推荐）。
      // tagRank=on 时标签重排会压低「展示条最高词面相似度」，此时清空会把正常召回打成 0 条；
      // 自动标签是加分信号，不该拥有「清空候选」的权力，所以 on 档跳过这道清空。
      if (result.weak === true && Number(result.topSimilarity || 0) < 0.2 && !tagRankAppliedNow) result.candidates = []
      result.pendingSkills = pendingSkills
      // 待判定：随回执带出（≤2 条）。cold 模式不查待判定、更不写盘。
      // partial 路径用 manifest.pending 的 id+typeId 定向读 pending 所在类型，再定向写回
      // （task-6 的 writeTypeShards 会就地重算 touched 类型的 stats/recent，不在这里手工算）。
      let pendingOut
      if (coldMode) {
        pendingOut = { rows: [], skipped: [] }
      } else if (usedPartial && manifest !== null && Array.isArray(manifest.pending) && manifest.pending.length > 0) {
        const refs = manifest.pending
          .map((entry) => ({ id: String((entry && entry.id) || ''), typeId: String((entry && entry.typeId) || SYSTEM_TYPE.id) }))
          .filter((ref) => ref.id !== '')
        const pendingTypeIds = [...new Set(refs.map((ref) => ref.typeId))]
        const loadedPending = readShardRecordsOfTypes(dataDir, manifest, pendingTypeIds)
        const pendingStore = { version: manifest.version, types: manifest.types, clusters: manifest.clusters, experiences: loadedPending.records }
        pendingOut = pendingTasks(pendingStore, 2, { pendingTtl: config.pendingTtl, sessionId, strict: config.autoBind !== false })
        if (pendingOut.rows.length > 0 || pendingOut.skipped.length > 0) {
          const rowsByType = groupRowsByType(pendingStore.experiences)
          writeTypeShards(dataDir, readManifest(dataDir), {
            touchedTypeIds: pendingTypeIds,
            rowsByType: Object.fromEntries(pendingTypeIds.map((typeId) => [typeId, rowsByType[typeId] || []])),
          })
        }
      } else {
        pendingOut = pendingTasks(store, 2, { pendingTtl: config.pendingTtl, sessionId, strict: config.autoBind !== false })
      }
      const verdictWrote = verdictResults.some((item) => item.ok)
      const fullPendingWrote = !usedPartial && (pendingOut.rows.length > 0 || pendingOut.skipped.length > 0)
      if (!coldMode && (verdictWrote || fullPendingWrote)) {
        if (fullStoreCache === null) throw new Error('P3-B 内部错误：写回需要全量 store，但当前是 partial 读路径（partial store 不能交给 writeStore）')
        writeStore(dataDir, fullStoreCache)
      }
      const pending = config.pendingReceipt === false
        ? []
        : pendingOut.rows.map((item) => ({ id: item.id, brief: pendingBrief(item, { quote: pendingQuote(item), edit: pendingEdit(item) }) }))
      // 归纳提示（实验，2026-11-07）：同族样本够多时给一段原料让模型自己归纳；config.induction=false 可关。
      if (config.induction !== false) {
        // 归纳只用「本次可见」的候选：提示里写的是「本次可见 N 条」，N 必须与返回条数一致。
        const induction = buildInduction(result.candidates, { minSamples: config.inductionMinSamples })
        if (induction !== null) result.induction = induction
      }
      // 提取即强化（0.26.0）：只有调用方显式 mark 才记「主动提取」次数，读到不写、不污染排序。
      if (!coldMode && args.mark === true) {
        const recalledIds = new Set(result.candidates.flatMap((candidate) => (candidate.evidence || []).map((evidence) => evidence.id)))
        let marked = 0
        const markedTypes = new Set()
        for (const row of store.experiences) {
          if (!recalledIds.has(row.id)) continue
          row.retrievals = (Number(row.retrievals) || 0) + 1
          marked += 1
          markedTypes.add(String(row.typeId || SYSTEM_TYPE.id))
        }
        if (marked > 0) {
          if (usedPartial && manifest !== null) {
            // 只重写「被 mark 的类型」；rowsByType 是该类型的全部行（含 tombstone），红线不放宽。
            const rowsByType = groupRowsByType(store.experiences)
            const touchedTypeIds = [...markedTypes]
            writeTypeShards(dataDir, readManifest(dataDir), {
              touchedTypeIds,
              rowsByType: Object.fromEntries(touchedTypeIds.map((typeId) => [typeId, rowsByType[typeId] || []])),
            })
          } else {
            writeStore(dataDir, store)
          }
        }
        result.marked = marked
      }
      // 瘦身（0.13.0）：默认只回 2 条、去掉重复字段与空值；detail:true 返回原始 payload。
      const payload = args.detail === true || config.slimRecall === false
        ? result
        : slimRecall(result, { limit: recallLimit })
      if (payload !== null && typeof payload === 'object') {
        if (pending.length > 0) payload.pending = pending
        if (verdictResults.length > 0) payload.verdicts = verdictSummary(verdictResults)
        if (typeof result.induction === 'string') payload.induction = result.induction
        if (Number(result.marked) > 0) payload.marked = Number(result.marked)
        payload.pendingSkills = pendingSkills
        // 运行环境回执（P1）：让模型知道「这次按什么环境判断适用性」，以及哪些经验被环境门控隐藏/降权。
        const envDeclared = currentEnv.models.length > 0 || currentEnv.tools.length > 0 || currentEnv.environment !== ''
        if (envDeclared) payload.currentEnv = { models: currentEnv.models, tools: currentEnv.tools, environment: currentEnv.environment }
        const applicabilityNotes = []
        if (Number(result.applicabilityFiltered) > 0) {
          payload.applicabilityFiltered = Number(result.applicabilityFiltered)
          applicabilityNotes.push(`有 ${result.applicabilityFiltered} 条经验的适用范围与当前运行环境不匹配，已默认隐藏（需要历史方案时传 includeMismatched:true）。`)
        }
        const shownCandidates = Array.isArray(payload.candidates) ? payload.candidates : []
        const partialCount = shownCandidates.filter((candidate) => candidate && candidate.applicability === 'partial').length
        const mismatchCount = shownCandidates.filter((candidate) => candidate && candidate.applicability === 'mismatch').length
        if (partialCount > 0) applicabilityNotes.push(`${partialCount} 条只部分匹配当前环境，已降权。`)
        if (mismatchCount > 0) applicabilityNotes.push(`${mismatchCount} 条明确不匹配当前环境（includeMismatched 显式打开），仅作历史参考。`)
        if (applicabilityNotes.length > 0) payload.applicabilityNote = applicabilityNotes.join(' ')
        if (coldMode) {
          payload.cold = true
          payload.note = `冷档查询：只返回超出容量上限被下沉的老经验（默认召回不含它们）。${payload.note === undefined ? '' : payload.note}`
        }
        // 类型路由影子（P1）：只追加元数据，candidates 保持原顺序/数量（上面所有步骤已完成）。
        if (tagShadowEnabled) payload.tagShadow = buildTagShadow()
      }
      logUsage(dataDir, {
        tool: 'exp_recall',
        intent: String(args.intent || ''),
        candidates: result.candidates.length,
        neighbors: result.neighbor_count,
        hit: result.candidates.length > 0,
        mode: result.mode,
        cold: coldMode,
        route: result.route && result.route.fallback === false ? result.route.name : '(fallback)',
        route_score: result.route ? result.route.score : null,
        limit: recallLimit,
        ids: result.candidates.slice(0, 3).map((candidate) => ((candidate.evidence || [])[0] || {}).id).filter(Boolean),
        induction: typeof result.induction === 'string',
        marked: args.mark === true,
        markedCount: Number(result.marked) || 0,
        // 影子 top5 落盘（0.21.3 计划书 §21.1）：只记 id 与重合度，够算「重合度 / 增量」两个判据，
        // 不写正文、不改召回结果；tagShadow 关着时这一行不出现。
        // 0.25.0 P1：tagRank=shadow 时把「会加什么标签」也记进来（tagRankApplied），供 P0 报表用。
        ...((tagShadowEnabled && payload.tagShadow !== undefined) || tagRankShadow !== null
          ? {
            shadow: {
              ...(tagShadowEnabled && payload.tagShadow !== undefined
                ? {
                  overlapAt5: payload.tagShadow.overlapAt5,
                  tagTop: (payload.tagShadow.tagTop || []).slice(0, 5).map((item) => item && item.id).filter((id) => typeof id === 'string' && id !== ''),
                  typeTop: (payload.tagShadow.typeRoutingTop || []).slice(0, 5),
                }
                : {}),
              ...(tagRankShadow !== null ? { tagRankApplied: tagRankShadow } : {}),
            },
          }
          : {}),
        chars: measure(payload),
      }, usageOptions)
      return payload
      })
    },
  })

  const feedback = defineTool({
    name: 'exp_feedback',
    description: '用过一条召回的经验之后回报结果：helped（靠它做成了）/ hurt（用了反而返工、被纠正或没帮上）/ neutral（用了但没影响）。反馈按 EMA 修正该条的回报 G（排序依据），不动 hits、不新建条目、不改 outcome；下次召回按新回报排序。',
    parameters: {
      id: { type: 'string', required: true, description: '经验 id（取本轮 exp_recall 返回的 evidence[].id，别拍脑袋给旧条）' },
      result: { type: 'string', enum: ['helped', 'hurt', 'neutral'], required: true, description: '用后结果：helped / hurt / neutral。' },
      intent: { type: 'string', description: '可选：当时任务的意图（只进审计日志，不动经验内容）。' },
      note: { type: 'string', description: '可选：怎么用的、结果如何（≤200 字，只进审计日志）。' },
    },
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    execute(args = {}) {
      const dataDir = dataDirOf()
      // 技能反馈：id 形如 skill:<slug> 时改技能账本，而不是经验条。
      if (String(args.id || '').startsWith('skill:')) {
        // 裸 slug 可能省略套件前缀：解析成真实 id；找不到/有歧义要明确报错（以前静默成功但账本不写）。
        const slug = resolveSkillId(dataDir, String(args.id).slice('skill:'.length))
        if (args.result === 'neutral') {
          return { action: 'skill-neutral', id: args.id, slug, result: 'neutral', hint: 'neutral 不改技能 confidence（没有证据说明更好或更差）。' }
        }
        const out = applySkillOutcome(dataDir, slug, args.result)
        logUsage(dataDir, { tool: 'exp_feedback', id: args.id, result: args.result, skill: slug, confident: out.confident, commit: out.commit }, usageOptions)
        return {
          action: 'skill-feedback',
          id: args.id,
          slug,
          result: args.result,
          confident: out.confident,
          commit: out.commit === true,
          hint: args.result === 'hurt'
            ? 'hurt 会拉低 helped 比例：跌出阈值后召回不再只返回技能，具体经验重新可见。'
            : 'helped 累积到 ≥3 次且比例 ≥0.8 后，该技能才会被高确定召回。',
        }
      }
      return withStoreLock(dataDir, () => {
      const store = readStore(dataDir)
      const result = applyFeedback(store, args.id, { result: args.result, intent: args.intent, note: args.note }, { eta: config.feedbackEta, decayDays: config.feedbackDecayDays })
      writeStore(dataDir, store)
      logUsage(dataDir, {
        tool: 'exp_feedback',
        id: result.id,
        result: result.result,
        G_before: result.G_before,
        G_after: result.G_after,
      }, usageOptions)
      const active = visibleExperiences(store)
      // 提示里写实际用的 η：配置改过 feedbackEta 时不能还硬编码 0.35（2026-11-07 验收）。
      const effectiveEta = Number.isFinite(Number(config.feedbackEta)) ? Number(config.feedbackEta) : FEEDBACK_ETA
      const covered = active.filter((item) => item.feedback !== null && typeof item.feedback === 'object'
        && (Number(item.feedback.helped) || 0) + (Number(item.feedback.hurt) || 0) + (Number(item.feedback.neutral) || 0) > 0).length
      return {
        action: 'feedback',
        ...result,
        hint: result.result === 'neutral'
          ? 'neutral 只计数，G 不变（没有证据说明这条更有效或更差）。'
          : `G ${result.G_before} → ${result.G_after}（EMA η=${effectiveEta}）：下次召回按新回报排序；outcome 仍记的是首次结果。`,
        feedbackCovered: covered,
        count: active.length,
      }
      })
    },
  })

  const consolidateTool = defineTool({
    name: 'exp_consolidate',
    description: '把同族经验沉淀成技能：同族 ≥3 条且 ≥2 正 1 负时，生成 .exp/skills/<slug>/（SKILL.md 标准模板 + skill.json 账本）；相同 slug 再次沉淀会更新定义。可传 body 写正文、files 挂脚本（复制进 scripts/ 并在 SKILL.md 生成「## 脚本」清单）。技能归经验库自己管：不复制到 DSH skills 目录，召回时按需以技能形态返回。技能仍由 Â/障碍计数管理。',
    parameters: {
      intent: { type: 'string', required: true, description: '要沉淀的技能对应的任务意图（与 exp_recall 同一口径）。' },
      // 参数名不能叫 type：它和 JSON Schema 的 type 关键字同名，provider 严格校验会把它
      // 当成 schema 关键字读，报 "is not valid under any of the schemas listed in the anyOf"。
      skillName: { type: 'string', description: '可选：技能名（默认「类型：共同词」）。' },
      context: { type: 'array', description: '可选：技能的情境线索（写入 skill.json 与匹配）。' },
      minSamples: { type: 'number', description: '可选：最少同族条数，默认 3。' },
      body: { type: 'string', description: '可选：手写 SKILL.md 正文（覆盖自动生成模板；脚本用法/步骤写这里）。' },
      files: { type: 'array', description: '可选：附件路径列表（脚本等），复制进 <skill>/scripts/ 并登记到 skill.json。' },
    },
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    execute(args = {}) {
      const dataDir = dataDirOf()
      const store = readStore(dataDir)
      const intent = String(args.intent || '').trim()
      if (intent === '') throw new Error('intent 必填')
      const recalled = rankExperiences(store, intent, 8, { context: args.context })
      const draft = deriveSkillDraft(recalled.candidates, {
        intent,
        context: args.context,
        minSamples: args.minSamples,
        name: args.skillName !== undefined ? args.skillName : args.type,
      })
      if (draft === null) {
        return { action: 'skipped', reason: '同族样本不足或无正负对照（需要 ≥3 条，其中 ≥2 正 ≥1 负；全成功/全失败不沉淀）' }
      }
      const made = createSkill(dataDir, {
        ...draft,
        ...(typeof args.body === 'string' && args.body.trim() !== '' ? { body: args.body } : {}),
      })
      const attached = Array.isArray(args.files) && args.files.length > 0 ? attachSkillFiles(dataDir, made.slug, args.files) : null
      logUsage(dataDir, {
        tool: 'exp_consolidate',
        slug: made.slug,
        derivedFrom: draft.derivedFrom.length,
        commit: made.commit,
        files: attached === null ? 0 : attached.added.length,
      }, usageOptions)
      return {
        action: made.action,
        slug: made.slug,
        derivedFromCount: draft.derivedFrom.length,
        commit: made.commit,
        files: attached === null ? [] : attached.files.map((item) => item.path),
        hint: `技能已写入 .exp/skills/${made.slug}/（归经验库自己管，不写 DSH skills 目录）；${attached === null ? '' : `附件 ${attached.files.length} 个（scripts/）；`}先用 exp_feedback("skill:${made.slug}", "helped") 累积，≥3 次且比例 ≥0.8 后 exp_recall 会只返回它。`,
      }
    },
  })

  const skillAttachTool = defineTool({
    name: 'exp_skill_attach',
    description: '给已有技能挂附件/补正文：files 里的文件复制进 <skill>/scripts/ 并在 SKILL.md 维护「## 脚本」清单；body 会并进正文（保留已有「常见例外/已内化」）。技能留在经验库，不复制到 DSH skills 目录。',
    parameters: {
      slug: { type: 'string', required: true, description: '技能 slug（.exp/skills/ 下的目录名）。' },
      files: { type: 'array', description: '可选：要挂的文件路径列表（脚本/参考材料）；单文件 ≤2MB、总量 ≤8MB。' },
      body: { type: 'string', description: '可选：补进 SKILL.md 的正文（markdown）。' },
    },
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    execute(args = {}) {
      const dataDir = dataDirOf()
      const slug = resolveSkillId(dataDir, args.slug)
      let merged = null
      if (typeof args.body === 'string' && args.body.trim() !== '') {
        const current = readSkillBySlug(dataDir, slug)
        if (current === null) throw new Error(`没有这个技能：${slug}`)
        merged = createSkill(dataDir, {
          slug,
          name: current.name,
          description: current.description,
          body: args.body,
          typeName: current.meta.typeName,
          context: current.meta.context,
          triggers: current.meta.triggers,
        })
      }
      // 先写正文、再挂附件：附件会在正文末尾追加「## 脚本」，反过来会被正文重写覆盖。
      const attached = Array.isArray(args.files) && args.files.length > 0 ? attachSkillFiles(dataDir, slug, args.files) : null
      const skill = readSkillBySlug(dataDir, slug)
      logUsage(dataDir, { tool: 'exp_skill_attach', slug, files: attached === null ? 0 : attached.added.length }, usageOptions)
      return {
        action: 'attached',
        slug,
        files: skill === null ? [] : (skill.meta.files || []).map((item) => item.path),
        bodyUpdated: merged !== null,
        // 只改正文时 attached 为 null，但 createSkill 已经提交过：commit 要按实际来源报。
        commit: attached !== null ? attached.commit === true : (merged !== null && merged.commit === true),
      }
    },
  })

  const typeTool = defineTool({
    name: 'exp_type',
    description: '管理经验主分类：list 列表（含条数）/ labels 列出已有次级分类（写 labels 前先复用）/ create 新建 / rename 改名 / merge 合并（经验批量改挂，源类型删除）/ delete 删除（经验归「未分类」）/ assign 把单条经验改挂到指定类型（定点修脏数据，不动 hits）。主分类唯一；次级分类用 exp_record.labels 多标签。',
    parameters: {
      action: { type: 'string', enum: ['list', 'create', 'rename', 'merge', 'delete', 'assign', 'labels', 'label'], required: true, description: '要执行的动作。' },
      name: { type: 'string', description: 'create/rename/delete 时的类型名或 id（rename 时是旧名）；assign 时的目标类型名。' },
      newName: { type: 'string', description: 'rename 的新名；merge 的目标类型名（不存在会新建）。' },
      names: { type: 'array', description: 'merge 时的来源类型名/id 列表。' },
      id: { type: 'string', description: 'assign 时的经验 id（exp_recall 证据里的 id）。' },
      // 不叫 description：与 JSON Schema 的 description 关键字同名，provider 严格校验会误读。
      typeDescription: { type: 'string', description: 'create/rename 时可选写描述（≤120 字）。' },
      facet: { type: 'string', enum: [...TAG_FACETS], description: `label 时给**新标签**指定面（已登记标签不用给）：${TAG_FACETS.map((key) => `${key}=${TAG_FACET_LABELS[key]}`).join('、')}。新标签会登记进 .exp/tag-registry.json。` },
      tagDescription: { type: 'string', description: 'label 登记新标签时的说明（≤120 字，给人看，不是标签本身）。' },
    },
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    execute(args = {}) {
      const dataDir = dataDirOf()
      return withStoreLock(dataDir, () => {
      const manifest = readManifest(dataDir)
      const action = String(args.action || '').trim()
      if (action === 'label') {
        const store = readStore(dataDir)
        const row = store.experiences.find((item) => item.id === String(args.id || ''))
        if (row === undefined) throw new Error('经验不存在')
        const existing = normalizeContext(row.context)
        const rawLabels = Array.isArray(args.labels) ? args.labels : (args.labels === undefined || args.labels === null || args.labels === '' ? [] : [args.labels])
        const wanted = rawLabels.map((item) => String(item === undefined || item === null ? '' : item).trim()).filter((item) => item !== '')
        // 手动加标签 = 写入口：命名规则从严（项目实例名/版本/路径/句子一律拒绝，不再静默丢弃）。
        const problems = []
        const resolved = []
        for (const raw of wanted) {
          const check = validateNewTagName(raw)
          if (!check.ok) {
            problems.push(`「${raw}」${check.reason}`)
            continue
          }
          if (!resolved.some((name) => name.toLowerCase() === check.name.toLowerCase())) resolved.push(check.name)
        }
        if (problems.length > 0) {
          const error = new Error(`标签不合规：${problems.join('；')}`)
          error.code = 'invalid'
          throw error
        }
        // 未登记的新标签必须指定面（计划书 §5.2 / §8.1-4），登记进 .exp/tag-registry.json 后立即可用。
        const unknown = resolved.filter((name) => facetOf(name) === null)
        if (unknown.length > 0) {
          const facet = String(args.facet || '').trim()
          if (!TAG_FACETS.includes(facet)) {
            const error = new Error(`新标签 ${unknown.map((name) => `「${name}」`).join('')} 必须指定面：facet 取 ${TAG_FACETS.map((key) => `${key}(${TAG_FACET_LABELS[key]})`).join(' / ')}`)
            error.code = 'invalid'
            throw error
          }
          for (const name of unknown) saveTagOverride(dataDir, { name, facet, description: args.tagDescription })
        }
        const merged = [...new Set([...existing, ...resolved])]
        if (merged.length > 8) {
          const error = new Error('标签最多 8 个，请先删掉一些旧标签')
          error.code = 'invalid'
          throw error
        }
        row.context = normalizeContext(merged)
        writeStore(dataDir, store)
        const check = validateTagSet(row.context)
        return {
          action,
          id: row.id,
          labels: row.context,
          tags: row.context,
          tagWarning: check.warning === '' ? undefined : check.warning,
        }
      }
      if (action === 'labels') {
        const store = readStore(dataDir)
        const labels = tagCatalog(store, { limit: 60, dataDir })
        return { action, labels, total: labels.length }
      }
      // T4：list/create 只读 manifest（stats.tasksByType 提供唯一任务数），不加载全量经验。
      // merge/delete/assign/rename 要动经验行或引用名，仍走全量（写路径等 task-6 的 writeTypeShards 能力）。
      let catalogTypes = null
      let result = null
      if (manifest !== null) {
        if (action === 'list') {
          const types = typesFromManifest(manifest)
          if (types !== null) {
            catalogTypes = manifest.types
            result = { action, types }
          }
        } else if (action === 'create') {
          const typeStore = {
            version: manifest.version,
            types: (Array.isArray(manifest.types) ? manifest.types : []).map((type) => ({ ...type })),
            experiences: [],
          }
          const type = createType(typeStore, args.name, args.typeDescription !== undefined ? args.typeDescription : args.description)
          // 新类型是空簇：用 cluster.js 的同一套 ensureClusters 生成，别在 tools 里拼 cluster 结构。
          const cluster = ensureClusters({ types: [type], experiences: [] })[0]
          writeTypeShards(dataDir, manifest, {
            types: typeStore.types,
            clusters: [...(Array.isArray(manifest.clusters) ? manifest.clusters : []), cluster],
            touchedTypeIds: [type.id],
            rowsByType: { [type.id]: [] },
          })
          catalogTypes = typeStore.types
          // 空分类需要落一个带 created:true 的目录，重建时才能保留（R3 缺陷）。
          if (hasFamilyLayout(dataDir)) markFamilyTypeCreated(dataDir, type.id, type.name)
          result = { action, created: type.name, typeId: type.id }
        }
      }
      if (result !== null) {
        logUsage(dataDir, {
          tool: 'exp_type',
          op: action,
          target: String(args.name || args.id || args.newName || ''),
        }, usageOptions)
        result.typeCount = catalogTypes.filter((type) => type.system !== true && type.id !== 'ty_other').length
        result.typeLimit = Math.max(1, Math.trunc(Number(config.maxTypes) || 24))
        return result
      }
      // 回退：无 manifest / stats 缺 tasksByType / rename·merge·delete·assign —— 仍走全量。
      const store = readStore(dataDir)
      if (action === 'list') {
        result = { action, types: listTypes(store) }
      } else if (action === 'create') {
        const type = createType(store, args.name, args.typeDescription !== undefined ? args.typeDescription : args.description)
        result = { action, created: type.name, typeId: type.id }
      } else if (action === 'rename') {
        const renamed = renameType(store, args.name, args.newName, args.typeDescription !== undefined ? args.typeDescription : args.description)
        result = { action, from: renamed.oldName, to: renamed.type.name }
      } else if (action === 'merge') {
        result = { action, ...mergeTypes(store, args.names, args.newName, args.typeDescription !== undefined ? args.typeDescription : args.description) }
      } else if (action === 'delete') {
        result = { action, ...deleteType(store, args.name) }
      } else if (action === 'assign') {
        result = { action, ...assignType(store, args.id, args.name) }
      } else {
        throw new Error(`不支持的类型动作：${action}`)
      }
      writeStore(dataDir, store)
      reconcileFamilyTypeDirs(dataDir, store)
      logUsage(dataDir, {
        tool: 'exp_type',
        op: action,
        target: String(args.name || args.id || args.newName || ''),
      }, usageOptions)
      result.typeCount = store.types.filter((type) => type.system !== true && type.id !== 'ty_other').length
      result.typeLimit = Math.max(1, Math.trunc(Number(config.maxTypes) || 24))
      return result
      })
    },
  })

  const familyTool = defineTool({
    name: 'exp_family',
    description: '管理动作族（0.33）：list 列出真实存在的族 / create 校验并登记新族（首次写入时落盘）/ rename 改名 / merge 合并 / assign 把经验指派到族 / delete 仅允许空族。族名 1–12 字短名词，对象面标签不能当族名。',
    parameters: {
      action: { type: 'string', enum: ['list', 'create', 'rename', 'merge', 'assign', 'delete'], required: true, description: '要执行的动作。' },
      family: { type: 'string', description: 'create 的族名；rename/delete 的旧族名；assign 的目标族名。' },
      newName: { type: 'string', description: 'rename 的新族名；merge 的目标族名。' },
      names: { type: 'array', description: 'merge 的来源族名列表。' },
      ids: { type: 'array', description: 'assign 的经验 id 列表（与 sourceId 二选一）。' },
      sourceId: { type: 'string', description: 'assign 时按 sourceId 批量指派。' },
    },
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    execute(args = {}) {
      const dataDir = dataDirOf()
      return withStoreLock(dataDir, () => {
        const action = String(args.action || '').trim()
        const registry = readFamilyRegistry(dataDir)
        // 0.35：删族前先看对象链是否还引用它（定稿 §10-3：拒删）。
        if (action === 'delete') {
          const name = normalizeFamilyName(args.family)
          const refs = chainReferences(readObjects(dataDir), familyIdSetOf(registry, name))
          if (refs.length > 0) {
            const first = refs[0]
            throw new Error(`族「${name}」还被 ${refs.length} 处对象链引用（如对象「${first.object}」第 ${first.chainIndex} 条链），先把链里的引用改掉再删`)
          }
        }
        const store = readStore(dataDir)
        const { result, changed } = manageFamilies(store, action, args)
        if (changed) writeStore(dataDir, store)
        syncCreatedFamilies(dataDir, action, args, result)
        // 族稳定 id 跟着 rename/merge 走：rename 只改 name，merge 把来源 id 记进目标别名。
        const beforeRegistry = JSON.stringify(registry)
        try {
          if (action === 'create') {
            const name = result.family || args.family || ''
            if (normalizeFamilyName(name) !== '') ensureFamilyEntry(registry, name)
          } else if (action === 'rename') {
            renameFamilyEntry(registry, args.family, result.target || args.newName || '')
          } else if (action === 'merge') {
            mergeFamilyEntries(registry, args.names, result.target || args.newName || '')
          } else if (action === 'delete') {
            dropFamilyEntry(registry, result.family || args.family || '')
          } else if (action === 'assign') {
            const name = result.target || args.family || ''
            if (normalizeFamilyName(name) !== '') ensureFamilyEntry(registry, name)
          }
        } catch (error) {
          // id 注册表同步失败要当场报出来：静默失败会让链里的族 id 变成悬空引用。
          throw new Error(`族 id 注册表同步失败：${error && error.message ? error.message : error}`)
        }
        if (JSON.stringify(registry) !== beforeRegistry) writeFamilyRegistry(dataDir, registry)
        if (action === 'list' && Array.isArray(result.families)) {
          for (const family of readCreatedFamilies(dataDir)) {
            if (!result.families.some((item) => item.family === family)) result.families.push({ family, count: 0 })
          }
          result.families.sort((a, b) => (b.count - a.count) || (a.family < b.family ? -1 : 1))
          for (const item of result.families) {
            const id = familyIdByName(registry, item.family)
            if (id !== '') item.id = id
          }
        }
        return result
      })
    },
  })

  const objectTool = defineTool({
    name: 'exp_object',
    description: '对象链（0.35）：记录「这一件具体工作按什么顺序做完」。对象名 + 1..n 条链（每条 1..n 步，每步一个动作族）；某步失败可在该步下挂分支换一组动作。create 建对象+首条链 / append 追一条新链或补一步 / branch 给 failed 步骤挂分支 / show 读对象（族 id 解析成当前名）/ list 清单 / delete 删对象。不参与召回与排序；具体做法仍记 exp_record。',
    parameters: {
      action: { type: 'string', enum: ['create', 'append', 'branch', 'show', 'list', 'delete'], required: true, description: '要执行的动作。' },
      object: { type: 'string', description: 'create 的对象名（1–40 字）；其余动作传对象名或 ob_ id。' },
      chain: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'create/append 的步骤数组：[{ family: "跑 npm 测试", note: "可选", outcome: "failed" }]；family 必填，note 可选。' },
      steps: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'branch 的动作组，与 chain 同形状。' },
      chainIndex: { type: 'number', description: '从 1 起。append 指向已有链；branch 必填（要用作补步时对象+链一次写）。' },
      stepPath: { type: 'array', items: { type: 'number' }, description: '从 1 起：[步骤] 定位主干步骤；[步骤, 分支, 步骤] 定位分支里的步骤。branch 必填；append 补进分支时给偶数路径 [步骤, 分支]。' },
      when: { type: 'string', description: 'branch 必填：撞上什么具体意外（报错信息 / 环境不对），不要只写「失败」。' },
      result: { type: 'string', enum: ['recovered', 'aborted'], description: 'branch 可选：默认 recovered（分支走完接回主干）；aborted 表示这条分支放弃收工。' },
      note: { type: 'string', description: 'create/append 的链说明。' },
    },
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    execute(args = {}) {
      const dataDir = dataDirOf()
      const action = String(args.action || '').trim().toLowerCase()
      if (!['create', 'append', 'branch', 'show', 'list', 'delete'].includes(action)) {
        throw new Error(`action 只能是 create / append / branch / show / list / delete，收到：${action || '(空)'}`)
      }
      return withStoreLock(dataDir, () => {
        const registry = readFamilyRegistry(dataDir)
        let registryDirty = false
        const resolveFamily = (name) => {
          const id = familyIdByName(registry, name)
          if (id !== '') return id
          registryDirty = true
          return ensureFamilyEntry(registry, name)
        }
        const hintViews = (obj) => promotionHints(obj).map((hint) => ({
          ...hint,
          steps: (hint.steps || []).map((id) => {
            const ref = resolveFamilyRef(registry, id)
            return ref === null ? '(族已删除)' : ref.name
          }),
        }))
        const objects = readObjects(dataDir)
        const requireObject = (key) => {
          const found = findObject(objects, key)
          if (found === null) throw new Error(`没有这个对象：${String(key || '').trim() || '(空)'}；先 create`)
          return found
        }
        let result = null
        if (action === 'list') {
          result = {
            action,
            count: objects.length,
            objects: objects.map((obj) => {
              const hints = hintViews(obj)
              const families = new Set()
              const walk = (steps) => {
                for (const step of Array.isArray(steps) ? steps : []) {
                  const ref = resolveFamilyRef(registry, step && step.familyId)
                  if (ref !== null) families.add(ref.name)
                  for (const branch of Array.isArray(step && step.branches) ? step.branches : []) walk(branch.steps)
                }
              }
              for (const chain of Array.isArray(obj.chains) ? obj.chains : []) walk(chain.steps)
              const item = {
                id: obj.id,
                object: obj.object,
                chains: obj.chains.length,
                families: [...families],
                lastAt: obj.chains.length > 0 ? obj.chains[obj.chains.length - 1].at : '',
              }
              if (hints.length > 0) item.hints = hints
              return item
            }),
          }
        } else if (action === 'show') {
          const obj = requireObject(args.object)
          result = { action, ...objectView(obj, registry), hints: hintViews(obj) }
        } else if (action === 'delete') {
          const obj = requireObject(args.object)
          objects.splice(objects.indexOf(obj), 1)
          writeObjects(dataDir, objects)
          result = { action, deleted: obj.object, id: obj.id, remaining: objects.length }
        } else if (action === 'create') {
          const steps = buildSteps(args.chain, resolveFamily)
          const obj = createObject(objects, args.object, steps, { note: args.note })
          writeObjects(dataDir, objects)
          result = { action, id: obj.id, object: obj.object, chains: obj.chains.length, steps: steps.length }
        } else if (action === 'append') {
          const obj = requireObject(args.object)
          const steps = buildSteps(args.chain, resolveFamily)
          let at = null
          if (args.chainIndex === undefined || args.chainIndex === null || String(args.chainIndex).trim() === '') {
            at = appendChain(obj, steps, { note: args.note })
          } else {
            for (const step of steps) at = appendToObject(obj, { chainIndex: args.chainIndex, stepPath: args.stepPath, step, note: args.note })
          }
          writeObjects(dataDir, objects)
          result = { action, id: obj.id, object: obj.object, chains: obj.chains.length, at }
        } else if (action === 'branch') {
          const obj = requireObject(args.object)
          const steps = buildSteps(args.steps, resolveFamily)
          const added = addBranch(obj, { chainIndex: args.chainIndex, stepPath: args.stepPath, when: args.when, steps, result: args.result })
          writeObjects(dataDir, objects)
          result = { action, id: obj.id, object: obj.object, ...added }
        }
        if (registryDirty) writeFamilyRegistry(dataDir, registry)
        logUsage(dataDir, { tool: 'exp_object', op: action, target: String(args.object || '') }, usageOptions)
        return result
      })
    },
  })

  const reviewTool = defineTool({
    name: 'exp_review',
    description: '经验/技能的时效复核：due 列到期/待复核清单（只读）；verify 确认仍有效（刷新 lastVerifiedAt / reviewAfter，清 stale）；stale 标待复核（不删除、不退休）；retire 退休（保留正文与历史，可 revive）；revive 恢复 active（需要 note 说明理由）。只改时效字段，不改 G / outcome / 反馈账本。',
    parameters: {
      action: { type: 'string', enum: ['due', 'verify', 'stale', 'retire', 'revive'], required: true, description: '要执行的复核动作。' },
      id: { type: 'string', description: '经验 id；技能用 skill:<slug>。verify/stale/retire/revive 必填。' },
      note: { type: 'string', description: '复核结论或理由（≤240 字）；revive 必填。' },
      volatility: { type: 'string', enum: ['stable', 'semi', 'perishable'], description: '可选：修正易腐层。' },
      reviewAfter: { type: 'string', description: '可选：指定下一次复核时间（ISO）；不填按半衰期推算。' },
      appliesTo: { type: 'object', description: '可选：修正适用范围 { models?, tools?, environment? }。', properties: { models: { type: 'array', items: { type: 'string' } }, tools: { type: 'array', items: { type: 'string' } }, environment: { type: 'string' } }, additionalProperties: false },
      reason: { type: 'string', enum: ['manual', 'review-due', 'negative-feedback', 'model-upgrade'], description: '可选：stale / retire 的原因，默认 manual。' },
      limit: { type: 'number', description: 'due 时返回条数，默认 20（≤50）。' },
    },
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    execute(args = {}) {
      const dataDir = dataDirOf()
      const action = String(args.action || '').trim().toLowerCase()
      if (!REVIEW_ACTIONS.includes(action)) {
        throw new Error(`action 只能是 ${REVIEW_ACTIONS.join(' / ')}，收到：${action || '(空)'}`)
      }
      if (action === 'due') {
        const store = readStore(dataDir)
        const limit = Math.max(1, Math.min(50, Math.trunc(Number(args.limit) || 20)))
        const dueAll = dueReviewRows(store, { limit: 50 })
        const skillsAll = listSkills(dataDir)
          .map((skill) => ({ skill, meta: lifecycleMetaOf(skill.meta) }))
          .filter((item) => item.meta.reviewDue || item.meta.lifecycle === 'stale')
          .sort((left, right) => String(left.meta.reviewAfter || '').localeCompare(String(right.meta.reviewAfter || '')))
        const due = dueAll.slice(0, limit)
        const skills = skillsAll.slice(0, Math.max(0, limit - due.length))
          .map(({ skill, meta }) => ({
            id: `skill:${skill.id}`,
            slug: skill.id,
            name: skill.name,
            lifecycle: meta.lifecycle,
            volatility: meta.volatility,
            freshness: meta.freshness,
            lastVerifiedAt: meta.lastVerifiedAt,
            reviewAfter: meta.reviewAfter,
            reviewDue: meta.reviewDue,
          }))
        logUsage(dataDir, { tool: 'exp_review', op: 'due', due: due.length, skills: skills.length }, usageOptions)
        return {
          action,
          total: due.length + skills.length,
          rows: due.map(({ row, meta }) => ({
            id: row.id,
            intent: row.intent,
            action: row.action,
            typeName: row.typeName,
            lifecycle: meta.lifecycle,
            volatility: meta.volatility,
            freshness: meta.freshness,
            lastVerifiedAt: meta.lastVerifiedAt,
            reviewAfter: meta.reviewAfter,
            reviewDue: meta.reviewDue,
          })),
          skills,
        }
      }
      const id = String(args.id || '').trim()
      if (id === '') throw new Error('缺少 id（经验 id 或 skill:<slug>）')
      const note = String(args.note || '').replace(/\s+/gu, ' ').trim().slice(0, REVIEW_NOTE_LIMIT)
      const reason = String(args.reason || '').trim()
      const reviewAfterInput = checkedIsoDate(args.reviewAfter, 'reviewAfter')
      if (id.startsWith('skill:')) {
        const slug = resolveSkillId(dataDir, id.slice('skill:'.length))
        const skill = readSkillBySlug(dataDir, slug)
        if (skill === null) throw new Error(`没有这个技能：${slug}`)
        const skillLife = lifecycleMetaOf(skill.meta)
        if (skill.meta.retired_at && (action === 'verify' || action === 'stale')) throw new Error('技能已退休，先 revive 再复核')
        if (action === 'revive' && !skill.meta.retired_at && !skill.meta.stale_at && !skillLife.reviewDue) throw new Error('技能当前不是 retired/stale/到期，不需要 revive')
        if (action === 'revive' && note === '') throw new Error('revive 需要 note 说明理由')
        const effectiveReason = REVIEW_REASONS.includes(reason) ? reason : 'manual'
        const now = new Date()
        const nowIso = now.toISOString()
        const effectiveVolatility = normalizeVolatility(args.volatility) || skill.meta.volatility || 'perishable'
        const patch = {
          ...(args.volatility !== undefined ? { volatility: args.volatility } : {}),
          ...(args.appliesTo !== undefined ? { appliesTo: args.appliesTo } : {}),
          ...(reviewAfterInput !== undefined ? { reviewAfter: reviewAfterInput } : {}),
          ...(note === '' ? {} : { review_note: note }),
        }
        if (action === 'verify') {
          patch.lastVerifiedAt = nowIso
          patch.reviewAfter = reviewAfterInput || nextReviewAfter(now, effectiveVolatility)
          patch.verifiedBy = 'manual'
          patch.stale_at = null
          patch.stale_reason = null
        } else if (action === 'stale') {
          patch.stale_at = nowIso
          patch.stale_reason = effectiveReason
        } else if (action === 'retire') {
          patch.retired_at = nowIso
          patch.retired_reason = effectiveReason
          patch.stale_at = null
          patch.stale_reason = null
        } else if (action === 'revive') {
          patch.retired_at = null
          patch.retired_reason = null
          patch.stale_at = null
          patch.stale_reason = null
          patch.lastVerifiedAt = nowIso
          patch.verifiedBy = 'manual'
          patch.reviewAfter = reviewAfterInput || nextReviewAfter(now, effectiveVolatility)
        }
        const out = updateSkillMeta(dataDir, slug, patch)
        logUsage(dataDir, { tool: 'exp_review', op: action, id, slug, volatility: effectiveVolatility }, usageOptions)
        return { action, id, slug, commit: out.commit, ...out.lifecycle }
      }
      return withStoreLock(dataDir, () => {
        const store = readStore(dataDir)
        const out = reviewExperience(store, id, { ...args, action }, { now: new Date() })
        if (out.ok !== true) throw new Error(out.error || '复核失败')
        writeStore(dataDir, store)
        logUsage(dataDir, {
          tool: 'exp_review',
          op: action,
          id,
          volatility: out.meta.volatility,
          lifecycle: out.meta.lifecycle,
        }, usageOptions)
        return {
          action,
          id,
          lifecycle: out.meta.lifecycle,
          volatility: out.meta.volatility,
          freshness: out.meta.freshness,
          lastVerifiedAt: out.meta.lastVerifiedAt,
          reviewAfter: out.meta.reviewAfter,
          reviewDue: out.meta.reviewDue,
          staleAt: out.meta.staleAt,
          retiredAt: out.meta.retiredAt,
        }
      })
    },
  })

  // 失败调用也要留痕：否则「调用次数」的分母只含成功调用，使用率会被高估。
  // 成功行由各工具自己写（带业务字段）；这里只兜异常。
  // 注意：必须把宿主执行上下文 exec 原样透传（tool.execute(args, exec)），
  // 否则 exp_record/exp_recall 拿不到 agent.session.header.cwd 与 agent.id（B7）。
  const guarded = [record, recall, feedback, consolidateTool, skillAttachTool, typeTool, familyTool, objectTool, reviewTool].map((tool) => ({
    ...tool,
    execute(args = {}, exec) {
      try {
        return tool.execute(args, exec)
      } catch (error) {
        logUsage(dataDirOf(), {
          tool: tool.name,
          ok: false,
          error: String((error && error.message) || error).slice(0, 120),
        }, usageOptions)
        throw error
      }
    },
  }))
  return guarded
}

/** 供外部（如管理/调试）复用的回报推断。 */
export { scoreOf }
