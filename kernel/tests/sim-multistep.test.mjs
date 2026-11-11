/**
 * 单步 / 多步混合经验测试（特性化 + 两条回归）
 *
 * 场景：4 步任务「给研学课 PPT 插一页过渡页」
 *   ① 克隆页 ② 重画主体 ③ 挪进 sldIdLst ④ 重算页码（失败）
 *
 * 特性化：钉死 0.5.x 的真实行为（按步记 vs 整条记、行级统计、召回配额、反馈/取代粒度、连锁取代）。
 * 回归：① 负样本不能被下一次成功覆盖（先失败后成功要新开条）；② 失败步骤必须在默认召回里留一席。
 *
 * Run: node tests/sim-multistep.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { readStore } from '../store.js'
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

class Agent {
  constructor(dataDir) {
    this.dataDir = dataDir
    this.tools = buildTools((definition) => definition, { dataDir })
  }

  call(name, args) {
    return this.tools.find((item) => item.name === name).execute(args)
  }

  record(input) { return this.call('exp_record', input) }
  recall(intent, extra = {}) { return this.call('exp_recall', { intent, ...extra }) }
  feedback(id, result) { return this.call('exp_feedback', { id, result }) }

  visible() {
    return readStore(this.dataDir).experiences.filter((item) => !item.deleted_at && !item.superseded_by)
  }

  typeStats(name) {
    const rows = this.visible().filter((item) => item.typeName === name)
    return {
      count: rows.length,
      success: rows.filter((item) => Number(item.G) > 0).length,
      fail: rows.filter((item) => Number(item.G) < 0).length,
    }
  }
}

const newAgent = () => new Agent(fs.mkdtempSync(path.join(os.tmpdir(), 'exp-multistep-')))

const STEPS = [
  ['克隆相邻页做底子', 'success'],
  ['按本册网格重画主体', 'success'],
  ['把整块挪进 sldIdLst', 'success'],
  ['按物理页序重算页码', 'failed'],
]
const WHOLE_ACTION = '克隆相邻页 → 按网格重画主体 → 整块挪进 sldIdLst → 重算页码'

const recordSteps = (agent) => STEPS.map(([step, outcome]) => agent.record({
  intent: `给研学课 PPT 插页：${step}`,
  action: step,
  outcome,
  type: 'PPT / 课件',
  note: outcome === 'failed' ? '页码分母没重算' : '',
}))

const evidenceG = (recalled) => recalled.candidates.flatMap((candidate) => candidate.evidence.map((e) => Number(e.G)))

check('按步记（意图带步骤名）：4 条并存，失败只落第 4 步', () => {
  const agent = newAgent()
  recordSteps(agent)
  const visible = agent.visible()
  assert.equal(visible.length, 4)
  const bad = visible.filter((item) => Number(item.G) < 0)
  assert.equal(bad.length, 1)
  assert.equal(bad[0].action, '按物理页序重算页码')
})

check('整条记：1 条，没有 steps，查不到哪一步失败', () => {
  const agent = newAgent()
  agent.record({ intent: '给研学课 PPT 插一页过渡页', action: WHOLE_ACTION, outcome: 'failed', type: 'PPT / 课件', note: '页码分母没重算' })
  const row = agent.visible()[0]
  assert.equal(row.G, -0.6)
  assert.deepEqual(row.step_rewards, [-0.6])
  assert.ok(!('steps' in row) && !('task_id' in row), '当前模型没有任务/步骤字段')
})

check('行级统计：3 步成 + 整条败 = 60%（系统没有任务口径）', () => {
  const agent = newAgent()
  recordSteps(agent)
  agent.record({ intent: '给研学课 PPT 插一页过渡页', action: WHOLE_ACTION, outcome: 'failed', type: 'PPT / 课件' })
  const stats = agent.typeStats('PPT / 课件')
  assert.equal(stats.count, 5)
  assert.equal(stats.success, 3)
  assert.equal(stats.fail, 2)
  assert.equal(stats.success / stats.count, 0.6, '按行计 60%：步骤成功被算进类型成功率')
})

check('召回配额：失败步骤在默认召回里必须留一席（回归）', () => {
  const agent = newAgent()
  const made = recordSteps(agent)
  agent.record({ intent: '给研学课 PPT 插一页过渡页', action: WHOLE_ACTION, outcome: 'failed', type: 'PPT / 课件' })
  const recalled = agent.recall('给研学课 PPT 插页')
  const negatives = evidenceG(recalled).filter((g) => g < 0)
  assert.ok(negatives.length >= 1, `默认召回应含负样本，实际 G=${JSON.stringify(evidenceG(recalled))}`)
  assert.ok(recalled.candidates.length <= 4, '簇内配额仍是 4')
  assert.ok(recalled.candidates.some((candidate) => candidate.evidence.some((e) => e.id === made[3].id)) === false
    || recalled.candidates.some((candidate) => candidate.evidence.some((e) => e.id === made[3].id && Number(e.G) < 0)),
  '若有第 4 步，它必须是负的那条')
})

check('反馈粒度：hurt 只压那一条，整条经验不动', () => {
  const agent = newAgent()
  const made = recordSteps(agent)
  const whole = agent.record({ intent: '给研学课 PPT 插一页过渡页', action: WHOLE_ACTION, outcome: 'failed', type: 'PPT / 课件' })
  agent.feedback(made[3].id, 'hurt')
  const store = readStore(agent.dataDir)
  assert.ok(store.experiences.find((item) => item.id === made[3].id).G < -0.6)
  assert.equal(store.experiences.find((item) => item.id === whole.id).G, -0.6)
})

check('同 action 先失败后成功：新开一条，负样本保留（回归）', () => {
  const agent = newAgent()
  const failed = agent.record({ intent: '给课件排页码', action: '硬改页脚文本', outcome: 'failed', type: 'PPT / 课件', note: '分母不对' })
  const retry = agent.record({ intent: '给课件排页码', action: '硬改页脚文本', outcome: 'success', type: 'PPT / 课件' })
  assert.equal(retry.action, 'added', '正负翻转必须新开条，不能覆盖负样本')
  const visible = agent.visible()
  assert.equal(visible.length, 2)
  assert.ok(visible.some((item) => item.id === failed.id && item.G < 0), '失败那条仍在')
})

check('跨类型多步：一次召回能看到 3 个类型（簇内不足 3 条仍回退全库）', () => {
  const agent = newAgent()
  agent.record({ intent: '发布插件：先跑测试', action: 'npm test 全绿再打包', outcome: 'success', type: '环境 / 部署' })
  agent.record({ intent: '发布插件：改版本号并打包', action: '改 package.json 后 npm pack', outcome: 'failed', type: '代码 / 插件', note: '版本号没同步' })
  agent.record({ intent: '发布插件：写更新说明', action: '在 README 补 changelog', outcome: 'success', type: '文档 / 教案' })
  const recalled = agent.recall('发布插件', { limit: 3 })
  const types = new Set()
  for (const candidate of recalled.candidates) for (const evidence of candidate.evidence) types.add(evidence.typeName)
  assert.equal(types.size, 3)
  assert.equal(recalled.route.fallback, false, '路由命中了一个簇，但 pool 仍回退全库')
  assert.ok(!readStore(agent.dataDir).experiences.some((item) => 'task_id' in item), '没有字段表达三步属于同一任务')
})

check('归纳计数 = 候选条数（不是族规模），且现在含失败那一席', () => {
  const agent = newAgent()
  recordSteps(agent)
  agent.record({ intent: '给研学课 PPT 插一页过渡页', action: WHOLE_ACTION, outcome: 'failed', type: 'PPT / 课件' })
  const recalled = agent.recall('给研学课 PPT 插页', { limit: 4 })
  assert.ok(recalled.induction.includes(`本次可见 ${recalled.candidates.length} 条`), `实际：${recalled.induction}`)
  assert.ok(recalled.candidates.length <= 4)
})

check('已知缺陷：同一任务意图 + 不同步骤 action → 连锁取代，8 步只剩 1 条', () => {
  const agent = newAgent()
  for (const step of ['克隆页', '重画主体', '挪块', '重算页码', '改标题', '加图注', '查动画', '打包归档']) {
    agent.record({ intent: '给研学课 PPT 插页（多步）', action: step, outcome: 'success', type: 'PPT / 课件' })
  }
  assert.equal(agent.visible().length, 1, '步骤被当成「同意图的不同做法」互相取代')
})

check('已知缺陷：整条做法与步骤同类型同意图，会跨粒度取代', () => {
  const agent = newAgent()
  agent.record({ intent: '给研学课 PPT 插页：步骤', action: '克隆页', outcome: 'success', type: 'PPT / 课件' })
  agent.record({ intent: '给研学课 PPT 插页：步骤', action: '重画主体', outcome: 'success', type: 'PPT / 课件' })
  agent.record({ intent: '给研学课 PPT 插页：步骤', action: '挪块', outcome: 'success', type: 'PPT / 课件' })
  const before = agent.visible().length
  agent.record({ intent: '给研学课 PPT 插一页过渡页', action: '整套做法：克隆→重画→挪块', outcome: 'success', type: 'PPT / 课件' })
  const after = agent.visible()
  assert.equal(before, 1, '三个同意图步骤先被折叠成 1 条')
  assert.equal(after.length, 2, '整条与步骤并存（没有再吞）')
})

console.log('')
console.log(`结果：通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exit(1)
