/**
 * 任务 / 步骤结构 + 复活测试（0.7.0）
 *
 *  - 一条经验可标记为「整条任务」或「任务里的一步」：taskId / kind / stepIndex / stepTotal / failedStep / stepRewards；
 *  - 统计按 taskId 去重（任务级），不再按行计；
 *  - 同任务不同步骤不再互相取代；跨任务同 action 不合并；
 *  - 被取代的经验，如果同一做法又做成 → 复活（解除隐藏、hits+1）；删除的墓碑不复活；
 *  - 召回证据带 taskId / kind / stepIndex。
 *
 * Run: node tests/task-steps.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { forgetExperience, readStore, writeStore } from '../store.js'
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

const newAgent = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-task-'))
  const tools = buildTools((definition) => definition, { dataDir: dir })
  const call = (name, args) => tools.find((item) => item.name === name).execute(args)
  return {
    dir,
    tools,
    record: (input) => call('exp_record', input),
    recall: (intent, extra = {}) => call('exp_recall', { intent, ...extra }),
    feedback: (id, result) => call('exp_feedback', { id, result }),
    visible: () => readStore(dir).experiences.filter((item) => !item.deleted_at && !item.superseded_by),
    all: () => readStore(dir).experiences,
  }
}

check('默认：没有任务字段时按独立整条任务记，taskId=自身 id、kind=task', () => {
  const agent = newAgent()
  const made = agent.record({ intent: '改 PPT 页码', action: '重算物理页序', outcome: 'success', type: 'PPT / 课件' })
  const row = agent.all().find((item) => item.id === made.id)
  assert.equal(row.taskId, made.id)
  assert.equal(row.kind, 'task')
  assert.equal(row.stepIndex, null)
  assert.deepEqual(row.step_rewards, [0.8])
})

check('同任务 4 步：统计按任务算一次，失败取最弱一步', () => {
  const agent = newAgent()
  const taskId = 'task-ppt-insert'
  const steps = [
    ['克隆相邻页', 'success'],
    ['重画主体', 'success'],
    ['挪进 sldIdLst', 'success'],
    ['重算页码', 'failed'],
  ]
  steps.forEach(([action, outcome], index) => {
    agent.record({
      intent: `给研学课 PPT 插页：${action}`, action, outcome, type: 'PPT / 课件',
      taskId, kind: 'step', stepIndex: index + 1, stepTotal: 4,
    })
  })
  const store = readStore(agent.dir)
  const cluster = (store.clusters || []).find((item) => item.name === 'PPT / 课件')
  assert.ok(cluster, '应有 PPT / 课件簇')
  assert.equal(cluster.stats.count, 1, '4 步只算 1 个任务')
  assert.equal(cluster.stats.success, 0)
  assert.equal(cluster.stats.fail, 1, '有一步失败 → 任务算失败')
  assert.equal(cluster.stats.steps, 4)
})

check('同任务 8 步、全正、同意图：不再连锁取代', () => {
  const agent = newAgent()
  for (let i = 1; i <= 8; i += 1) {
    agent.record({
      intent: '给研学课 PPT 插页（多步）', action: `步骤 ${i}`, outcome: 'success',
      type: 'PPT / 课件', taskId: 'task-multi', kind: 'step', stepIndex: i, stepTotal: 8,
    })
  }
  assert.equal(agent.visible().length, 8, '步骤按 stepIndex 区分，不再互相取代')
})

check('跨任务同 action：不合并（两份经验各自保留）', () => {
  const agent = newAgent()
  agent.record({ intent: '给研学课 PPT 插页', action: '克隆相邻页', outcome: 'success', type: 'PPT / 课件', taskId: 'task-a', kind: 'step', stepIndex: 1 })
  agent.record({ intent: '给常规课 PPT 插页', action: '克隆相邻页', outcome: 'failed', type: 'PPT / 课件', taskId: 'task-b', kind: 'step', stepIndex: 1 })
  assert.equal(agent.visible().length, 2)
  const gs = agent.visible().map((item) => item.G).sort((a, b) => a - b)
  assert.deepEqual(gs, [-0.6, 0.8])
})

check('整条任务带 stepRewards：G=min(分步)，step_rewards 保留数组、failedStep 落库', () => {
  const agent = newAgent()
  const made = agent.record({
    intent: '给研学课 PPT 插一页过渡页',
    action: '整套做法：克隆→重画→挪块→重算页码',
    outcome: 'failed',
    type: 'PPT / 课件',
    taskId: 'task-whole',
    kind: 'task',
    stepTotal: 4,
    failedStep: 4,
    stepRewards: [0.8, 0.8, 0.8, -0.6],
  })
  const row = agent.all().find((item) => item.id === made.id)
  assert.equal(row.G, -0.6)
  assert.deepEqual(row.step_rewards, [0.8, 0.8, 0.8, -0.6])
  assert.equal(row.failedStep, 4)
  assert.equal(row.stepTotal, 4)
})

check('复活：A 被 B 取代后，A 又做成 → 解除隐藏、hits+1、B 的 supersedes 指针清空', () => {
  const agent = newAgent()
  const a = agent.record({ intent: '发布插件到 GitHub', action: '法甲', outcome: 'success', type: '代码 / 插件' })
  const b = agent.record({ intent: '发布插件到 GitHub', action: '法乙', outcome: 'success', type: '代码 / 插件' })
  assert.equal(b.action, 'superseded')
  const revived = agent.record({ intent: '发布插件到 GitHub', action: '法甲', outcome: 'success', type: '代码 / 插件' })
  assert.equal(revived.action, 'revived')
  assert.equal(revived.id, a.id)
  const store = readStore(agent.dir)
  const rowA = store.experiences.find((item) => item.id === a.id)
  const rowB = store.experiences.find((item) => item.id === b.id)
  assert.equal(rowA.superseded_by, null)
  assert.equal(rowA.hits, 2)
  assert.ok(typeof rowA.revived_at === 'string')
  assert.equal(rowB.supersedes, null, '旧取代者不再声称取代 A')
  assert.ok(agent.visible().some((item) => item.id === rowA.id))
})

check('复活只认同任务：不同 taskId 的同名做法走新条', () => {
  const agent = newAgent()
  agent.record({ intent: '插页', action: '克隆页', outcome: 'success', type: 'PPT / 课件', taskId: 'task-1', kind: 'step', stepIndex: 1 })
  agent.record({ intent: '插页', action: '重画', outcome: 'success', type: 'PPT / 课件', taskId: 'task-1', kind: 'step', stepIndex: 1 })
  const before = agent.visible().length
  const made = agent.record({ intent: '插页', action: '克隆页', outcome: 'success', type: 'PPT / 课件', taskId: 'task-2', kind: 'step', stepIndex: 1 })
  assert.equal(made.action, 'added')
  assert.equal(agent.visible().length, before + 1)
})

check('删除的墓碑不自动复活：同做法再记 = 新条', () => {
  const agent = newAgent()
  const made = agent.record({ intent: '装插件到 profile', action: '用 tgz 装', outcome: 'failed', type: '环境 / 部署' })
  const store = readStore(agent.dir)
  forgetExperience(store, made.id)
  writeStore(agent.dir, store)
  const again = agent.record({ intent: '装插件到 profile', action: '用 tgz 装', outcome: 'success', type: '环境 / 部署' })
  assert.equal(again.action, 'added')
  assert.notEqual(again.id, made.id)
  const rows = agent.all()
  assert.ok(rows.some((item) => item.id === made.id && item.deleted_at), '墓碑保留')
})

check('召回证据带 taskId / kind / stepIndex', () => {
  const agent = newAgent()
  agent.record({ intent: '给研学课 PPT 插页：克隆', action: '克隆相邻页', outcome: 'success', type: 'PPT / 课件', taskId: 'task-x', kind: 'step', stepIndex: 2 })
  const recalled = agent.recall('给研学课 PPT 插页')
  const evidence = recalled.candidates.flatMap((candidate) => candidate.evidence)[0]
  assert.equal(evidence.taskId, 'task-x')
  assert.equal(evidence.kind, 'step')
  assert.equal(evidence.stepIndex, 2)
})

check('跨类型同名做法不复活（新条；旧条仍隐藏）', () => {
  const agent = newAgent()
  const a = agent.record({ intent: '发布插件', action: '法甲', outcome: 'success', type: '代码 / 插件' })
  agent.record({ intent: '发布插件', action: '法乙', outcome: 'success', type: '代码 / 插件' })
  const cross = agent.record({ intent: '发布插件', action: '法甲', outcome: 'success', type: '文档 / 教案' })
  assert.equal(cross.action, 'added', '跨类型不能复活另一类型的旧条')
  const rowA = agent.all().find((item) => item.id === a.id)
  assert.equal(rowA.superseded_by !== null, true, 'A 仍隐藏')
})

check('正负翻转不复活：失败重记不能把成功条改成负的（新条保留成功条）', () => {
  const agent = newAgent()
  const a = agent.record({ intent: '发布插件', action: '法甲', outcome: 'success', type: '代码 / 插件' })
  agent.record({ intent: '发布插件', action: '法乙', outcome: 'success', type: '代码 / 插件' })
  const failed = agent.record({ intent: '发布插件', action: '法甲', outcome: 'failed', type: '代码 / 插件' })
  assert.equal(failed.action, 'added')
  const rowA = agent.all().find((item) => item.id === a.id)
  assert.ok(rowA.G > 0, '成功条没被改成负值')
  assert.equal(rowA.superseded_by !== null, true, '成功条仍隐藏')
  assert.equal(agent.visible().some((item) => item.id === failed.id && item.G < 0), true)
})

check('无 taskId 的 step 不会复活别人任务里的 step1', () => {
  const agent = newAgent()
  agent.record({ intent: '插页', action: '克隆页', outcome: 'success', type: 'PPT / 课件', taskId: 'task-x', kind: 'step', stepIndex: 1 })
  agent.record({ intent: '插页', action: '新建页', outcome: 'success', type: 'PPT / 课件', taskId: 'task-x', kind: 'step', stepIndex: 1 })
  const loose = agent.record({ intent: '插页', action: '克隆页', outcome: 'success', type: 'PPT / 课件', kind: 'step', stepIndex: 1 })
  assert.equal(loose.action, 'added', '无 taskId 时不能挂到别人的 task-x 上')
})

check('复活顶替现任：复活 A 后 B 被隐，C 取代的是当前的 A', () => {
  const agent = newAgent()
  const a = agent.record({ intent: '发布插件', action: '法甲', outcome: 'success', type: '代码 / 插件' })
  const b = agent.record({ intent: '发布插件', action: '法乙', outcome: 'success', type: '代码 / 插件' })
  const revived = agent.record({ intent: '发布插件', action: '法甲', outcome: 'success', type: '代码 / 插件' })
  assert.equal(revived.action, 'revived')
  const store = readStore(agent.dir)
  assert.equal(store.experiences.find((item) => item.id === b.id).superseded_by, a.id, 'B 被复活条顶替')
  assert.equal(store.experiences.find((item) => item.id === a.id).supersedes, b.id)
  const c = agent.record({ intent: '发布插件', action: '法丙', outcome: 'success', type: '代码 / 插件' })
  assert.equal(c.action, 'superseded')
  assert.equal(c.supersededId, a.id, 'A 已是现任，C 取代 A')
})

check('删除取代者：被它取代的那条自动回到可见', () => {
  const agent = newAgent()
  const a = agent.record({ intent: '发布插件', action: '法甲', outcome: 'success', type: '代码 / 插件' })
  const b = agent.record({ intent: '发布插件', action: '法乙', outcome: 'success', type: '代码 / 插件' })
  assert.equal(b.action, 'superseded')
  const store = readStore(agent.dir)
  forgetExperience(store, b.id)
  writeStore(agent.dir, store)
  const rowA = agent.all().find((item) => item.id === a.id)
  assert.equal(rowA.superseded_by, null)
  assert.ok(agent.visible().some((item) => item.id === a.id))
  assert.equal(agent.all().find((item) => item.id === b.id).deleted_at !== null, true)
})

check('outcome=failed + 全正 stepRewards：G 取 min(reward, 分步)，记成负', () => {
  const agent = newAgent()
  const made = agent.record({
    intent: '给研学课 PPT 插页', action: '整套做法', outcome: 'failed', type: 'PPT / 课件',
    stepRewards: [0.8, 0.8, 0.8], stepTotal: 3, failedStep: 3,
  })
  assert.ok(made.signWarning, '反号时必须给提示')
  const row = agent.all().find((item) => item.id === made.id)
  assert.equal(row.G, -0.6, '失败不能被正的分步回报洗白')
})

check('整条 + 步骤混记：steps 只数步骤，不把整条算一步', () => {
  const agent = newAgent()
  const taskId = 'task-mixed'
  agent.record({ intent: '插页', action: '整条做法', outcome: 'success', type: 'PPT / 课件', taskId, kind: 'task', stepTotal: 3 })
  for (let i = 1; i <= 3; i += 1) {
    agent.record({ intent: '插页', action: `步骤 ${i}`, outcome: 'success', type: 'PPT / 课件', taskId, kind: 'step', stepIndex: i, stepTotal: 3 })
  }
  const store = readStore(agent.dir)
  const cluster = (store.clusters || []).find((item) => item.name === 'PPT / 课件')
  assert.equal(cluster.stats.count, 1)
  assert.equal(cluster.stats.steps, 3)
})

check('kind=step 但没给 stepIndex：不同步骤不互相取代', () => {
  const agent = newAgent()
  agent.record({ intent: '给研学课 PPT 插页（多步）', action: '克隆页', outcome: 'success', type: 'PPT / 课件', taskId: 'task-noidx', kind: 'step' })
  agent.record({ intent: '给研学课 PPT 插页（多步）', action: '重画主体', outcome: 'success', type: 'PPT / 课件', taskId: 'task-noidx', kind: 'step' })
  assert.equal(agent.visible().length, 2, '没有编号的步骤也不能被当成同一步')
})

check('召回证据带 stepTotal / failedStep', () => {
  const agent = newAgent()
  agent.record({
    intent: '给研学课 PPT 插页', action: '整套做法', outcome: 'failed', type: 'PPT / 课件',
    taskId: 'task-e', kind: 'task', stepTotal: 4, failedStep: 4, stepRewards: [0.8, 0.8, 0.8, -0.6],
  })
  const evidence = agent.recall('给研学课 PPT 插页').candidates.flatMap((candidate) => candidate.evidence)[0]
  assert.equal(evidence.stepTotal, 4)
  assert.equal(evidence.failedStep, 4)
})

console.log('')
console.log(`结果：通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exit(1)
