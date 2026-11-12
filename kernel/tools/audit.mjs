#!/usr/bin/env node
/**
 * 经验库体检（只读）：把「靠人读召回输出」换成可复跑的一组指标。
 *
 *   node tools/audit.mjs [dataDir]
 *
 * 默认 dataDir 跟随 Provider 服务设置，读不到再用插件配置/当前目录。
 * 退出码：0 = 无 FAIL；1 = 有 FAIL（脏数据 / 完全召回空转）。
 *
 * 检查项：
 *  1. 条目与类型分布（含 0 条目的业务类型）
 *  2. 回报分布与负样本数（没有负样本 → 排序无区分度）
 *  3. 对照覆盖：同类型下相似度 ≥ 0.45 且符号相反的经验对
 *  4. 工具调用残渣（</note> / <parameter）
 *  5. 固定意图集召回：过阈条数、top1、mode（衡量「库是不是真的召得回」）
 */
import path from 'node:path'
import fs from 'node:fs'

import {
  DEGENERATE_ADV_SPREAD,
  rankExperiences,
  readManifest,
  readStore,
  resolveToolDataDir,
  storeFile,
  visibleExperiences,
} from '../store.js'
import { legacyPath } from '../shard-store.js'
import { RECALL_MIN_SIMILARITY, similarityV2, stateOf } from '../retrieval.js'
import { listSkills, validateAllSkills } from '../skills.js'
import { resolveEngramDataDir } from '../settings.js'

/** 固定体检意图：覆盖库里常见主题；不为具体条目写死 id，看的是「召不召得回」。 */
export const AUDIT_INTENTS = [
  '做个研学课 PPT',
  '给课件插一页过渡页',
  '改 PPT 页码',
  '把插件发布到 GitHub',
  '给插件跑自动化测试',
  '清理临时 worktree',
  '写 bat 和 ps1 脚本',
  '经验库写入语义怎么设计',
  '安装本地第三方插件',
  '在沙箱里推 GitHub',
  '做一节课的任务单',
  '改一条史实锚点',
]

const RESIDUE_RE = /<\/?\s*note\s*>|<\s*parameter\b/i

/**
 * 迁移留痕：对比「落盘的旧快照」与「readStore 迁移/归一化后的 G」（只读，不落盘）。
 *
 * 0.14.0 起存储是分片布局：迁移会把 `exp-lib.json` 改名成 `exp-lib.legacy.json`，
 * 所以旧文件优先顺序是：现存的 `exp-lib.json`（未迁移）→ `exp-lib.legacy.json`（已迁移的快照）。
 * 两者都没有而 manifest 在：说明是分片库但 legacy 被删了，无法对比——明确说明，不静默当「无差异」。
 * @returns {{available: boolean, source?: 'single-file'|'legacy', reason?: string, migrated: number, maxDelta: number, examples: string[]}}
 */
export function migrationReport(store, dataDir) {
  const singleFile = storeFile(dataDir)
  const legacyFile = legacyPath(dataDir)
  let manifest = null
  try {
    manifest = readManifest(dataDir)
  } catch {
    manifest = null
  }
  let raw = null
  let source = ''
  try {
    if (fs.existsSync(singleFile)) {
      raw = JSON.parse(fs.readFileSync(singleFile, 'utf8'))
      source = 'single-file'
    } else if (fs.existsSync(legacyFile)) {
      raw = JSON.parse(fs.readFileSync(legacyFile, 'utf8'))
      source = 'legacy'
    } else if (manifest !== null) {
      return {
        available: false,
        reason: '已迁移到分片，但 exp-lib.legacy.json 快照不存在（无法做迁移留痕对比）',
        migrated: 0,
        maxDelta: 0,
        examples: [],
      }
    } else {
      return { available: false, reason: '没有可对照的旧库文件（首跑/空库）', migrated: 0, maxDelta: 0, examples: [] }
    }
  } catch (error) {
    return {
      available: false,
      reason: `旧库快照读不了：${error && error.message ? error.message : error}`,
      migrated: 0,
      maxDelta: 0,
      examples: [],
    }
  }
  const rawById = new Map((Array.isArray(raw.experiences) ? raw.experiences : []).map((item) => [item.id, item]))
  let migrated = 0
  let maxDelta = 0
  const examples = []
  for (const row of store.experiences) {
    const before = rawById.get(row.id)
    if (before === undefined) continue
    const oldG = Number(before.G)
    const newG = Number(row.G)
    if (!Number.isFinite(oldG) || !Number.isFinite(newG) || Math.abs(oldG - newG) < 1e-9) continue
    migrated += 1
    const delta = Math.abs(oldG - newG)
    if (delta > maxDelta) maxDelta = delta
    if (examples.length < 3) examples.push(`${String(row.id).slice(0, 8)} ${oldG.toFixed(2)}→${newG.toFixed(2)}`)
  }
  return { available: true, source, migrated, maxDelta, examples }
}

