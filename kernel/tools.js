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
  pendingTasks,
  rankExperiences,
  readStore,
  resolveVerdicts,
  visibleExperiences,
  renameType,
  scoreOf,
  withStoreLock,
  upsertExperience,
  writeStore,
} from './store.js'
import { findRecordBinding, userMessageForRecord } from './session.js'
import { measure, slimRecall, slimReceipt } from './token-budget.js'
import { pendingBrief } from './brief.js'
import { summarizeUserEdits } from './artifact-diff.js'
import { routeCluster } from './cluster.js'
import { resolveEngramDataDir } from './settings.js'
import { applySkillObstacle, applySkillOutcome, attachSkillFiles, confidenceReason, createSkill, deriveSkillDraft, listSkills, matchSkill, readSkillBySlug, resolveSkillId } from './skills.js'

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
      return userMessageForRecord({ sessionId: item.sessionId, turn: item.turn }, { sessionsRoot: config.sessionsRoot })
    } catch {
      return ''
    }
  }

  const record = defineTool({
    name: 'exp_record',
    description: '记录一条工作经验（做法 + 结果）。同一做法会就地更新 hits，近似替换会写新条并标记旧条被取代。',
    parameters: {
      intent: { type: 'string', required: true, description: '要做的任务/意图。' },
      action: { type: 'string', required: true, description: '采取的做法或方案名。' },
      outcome: { type: 'string', enum: ['accepted', 'success', 'partial', 'unknown', 'failed', 'corrected', 'aborted'], description: '结果；影响回报 G。' },
      // 不叫 type：与 JSON Schema 的 type 关键字同名时，provider 严格校验会把参数当关键字读。
      typeName: { type: 'string', description: '类型名（可选）。不填归「未分类」；填了新名字会按需新建类型（受上限与近似合并限制）。' },
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
      artifacts: { type: 'array', description: '可选：本次产物的路径（工作区相对路径，≤5）。给用户手改学习留锚点。' },
      dimensions: { type: 'array', description: '可选：能力维度（≤3 个短标签，如「布局」「语义理解」）；只存不校验。' },
      verdicts: { type: 'array', description: '可选：回填回执里的 pending，[{id,outcome,dimensions?}]；一次可回填多条。' },
      cwd: { type: 'string', description: '可选：工作区路径（headless/脚本调用时给；给了才能对手改产物做 diff）。' },
      skillId: { type: 'string', description: '可选：本次使用的技能（技能 id 或 skill:<slug>）；记录后更新技能 confidence/障碍并提交。' },
      blockedBy: { type: 'string', description: '可选：本次撞到的障碍原文；给了就按签名计数，连续 3 次覆盖技能。' },
      blockedByList: { type: 'array', description: '可选：一次撞到多个障碍时传数组，各签名分别计数（与 blockedBy 二选一）。' },
    },
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    execute(args = {}) {
      const dataDir = dataDirOf()
      return withStoreLock(dataDir, () => {
      const store = readStore(dataDir)
      // 没给类型时按簇路由自动归族（config.routing='off' 或 autoAssign=false 可关）；落不进任何簇就保持「未分类」。
      const autoAssign = config.autoAssign !== false && config.routing !== 'off'
      let typeName = args.typeName !== undefined ? args.typeName : args.type
      let routedCluster = null
      if ((typeName === undefined || typeName === null || String(typeName).trim() === '') && autoAssign) {
        const route = routeCluster(store, String(args.intent || ''))
        if (!route.fallback) {
          typeName = route.name
          routedCluster = { clusterId: route.clusterId, name: route.name, score: route.score }
        }
      }
      // 回填（0.13.0）：模型把上一条 pending 的判定带回来；插件只写回，不判断。
      const verdictResults = Array.isArray(args.verdicts) && args.verdicts.length > 0
        ? resolveVerdicts(store, args.verdicts)
        : []
      // 绑定会话 turn：读最近会话里的 tool/call，把本条记录挂到它所在的回合（只读，失败就跳过）。
      let binding = null
      if (config.autoBind !== false) {
        try {
          binding = findRecordBinding({ intent: args.intent, action: args.action }, { sessionsRoot: config.sessionsRoot })
        } catch {
          binding = null
        }
      }
      // 待判定队列在写入本条之前取：刚记的这条不算「提醒过一次」，下一轮才出现。
      const pendingOut = pendingTasks(store, 2, { pendingTtl: config.pendingTtl })
      const result = upsertExperience(store, {
        intent: args.intent,
        action: args.action,
        outcome: args.outcome,
        verdict: (args.outcome === undefined || args.outcome === null || String(args.outcome).trim() === '') ? 'pending' : 'decided',
        sessionId: binding === null ? undefined : binding.sessionId,
        turn: binding === null ? undefined : binding.turn,
        cwd: (typeof args.cwd === 'string' && args.cwd.trim() !== '') ? args.cwd.trim() : (binding === null ? undefined : binding.cwd),
        artifacts: args.artifacts,
        dimensions: args.dimensions,
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
            skillResult = applySkillOutcome(dataDir, slug, Number(result.experience.G) < 0 ? 'hurt' : 'helped', { intent: args.intent })
          }
          const warning = skillResult.action === 'multi'
            ? (skillResult.results.find((item) => typeof item.warning === 'string') || {}).warning
            : skillResult.warning
          if (typeof warning === 'string') skillWarning = warning
        }
      }
      const typeInfo = result.type || {}
      const sanitized = result.sanitized || {}
      const active = visibleExperiences(store)
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
        typeCreated: typeInfo.created === true ? true : undefined,
        typeMergedInto: typeInfo.mergedInto || undefined,
        typeWarning: typeInfo.rejected ? `${typeInfo.reason}（已归「未分类」）` : undefined,
        typeRecoveredFromNote: result.typeRecoveredFromNote === true ? true : undefined,
        noteSanitized: sanitized.note === true || sanitized.intent === true || sanitized.action === true ? true : undefined,
        routedCluster,
        supersededId: result.supersededId || undefined,
        retired: Array.isArray(result.retired) && result.retired.length > 0 ? result.retired : undefined,
        count: active.length,
        // outcome 与分步回报反号时明确提示：G 取最弱一步，统计会按 G 记失败（2026-11-07）。
        signWarning: result.signMismatch === true
          ? `outcome（${result.experience.outcome}）与分步回报反号：G=${result.experience.G} 取最弱一步，统计会按 G 记失败。`
          : undefined,
        verdicts: verdictSummary(verdictResults),
        pending: pending.length > 0 ? pending : undefined,
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
      intent: { type: 'string', required: true, description: '当前任务意图。写「对象+任务+关键约束」（如「给研学课 PPT 插一页（深蓝色调）」）；只写「再来一页」这种省略句会因相似度不足召回不到。' },
      limit: { type: 'number', description: '返回几条候选做法，默认 3；显式给就按给的值（≤8，簇内也不截到 4）。改稿/纠错要看「上次那条」时给 5~6。' },
      cluster: { type: 'string', description: '可选：直接指定簇（类型名或 id），跳过路由。' },
      context: { type: 'array', description: '可选：当前任务的情境线索；给了就优先召回情境匹配的经验。' },
      mark: { type: 'boolean', description: '可选：把这次召回记为一次「主动提取」（累加 retrievals，用于证据展示，不改排序）。' },
      all: { type: 'boolean', description: '可选：强制全库检索，忽略路由。' },
      detail: { type: 'boolean', description: '可选：返回完整回执（含全部字段与长 note）；默认瘦身档省 token。' },
      verdicts: { type: 'array', description: '可选：顺手回填回执里的 pending，[{id,outcome,dimensions?}]。' },
    },
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    execute(args = {}) {
      const dataDir = dataDirOf()
      return withStoreLock(dataDir, () => {
      const store = readStore(dataDir)
      // 回填（0.13.0）：召回时顺手把上一条 pending 结掉，模型不必为判定新开一次调用。
      const verdictResults = Array.isArray(args.verdicts) && args.verdicts.length > 0
        ? resolveVerdicts(store, args.verdicts)
        : []
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
        && (confidentHit === null || (overallHit.skill.slug !== confidentHit.skill.slug && overallHit.score >= confidentHit.score))
      const picked = overallClearlyBetter ? { hit: overallHit, trial: true } : (confidentHit !== null ? { hit: confidentHit, trial: false } : (overallHit !== null ? { hit: overallHit, trial: true } : null))
      const routing = args.all === true
        ? 'off'
        : (config.routing === 'shadow' ? 'shadow' : config.routing === 'off' ? 'off' : 'on')
      let clusterId
      if (args.cluster !== undefined && args.cluster !== null && String(args.cluster).trim() !== '') {
        const type = findType(store.types, String(args.cluster))
        if (type === null) throw new Error(`没有这个簇：${String(args.cluster)}（用 exp_type list 看现有类型）`)
        clusterId = type.id
      }
      const recallLimit = Math.max(1, Math.min(8, Math.trunc(Number(args.limit) || Number(config.recallLimitDefault) || 3)))
      const result = rankExperiences(store, String(args.intent || ''), recallLimit, { routing, clusterId, consolidation: config.consolidation, consolidationMinSamples: config.consolidationMinSamples, context: args.context, explicitLimit: Number(args.limit) > 0, rankBlend: config.rankBlend !== false, recent: config.recent !== false })
      // 相似度低于 0.20 且判 weak：不展示噪声候选（无关任务时避免「1 条沾边候选」被当推荐）。
      if (result.weak === true && Number(result.topSimilarity || 0) < 0.2) result.candidates = []
      result.pendingSkills = pendingSkills
      // 待判定：随回执带出（≤2 条）。
      const pendingOut = pendingTasks(store, 2, { pendingTtl: config.pendingTtl })
      if (verdictResults.some((item) => item.ok) || pendingOut.rows.length > 0 || pendingOut.skipped.length > 0) writeStore(dataDir, store)
      const pending = config.pendingReceipt === false
        ? []
        : pendingOut.rows.map((item) => ({ id: item.id, brief: pendingBrief(item, { quote: pendingQuote(item), edit: pendingEdit(item) }) }))
      // 技能命中时不再吞掉经验候选：技能给正文，经验给参考（并列返回），
      // 否则同一意图下刚写的经验会被技能模式完全遮住（验收时发现的读路径问题）。
      if (picked !== null) {
        const hit = picked.hit
        const mode = picked.trial ? 'skill-trial' : 'skill'
        // detail：按调用方 limit 返回（默认瘦身档只给 2 条）；技能正文另算。
        const candidates = args.detail === true || config.slimRecall === false
          ? (result.candidates || []).slice(0, recallLimit)
          : (slimRecall(result, { limit: 2, detail: false }).candidates || [])
        // 技能命中不代表经验候选相关：与普通路径同口径，用候选的 mean_similarity（拿不到再退回证据相似度）。
        const similarityOf = (candidate) => (Number.isFinite(Number(candidate.mean_similarity))
          ? Number(candidate.mean_similarity)
          : Math.max(0, ...(candidate.evidence || []).map((evidence) => Number(evidence.similarity) || 0)))
        const maxSimilarity = candidates.reduce((max, candidate) => Math.max(max, similarityOf(candidate)), 0)
        const weakCandidates = candidates.length === 0 || maxSimilarity < 0.4
        const relevanceGeneral = !weakCandidates && candidates.length > 0 && maxSimilarity < 0.5
        const similarityText = String(Math.round(maxSimilarity * 10000) / 10000)
        const skillPayload = {
          mode,
          intent: String(args.intent || ''),
          skill: {
            id: hit.skill.slug,
            name: hit.skill.name,
            description: hit.skill.description,
            body: (() => {
              // 正文可能几万字（实测某技能 28k）：回执里截到 12k 并标注，完整正文用 readSkill 读。
              const raw = String(hit.skill.body || '')
              return raw.length > 6000 ? `${raw.slice(0, 6000)}\n…（正文过长已截断，共 ${raw.length} 字符；完整内容用 readSkill 读）` : raw
            })(),
            ...(String(hit.skill.body || '').length > 6000 ? { bodyTruncated: true, bodyChars: String(hit.skill.body).length } : {}),
            context: hit.skill.meta.context,
            files: (hit.skill.meta.files || []).map((item) => item.path),
            confidence: { ...hit.skill.meta.confidence, reason: confidenceReason(hit.skill.meta) },
            score: Math.round(hit.score * 1000) / 1000,
            // 自查依据：命中词。任务里明显无关却命中的技能，按错配处理。
            match: {
              matchedTerms: Array.isArray(hit.matchedTerms) ? hit.matchedTerms : [],
              selfCheck: '先看 matchedTerms 与当前任务是否真的相关；明显无关说明这次是错配，换更具体的 intent 重试（例如把「页面动画」换成「CSS 过渡/帧预算/缓动曲线」），不要硬套这个技能。',
            },
          },
          candidates,
          // 技能命中也要带「最近做过」：否则上一轮刚记的教训在下次碰巧命中技能时完全看不到。
          recent: Array.isArray(result.recent) ? result.recent.slice(0, 2) : [],
          ...(weakCandidates || !result.brief ? {} : { brief: result.brief }),
          cluster: result.route && result.route.fallback === false ? result.route.name : undefined,
          pendingSkills: pendingSkills,
          pending: pending.length > 0 ? pending : undefined,
          verdicts: verdictSummary(verdictResults),
          ...(weakCandidates ? { weak: true } : {}),
          ...(weakCandidates || relevanceGeneral ? { topSimilarity: Math.round(maxSimilarity * 10000) / 10000 } : {}),
          note: (picked.trial
            ? '试用技能（未养熟）：先看 matchedTerms 是否相关，无关就换 intent 重试；相关则照做，用完 exp_feedback 回填。'
            : '高确定技能：先看 matchedTerms，无关就是错配，换 intent 重试；成功用 exp_feedback 回填，遇阻记 skillId+blockedBy。')
            + (weakCandidates && candidates.length === 0
              ? ' 经验候选为空，别当参考。'
              : (weakCandidates
                ? ' 经验候选都不够相关（最高相似度低），别当参考。'
                : (relevanceGeneral ? ` 候选相关度一般（${similarityText}），参考而非照抄。` : (candidates.length > 0 ? ' 下方候选可参考。' : '')))),
        }
        logUsage(dataDir, {
          tool: 'exp_recall',
          intent: String(args.intent || ''),
          mode,
          skill: hit.skill.slug,
          candidates: candidates.length,
          hit: true,
          marked: args.mark === true,
          chars: measure(skillPayload),
        }, usageOptions)
        return skillPayload
      }      // 归纳提示（实验，2026-11-07）：同族样本够多时给一段原料让模型自己归纳；config.induction=false 可关。
      if (config.induction !== false) {
        // 归纳只用「本次可见」的候选：提示里写的是「本次可见 N 条」，N 必须与返回条数一致。
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
        limit: recallLimit,
        ids: result.candidates.slice(0, 3).map((candidate) => ((candidate.evidence || [])[0] || {}).id).filter(Boolean),
        induction: typeof result.induction === 'string',
        marked: args.mark === true,
        markedCount: Number(result.marked) || 0,
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
    description: '管理经验类型：list 列表（含条数）/ create 新建 / rename 改名 / merge 合并（经验批量改挂，源类型删除）/ delete 删除（经验归「未分类」）/ assign 把单条经验改挂到指定类型（定点修脏数据，不动 hits）。',
    parameters: {
      action: { type: 'string', enum: ['list', 'create', 'rename', 'merge', 'delete', 'assign'], required: true, description: '要执行的动作。' },
      name: { type: 'string', description: 'create/rename/delete 时的类型名或 id（rename 时是旧名）；assign 时的目标类型名。' },
      newName: { type: 'string', description: 'rename 的新名；merge 的目标类型名（不存在会新建）。' },
      names: { type: 'array', description: 'merge 时的来源类型名/id 列表。' },
      id: { type: 'string', description: 'assign 时的经验 id（exp_recall 证据里的 id）。' },
      // 不叫 description：与 JSON Schema 的 description 关键字同名，provider 严格校验会误读。
      typeDescription: { type: 'string', description: 'create/rename 时可选写描述（≤120 字）。' },
    },
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    execute(args = {}) {
      const dataDir = dataDirOf()
      return withStoreLock(dataDir, () => {
      const store = readStore(dataDir)
      const action = String(args.action || '').trim()
      let result
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
