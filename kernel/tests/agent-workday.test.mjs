/**
 * Agent 完整工作日验收（0.27.0）
 *
 * 把各机制放进同一条时间线，看会不会互相打架：
 *   首跑失败（带预期）→ 学到好做法 → 重复（hits）→ 用后反馈
 *   → 同做法后来成功（退休旧失败）→ 再失败（复活）
 *   → 情境切换（课件/教案）→ 巩固（候选规则）→ 提取强化（retrievals）
 *   → 跨任务迁移 → 换实例持久化
 *
 * 世界确定性；每个断言都是「同一时间线上的因果」，不是单工具点测。
 * Run: node tests/agent-workday.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { readStore, visibleExperiences } from '../store.js'
import { buildTools } from '../tools.js'

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

const TYPE = 'PPT / 课件'
const DAY = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-workday-'))

class WorkAgent {
  constructor(dir) {
    this.dir = dir
    this.tools = buildTools((definition) => definition, { dataDir: dir })
  }

  call(name, args) { return this.tools.find((item) => item.name === name).execute(args) }
  record(input) { return this.call('exp_record', input) }
  recall(intent, extra = {}) { return this.call('exp_recall', { intent, ...extra }) }
  feedback(id, result) { return this.call('exp_feedback', { id, result }) }
  rows() { return readStore(this.dir).experiences }
  visible() { return visibleExperiences(readStore(this.dir)) }
}

const agent = new WorkAgent(DAY)

// ── 上午：第一次接活，没经验，预测会成功但失败 ───────────────────────────
let firstFail
check('① 首跑失败：记成负样本，且预测误差为负', () => {
  const task = '给研学课 PPT 插一页过渡页'
  const recalled = agent.recall(task)
  assert.equal(recalled.candidates.length, 0, '开始时应没有经验')
  const recorded = agent.record({
    intent: task, action: '直接套模板', outcome: 'failed', type: TYPE,
    expectedG: 0.8, note: '页脚错位',
  })
  firstFail = recorded
  const row = agent.rows().find((item) => item.id === recorded.id)
  assert.ok(row.G < 0)
  assert.equal(row.predictionError, -1.4)
})

// ── 上午：回想上次的坑，换做法成功 ───────────────────────────────────────
let good
check('② 回想失败教训 → 换做法成功 → 用后反馈 helped', () => {
  const task = '给研学课 PPT 插一页过渡页'
  const recalled = agent.recall(task)
  const negative = recalled.candidates.flatMap((candidate) => candidate.evidence).find((item) => item.G < 0)
  assert.ok(negative, '应召回刚才的失败')
  good = agent.record({ intent: task, action: '克隆相邻页再改字', outcome: 'success', type: TYPE, expectedG: 0.8 })
  assert.equal(agent.rows().find((item) => item.id === good.id).predictionError, 0)
  const fb = agent.feedback(good.id, 'helped')
  assert.ok(fb.G_after > 0.8)
})

// ── 下午：同一做法又做一遍（间隔重复） ───────────────────────────────────
check('③ 同做法重复：hits 递增，反馈历史保留', () => {
  const again = agent.record({ intent: '给研学课 PPT 插一页过渡页', action: '克隆相邻页再改字', outcome: 'success', type: TYPE })
  assert.equal(again.action, 'updated')
  assert.equal(again.hits, 2)
  const row = agent.rows().find((item) => item.id === good.id)
  assert.equal(row.feedback.helped, 1)
})

// ── 环境变了：同一做法这次失败 → 新负条，旧成功条保留 ─────────────────────
check('④ 同做法偶尔失败：正负翻转新开条，成功条不丢', () => {
  const flipped = agent.record({ intent: '给研学课 PPT 插一页过渡页', action: '克隆相邻页再改字', outcome: 'failed', type: TYPE })
  assert.equal(flipped.action, 'added')
  const rows = agent.rows()
  assert.ok(rows.some((item) => item.id === good.id && Number(item.G) > 0))
  assert.ok(rows.some((item) => item.id === flipped.id && Number(item.G) < 0))
})

// ── 失败教训退休与复活：套模板后来成功 → 退休；再失败 → 复活 ───────────────
check('⑤ 同做法成功后失败教训退休；再失败复活同一条', () => {
  // 用失败那条自己的 taskId 记：既算「同任务同做法成功」（退休旧失败），又不去取代别的做法。
  const success = agent.record({ intent: '给研学课 PPT 插一页过渡页', action: '直接套模板', outcome: 'success', type: TYPE, taskId: firstFail.id })
  assert.equal(success.action, 'added')
  const retired = agent.rows().find((item) => item.id === firstFail.id)
  assert.ok(typeof retired.retired_at === 'string')
  assert.ok(!agent.visible().some((item) => item.id === retired.id))

  const again = agent.record({ intent: '给研学课 PPT 插一页过渡页', action: '直接套模板', outcome: 'failed', type: TYPE, taskId: firstFail.id })
  assert.equal(again.action, 'revived')
  assert.equal(again.id, firstFail.id)
  assert.ok(agent.visible().some((item) => item.id === again.id))
})

// ── 情境切换：同一意图，课件 vs 教案 ─────────────────────────────────────
check('⑥ 情境切换：课件想起克隆页，教案想起改写原页', () => {
  const task = '给研学课 PPT 插一页过渡页'
  agent.record({ intent: task, action: '克隆相邻页再改字', outcome: 'success', type: TYPE, context: ['课件'], taskId: 'task-ctx-day', kind: 'step', stepIndex: 1, stepTotal: 2 })
  agent.record({ intent: task, action: '直接改写原页文案', outcome: 'success', type: TYPE, context: ['教案'], taskId: 'task-ctx-day', kind: 'step', stepIndex: 2, stepTotal: 2 })
  assert.equal(agent.recall(task, { context: ['课件'] }).candidates[0].action, '克隆相邻页再改字')
  assert.equal(agent.recall(task, { context: ['教案'] }).candidates[0].action, '直接改写原页文案')
})

// ── 巩固：同一时间线里已经积累了正负对照，应给候选规则 ────────────────────
check('⑦ 巩固：工作日积累后给出候选规则（含优先/避免）', () => {
  const recalled = agent.recall('给研学课 PPT 插一页过渡页')
  assert.ok(typeof recalled.consolidated === 'string', `consolidated=${JSON.stringify(recalled.consolidated)}`)
  assert.ok(recalled.consolidated.includes('优先'))
  assert.ok(recalled.consolidated.includes('避免'))
})

// ── 提取强化：主动提取累加，不改排序 ─────────────────────────────────────
check('⑧ 提取强化：mark 累加 retrievals，top1 不变', () => {
  const before = agent.recall('给研学课 PPT 插一页过渡页').candidates[0].action
  agent.recall('给研学课 PPT 插一页过渡页', { mark: true })
  agent.recall('给研学课 PPT 插一页过渡页', { mark: true })
  const after = agent.recall('给研学课 PPT 插一页过渡页').candidates[0].action
  assert.equal(after, before)
  const withPractice = agent.rows().filter((item) => Number(item.retrievals) > 0)
  assert.ok(withPractice.length >= 1)
})

// ── 迁移：换表面（常规课）仍能想起研学课学到的做法 ─────────────────────────
check('⑨ 跨任务迁移：常规课仍能召回同族好做法（克隆页至少在候选里，top1 为正回报）', () => {
  const transfer = agent.recall('给常规课 PPT 插一页过渡页')
  assert.ok(transfer.candidates.length >= 1)
  assert.ok(transfer.candidates.some((candidate) => candidate.action === '克隆相邻页再改字'))
  const top = transfer.candidates[0]
  assert.ok(top.evidence.some((item) => Number(item.G) > 0), 'top1 必须带正回报证据')
})

// ── 换实例：持久化 ───────────────────────────────────────────────────────
check('⑫ 技能：沉淀 → 采用 → 连续障碍覆盖 → hurt 降级', () => {
  const agent = new WorkAgent(fs.mkdtempSync(path.join(os.tmpdir(), 'exp-workday-skill-')))
  const intent = '给研学课 PPT 插一页过渡页'
  for (const [i, outcome, action] of [
    [1, 'success', '先克隆相邻页再改字'],
    [2, 'success', '先克隆相邻页再重画主体'],
    [3, 'failed', '直接套模板不做克隆'],
  ]) {
    agent.record({ intent, action, outcome, type: TYPE, taskId: 'task-skill-day', kind: 'step', stepIndex: i, stepTotal: 3 })
  }
  const made = agent.call('exp_consolidate', { intent })
  assert.equal(made.action, 'created')
  for (let i = 0; i < 3; i += 1) agent.feedback(`skill:${made.slug}`, 'helped')
  assert.equal(agent.recall(intent).mode, 'skill')
  let last = null
  for (let i = 0; i < 3; i += 1) {
    last = agent.record({
      intent, action: '按技能做', outcome: 'failed', type: TYPE,
      skillId: `skill:${made.slug}`, blockedBy: '页脚错位 第 3 行',
    })
  }
  assert.equal(last.skill.action, 'replaced')
  for (let i = 0; i < 2; i += 1) agent.feedback(`skill:${made.slug}`, 'hurt')
  assert.notEqual(agent.recall(intent).mode, 'skill')
})

check('⑩ 换实例持久化：新 Agent 同库仍能召回与看生命周期', () => {
  const next = new WorkAgent(DAY)
  const recalled = next.recall('给研学课 PPT 插一页过渡页')
  assert.ok(recalled.candidates.length >= 1)
  assert.ok(recalled.candidates.some((candidate) => candidate.action === '克隆相邻页再改字'))
  assert.ok(Number(recalled.candidates[0].evidence[0].G) !== 0)
  const withLifecycle = recalled.candidates.flatMap((candidate) => candidate.evidence).find((item) => item.lifecycle)
  assert.ok(withLifecycle, '应至少有一条带 lifecycle 的经验')
})

// ── 最终一致性：可见集里没有退休/被取代/删除的条 ─────────────────────────
check('⑪ 最终一致性：可见集不含退休/被取代/删除条，正负样本并存', () => {
  const rows = agent.rows()
  const visible = agent.visible()
  for (const row of visible) {
    assert.ok(!row.deleted_at)
    assert.ok(!row.superseded_by)
    assert.ok(!row.retired_at)
  }
  assert.ok(visible.some((item) => Number(item.G) > 0))
  assert.ok(visible.some((item) => Number(item.G) < 0))
  assert.ok(rows.some((item) => (item.history || []).some((event) => event.type === 'retired' || event.type === 'revived')), '历史里应留下退休/复活痕迹')
})

console.log('')
console.log(`结果：通过 ${passed} 项，失败 ${failed} 项（工作目录 ${DAY}）`)
if (failed > 0) process.exit(1)