function main() {
  const dataDir = path.resolve(process.argv[2] || resolveEngramDataDir({}))
  const store = readStore(dataDir)
  // 分片布局的读回顺序是「按桶分组」，单文件是按文件顺序：诊断输出不能因此漂移。
  // 统一按 id 排序，保证同一份数据在两种布局下输出逐行可比（相似度是有方向的，顺序会改结果）。
  const active = visibleExperiences(store).sort((left, right) => String(left.id).localeCompare(String(right.id)))
  // 召回也用同一顺序的 experiences：分片布局下 store.experiences 的顺序不同，平手时 top1 会漂。
  const recallStore = { ...store, experiences: [...store.experiences].sort((left, right) => String(left.id).localeCompare(String(right.id))) }
  const fails = []
  const warns = []

  console.log(`经验库体检：${dataDir}`)
  console.log(`条目 ${active.length}（总 ${store.experiences.length}）｜类型 ${store.types.length}`)

  /* ---- 1. 类型分布 ---- */
  const counts = new Map()
  for (const item of active) counts.set(item.typeId, (counts.get(item.typeId) || 0) + 1)
  const userTypes = store.types.filter((type) => type.system !== true && type.id !== 'ty_other')
  console.log('\n[类型分布]')
  const emptyTypes = []
  for (const type of store.types) {
    const count = counts.get(type.id) || 0
    if (type.system !== true && count === 0) emptyTypes.push(type.name)
    console.log(`  ${type.system === true ? '·' : ' '} ${type.name}: ${count}`)
  }
  console.log(`  业务类型 ${userTypes.length}/24${emptyTypes.length > 0 ? `｜0 条的类型：${emptyTypes.join('、')}` : ''}`)

  /* ---- 1b. 簇一致性（cluster 是 type 的派生视图，两者必须对齐） ---- */
  const clusters = Array.isArray(store.clusters) ? store.clusters : []
  const clusterSum = clusters.reduce((sum, cluster) => sum + (Number(cluster.stats && cluster.stats.count) || 0), 0)
  const orphan = active.filter((item) => !store.types.some((type) => type.id === item.typeId))
  const emptyClusters = clusters.filter((cluster) => (Number(cluster.stats && cluster.stats.count) || 0) === 0 && cluster.system !== true)
  const blankSignature = clusters.filter((cluster) => (Number(cluster.stats && cluster.stats.count) || 0) > 0
    && (cluster.signature.artifacts.length + cluster.signature.tokens.length + cluster.signature.cgrams.length) === 0)
  console.log('\n[簇一致性]')
  console.log(`  簇 ${clusters.length}（类型 ${store.types.length}）｜归属合计 ${clusterSum}（可见 ${active.length}）｜空簇 ${emptyClusters.length}`)
  if (clusters.length !== store.types.length) fails.push(`簇数 ${clusters.length} 与类型数 ${store.types.length} 不一致`)
  if (clusterSum !== active.length) fails.push(`簇归属合计 ${clusterSum} ≠ 可见经验 ${active.length}（有经验没归入任何簇）`)
  if (orphan.length > 0) fails.push(`${orphan.length} 条经验的 typeId 不在类型表里（${orphan.slice(0, 3).map((item) => item.id).join('、')}）`)
  if (blankSignature.length > 0) warns.push(`有 ${blankSignature.length} 个簇签名全空（intent/action 太短？）`)

  /* ---- 2. 回报分布 ---- */
  const Gs = active.map((item) => Number(item.G) || 0)
  const get = (n) => active.filter((item) => item.outcome === n).length
  const negatives = Gs.filter((g) => g < 0).length
  console.log('\n[回报分布]')
  console.log(`  accepted ${get('accepted')}｜success ${get('success')}｜partial ${get('partial')}｜unknown ${get('unknown')}`)
  console.log(`  failed ${get('failed')}｜corrected ${get('corrected')}｜aborted ${get('aborted')}`)
  console.log(`  G 区间 ${Gs.length ? Math.min(...Gs).toFixed(2) : '-'} .. ${Gs.length ? Math.max(...Gs).toFixed(2) : '-'}｜负样本 ${negatives}`)
  const withFeedback = active.filter((item) => item.feedback !== null && typeof item.feedback === 'object'
    && (Number(item.feedback.helped) || 0) + (Number(item.feedback.hurt) || 0) + (Number(item.feedback.neutral) || 0) > 0)
  const sumFeedback = (key) => withFeedback.reduce((total, item) => total + (Number(item.feedback[key]) || 0), 0)
  const feedbackRewritten = active.filter((item) => item.GSource === 'feedback').length
  console.log(`  用后反馈：${withFeedback.length} 条｜helped ${sumFeedback('helped')}｜hurt ${sumFeedback('hurt')}｜neutral ${sumFeedback('neutral')}｜G 被反馈改写过 ${feedbackRewritten}`)
  // 退休 / 生命周期：退休是「做法已被成功绕过」的软隐，不是删除；审计里要能看见。
  const retired = store.experiences.filter((item) => item.retired_at && !item.deleted_at).length
  const revived = store.experiences.filter((item) => Array.isArray(item.history) && item.history.some((event) => event.type === 'revived')).length
  console.log(`  生命周期：退休 ${retired}｜复活过 ${revived}｜历史中位 ${store.experiences.length ? Math.round(store.experiences.reduce((total, item) => total + (Array.isArray(item.history) ? item.history.length : 0), 0) / store.experiences.length) : 0} 条`)
  // 预测误差：有多少条是「带预期」记的，平均偏了多少。
  const withPrediction = store.experiences.filter((item) => item.expectedG !== undefined && item.expectedG !== null && Number.isFinite(Number(item.predictionError)))
  if (withPrediction.length > 0) {
    const meanAbs = withPrediction.reduce((total, item) => total + Math.abs(Number(item.predictionError)), 0) / withPrediction.length
    console.log(`  预测误差：${withPrediction.length} 条有预期｜平均 |误差| ${meanAbs.toFixed(2)}`)
  }

  const migration = migrationReport(store, dataDir)
  if (migration.available === false) {
    console.log(`  迁移留痕：不可用（${migration.reason}）`)
  } else {
    const label = migration.source === 'legacy' ? 'legacy 快照' : 'exp-lib.json'
    if (migration.migrated > 0) console.log(`  迁移留痕（对照 ${label}）：${migration.migrated} 行 G 被读时重算（最大 Δ${migration.maxDelta.toFixed(2)}）｜${migration.examples.join('；')}`)
    else console.log(`  迁移留痕（对照 ${label}）：无（文件与读后一致）`)
  }

  /* ---- 3. 对照覆盖 ---- */
  let contrastPairs = 0
  for (let i = 0; i < active.length; i += 1) {
    for (let j = i + 1; j < active.length; j += 1) {
      const left = active[i]
      const right = active[j]
      if (left.typeId !== right.typeId) continue
      if (Math.sign(Number(left.G) || 0) === Math.sign(Number(right.G) || 0)) continue
      const similarity = similarityV2(stateOf(left.intent, left.action), stateOf(right.intent, right.action))
      if (similarity >= 0.45) contrastPairs += 1
    }
  }
  console.log('\n[对照覆盖]')
  console.log(`  同类型、意图相似 ≥0.45 的正负样本对：${contrastPairs}`)
  if (active.length >= 6 && contrastPairs === 0) warns.push('没有任何成败对照对：库只能教「坑」，教不了「哪种打法更好」')

  /* ---- 4. 残渣 ---- */
  const dirty = active.filter((item) => RESIDUE_RE.test(`${item.intent}\n${item.action}\n${item.note || ''}`))
  console.log('\n[写入卫生]')
  console.log(`  含工具残渣的条目：${dirty.length}`)
  for (const item of dirty.slice(0, 5)) {
    console.log(`   FAIL ${item.id} [${item.typeName}] ${String(item.intent).slice(0, 30)}`)
    fails.push(`条目 ${item.id} 含工具调用残渣（note/intent/action）`)
  }

  /* ---- 5. 固定意图集召回 ---- */
  console.log('\n[固定意图集召回]')
  let recalled = 0
  for (const intent of AUDIT_INTENTS) {
    const ranked = rankExperiences(recallStore, intent, 5)
    const top = ranked.candidates[0]
    const hit = ranked.neighbor_count > 0
    if (hit) recalled += 1
    console.log(
      `  ${hit ? '√' : '×'} ${intent}: 邻居 ${ranked.neighbor_count}｜${ranked.mode}${top ? `｜${String(top.action).slice(0, 24)}` : ''}`,
    )
  }
  console.log(`  召回率 ${recalled}/${AUDIT_INTENTS.length}`)
  if (active.length >= 6 && recalled === 0) fails.push(`固定意图集全部召回空转（阈值 ${RECALL_MIN_SIMILARITY}）`)
  else if (active.length >= 6 && recalled < AUDIT_INTENTS.length / 2) warns.push(`固定意图集召回率偏低：${recalled}/${AUDIT_INTENTS.length}`)

  /* ---- 技能健康 ---- */
  const skills = listSkills(dataDir)
  if (skills.length > 0) {
    const invalid = validateAllSkills(dataDir)
    const pending = skills.filter((skill) => skill.meta.pendingCommit === true).length
    console.log(`  技能：${skills.length} 个｜不变量问题 ${invalid.length} 条｜待补提交 ${pending}`)
    if (invalid.length > 0) fails.push(`技能不变量问题：${invalid.map((item) => `${item.slug}(${item.problems.join('；')})`).join('、')}`)
    if (pending > 0) warns.push(`${pending} 个技能有 pendingCommit 未补提交`)
  }

  /* ---- 汇总 ---- */
  console.log('')
  if (warns.length > 0) {
    console.log(`WARN ${warns.length} 条：`)
    for (const message of warns) console.log(`  - ${message}`)
  }
  if (fails.length > 0) {
    console.log(`FAIL ${fails.length} 条：`)
    for (const message of fails) console.log(`  - ${message}`)
    console.log(`\n结论：有问题（degenerate 阈值 ${DEGENERATE_ADV_SPREAD}）`)
    process.exit(1)
  }
  console.log('结论：无 FAIL。')
}

if (process.argv[1] && process.argv[1].endsWith('audit.mjs')) main()
