/**
 * 沉淀入口测试（0.31.0）：exp_consolidate
 *  - 同族 ≥3 且 ≥2 正 1 负 → 生成 .exp/skills/<slug>/（SKILL.md + skill.json + derivedFrom）；
 *  - 全成功 / 样本不足 → skipped；
 *  - 同 slug 再次沉淀 → updated（derivedFrom 合并，不重复建目录）；
 *  - 沉淀后可被高确定召回（与 0.30 的链路）。
 * Run: node tests/skill-consolidate.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { applySkillOutcome, listSkills, readSkill, skillsRootOf } from '../skills.js'
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

const newAgent = (extra = {}) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-consol-'))
  const dataDir = path.join(base, '.exp')
  const tools = buildTools((definition) => definition, { dataDir, ...extra })
  const call = (name, args) => tools.find((item) => item.name === name).execute(args)
  return { dataDir, call }
}

function seed(agent, { omitNegative = false } = {}) {
  const taskId = 'task-consol'
  agent.call('exp_record', { intent: '给 PPT 插页：先克隆相邻页', action: '先克隆相邻页再改字', outcome: 'success', type: 'PPT / 课件', taskId, kind: 'step', stepIndex: 1, stepTotal: 3 })
  agent.call('exp_record', { intent: '给 PPT 插页：先克隆相邻页再重画', action: '先克隆相邻页再重画主体', outcome: 'success', type: 'PPT / 课件', taskId, kind: 'step', stepIndex: 2, stepTotal: 3 })
  agent.call('exp_record', {
    intent: '给 PPT 插页：直接套模板',
    action: omitNegative ? '先克隆相邻页再检查' : '直接套模板不做克隆',
    outcome: omitNegative ? 'success' : 'failed',
    type: 'PPT / 课件', taskId, kind: 'step', stepIndex: 3, stepTotal: 3,
  })
}

check('同族 2 正 1 负 → 生成技能目录，含 derivedFrom/typeName/context', () => {
  const agent = newAgent()
  seed(agent)
  const made = agent.call('exp_consolidate', { intent: '给 PPT 插页', context: ['课件'] })
  assert.equal(made.action, 'created')
  assert.equal(made.derivedFromCount, 3)
  assert.equal(made.commit, true)
  const dir = path.join(skillsRootOf(agent.dataDir), made.slug)
  assert.ok(fs.existsSync(path.join(dir, 'SKILL.md')))
  const skill = readSkill(dir)
  assert.equal(skill.meta.typeName, 'PPT / 课件')
  assert.deepEqual(skill.meta.context, ['课件'])
  assert.equal(skill.meta.derivedFrom.length, 3)
  assert.ok(skill.body.includes('优先'))
  assert.ok(skill.body.includes('避免'))
  assert.ok(skill.body.includes('## 常见例外'))
})

check('自动沉淀的技能天生高排序（order 90）', () => {
  const agent = newAgent()
  seed(agent)
  const made = agent.call('exp_consolidate', { intent: '给 PPT 插页' })
  const skill = readSkill(path.join(skillsRootOf(agent.dataDir), made.slug))
  assert.equal(skill.meta.order, 90, '沉淀出来的技能默认 order 应为 90')
})

check('技能正文含动作词，不被意图词（ppt/插页）占满', () => {
  const agent = newAgent()
  seed(agent)
  const made = agent.call('exp_consolidate', { intent: '给 PPT 插页' })
  const skill = readSkill(path.join(skillsRootOf(agent.dataDir), made.slug))
  const lines = skill.body.split(/\r?\n/)
  const start = lines.findIndex((line) => line.trim() === '## 做法')
  assert.ok(start >= 0)
  const procedure = []
  for (let i = start + 1; i < lines.length && !/^##\s/.test(lines[i]); i += 1) if (lines[i].trim() !== '') procedure.push(lines[i])
  assert.ok(procedure.length >= 1, '做法段不能为空')
  const joined = procedure.join(' ')
  assert.ok(/克隆|相邻/.test(joined), `做法应含动作词，实际：${joined}`)
  assert.ok(!procedure.every((line) => /ppt|插页/i.test(line)), '做法不能被意图词占满')
})

check('全是成功样本 → skipped（没有反例不沉淀）', () => {
  const agent = newAgent()
  seed(agent, { omitNegative: true })
  const made = agent.call('exp_consolidate', { intent: '给 PPT 插页' })
  assert.equal(made.action, 'skipped')
  assert.equal(listSkills(agent.dataDir).length, 0)
})

check('样本不足 → skipped', () => {
  const agent = newAgent()
  agent.call('exp_record', { intent: '装插件', action: '先打包', outcome: 'success', type: '环境 / 部署' })
  agent.call('exp_record', { intent: '装插件', action: '先打包再装', outcome: 'failed', type: '环境 / 部署' })
  const made = agent.call('exp_consolidate', { intent: '装插件', minSamples: 3 })
  assert.equal(made.action, 'skipped')
})

check('同 slug 再次沉淀 → updated，derivedFrom 合并且不重复建目录', () => {
  const agent = newAgent()
  seed(agent)
  const first = agent.call('exp_consolidate', { intent: '给 PPT 插页' })
  assert.equal(first.action, 'created')
  const second = agent.call('exp_consolidate', { intent: '给 PPT 插页' })
  assert.equal(second.action, 'updated')
  assert.equal(second.slug, first.slug)
  assert.equal(listSkills(agent.dataDir).length, 1)
})

check('沉淀 → 3 次 helped → exp_recall 返回技能（经验候选并列）', () => {
  const agent = newAgent()
  seed(agent)
  const made = agent.call('exp_consolidate', { intent: '给 PPT 插页' })
  for (let i = 0; i < 3; i += 1) applySkillOutcome(agent.dataDir, made.slug, 'helped')
  const recalled = agent.call('exp_recall', { intent: '给 PPT 插页' })
  assert.equal(recalled.mode, 'skill')
  assert.equal(recalled.skill.id, made.slug)
  // 0.13 起技能与经验并列返回：技能给正文，候选给同类经验参考。
  assert.ok(Array.isArray(recalled.candidates), 'candidates 不是数组')
})

check('技能召回后遇阻：record 带 skillId+blockedBy 进入签名计数', () => {
  const agent = newAgent()
  seed(agent)
  const made = agent.call('exp_consolidate', { intent: '给 PPT 插页' })
  const recorded = agent.call('exp_record', {
    intent: '给 PPT 插页', action: '按技能做', outcome: 'failed', type: 'PPT / 课件',
    skillId: `skill:${made.slug}`, blockedBy: '页脚错位 第 3 行',
  })
  assert.equal(recorded.skill.action, 'appended')
  const skill = readSkill(path.join(skillsRootOf(agent.dataDir), made.slug))
  assert.equal(Object.values(skill.meta.obstacles)[0].total, 1)
})

console.log('')
console.log(`结果：通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exit(1)
