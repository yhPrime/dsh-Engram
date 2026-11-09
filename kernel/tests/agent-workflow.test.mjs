/**
 * Agent 工作流端到端模拟（0.23.0）
 *
 * 模拟一个 Agent 真正干活时的经验循环，而不是逐个工具单测：
 *   接任务 → 召回 → 采用（或不用）经验 → 执行 → 记录结果 → 用后反馈 → 下次复用
 * 另加：重复（间隔）、失败教训、退休/复活、跨任务迁移、巩固、全负警告、持久化。
 *
 * 世界是确定性的：某做法在某个任务族里成功/失败由 TRUTH 决定，不依赖真实执行。
 * Run: node tests/agent-workflow.test.mjs
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

/** 确定性世界：任务族 → 哪些做法会成功。 */
const TRUTH = {
  insert: {
    type: 'PPT / 课件',
    good: ['克隆相邻页再改字', '先建空页再放形状'],
    bad: '直接套模板',
  },
}

class DeskAgent {
  constructor(dir) {
    this.dir = dir
    this.tools = buildTools((definition) => definition, { dataDir: dir })
  }

  call(name, args) { return this.tools.find((item) => item.name === name).execute(args) }
  record(input) { return this.call('exp_record', input) }
  recall(intent, extra = {}) { return this.call('exp_recall', { intent, ...extra }) }
  feedback(id, result) { return this.call('exp_feedback', { id, result }) }
  visible() { return visibleExperiences(readStore(this.dir)) }

  /** 接一个任务：召回 → 采用 top1（或默认做法）→ 执行 → 记录。 */
  work(task, options = {}) {
    const recalled = this.recall(task.intent)
    const top = recalled.candidates[0]
    const chosen = options.ignoreRecall || top === undefined ? task.defaultAction : top.action
    const good = TRUTH.insert.good.includes(chosen)
    const outcome = good ? 'success' : 'failed'
    const recorded = this.record({
      intent: task.intent, action: chosen, outcome, type: TRUTH.insert.type,
      note: good ? '' : '试出来的坑',
    })
    return { recalled, chosen, outcome, recorded }
  }
}

const newAgent = () => new DeskAgent(fs.mkdtempSync(path.join(os.tmpdir(), 'exp-agent-')))

check('首跑无经验：用默认做法失败 → 记成负样本；下次同任务能召回它', () => {
  const agent = newAgent()
  const task = { intent: '给研学课 PPT 插一页过渡页', defaultAction: '直接套模板' }
  const first = agent.work(task, { ignoreRecall: true })
  assert.equal(first.outcome, 'failed')
  assert.equal(first.recorded.action, 'added')
  const second = agent.recall(task.intent)
  const evidence = second.candidates.flatMap((candidate) => candidate.evidence)
  assert.ok(evidence.some((item) => item.action === '直接套模板' && item.G < 0))
})

check('学到好做法：成功后下次 top1 换成它', () => {
  const agent = newAgent()
  const task = { intent: '给研学课 PPT 插一页过渡页', defaultAction: '直接套模板' }
  agent.work(task, { ignoreRecall: true })
  agent.record({ intent: task.intent, action: '克隆相邻页再改字', outcome: 'success', type: TRUTH.insert.type })
  const recalled = agent.recall(task.intent)
  assert.equal(recalled.candidates[0].action, '克隆相邻页再改字')
  assert.equal(recalled.mode, 'advantage')
})

check('重复同一做法：就地更新、hits 递增（间隔重复）', () => {
  const agent = newAgent()
  const task = { intent: '给研学课 PPT 插一页过渡页', defaultAction: '直接套模板' }
  agent.record({ intent: task.intent, action: '克隆相邻页再改字', outcome: 'success', type: TRUTH.insert.type })
  const second = agent.record({ intent: task.intent, action: '克隆相邻页再改字', outcome: 'success', type: TRUTH.insert.type })
  assert.equal(second.action, 'updated')
  assert.equal(second.hits, 2)
})

check('用后反馈：hurt 让失败做法更沉，不抢成功做法', () => {
  const agent = newAgent()
  const task = { intent: '给研学课 PPT 插一页过渡页', defaultAction: '直接套模板' }
  const bad = agent.work(task, { ignoreRecall: true })
  agent.record({ intent: task.intent, action: '克隆相邻页再改字', outcome: 'success', type: TRUTH.insert.type })
  agent.feedback(bad.recorded.id, 'hurt')
  const after = readStore(agent.dir).experiences.find((item) => item.id === bad.recorded.id)
  assert.ok(after.G < -0.6)
  const recalled = agent.recall(task.intent)
  assert.equal(recalled.candidates[0].action, '克隆相邻页再改字')
})

