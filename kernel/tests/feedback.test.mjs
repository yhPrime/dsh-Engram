/**
 * 用后反馈（0.4.0）测试：
 *  - helped / hurt / neutral 的语义：G 按 EMA 修正、neutral 不动 G；
 *  - 不动 hits、不新建条目、不改 outcome（反馈是再评估，不是重记一次）；
 *  - 边界：clamp 到 [-1,1]、日志上限、被取代/已删除/未知 id/非法 result 一律拒绝；
 *  - 排序跟随：hurt 到负回报后该条不再排第一；召回证据带 feedback 计数；
 *  - 簇统计（成败计数）跟随反馈；工具落盘。
 * Run: node tests/feedback.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { buildTools } from '../tools.js'
import {
  FEEDBACK_ETA,
  FEEDBACK_LOG_LIMIT,
  FEEDBACK_RESULTS,
  applyFeedback,
  rankExperiences,
  readStore,
  upsertExperience,
} from '../store.js'

let passed = 0
let failed = 0

function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}`)
    console.log(`       ${error && error.message ? error.message : error}`)
  }
}

function tempStore(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  return { dir, store: readStore(dir) }
}

const near = (actual, expected) => Math.abs(Number(actual) - expected) < 1e-9

/* ----------------------------------------------------------- 语义与边界 --- */

const base = tempStore('exp-feedback-')
const made = upsertExperience(base.store, {
  intent: '把经验库装进 desktop profile',
  action: 'npm pack 后 pnpm install 重链',
  outcome: 'success',
  type: '环境 / 部署',
  note: '只换 spec 不重链会留旧包',
})
const id = made.experience.id

check('常量对外可见，FEEDBACK_RESULTS 只有三种', () => {
  assert.deepEqual(Object.keys(FEEDBACK_RESULTS).sort(), ['helped', 'hurt', 'neutral'])
  assert.equal(FEEDBACK_RESULTS.helped, 1)
  assert.equal(FEEDBACK_RESULTS.hurt, -1)
  assert.equal(FEEDBACK_RESULTS.neutral, 0)
  assert.ok(FEEDBACK_ETA > 0 && FEEDBACK_ETA < 1)
  assert.ok(FEEDBACK_LOG_LIMIT > 0)
})

check('helped：G 按 EMA 上调，计数与日志落位，不动 hits / outcome', () => {
  const out = applyFeedback(base.store, id, { result: 'helped', intent: '装插件', note: '确实得重链' })
  assert.equal(out.result, 'helped')
  assert.equal(out.G_before, 0.8)
  assert.ok(near(out.G_after, 0.87), `G_after=${out.G_after}`)
  assert.equal(out.changed, true)
  const experience = base.store.experiences.find((item) => item.id === id)
  assert.equal(experience.GSource, 'feedback')
  assert.equal(experience.outcome, 'success', 'outcome 是首次结果，反馈不改')
  assert.equal(experience.hits, 1, '反馈不动 hits（不是复现）')
  assert.equal(experience.feedback.helped, 1)
  assert.equal(experience.feedback.hurt, 0)
  assert.equal(experience.feedback.lastResult, 'helped')
  assert.equal(experience.feedback_log.length, 1)
  assert.equal(experience.feedback_log[0].intent, '装插件')
  assert.equal(experience.feedback_log[0].note, '确实得重链')
})

check('hurt：两次把正回报拉到负数（一次不翻符号）', () => {
  const { store } = tempStore('exp-feedback-hurt-')
  const experience = upsertExperience(store, { intent: '导出 PPTX 并核对字号', action: '先导出再看字号', outcome: 'success' }).experience
  applyFeedback(store, experience.id, { result: 'hurt' })
  assert.ok(near(experience.G, 0.17), `一次 hurt G=${experience.G}`)
  applyFeedback(store, experience.id, { result: 'hurt' })
  assert.ok(experience.G < 0, `两次 hurt 应变负，G=${experience.G}`)
  assert.ok(near(experience.G, -0.2395), `G=${experience.G}`)
  assert.equal(experience.feedback.hurt, 2)
  assert.equal(experience.outcome, 'success', '结果标签仍记首次结果')
})

