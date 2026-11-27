/**
 * 工具面：exp_record / exp_recall / exp_feedback / exp_type。
 *
 * 同一份数据、同一套语义；写入只走 exp_record（Provider 的通用 remember 被禁用）。
 * SDK 由 index.js 注入，测试用桩。
 */
import { cjkBigrams, jaccard, stateSignature, stateSimilarity, tokenize } from './kernel.js'
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
import { applySkillObstacle, applySkillOutcome, attachSkillFiles, buildReuseReceipt, catalogConfigOf, clipSkillBody, confidenceReason, createSkill, deriveSkillDraft, listSkills, listSkillsCached, matchSkill, readSkillBySlug, resolveSkillId, sessionHashOf, skillCatalogUsageOf, skillGiveDecision, skillGroupsOf, skillRuntimeOf, updateSkillMeta } from './skills.js'
// 标签词表（0.20.0 P0）：写入侧的面校验与命名规则都在 registry，工具层只负责「什么时候用哪条规则」。
import { TAG_FACETS, TAG_VISIBLE_FACETS, TAG_FACET_HINTS, TAG_FACET_LABELS, TAG_MAX_COUNT, TAG_REQUIRED_FACETS, facetOf, groupByFacet, inferTagFacet, saveTagOverride, updateTagFacet, validateNewTagName, validateTagSet, validateDirectionForFamily, directionFamilyOf, remapDirectionFamily, wordlistUnreadable } from './tag-registry.js'
import { familyOf, hasFamilyLayout, markFamilyTypeCreated } from './shard-store.js'
import { manageFamilies, readCreatedFamilies, searchFamiliesByBuckets, syncCreatedFamilies, validateFamilyName } from './family-tools.js'
import { FAMILY_INVISIBLE_RE, GENERIC_FAMILY_NAMES, normalizeFamilyName, specificFamilyOf } from './family-name.js'
import {
  canonicalFamilyName,
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
import { autoTypeFromTags, reconcileFamilyTypeDirs, flattenQueryTags, renderJson, clipText, pruneRowForeignDirections, familyIsKnown, checkedIsoDate, hostSessionOf, hostSessionObjectOf, visibleSeqsOf, groupRowsByType, typesFromManifest, isTypeIdList, fastIndexTrusted } from './tool-helpers.js'
import { CONSOLIDATE_TOOL, FAMILY_TOOL, FEEDBACK_TOOL, OBJECT_TOOL, RECALL_TOOL, RECORD_TOOL, REVIEW_TOOL, SKILL_ATTACH_TOOL, TYPE_TOOL } from './tool-schemas.js'

const OUTPUT_SCHEMA = { type: 'object', additionalProperties: true }
// 试用技能的门槛：略高于正式匹配下限，避免把不相关技能当试用塞给模型
const TRIAL_MIN_SIMILARITY = 0.18

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
    ...RECORD_TOOL,
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    execute(args = {}, exec) {
      const dataDir = dataDirOf()
      return withStoreLock(dataDir, () => {
      // P3.5（task-9）：记录路径走 partial 读 + 定向写。manifest 是入口；老库（无 manifest）仍走全量。
      const manifest = readManifest(dataDir)
      // 0.38 健壮性：写路径进方向校验前先按 dataDir 加载词表，冷启动（未召回）也能认到磁盘上已登记的方向。
      try { ensureTagOverrides(dataDir) } catch { /* 坏词表按内建词走 */ }
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
      // 0.38：outcome 非字符串（new String / 数组 / 带 toString 的对象）先按 typeof 拒，不靠 String() 强转后枚举兜底。
      if (args.outcome !== undefined && args.outcome !== null && typeof args.outcome !== 'string') {
        throw new Error('outcome 只能是字符串（accepted/success/partial/unknown/failed/corrected/aborted）')
      }
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
          suggestion: '补一句具体的「动词+名词」动作再记；动作写不出就说明这条还不值得记',
        }
      }
      if (args.force !== true && !gateNegative && !gateUser && (gateGeneric || familyGeneric)) {
        return {
          skipped: true,
          reason: familyGeneric
            ? '族名太泛，不能单独成为动作族'
            : '通用单步操作，模型本来就会，重学成本低',
          suggestion: familyGeneric ? '改用具体动作，例如 git 推送 / 跑 npm 测试 / 改 React 页面' : '这是任务流水：这件任务怎么做的用 exp_object 记；可复用做法请写清技法，确需记录可传 force:true',
        }
      }

      // 0.38：显式族名类型错误（数字/数组/对象）必须明确拒，不能静默当「没给」再按推导族落库。
      if (args.family !== undefined && args.family !== null && typeof args.family !== 'string') {
        return { skipped: true, reason: '族名必须是字符串', suggestion: 'family 传可复用动作的族名字符串；不需要族就别传 family' }
      }
      // 0.38：显式给了族名（哪怕全是空白/纯不可见）就不能静默当「没给」。
      const familyProvided = typeof args.family === 'string' && args.family !== ''
      // 用**原始**串校验（含不可见字符/BOM），不能先归一再校验——否则 BOM 会被 NFKC 吃掉、纯空白/纯 BOM 文案也会分叉。
      if (familyProvided) {
        try { validateFamilyName(args.family) } catch (error) {
          return { skipped: true, reason: `族名不合法：${error.message}`, suggestion: '族名要是具体动作（如 写脚本/改代码/跑测试）；具体任务用 exp_object 记，不需要族就别传 family' }
        }
      }
      // 0.38 P4：族名（显式/推导）必须过族名校验；force 只覆盖记录门槛，不覆盖族名合法性。
      // 推导族名：显式 > 首个「非泛词」动作面标签 > specificFamilyOf(action)。泛词动作标签不当族。
      const directionTags = allTags.filter((name) => facetOf(name) === 'direction')
      let effectiveFamily = normalizedFamily
      if (effectiveFamily === '') {
        const actionTag = allTags.find((name) => facetOf(name) === 'action' && !GENERIC_FAMILY_NAMES.includes(normalizeFamilyName(name))) || ''
        effectiveFamily = actionTag
      }
      if (effectiveFamily === '') effectiveFamily = specificFamilyOf(gateText)
      if (effectiveFamily !== '') {
        try { validateFamilyName(effectiveFamily) } catch (error) {
          return { skipped: true, reason: `族名不合法：${error.message}`, suggestion: '族名要是具体动作（如 写脚本/改代码/跑测试）；具体任务用 exp_object 记' }
        }
      }
      // 0.38：引用方向时校验「归属族匹配」（未登记的词按普通标签处理，不算方向）。
      if (effectiveFamily !== '' && directionTags.length > 0) {
        for (const name of directionTags) {
          const dirFamily = directionFamilyOf(name)
          if (dirFamily !== null && normalizeFamilyName(dirFamily) !== normalizeFamilyName(effectiveFamily)) {
            return { skipped: true, reason: `方向「${name}」属于族「${dirFamily}」，与这条记录的族「${effectiveFamily}」不符`, suggestion: '方向只能用该族已登记的方向标签；先 exp_type label 用正确族登记' }
          }
        }
      }
      // 0.38：改名/合并后的旧族名并入当前族名（不复活成幽灵旧族）；方向错配已在上面按旧名拒掉。
      if (effectiveFamily !== '') {
        effectiveFamily = canonicalFamilyName(readFamilyRegistry(dataDir), effectiveFamily)
      }
      // 0.38 P1：对象流水拦截（拍板②）——裸单文件编辑 / 裸工具名命令，不是可复用做法。
      // 负面/多步/用户口径/force 仍放行（与门槛一致）；清晰技法描述（哪怕短）不受影响。
      // origin=auto 暂放行：自动记录默认关、P5 会改造成「多步→对象」，届时再收紧。
      const gateBareFileEdit = /^(?:改|修改|编辑|更新|重构)\s+\S+\.[A-Za-z0-9]+$/u.test(gateText.trim())
      const gateBareIdentifier = /^[A-Za-z][A-Za-z0-9_.\-]*$/u.test(gateText.trim())
      const gateIsAuto = String(args.origin || '').toLowerCase() === 'auto'
      if (args.force !== true && !gateIsAuto && !gateNegative && !gateUser && !gateMulti && (gateBareFileEdit || gateBareIdentifier)) {
        return {
          skipped: true,
          reason: gateBareFileEdit ? '单文件编辑无技法，是任务流水不是可复用动作模式' : '裸工具名/命令，不是可复用做法',
          suggestion: '这件任务怎么做的用 exp_object 记；可复用做法请写出技法（如「改 X 逻辑以解决 Y」），别只丢文件名/命令',
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
        // 0.38：显式族名用已规范化+旧名归一的 effectiveFamily，别再用原始 args.family（否则旧名会复活成幽灵族）。
        family: (typeof args.family === 'string' && args.family.trim() !== '') ? (effectiveFamily || normalizeFamilyName(args.family) || args.family.trim()) : undefined,
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
      // 0.38：store 推导出的族名若是改名/合并前的旧名，并入当前族（显式族名已在 upsertInput.family 归一）。
      const canonicalizeRowFamily = (row) => {
        if (row === null || typeof row !== 'object' || typeof row.family !== 'string' || row.family === '') return
        const canonicalFamily = canonicalFamilyName(readFamilyRegistry(dataDir), row.family)
        if (canonicalFamily !== row.family) row.family = canonicalFamily
      }
      // 0.38：族即动作——已登记 action 面的标签、以及与行族同名的标签，都不再落进 context
      //（族已承担动作/同名语义，标签只留方向/主题/质量）。
      const stripRowActionTags = (row) => {
        if (row === null || typeof row !== 'object' || !Array.isArray(row.context)) return
        const family = normalizeFamilyName(row.family)
        const kept = row.context.filter((name) => facetOf(name) !== 'action' && (family === '' || normalizeFamilyName(name) !== family))
        if (kept.length !== row.context.length) row.context = kept
      }
      const haveVerdicts = Array.isArray(args.verdicts) && args.verdicts.length > 0
      let verdictResults = []
      let pendingOut = { rows: [], skipped: [] }
      let result = null
      let directionDropped = []
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
            // 0.38：重记/合并后摘掉跨族方向（先摘再写盘，保证落库就干净）。
            directionDropped = pruneRowForeignDirections(result.experience)
            canonicalizeRowFamily(result.experience)
            stripRowActionTags(result.experience)
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
        directionDropped = pruneRowForeignDirections(result.experience)
        canonicalizeRowFamily(result.experience)
        stripRowActionTags(result.experience)
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
      const overflowTags = allTags.filter((tag) => facetOf(tag) !== 'action' && !savedTags.some((saved) => saved.toLowerCase() === tag.toLowerCase())
        && !directionDropped.some((dropped) => dropped.toLowerCase() === tag.toLowerCase()))
      const directionWarn = directionDropped.map((tag) => `方向「${clipText(tag)}」不属于本经验的族「${clipText(result.experience && result.experience.family)}」，已摘除`)
      // 0.38：整段告警限长，避免一次塞几十条超长标签把回执撑过 2KB。
      const finalTagWarning = clipText([
        ...directionWarn,
        ...((ctxGiven || lblGiven)
          ? [
            ...savedMissingFacets.map((facet) => TAG_FACET_HINTS[facet]),
            ...rejectedTags.slice(0, 4).map((item) => `已忽略「${clipText(item.value)}」：${clipText(item.reason, 120)}`),
            overflowTags.length > 0
              ? `标签最多保留 ${TAG_MAX_COUNT} 个，已保留：${clipText(savedTags.join('、'), 120)}；被截断/丢弃：${clipText(overflowTags.slice(0, 5).join('、'), 120)}`
              : '',
          ]
          : []),
      ].filter(Boolean).join('；'), 900)
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
        tagsRejected: rejectedTags.length > 0 ? rejectedTags.slice(0, 4).map((item) => clipText(item.value, 200)) : undefined,
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
    ...RECALL_TOOL,
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
      // 0.38：族名非字符串明确拒（只读路径也不静默强转）。
      if (args.family !== undefined && args.family !== null && typeof args.family !== 'string') throw new Error('族名必须是字符串（family）')
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
          // 排序分支的候选字段可能包在 evidence 里；按 id 回原始行兜底，保证 family/context/lastSeenAt 不丢。
          const rowId = row.id !== undefined && row.id !== '' ? row.id : source.id
          const original = rowId ? visibleRows.find((item) => item.id === rowId) : undefined
          const pick = (key) => {
            if (row[key] !== undefined) return row[key]
            if (original !== undefined && original[key] !== undefined) return original[key]
            return source[key]
          }
          const context = pick('context')
          const family = pick('family')
          return {
            id: row.id || source.id || '',
            intent: row.intent !== undefined ? row.intent : (source.intent !== undefined ? source.intent : ''),
            action: row.action !== undefined ? row.action : (source.action !== undefined ? source.action : ''),
            outcome: row.outcome !== undefined ? row.outcome : source.outcome,
            G: row.G !== undefined ? row.G : source.G,
            lastSeenAt: pick('lastSeenAt') || pick('ts') || '',
            // 0.38：按族召回要能看出「哪一族、哪个方向」，否则调用方拿不到复用线索。
            family: family !== undefined && family !== '' ? family : explicitFamily,
            ...(Array.isArray(context) && context.length > 0 ? { context, tags: context } : {}),
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
      const rankOptions = { routing, clusterId, consolidation: config.consolidation, consolidationMinSamples: config.consolidationMinSamples, context: rankContext, tagBonusOnly: tagRankAppliedNow && tagQuery !== null, tagQuery, explicitLimit: Number(args.limit) > 0, rankBlend: config.rankBlend !== false, retrievalMode: config.retrievalMode, criticUnknownMode: config.criticUnknownMode, recent: recentRequested, recentAllSessions, sessionId: coldMode ? '' : sessionIdText, includeMismatched: args.includeMismatched === true, current: currentEnv }
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
        // 0.39 P2：回执顶层带「本次命中的族」（≤3），模型从结果里就知道族名怎么叫，不必背全族目录。
        const familyHits = new Map()
        for (const candidate of Array.isArray(result.candidates) ? result.candidates : []) {
          const row = (Array.isArray(candidate.evidence) && candidate.evidence[0]) || candidate
          const family = row !== null && typeof row === 'object' && typeof row.family === 'string' ? row.family.trim() : ''
          if (family !== '') familyHits.set(family, (familyHits.get(family) || 0) + 1)
        }
        const routeFamilies = [...familyHits.entries()]
          .map(([family, count]) => ({ family, count }))
          .sort((left, right) => (right.count - left.count) || left.family.localeCompare(right.family, 'zh'))
          .slice(0, 3)
        if (routeFamilies.length > 0) payload.routes = routeFamilies
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
        rankMode: result.rankMode,
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
    ...FEEDBACK_TOOL,
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
    ...CONSOLIDATE_TOOL,
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
    ...SKILL_ATTACH_TOOL,
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
    ...TYPE_TOOL,
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    execute(args = {}) {
      const dataDir = dataDirOf()
      return withStoreLock(dataDir, () => {
      const manifest = readManifest(dataDir)
      // 0.38 健壮性：label 前先按 dataDir 加载词表，冷启动（真新进程）也能认到磁盘上已登记的方向/标签。
      try { ensureTagOverrides(dataDir) } catch { /* 坏词表按内建词走 */ }
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
            problems.push(`「${clipText(raw, 40)}」${clipText(check.reason, 120)}`)
            continue
          }
          if (!resolved.some((name) => name.toLowerCase() === check.name.toLowerCase())) resolved.push(check.name)
        }
        if (problems.length > 0) {
          // 0.38：只回显前几条并截断，避免一次塞 100 条超长标签把报错撑到几百 KB。
          const shown = problems.slice(0, 5).join('；')
          const more = problems.length > 5 ? `；等 ${problems.length} 项不合规` : ''
          const error = new Error(`标签不合规：${clipText(shown, 1000)}${more}`)
          error.code = 'invalid'
          throw error
        }
        // 0.38：新标签的面/归属族、方向归属校验、标签上限——全部校验通过再写盘（拒收不留半写）。
        const unknown = resolved.filter((name) => facetOf(name) === null)
        // 0.40：facet 非字符串明确拒（别 String() 把 ['topic'] 强转成 'topic'）。
        if (args.facet !== undefined && args.facet !== null && typeof args.facet !== 'string') {
          const error = new Error('facet 必须是字符串（direction / topic / quality）')
          error.code = 'invalid'
          throw error
        }
        const facet = String(args.facet || '').trim()
        // 0.38：label 指定 facet=direction 时，已登记成别的面（写入即登记常先记成 topic）的标签要纠正成方向，
        // 不能静默丢面；也不能直接报错（调用方明确要登记方向）。
        const reFacet = facet === 'direction'
          ? resolved.filter((name) => {
            const existingFacet = facetOf(name)
            return existingFacet !== null && existingFacet !== 'direction'
          })
          : []
        // 0.38：归属族名非字符串明确拒，别 String() 强转后拿去登记方向。
        if (args.family !== undefined && args.family !== null && typeof args.family !== 'string') {
          const error = new Error('方向归属族必须是非空字符串（family）')
          error.code = 'invalid'
          throw error
        }
        // 0.38：用原始串校验（含不可见字符/BOM）——String().trim() 会把首尾 BOM 吃掉，导致六入口口径不一致。
        // 纯空白（无不可见符）留给下面报「必须给 family」；纯不可见符（如 U+FEFF）走校验器的「族名不能为空」。
        if (typeof args.family === 'string' && args.family !== '') {
          // 0.39：先剥掉标准空白（\t\n\r 也是 \p{Cc}），纯空白仍报「必须给 family」；只剩非空白不可见符才走校验器。
          const withoutBlank = args.family.replace(/[\t\n\r]/gu, '')
          const plainBlank = args.family.trim() === '' && !FAMILY_INVISIBLE_RE.test(withoutBlank)
          if (!plainBlank) validateFamilyName(args.family)
        }
        const labelFamily = String(args.family || '').trim()
        // 0.40：facet 只要传了就必须是可见面——action 一律拒（哪怕标签已登记，不能把 action 词写回 context）。
        if (facet !== '' && !TAG_VISIBLE_FACETS.includes(facet)) {
          const facetHint = facet === 'action' ? '（action 面已收敛：族即动作，族内场景用 direction）' : ''
          const error = new Error(`facet 取 ${TAG_VISIBLE_FACETS.map((key) => `${key}(${TAG_FACET_LABELS[key]})`).join(' / ')}${facetHint}`)
          error.code = 'invalid'
          throw error
        }
        if (unknown.length > 0 && !TAG_VISIBLE_FACETS.includes(facet)) {
          // 0.40：action 面已收敛，不能把它列成合法面；传 action 时给迁移提示。
          const facetHint = String(facet || '') === 'action' ? '（action 面已收敛：族即动作，族内场景用 direction）' : ''
          const error = new Error(`新标签 ${unknown.map((name) => `「${name}」`).join('')} 必须指定面：facet 取 ${TAG_VISIBLE_FACETS.map((key) => `${key}(${TAG_FACET_LABELS[key]})`).join(' / ')}${facetHint}`)
          error.code = 'invalid'
          throw error
        }
        // 0.38：方向标签（新登记，或把已登记成 topic 的词纠正成方向）都必须带合法且已登记的族归属（拍板⑤）。
        if (facet === 'direction' && (unknown.length > 0 || reFacet.length > 0)) {
          if (labelFamily === '') {
            const error = new Error('登记方向标签必须给 family（这个方向属于哪个动作族）')
            error.code = 'invalid'
            throw error
          }
          validateFamilyName(labelFamily)
          if (!familyIsKnown(store, dataDir, labelFamily)) {
            const error = new Error(`方向归属族「${labelFamily}」未登记：先用该族记一条经验，或 exp_family create 登记族`)
            error.code = 'invalid'
            throw error
          }
        }
        // 方向归属族必须与经验行族一致（已登记方向 + 本次要登记的新方向都算）。
        const rowFamily = normalizeFamilyName(row.family)
        const dirFamilyOfResolved = (name) => {
          if (facetOf(name) === 'direction') return directionFamilyOf(name)
          if ((unknown.includes(name) || reFacet.includes(name)) && facet === 'direction') return labelFamily
          return null
        }
        for (const name of resolved) {
          const dirFamily = dirFamilyOfResolved(name)
          if (dirFamily !== null && rowFamily !== '' && normalizeFamilyName(dirFamily) !== rowFamily) {
            const error = new Error(`方向「${name}」属于族「${dirFamily}」，与这条经验的族「${rowFamily}」不符`)
            error.code = 'invalid'
            throw error
          }
        }
        // 0.40：手动 label 也不得把 action 面标签写回 context（与 exp_record 剥 action 标签同口径）。
        const merged = [...new Set([...existing, ...resolved])].filter((name) => facetOf(name) !== 'action')
        if (merged.length > 8) {
          const error = new Error('标签最多 8 个，请先删掉一些旧标签')
          error.code = 'invalid'
          throw error
        }
        // 全部校验通过，才登记新标签（拒收不留词表半写）。
        for (const name of unknown) saveTagOverride(dataDir, { name, facet, description: args.tagDescription, family: facet === 'direction' ? labelFamily : '' })
        // 0.38：把已登记成非方向的词纠正成方向（label 明确指定 facet=direction）。
        for (const name of reFacet) updateTagFacet(dataDir, { name, facet: 'direction', family: labelFamily })
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
    ...FAMILY_TOOL,
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    execute(args = {}) {
      const dataDir = dataDirOf()
      return withStoreLock(dataDir, () => {
        const action = String(args.action || '').trim()
        const registry = readFamilyRegistry(dataDir)
        // 0.38 健壮性：assign 摘方向前先加载词表，冷启动也能认出磁盘上已登记的方向。
        try { ensureTagOverrides(dataDir) } catch { /* 坏词表按内建词走 */ }
        // 0.38：词表不可读（坏 JSON / 被目录占用）时改族会断掉方向归属（迁不了也告不出），
        // 先修复词表再 rename/merge，别把行改成新族、方向还挂旧族。
        if ((action === 'rename' || action === 'merge') && wordlistUnreadable(dataDir)) {
          throw new Error('词表不可读（tag-registry.json 是坏 JSON 或被目录占用）：先修复词表再改族，否则方向归属会断')
        }
        // 0.35：删族前先看对象链是否还引用它（定稿 §10-3：拒删）。
        if (action === 'delete') {
          const name = normalizeFamilyName(args.family)
          const refs = chainReferences(readObjects(dataDir), familyIdSetOf(registry, name))
          if (refs.length > 0) {
            const first = refs[0]
            throw new Error(`族「${name}」还被 ${refs.length} 处对象链引用（如对象「${first.object}」第 ${first.chainIndex} 条链），先把链里的引用改掉再删`)
          }
        }
        // 0.39：list query 只读 manifest.buckets（不读分片）——族多了也快。
        if (action === 'list' && typeof args.query === 'string' && args.query.trim() !== '') {
          let buckets = null
          try { buckets = (readManifest(dataDir) || {}).buckets } catch { buckets = null }
          const queryResult = searchFamiliesByBuckets(buckets, args.query)
          if (queryResult !== null) {
            for (const item of queryResult.families) {
              const id = familyIdByName(registry, item.family)
              if (id !== '') item.id = id
            }
            return queryResult
          }
        }
        const store = readStore(dataDir)
        // 0.38：create/assign 的目标族名先把旧名归一到当前族名，别把旧名复活成幽灵族（同一 id 出现两次）。
        let managedArgs = args
        let retiredNote = ''
        if ((action === 'create' || action === 'assign') && typeof args.family === 'string') {
          const canonical = canonicalFamilyName(registry, args.family)
          if (canonical !== normalizeFamilyName(args.family)) {
            retiredNote = `族名「${clipText(args.family)}」已并入「${clipText(canonical)}」`
            managedArgs = { ...args, family: canonical }
          }
        }
        // 0.39：create 的「是否首次」要含已登记的空族——第二次 create 同一空族应为 created:false。
        const createdBefore = action === 'create' ? readCreatedFamilies(dataDir) : []
        const { result, changed } = manageFamilies(store, action, managedArgs)
        if (changed) writeStore(dataDir, store)
        // 0.39：只读的 list 不写盘——只有改族动作才同步空族登记表。
        if (action === 'create' || action === 'rename' || action === 'merge' || action === 'assign' || action === 'delete') {
          syncCreatedFamilies(dataDir, action, managedArgs, result)
        }
        if (action === 'create' && result.created === true && createdBefore.includes(normalizeFamilyName(result.family))) {
          result.created = false
        }
        if (retiredNote !== '') result.note = result.note ? `${result.note}；${retiredNote}` : retiredNote
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
        // 0.38：族改名/合并后同步迁移方向归属（否则合法方向会被判跨族拒记）。
        if (action === 'rename') {
          remapDirectionFamily(dataDir, [[args.family, result.target || args.newName || '']])
        } else if (action === 'merge') {
          const mergeTarget = result.target || args.newName || ''
          remapDirectionFamily(dataDir, (Array.isArray(args.names) ? args.names : []).map((name) => [name, mergeTarget]))
        }
        // 词表文件被目录占用时读不到方向，迁移会静默 0 条——回执要明确告警，别让调用方以为迁了。
        if ((action === 'rename' || action === 'merge') && wordlistUnreadable(dataDir)) {
          result.directionWarning = '词表不可读（tag-registry.json 不是文件），方向归属未迁移；先修复词表文件再重试'
        }
        // 0.38：assign 到另一族时摘掉了跨族方向——回执明确点出摘了哪些，不静默丢标签。
        if (action === 'assign' && Array.isArray(result.droppedDirections) && result.droppedDirections.length > 0) {
          const dropped = result.droppedDirections
          result.droppedDirections = dropped.slice(0, 10).map((name) => clipText(name, 40))
          result.directionWarning = `指派到族「${clipText(result.target, 40)}」时摘除了不属于该族的方向：${result.droppedDirections.join('、')}`
        }
        if (action === 'list' && Array.isArray(result.families)) {
          // 0.39：query 模式保持模糊搜的 score 顺序，不并入空族、不再按 count 重排（count 只在同分时做次序）。
          const queryMode = typeof args.query === 'string' && args.query.trim() !== ''
          if (!queryMode) {
            for (const family of readCreatedFamilies(dataDir)) {
              if (!result.families.some((item) => item.family === family)) result.families.push({ family, count: 0 })
            }
            result.families.sort((a, b) => (b.count - a.count) || (a.family < b.family ? -1 : 1))
          }
          for (const item of result.families) {
            const id = familyIdByName(registry, item.family)
            if (id !== '') item.id = id
          }
        }
        // 0.38：超长来源族名/名单/目标名进回执前截断（避免 10 万字符撑爆回执）。
        if (Array.isArray(result.sources)) result.sources = result.sources.slice(0, 20).map((name) => clipText(name, 40))
        if (typeof result.target === 'string') result.target = clipText(result.target, 40)
        if (typeof result.family === 'string') result.family = clipText(result.family, 40)
        return result
      })
    },
  })

  const objectTool = defineTool({
    ...OBJECT_TOOL,
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    execute(args = {}) {
      const dataDir = dataDirOf()
      const action = String(args.action || '').trim().toLowerCase()
      if (!['create', 'append', 'branch', 'show', 'list', 'delete'].includes(action)) {
        throw new Error(`action 只能是 create / append / branch / show / list / delete，收到：${action || '(空)'}`)
      }
      return withStoreLock(dataDir, () => {
        const registry = readFamilyRegistry(dataDir)
        // 0.38 健壮性：对象步方向校验前先加载词表，冷启动也能认到磁盘上已登记的方向。
        try { ensureTagOverrides(dataDir) } catch { /* 坏词表按内建词走 */ }
        let registryDirty = false
        const resolveFamily = (name) => {
          // 0.38：先对原始族名做完整校验（含不可见字符），再按归一名查 id——已登记的族也要校验，
          // 否则带 BOM 的「写\ufeff断言」会被归一成「写断言」静默复用。
          validateFamilyName(name)
          // 0.38：旧族名（改名/合并前）由 familyIdByName 的 retired 命中直接解析到新族 id，不重建旧族。
          const id = familyIdByName(registry, name)
          if (id !== '') return id
          registryDirty = true
          return ensureFamilyEntry(registry, name)
        }
        // 0.38：方向解析器——必须是该族已登记的方向标签（拍板⑤），否则抛错。
        const resolveDirection = (familyName, direction) => {
          const check = validateDirectionForFamily(direction, familyName)
          if (!check.ok) throw new Error(check.reason)
          return check.name
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
          if (found === null) throw new Error(`没有这个对象：${clipText(String(key || '').trim() || '(空)', 40)}；先 create`)
          return found
        }
        let result = null
        if (action === 'list') {
          const items = objects.map((obj) => {
            const hints = hintViews(obj)
            const families = new Set()
            const walk = (steps, depth = 0) => {
              if (depth > 64) return
              for (const step of Array.isArray(steps) ? steps : []) {
                if (step === null || typeof step !== 'object') continue
                const ref = resolveFamilyRef(registry, step.familyId)
                if (ref !== null) families.add(ref.name)
                for (const branch of Array.isArray(step.branches) ? step.branches : []) walk(branch && branch.steps, depth + 1)
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
          })
          // 0.41：按关键词/任务描述模糊搜对象（对象名 + 链的步：族名/方向/note），复用 kernel 的 token/bigram 双信号。
          // query 截到 200 码点、签名只算一次（10 万字符 query 不放大成 200×超长集合）。
          const queryText = typeof args.query === 'string' ? Array.from(args.query.trim()).slice(0, 200).join('') : ''
          if (queryText !== '') {
            const wantSig = stateSignature({ tokens: tokenize(queryText), artifacts: [], cgrams: cjkBigrams(queryText.toLowerCase()) })
            const wantMain = new Set([...wantSig.tokens, ...wantSig.artifacts])
            const byId = new Map(objects.map((obj) => [obj.id, obj]))
            const scored = items
              .map((item) => {
                const obj = byId.get(item.id) || {}
                const parts = [item.object, ...(item.families || [])]
                const walk = (steps, depth = 0) => {
                  if (depth > 64) return
                  for (const step of Array.isArray(steps) ? steps : []) {
                    if (step === null || typeof step !== 'object') continue
                    parts.push(String(step.direction || ''), String(step.note || ''))
                    for (const branch of Array.isArray(step.branches) ? step.branches : []) walk(branch && branch.steps, depth + 1)
                  }
                }
                for (const chain of Array.isArray(obj.chains) ? obj.chains : []) walk(chain.steps)
                const text = parts.join(' ')
                const haveSig = stateSignature({ tokens: tokenize(text), artifacts: [], cgrams: cjkBigrams(text.toLowerCase()) })
                const haveMain = new Set([...haveSig.tokens, ...haveSig.artifacts])
                return { ...item, score: 0.75 * jaccard(wantMain, haveMain) + 0.25 * jaccard(wantSig.grams, haveSig.grams) }
              })
              .filter((item) => item.score > 0)
              .sort((a, b) => b.score - a.score)
              .slice(0, 5)
            result = { action, count: scored.length, total: items.length, query: queryText, objects: scored }
          } else {
            result = { action, count: items.length, objects: items }
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
          const steps = buildSteps(args.chain, resolveFamily, { resolveDirection })
          const obj = createObject(objects, args.object, steps, { note: args.note })
          writeObjects(dataDir, objects)
          result = { action, id: obj.id, object: obj.object, chains: obj.chains.length, steps: steps.length }
        } else if (action === 'append') {
          const obj = requireObject(args.object)
          const steps = buildSteps(args.chain, resolveFamily, { resolveDirection })
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
          const steps = buildSteps(args.steps, resolveFamily, { resolveDirection })
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
    ...REVIEW_TOOL,
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