check('失败教训退休与复活：同做法后来成功 → 退休旧失败；再失败 → 复活它', () => {
  const agent = newAgent()
  const task = { intent: '给研学课 PPT 插一页过渡页', defaultAction: '直接套模板' }
  const bad = agent.work(task, { ignoreRecall: true })
  // 环境变了：同一个做法这次成功（正负翻转 → 新条，并让旧失败条退休）
  const success = agent.record({ intent: task.intent, action: '直接套模板', outcome: 'success', type: TRUTH.insert.type })
  assert.equal(success.action, 'added')
  const retired = readStore(agent.dir).experiences.find((item) => item.id === bad.recorded.id)
  assert.ok(typeof retired.retired_at === 'string', '同做法成功后旧失败应退休')
  assert.ok(!agent.visible().some((item) => item.id === retired.id))
  const again = agent.record({ intent: task.intent, action: '直接套模板', outcome: 'failed', type: TRUTH.insert.type })
  assert.equal(again.action, 'revived')
  assert.equal(again.id, bad.recorded.id)
  assert.ok(agent.visible().some((item) => item.id === again.id), '再次失败应复活')
})

check('跨任务迁移：换一个表面（常规课）仍能召回研学课学到的做法', () => {
  const agent = newAgent()
  agent.record({ intent: '给研学课 PPT 插一页过渡页', action: '克隆相邻页再改字', outcome: 'success', type: TRUTH.insert.type })
  agent.record({ intent: '给研学课 PPT 插一页过渡页', action: '直接套模板', outcome: 'failed', type: TRUTH.insert.type })
  const transfer = agent.recall('给常规课 PPT 插一页过渡页')
  assert.ok(transfer.candidates.length >= 1)
  assert.equal(transfer.candidates[0].action, '克隆相邻页再改字')
})

check('巩固：同族 3 条且有正负对照 → 候选规则；全成功 → 不给', () => {
  const agent = newAgent()
  const taskId = 'task-work-cons'
  agent.record({ intent: '给 PPT 插页：第一步', action: '先克隆相邻页', outcome: 'success', type: TRUTH.insert.type, taskId, kind: 'step', stepIndex: 1 })
  agent.record({ intent: '给 PPT 插页：第二步', action: '先克隆相邻页再重画', outcome: 'success', type: TRUTH.insert.type, taskId, kind: 'step', stepIndex: 2 })
  agent.record({ intent: '给 PPT 插页：第三步', action: '直接套模板不做克隆', outcome: 'failed', type: TRUTH.insert.type, taskId, kind: 'step', stepIndex: 3 })
  const recalled = agent.recall('给 PPT 插页')
  assert.ok(typeof recalled.consolidated === 'string', `consolidated=${JSON.stringify(recalled.consolidated)}`)
  assert.ok(recalled.consolidated.includes('优先'))
  assert.ok(recalled.consolidated.includes('避免'))

  const fresh = newAgent()
  for (let i = 1; i <= 3; i += 1) {
    fresh.record({ intent: `给 PPT 插页：第 ${i} 步`, action: `克隆相邻页再改 ${i}`, outcome: 'success', type: TRUTH.insert.type, taskId: 't2', kind: 'step', stepIndex: i })
  }
  assert.equal(fresh.recall('给 PPT 插页').consolidated, undefined)
})

check('全负族：召回给 warning，提醒别照做', () => {
  const agent = newAgent()
  agent.record({ intent: '给 PPT 插页', action: '直接套模板', outcome: 'failed', type: TRUTH.insert.type })
  agent.record({ intent: '给 PPT 插页', action: '硬改页脚', outcome: 'failed', type: TRUTH.insert.type })
  const recalled = agent.recall('给 PPT 插页')
  assert.ok(typeof recalled.warning === 'string')
  assert.ok(recalled.warning.includes('负回报'))
})