check('neutral：只计数，G 不变', () => {
  const { store } = tempStore('exp-feedback-neutral-')
  const experience = upsertExperience(store, { intent: '整理历史归档', action: '按月分目录', outcome: 'success' }).experience
  const out = applyFeedback(store, experience.id, { result: 'neutral' })
  assert.equal(out.G_before, 0.8)
  assert.equal(out.G_after, 0.8)
  assert.equal(out.changed, false)
  assert.equal(experience.feedback.neutral, 1)
  assert.equal(experience.GSource, 'outcome', 'neutral 不动 G，也不把来源改成 feedback')
  assert.equal(experience.feedback_log.length, 1)
})

check('clamp：G 不超过 1、不低于 -1', () => {
  const { store } = tempStore('exp-feedback-clamp-')
  const experience = upsertExperience(store, { intent: '写发布说明', action: '先列改动再写', outcome: 'success' }).experience
  // 默认 η 是渐近的：10 次后 0.9973，永远到不了 1 是正常的；边界用 η=1 直接验证 clamp。
  for (let i = 0; i < 10; i += 1) applyFeedback(store, experience.id, { result: 'helped' })
  assert.ok(experience.G <= 1 && experience.G > 0.99, `G=${experience.G}`)
  applyFeedback(store, experience.id, { result: 'helped' }, { eta: 1 })
  assert.equal(experience.G, 1)
  applyFeedback(store, experience.id, { result: 'hurt' }, { eta: 1 })
  assert.equal(experience.G, -1)
  applyFeedback(store, experience.id, { result: 'hurt' })
  assert.equal(experience.G, -1, '已在端点，再 hurt 仍是 -1')
})

check(`日志上限：超过 ${FEEDBACK_LOG_LIMIT} 条只留最近`, () => {
  const { store } = tempStore('exp-feedback-log-')
  const experience = upsertExperience(store, { intent: '改页码', action: '重算物理页序', outcome: 'success' }).experience
  for (let i = 0; i < FEEDBACK_LOG_LIMIT + 2; i += 1) applyFeedback(store, experience.id, { result: 'neutral', note: `第 ${i} 次` })
  assert.equal(experience.feedback_log.length, FEEDBACK_LOG_LIMIT)
  assert.equal(experience.feedback_log[experience.feedback_log.length - 1].note, `第 ${FEEDBACK_LOG_LIMIT + 1} 次`)
  assert.equal(experience.feedback.neutral, FEEDBACK_LOG_LIMIT + 2, '日志截断不影响计数')
})

check('拒绝：未知 id / 非法 result / 已删除 / 已被取代', () => {
  const { store } = tempStore('exp-feedback-guard-')
  const experience = upsertExperience(store, { intent: '插页', action: '克隆相邻页', outcome: 'success' }).experience
  assert.throws(() => applyFeedback(store, 'ex_not_exists', { result: 'helped' }), /没有这条经验/)
  assert.throws(() => applyFeedback(store, '', { result: 'helped' }), /id 必填/)
  assert.throws(() => applyFeedback(store, experience.id, { result: 'good' }), /helped \/ hurt \/ neutral/)
  assert.throws(() => applyFeedback(store, experience.id, {}), /helped \/ hurt \/ neutral/)
  experience.deleted_at = new Date().toISOString()
  assert.throws(() => applyFeedback(store, experience.id, { result: 'hurt' }), /已删除/)
  experience.deleted_at = null
  experience.superseded_by = 'ex_newer'
  assert.throws(() => applyFeedback(store, experience.id, { result: 'hurt' }), /取代/)
})

/* ------------------------------------------------------------- 排序跟随 --- */

check('hurt 到负回报后，这条经验不再排第一', () => {
  const { store } = tempStore('exp-feedback-rank-')
  const good = upsertExperience(store, {
    intent: '把插件发布到 GitHub',
    action: 'subtree split 出发布分支再 force-with-lease',
    outcome: 'accepted',
    type: '代码 / 插件',
  }).experience
  upsertExperience(store, {
    intent: '把插件发布到 GitHub',
    action: '直接 git push 原始分支',
    outcome: 'failed',
    type: '代码 / 插件',
    note: '推错了旧树',
  })
  const before = rankExperiences(store, '把插件发布到 GitHub', 5)
  assert.equal(before.mode, 'advantage', `mode=${before.mode}`)
  assert.equal(before.candidates[0].action, good.action, '反馈前：验证过的做法排第一')
  for (let i = 0; i < 5; i += 1) applyFeedback(store, good.id, { result: 'hurt', note: '这次没帮上' })
  assert.ok(good.G < 0, `反馈后 G=${good.G}`)
  const after = rankExperiences(store, '把插件发布到 GitHub', 5)
  assert.notEqual(after.candidates[0].action, good.action, '反馈后：被否决的做法不该还在第一')
})

