/**
 * 可用性验收（0.13.0，2026-11-11 行为模拟后定）：不看 token 绝对值，只看「功能能不能用」。
 *
 *  ① 刚记的条，下一次同类任务召回必须出现；
 *  ② 否定要能打到当轮那条（hurt 后 G 下降）；
 *  ③ 未分类的条在簇内召回里不能消失；
 *  ④ 换做法成功要产生新旧交替（旧条被取代）；
 *  ⑤ pending 要在下一次调用被回填。
 *
 * Run: node tests/usability.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { rankExperiences, readStore, visibleExperiences } from '../store.js'
import { buildTools } from '../tools.js'
import { measure } from '../token-budget.js'

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

const newAgent = (config = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-usable-'))
  const tools = buildTools((definition) => definition, { dataDir: dir, autoBind: false, ...config })
  const call = (name, args) => tools.find((item) => item.name === name).execute(args)
  return {
    dir,
    call,
    record: (input) => call('exp_record', input),
    recall: (intent, extra = {}) => call('exp_recall', { intent, ...extra }),
    store: () => readStore(dir),
    visible: () => visibleExperiences(readStore(dir)),
  }
}

check('① 刚记的条，下一次同类任务召回必须出现（intent 写「对象+任务」）', () => {
  const agent = newAgent()
  const made = agent.record({ intent: '给研学课 PPT 插一页过渡页', action: '新建一页：居中大标题 + 副标题', outcome: 'success', typeName: 'PPT / 课件' })
  const recalled = agent.recall('给研学课 PPT 再插一页（深蓝色调）', { limit: 4 })
  const evidence = (recalled.candidates || []).flatMap((candidate) => candidate.evidence || [])
  assert.ok(evidence.some((item) => item.id === made.id), '刚记的那条应出现在召回里')
})

check('② 否定打到当轮那条：hurt 后 G 下降', () => {
  const agent = newAgent()
  const made = agent.record({ intent: '给研学课 PPT 过渡页加装饰', action: '在标题旁画一个装饰圆', outcome: 'success', typeName: 'PPT / 课件' })
  const recalled = agent.recall('给研学课 PPT 过渡页装饰位置（挡住标题）', { limit: 6 })
  const evidence = (recalled.candidates || []).flatMap((candidate) => candidate.evidence || [])
  const target = evidence.find((item) => item.id === made.id)
  assert.ok(target, '当轮那条要能被召回，否则只能拍脑袋打老条')
  const before = Number(target.G)
  agent.call('exp_feedback', { id: made.id, result: 'hurt' })
  const after = Number(agent.store().experiences.find((item) => item.id === made.id).G)
  assert.ok(after < before, `hurt 后 G 应变小：${before} → ${after}`)
})

check('③ 未分类的条在簇内召回里也要可见', () => {
  const agent = newAgent({ routing: 'off' })
  agent.record({ intent: '给研学课 PPT 插一页', action: '克隆相邻页再改字', outcome: 'success', typeName: 'PPT / 课件' })
  // 同样主题、但故意不写类型 → 落「未分类」；召回时不能因为它在簇外就看不见。
  const loose = agent.record({ intent: '给研学课 PPT 插页的版式说明', action: '先写版式约束再动手', outcome: 'success' })
  const store = agent.store()
  const looseRow = store.experiences.find((item) => item.id === loose.id)
  assert.equal(looseRow.typeId, 'ty_other', '这条应是未分类')
  const ranked = rankExperiences(store, '给研学课 PPT 插页', 6, { routing: 'on' })
  const evidence = (ranked.candidates || []).flatMap((candidate) => candidate.evidence || [])
  assert.ok(evidence.some((item) => item.id === loose.id), '未分类条不该被簇内召回吞掉')
})

check('④ 换做法成功：旧做法被取代（新旧交替可见）', () => {
  const agent = newAgent()
  const old = agent.record({ intent: '导出课件 PDF', action: '直接 print 成 PDF', outcome: 'success', typeName: '导出' })
  const next = agent.record({ intent: '导出课件 PDF', action: 'LibreOffice 无头转 PDF 并嵌字体', outcome: 'success', typeName: '导出' })
  assert.equal(next.action, 'superseded', `换做法应取代旧条，实际 ${next.action}`)
  const oldRow = agent.store().experiences.find((item) => item.id === old.id)
  assert.ok(oldRow.superseded_by === next.id || oldRow.retired_at, '旧做法应被取代或退休，而不是并排当同事')
})

check('⑤ pending 在下一次调用必须被回填', () => {
  const agent = newAgent()
  const made = agent.record({ intent: '给研学课 PPT 插一页过渡页', action: '先套模板', typeName: 'PPT / 课件' })
  assert.equal(agent.store().experiences.find((item) => item.id === made.id).verdict, 'pending')
  const filled = agent.record({
    intent: '给研学课 PPT 插一页过渡页',
    action: '先套模板',
    typeName: 'PPT / 课件',
    verdicts: [{ id: made.id, outcome: 'success' }],
  })
  assert.equal(filled.verdicts.ok, 1)
  assert.equal(agent.store().experiences.find((item) => item.id === made.id).verdict, 'decided')
})

check('⑥ 字符数只做记录：单任务（2 轮 + 1 召回 + 1 记录）不超过 20,000（防失控，不做 token 目标）', () => {
  const agent = newAgent()
  const first = agent.record({ intent: '给研学课 PPT 插一页过渡页', action: '先套模板', typeName: 'PPT / 课件' })
  const recalled = agent.recall('给研学课 PPT 插一页过渡页')
  const second = agent.record({ intent: '给研学课 PPT 插一页过渡页', action: '先套模板', typeName: 'PPT / 课件', verdicts: [{ id: first.id, outcome: 'success' }] })
  const total = measure(recalled) + measure(first) + measure(second)
  assert.ok(total < 20000, `单任务回执合计 ${total} 字符`)
})

check('⑦ 新记的条不会被成熟条挤掉（相似度预留；行为模拟发现的新条饿死问题）', () => {
  const agent = newAgent()
  // 5 条同主题、高回报（accepted=1.0）的成熟条：Â 高，按旧排序会把新条挤出输出。
  const actions = ['先套模板', '克隆相邻页再改字', '整页重画', '插页后重算页码', '先改母版再插页']
  for (const action of actions) {
    agent.record({ intent: '给研学课 PPT 插一页过渡页', action, outcome: 'accepted', typeName: 'PPT / 课件' })
  }
  // 一条与查询无关的失败条：旧逻辑会用「负样本补位」抢走最后一格（行为复核 R2 实测）。
  agent.record({ intent: '给机器人编排一段舞蹈动作', action: '直接套模板动作', outcome: 'failed', typeName: '机器人 / 动作' })
  const fresh = agent.record({ intent: '给研学课 PPT 插一页过渡页', action: '新建一页：深蓝底白字标题', outcome: 'success', typeName: 'PPT / 课件' })
  for (const limit of [undefined, 4, 6]) {
    const recalled = limit === undefined
      ? agent.recall('给研学课 PPT 插一页过渡页')
      : agent.recall('给研学课 PPT 插一页过渡页', { limit })
    const evidence = (recalled.candidates || []).flatMap((candidate) => candidate.evidence || [])
    assert.ok(evidence.some((item) => item.id === fresh.id), `limit=${limit === undefined ? '默认' : limit} 时新条必须可见`)
  }
})

check('⑧ 没有相关经验时不许瞎推荐：明说「没有」', () => {
  const agent = newAgent()
  agent.record({ intent: '给机器人编排一段舞蹈动作', action: '直接套模板动作', outcome: 'success', typeName: '机器人 / 动作' })
  const recalled = agent.recall('把财务报表做成现金流折现模型')
  const note = String(recalled.note || '')
  assert.ok(recalled.weak === true || /没有(足够|相似度)/.test(note), `应标 weak 或明说没有相关，实际：weak=${recalled.weak} note=${note}`)
})

console.log('')
console.log(`结果：通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exit(1)