check('预测校准：预期成功却失败 → 误差为负；预期成功且成功 → 误差 0', () => {
  const agent = newAgent()
  const failed = agent.record({ intent: '给研学课 PPT 插一页过渡页', action: '直接套模板', outcome: 'failed', type: TRUTH.insert.type, expectedG: 0.8 })
  const ok = agent.record({ intent: '给研学课 PPT 插一页过渡页', action: '克隆相邻页再改字', outcome: 'success', type: TRUTH.insert.type, expectedG: 0.8 })
  const rows = readStore(agent.dir).experiences
  assert.equal(rows.find((item) => item.id === failed.id).predictionError, -1.4)
  assert.equal(rows.find((item) => item.id === ok.id).predictionError, 0)
})

check('情境线索：同一任务在「课件」与「教案」情境下想起不同做法', () => {
  const agent = newAgent()
  agent.record({
    intent: '给研学课 PPT 插一页过渡页', action: '克隆相邻页再改字', outcome: 'success',
    type: TRUTH.insert.type, context: ['课件'], taskId: 'task-ctx-w', kind: 'step', stepIndex: 1, stepTotal: 2,
  })
  agent.record({
    intent: '给研学课 PPT 插一页过渡页', action: '直接改写原页文案', outcome: 'success',
    type: TRUTH.insert.type, context: ['教案'], taskId: 'task-ctx-w', kind: 'step', stepIndex: 2, stepTotal: 2,
  })
  assert.equal(agent.recall('给研学课 PPT 插一页过渡页', { context: ['课件'] }).candidates[0].action, '克隆相邻页再改字')
  assert.equal(agent.recall('给研学课 PPT 插一页过渡页', { context: ['教案'] }).candidates[0].action, '直接改写原页文案')
})

check('提取即强化：主动提取累加 retrievals，不改排序', () => {
  const agent = newAgent()
  agent.record({ intent: '给研学课 PPT 插一页过渡页', action: '克隆相邻页再改字', outcome: 'success', type: TRUTH.insert.type, taskId: 'task-prac', kind: 'step', stepIndex: 1 })
  agent.record({ intent: '给研学课 PPT 插一页过渡页', action: '直接套模板', outcome: 'failed', type: TRUTH.insert.type, taskId: 'task-prac', kind: 'step', stepIndex: 2 })
  const before = agent.recall('给研学课 PPT 插一页过渡页').candidates[0].action
  agent.recall('给研学课 PPT 插一页过渡页', { mark: true })
  agent.recall('给研学课 PPT 插一页过渡页', { mark: true })
  const after = agent.recall('给研学课 PPT 插一页过渡页')
  assert.equal(after.candidates[0].action, before)
  const row = readStore(agent.dir).experiences.find((item) => item.action === '克隆相邻页再改字')
  assert.ok(Number(row.retrievals) >= 2)
})

check('持久化：换一个 Agent 实例（同库）仍能召回上次学到的做法', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-agent-persist-'))
  const first = new DeskAgent(dir)
  first.record({ intent: '给研学课 PPT 插一页过渡页', action: '克隆相邻页再改字', outcome: 'success', type: TRUTH.insert.type })
  const second = new DeskAgent(dir)
  const recalled = second.recall('给研学课 PPT 插一页过渡页')
  assert.equal(recalled.candidates[0].action, '克隆相邻页再改字')
})

check('一次完整工作日：6 个任务后，库里既有正样本也有负样本，排序稳定', () => {
  const agent = newAgent()
  const tasks = [
    { intent: '给研学课 PPT 插一页过渡页', defaultAction: '直接套模板' },
    { intent: '给研学课 PPT 插一页过渡页', defaultAction: '直接套模板' },
    { intent: '给常规课 PPT 插一页过渡页', defaultAction: '直接套模板' },
  ]
  for (const task of tasks) agent.work(task, { ignoreRecall: true })
  agent.record({ intent: '给研学课 PPT 插一页过渡页', action: '先建空页再放形状', outcome: 'success', type: TRUTH.insert.type })
  const recalled = agent.recall('给研学课 PPT 插一页过渡页')
  assert.equal(recalled.candidates[0].action, '先建空页再放形状')
  const rows = readStore(agent.dir).experiences
  assert.ok(rows.some((item) => Number(item.G) > 0))
  assert.ok(rows.some((item) => Number(item.G) < 0))
  const top3 = recalled.candidates.slice(0, 3).map((candidate) => candidate.action)
  assert.ok(top3.includes('先建空页再放形状'))
})

console.log('')
console.log(`结果：通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exit(1)