check('簇统计跟随反馈：G 转负后 success→fail', () => {
  const { store } = tempStore('exp-feedback-cluster-')
  const experience = upsertExperience(store, { intent: '做一节课的任务单', action: '先列任务再配图', outcome: 'success', type: '文档 / 教案' }).experience
  const clusterOf = () => store.clusters.find((cluster) => cluster.id === experience.typeId)
  assert.equal(clusterOf().stats.success, 1)
  assert.equal(clusterOf().stats.fail, 0)
  for (let i = 0; i < 3; i += 1) applyFeedback(store, experience.id, { result: 'hurt' })
  assert.ok(clusterOf().stats.fail >= 1, `fail=${clusterOf().stats.fail}`)
  assert.equal(clusterOf().stats.success, 0)
})

/* ----------------------------------------------------------------- 工具面 --- */

check('exp_feedback 注册，参数 schema 完整（id/result 必填，result 三选一）', () => {
  const tools = buildTools((definition) => definition, { dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'exp-feedback-schema-')) })
  const names = tools.map((tool) => tool.name)
  assert.deepEqual(names, ['exp_record', 'exp_recall', 'exp_feedback', 'exp_consolidate', 'exp_type'])
  const tool = tools.find((item) => item.name === 'exp_feedback')
  assert.equal(tool.parameters.id.required, true)
  assert.equal(tool.parameters.result.required, true)
  assert.deepEqual(tool.parameters.result.enum, ['helped', 'hurt', 'neutral'])
  assert.equal(typeof tool.execute, 'function')
})

check('工具：落盘 + 召回证据带 feedback 计数（无反馈时不占字段）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-feedback-tool-'))
  const tools = buildTools((definition) => definition, { dataDir: dir })
  const record = tools.find((tool) => tool.name === 'exp_record')
  const recall = tools.find((tool) => tool.name === 'exp_recall')
  const feedbackTool = tools.find((tool) => tool.name === 'exp_feedback')
  record.execute({ intent: '把 PPTX 导出成 PDF', action: 'LibreOffice 无头转换', outcome: 'success', type: 'PPT / 课件' })
  const first = recall.execute({ intent: '把 PPTX 导出成 PDF', limit: 3 })
  const evidence = first.candidates[0].evidence[0]
  assert.equal(evidence.feedback, undefined, '没有反馈时不应出现 feedback 字段')

  const out = feedbackTool.execute({ id: evidence.id, result: 'hurt', note: '字体被替换了' })
  assert.equal(out.action, 'feedback')
  assert.equal(out.result, 'hurt')
  assert.equal(out.G_before, 0.8)
  assert.ok(out.G_after < out.G_before)
  assert.equal(out.feedbackCovered, 1)
  assert.match(out.hint, /G /)

  const second = recall.execute({ intent: '把 PPTX 导出成 PDF', limit: 3 })
  const after = second.candidates[0].evidence[0]
  assert.deepEqual(after.feedback, { helped: 0, hurt: 1, neutral: 0, window: 1 })
  const persisted = readStore(dir).experiences[0]
  assert.equal(persisted.feedback_log.length, 1)
  assert.equal(persisted.feedback_log[0].note, '字体被替换了')
})

try {
  for (const dir of [base.dir]) fs.rmSync(dir, { recursive: true, force: true })
} catch {}

check('提示里的 η 跟随配置：feedbackEta=0.5 时 hint 不能还写 0.35', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-feedback-eta-'))
  const tools = buildTools((definition) => definition, { dataDir: dir, feedbackEta: 0.5 })
  const made = tools.find((item) => item.name === 'exp_record').execute({ intent: '写发布说明', action: '先列改动再写', outcome: 'success' })
  const out = tools.find((item) => item.name === 'exp_feedback').execute({ id: made.id, result: 'hurt' })
  assert.ok(out.hint.includes('η=0.5'), out.hint)
})

console.log('')
console.log(`结果：通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exit(1)
