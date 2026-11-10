/**
 * 工具面：exp_record / exp_recall / exp_feedback / exp_type。
 *
 * 同一份数据、同一套语义；写入只走 exp_record（Provider 的通用 remember 被禁用）。
 * SDK 由 index.js 注入，测试用桩。
 */

import {
  FEEDBACK_ETA,
  applyFeedback,
  assignType,
  buildInduction,
  createType,
  deleteType,
  findType,
  listTypes,
  logUsage,
  mergeTypes,
  rankExperiences,
  readStore,
  visibleExperiences,
  renameType,
  resolveToolDataDir,
  scoreOf,
  upsertExperience,
  writeStore,
} from './store.js'
import { routeCluster } from './cluster.js'
import { resolveEngramDataDir } from './settings.js'
import { applySkillObstacle, applySkillOutcome, attachSkillFiles, confidenceReason, createSkill, deriveSkillDraft, listSkills, matchSkill, readSkillBySlug } from './skills.js'

const OUTPUT_SCHEMA = { type: 'object', additionalProperties: true }
// 试用技能的门槛：略高于正式匹配下限，避免把不相关技能当试用塞给模型
const TRIAL_MIN_SIMILARITY = 0.18

function renderJson(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

/**
 * @param {Function} defineTool - `@deepseek-ai/dsh-tools` 的 defineTool
 * @param {{dataDir?: string, mergeThreshold?: number, replaceThreshold?: number}} config
 */
export function buildTools(defineTool, config = {}) {
  // 0.11.0：工具面统一走 settings 的 resolveEngramDataDir（dataDir → currentRoot → 默认）。
  // @legacy-provider 上面 import 的 resolveToolDataDir 是 Provider 时代的旧解析，已不在工具里用。
  const dataDirOf = () => resolveEngramDataDir(config)
  // 用法日志（零 token）：只回答「召回到底有没有被用起来」；config.usageLog=false 可关。
  const usageOptions = { enabled: config.usageLog !== false, maxBytes: config.usageLogMaxBytes }

  const record = defineTool({
    name: 'exp_record',
    description: '记录一条工作经验（做法 + 结果）。同一做法会就地更新 hits，近似替换会写新条并标记旧条被取代。',
    parameters: {
      intent: { type: 'string', required: true, description: '要做的任务/意图。' },
      action: { type: 'string', required: true, description: '采取的做法或方案名。' },
      outcome: { type: 'string', enum: ['accepted', 'success', 'partial', 'unknown', 'failed', 'corrected', 'aborted'], description: '结果；影响回报 G。' },
      type: { type: 'string', description: '类型名（可选）。不填归「未分类」；填了新名字会按需新建类型（受上限与近似合并限制）。' },
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
      context: { type: 'array', description: '可选：情境线索（如产物/课程类型/工作区标签），≤5 个；召回时用于编码特异性匹配。' },
      skillId: { type: 'string', description: '可选：本次使用的技能（技能 id 或 skill:<slug>）；记录后更新技能 confidence/障碍并提交。' },
      blockedBy: { type: 'string', description: '可选：本次撞到的障碍原文；给了就按签名计数，连续 3 次覆盖技能。' },
      blockedByList: { type: 'array', description: '可选：一次撞到多个障碍时传数组，各签名分别计数（与 blockedBy 二选一）。' },
    },
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    execute(args = {}) {
      const dataDir = dataDirOf()
      const store = readStore(dataDir)
      // 没给类型时按簇路由自动归族（config.routing='off' 或 autoAssign=false 可关）；落不进任何簇就保持「未分类」。
      const autoAssign = config.autoAssign !== false && config.routing !== 'off'
      let typeName = args.type
      let routedCluster = null
      if ((typeName === undefined || typeName === null || String(typeName).trim() === '') && autoAssign) {
        const route = routeCluster(store, String(args.intent || ''))
        if (!route.fallback) {
          typeName = route.name
          routedCluster = { clusterId: route.clusterId, name: route.name, score: route.score }
        }
      }
      const result = upsertExperience(store, {
        intent: args.intent,
        action: args.action,
        outcome: args.outcome,
        type: typeName,
        typeDescription: args.typeDescription,
        note: args.note,
        taskId: args.taskId,
        kind: args.kind,
        stepIndex: args.stepIndex,
        stepTotal: args.stepTotal,
        failedStep: args.failedStep,
        stepRewards: args.stepRewards,
        expectedOutcome: args.expectedOutcome,
        expectedG: args.expectedG,
        context: args.context,
        skillId: args.skillId,
      }, {
        mergeThreshold: config.mergeThreshold,
        replaceThreshold: config.replaceThreshold,
        maxTypes: config.maxTypes,
        newTypesPerDay: config.newTypesPerDay,
        typeSimilarity: config.typeSimilarity,
        feedbackDecayDays: config.feedbackDecayDays,
      })
      writeStore(dataDir, store)
      // 技能账本：用了技能就回填结果；撞到障碍就按签名计数（连续 3 次覆盖并归档）。
      let skillResult = null
      let skillWarning = null
      if (typeof args.skillId === 'string' && args.skillId.trim() !== '') {
        const slug = args.skillId.trim().replace(/^skill:/, '')
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
          skillResult = applySkillOutcome(dataDir, slug, Number(result.experience.G) < 0 ? 'hurt' : 'helped', { intent: args.intent })
        }
        const warning = skillResult.action === 'multi'
          ? (skillResult.results.find((item) => typeof item.warning === 'string') || {}).warning
          : skillResult.warning
        if (typeof warning === 'string') skillWarning = warning
      }
      logUsage(dataDir, {
        tool: 'exp_record',
        op: result.action,
        id: result.experience.id,
        intent: result.experience.intent,
        action: result.experience.action,
        outcome: result.experience.outcome,
        typeName: result.experience.typeName,
        hits: result.experience.hits,
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
      const typeInfo = result.type || {}
      const sanitized = result.sanitized || {}
      const active = visibleExperiences(store)
      const negativeSamples = active.filter((item) => Number(item.G) < 0).length
      return {
        action: result.action,
        id: result.experience.id,
        hits: result.experience.hits,
        outcome: result.experience.outcome,
        G: result.experience.G,
        typeName: result.experience.typeName,
        typeCreated: typeInfo.created === true,
        typeMergedInto: typeInfo.mergedInto || null,
        typeWarning: typeInfo.rejected ? `${typeInfo.reason}（已归「未分类」）` : null,
        typeRecoveredFromNote: result.typeRecoveredFromNote === true,
        noteSanitized: sanitized.note === true || sanitized.intent === true || sanitized.action === true,
        clusterName: result.experience.typeName,
        routedCluster,
        typeCount: store.types.filter((type) => type.system !== true && type.id !== 'ty_other').length,
        typeLimit: Math.max(1, Math.trunc(Number(config.maxTypes) || 24)),
        supersededId: result.supersededId || null,
        retired: Array.isArray(result.retired) ? result.retired : [],
        count: active.length,
        negativeSamples,
        // outcome 与分步回报反号时明确提示：G 取最弱一步，统计会按 G 记失败（2026-11-07）。
        signWarning: result.signMismatch === true
          ? `outcome（${result.experience.outcome}）与分步回报反号：G=${result.experience.G} 取最弱一步，统计会按 G 记失败。`
          : null,
        qualityHint: negativeSamples === 0 && active.length >= 4
          ? '库里目前没有失败/纠正样本：召回会标 mode=evidence（Â 不具区分度）。遇到返工、被纠正或失败，请用 corrected/failed 记一条，负样本才让排序有信息量。'
          : null,
        ...(skillResult === null ? {} : { skill: skillResult }),
        ...(skillWarning === null ? {} : { skillWarning }),
      }
    },
  })

  const recall = defineTool({
    name: 'exp_recall',
    description: '按任务意图召回历史经验。默认先做簇路由（确定性的簇内检索，无同族回退全库）；返回 brief（记忆简报）、route（路由结果）与 candidates。mode=advantage：按 JitRL 优势排序；mode=evidence：无成败对照，Â 不具区分度，改按相似度×证据强度排序。',
    parameters: {
      intent: { type: 'string', required: true, description: '当前任务意图。' },
      limit: { type: 'number', description: '返回几条候选做法，默认 8。' },
      cluster: { type: 'string', description: '可选：直接指定簇（类型名或 id），跳过路由。' },
      context: { type: 'array', description: '可选：当前任务的情境线索；给了就优先召回情境匹配的经验。' },
      mark: { type: 'boolean', description: '可选：把这次召回记为一次「主动提取」（累加 retrievals，用于证据展示，不改排序）。' },
      all: { type: 'boolean', description: '可选：强制全库检索，忽略路由。' },
    },
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    execute(args = {}) {
      const dataDir = dataDirOf()
      const store = readStore(dataDir)
      // 技能优先：高确定技能命中时只返回技能本身，不再列具体经验。
      // 只拿还没全局注册的技能：注册过的交给 DSH 当普通技能用，经验库不再排序它
      const skills = listSkills(dataDir, { onlyLocal: true })
      const pendingSkills = skills.filter((skill) => skill.meta.pendingCommit === true).length
      const confidentHit = matchSkill(skills, String(args.intent || ''), { context: args.context, requireConfident: true })
      const overallHit = matchSkill(skills, String(args.intent || ''), { context: args.context, requireConfident: false, minSimilarity: TRIAL_MIN_SIMILARITY })
      // 先算两种命中再决定用哪个：高确定命中可能只因为「候选池被置信过滤缩小」而赢，
      // 例如问页码时池里只剩 pptx-existing-deck-edit；此时 overall 的 pptx-page-number(0.525)
      // 明显更像，应该按「试用技能」给它，而不是错配给养熟的旧技能。
      const overallClearlyBetter = overallHit !== null
        && (confidentHit === null || (overallHit.skill.slug !== confidentHit.skill.slug && overallHit.score >= confidentHit.score * 1.25))
      const picked = overallClearlyBetter ? { hit: overallHit, trial: true } : (confidentHit !== null ? { hit: confidentHit, trial: false } : (overallHit !== null ? { hit: overallHit, trial: true } : null))
      if (picked !== null) {
        const hit = picked.hit
        const mode = picked.trial ? 'skill-trial' : 'skill'
        logUsage(dataDir, {
          tool: 'exp_recall',
          intent: String(args.intent || ''),
          mode,
          skill: hit.skill.slug,
          candidates: 0,
          hit: true,
          marked: args.mark === true,
        }, usageOptions)
        return {
          mode,
          intent: String(args.intent || ''),
          skill: {
            id: hit.skill.slug,
            name: hit.skill.name,
            description: hit.skill.description,
            body: hit.skill.body,
            context: hit.skill.meta.context,
            files: (hit.skill.meta.files || []).map((item) => item.path),
            confidence: { ...hit.skill.meta.confidence, reason: confidenceReason(hit.skill.meta) },
            score: Math.round(hit.score * 1000) / 1000,
          },
          candidates: [],
          pendingSkills,
          note: picked.trial
            ? `试用技能（还没养熟，${confidenceReason(hit.skill.meta)}）：可以按它做，但先自行核对；用完用 exp_feedback("skill:${hit.skill.slug}", "helped"/"hurt") 回填，累计 3 次且比例 ≥0.8 后自动升级为高确定技能。`
            : `高确定技能：直接用。成功用 exp_feedback("skill:${hit.skill.slug}", "helped") 回填；遇阻用 exp_record 带 skillId 与 blockedBy 记一条。`,
        }
      }
      const routing = args.all === true
        ? 'off'
        : (config.routing === 'shadow' ? 'shadow' : config.routing === 'off' ? 'off' : 'on')
      let clusterId
      if (args.cluster !== undefined && args.cluster !== null && String(args.cluster).trim() !== '') {
        const type = findType(store.types, String(args.cluster))
        if (type === null) throw new Error(`没有这个簇：${String(args.cluster)}（用 exp_type list 看现有类型）`)
        clusterId = type.id
      }
      const result = rankExperiences(store, String(args.intent || ''), args.limit || 8, { routing, clusterId, consolidation: config.consolidation, consolidationMinSamples: config.consolidationMinSamples, context: args.context })
      result.pendingSkills = pendingSkills
      // 归纳提示（实验，2026-11-07）：同族样本够多时给一段原料让模型自己归纳；config.induction=false 可关。
      if (config.induction !== false) {
        const induction = buildInduction(result.candidates, { minSamples: config.inductionMinSamples })
        if (induction !== null) result.induction = induction
      }
      // 提取即强化（0.26.0）：只有调用方显式 mark 才记「主动提取」次数，读到不写、不污染排序。
      if (args.mark === true) {
        const recalledIds = new Set(result.candidates.flatMap((candidate) => (candidate.evidence || []).map((evidence) => evidence.id)))
        let marked = 0
        for (const row of store.experiences) {
          if (!recalledIds.has(row.id)) continue
          row.retrievals = (Number(row.retrievals) || 0) + 1
          marked += 1
        }
        if (marked > 0) writeStore(dataDir, store)
        result.marked = marked
      }
      logUsage(dataDir, {
        tool: 'exp_recall',
        intent: String(args.intent || ''),
        candidates: result.candidates.length,
        neighbors: result.neighbor_count,
        hit: result.candidates.length > 0,
        mode: result.mode,
        route: result.route && result.route.fallback === false ? result.route.name : '(fallback)',
        route_score: result.route ? result.route.score : null,
        limit: Math.max(1, Math.trunc(Number(args.limit) || 8)),
        ids: result.candidates.slice(0, 3).map((candidate) => ((candidate.evidence || [])[0] || {}).id).filter(Boolean),
        induction: typeof result.induction === 'string',
        marked: args.mark === true,
        markedCount: Number(result.marked) || 0,
      }, usageOptions)
      return result
    },
  })

  const feedback = defineTool({
    name: 'exp_feedback',
    description: '用过一条召回的经验之后回报结果：helped（靠它做成了）/ hurt（用了反而返工、被纠正或没帮上）/ neutral（用了但没影响）。反馈按 EMA 修正该条的回报 G（排序依据），不动 hits、不新建条目、不改 outcome；下次召回按新回报排序。',
    parameters: {
      id: { type: 'string', required: true, description: '经验 id（exp_recall 结果里 evidence[].id）。' },
      result: { type: 'string', enum: ['helped', 'hurt', 'neutral'], required: true, description: '用后结果：helped / hurt / neutral。' },
      intent: { type: 'string', description: '可选：当时任务的意图（只进审计日志，不动经验内容）。' },
      note: { type: 'string', description: '可选：怎么用的、结果如何（≤200 字，只进审计日志）。' },
    },
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    execute(args = {}) {
      const dataDir = dataDirOf()
      // 技能反馈：id 形如 skill:<slug> 时改技能账本，而不是经验条。
      if (String(args.id || '').startsWith('skill:')) {
        const slug = String(args.id).slice('skill:'.length).trim()
        if (slug === '') throw new Error('skill id 不能为空：应形如 skill:<slug>')
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
          hint: args.result === 'hurt'
            ? 'hurt 会拉低 helped 比例：跌出阈值后召回不再只返回技能，具体经验重新可见。'
            : 'helped 累积到 ≥3 次且比例 ≥0.8 后，该技能才会被高确定召回。',
        }
      }
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
    },
  })

  const consolidateTool = defineTool({
    name: 'exp_consolidate',
    description: '把同族经验沉淀成技能：同族 ≥3 条且 ≥2 正 1 负时，生成 .exp/skills/<slug>/（SKILL.md 标准模板 + skill.json 账本）；相同 slug 再次沉淀会更新定义。可传 body 写正文、files 挂脚本（复制进 scripts/ 并在 SKILL.md 生成「## 脚本」清单）。技能归经验库自己管：不复制到 DSH skills 目录，召回时按需以技能形态返回。技能仍由 Â/障碍计数管理。',
    parameters: {
      intent: { type: 'string', required: true, description: '要沉淀的技能对应的任务意图（与 exp_recall 同一口径）。' },
      type: { type: 'string', description: '可选：技能名（默认「类型：共同词」）。' },
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
        name: args.type,
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
      const slug = String(args.slug || '').trim()
      if (slug === '') throw new Error('slug 必填')
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
      }
    },
  })

  const typeTool = defineTool({
    name: 'exp_type',
    description: '管理经验类型：list 列表（含条数）/ create 新建 / rename 改名 / merge 合并（经验批量改挂，源类型删除）/ delete 删除（经验归「未分类」）/ assign 把单条经验改挂到指定类型（定点修脏数据，不动 hits）。',
    parameters: {
      action: { type: 'string', enum: ['list', 'create', 'rename', 'merge', 'delete', 'assign'], required: true, description: '要执行的动作。' },
      name: { type: 'string', description: 'create/rename/delete 时的类型名或 id（rename 时是旧名）；assign 时的目标类型名。' },
      newName: { type: 'string', description: 'rename 的新名；merge 的目标类型名（不存在会新建）。' },
      names: { type: 'array', description: 'merge 时的来源类型名/id 列表。' },
      id: { type: 'string', description: 'assign 时的经验 id（exp_recall 证据里的 id）。' },
      description: { type: 'string', description: 'create/rename 时可选写描述（≤120 字）。' },
    },
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    execute(args = {}) {
      const dataDir = dataDirOf()
      const store = readStore(dataDir)
      const action = String(args.action || '').trim()
      let result
      if (action === 'list') {
        result = { action, types: listTypes(store) }
      } else if (action === 'create') {
        const type = createType(store, args.name, args.description)
        result = { action, created: type.name, typeId: type.id }
      } else if (action === 'rename') {
        const renamed = renameType(store, args.name, args.newName, args.description)
        result = { action, from: renamed.oldName, to: renamed.type.name }
      } else if (action === 'merge') {
        result = { action, ...mergeTypes(store, args.names, args.newName, args.description) }
      } else if (action === 'delete') {
        result = { action, ...deleteType(store, args.name) }
      } else if (action === 'assign') {
        result = { action, ...assignType(store, args.id, args.name) }
      } else {
        throw new Error(`不支持的类型动作：${action}`)
      }
      writeStore(dataDir, store)
      logUsage(dataDir, {
        tool: 'exp_type',
        op: action,
        target: String(args.name || args.id || args.newName || ''),
      }, usageOptions)
      result.typeCount = store.types.filter((type) => type.system !== true && type.id !== 'ty_other').length
      result.typeLimit = Math.max(1, Math.trunc(Number(config.maxTypes) || 24))
      return result
    },
  })

  // 失败调用也要留痕：否则「调用次数」的分母只含成功调用，使用率会被高估。
  // 成功行由各工具自己写（带业务字段）；这里只兜异常。
  const guarded = [record, recall, feedback, consolidateTool, skillAttachTool, typeTool].map((tool) => ({
    ...tool,
    execute(args = {}) {
      try {
        return tool.execute(args)
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
