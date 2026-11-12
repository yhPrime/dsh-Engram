/**
 * 技能工具接入测试（0.30.0）
 *  - exp_recall：高确定技能只返回技能本身（candidates 为空）；
 *  - exp_record：带 skillId 回填 confidence；带 blockedBy 更新签名计数；
 *  - exp_feedback：skill:<slug> 改技能账本，hurt 降级；
 *  - 经验条与技能互不取代。
 * Run: node tests/skill-tools.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { applySkillOutcome, createSkill, readSkill, skillsRootOf } from '../skills.js'
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

const INTENT = '写 PowerShell 脚本 ps1 编码'
const setup = () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-skill-tools-'))
  const dataDir = path.join(base, '.exp')
  const tools = buildTools((definition) => definition, { dataDir })
  const call = (name, args) => tools.find((item) => item.name === name).execute(args)
  const made = createSkill(dataDir, {
    name: 'PowerShell 脚本写入',
    description: '写 ps1 时用 UTF-8 BOM 与 CRLF，避免编码与换行错误',
    typeName: '环境 / 部署',
    context: ['windows', 'powershell'],
    triggers: ['ps1', '编码', 'crlf'],
    derivedFrom: ['ex_a', 'ex_b'],
  })
  const skill = () => readSkill(path.join(skillsRootOf(dataDir), made.slug))
  return { dataDir, call, made, skill }
}

check('高确定技能：召回返回技能（经验候选并列）', () => {
  const { call, made, dataDir } = setup()
  for (let i = 0; i < 3; i += 1) applySkillOutcome(dataDir, made.slug, 'helped')
  const recalled = call('exp_recall', { intent: INTENT })
  assert.equal(recalled.mode, 'skill')
  assert.ok(Array.isArray(recalled.candidates), 'candidates 应为数组')
  assert.equal(recalled.skill.id, made.slug)
  assert.ok(recalled.skill.body.includes('## 做法'))
  assert.ok(typeof recalled.skill.confidence.reason === 'string', JSON.stringify(recalled.skill.confidence))
  assert.ok(recalled.skill.confidence.reason.includes('helped'))
})

check('非高确定技能：召回仍走普通经验路径', () => {
  const { call } = setup()
  const recalled = call('exp_recall', { intent: INTENT })
  assert.notEqual(recalled.mode, 'skill')
})

check('record 带 skillId + blockedBy：写经验、更新技能签名计数', () => {
  const { call, made, skill, dataDir } = setup()
  const recorded = call('exp_record', {
    intent: INTENT, action: '用 BOM 保存', outcome: 'failed', type: '环境 / 部署',
    skillId: `skill:${made.slug}`, blockedBy: 'PS 5.1 中文乱码 第 12 行', note: '中文乱码',
  })
  assert.ok(recorded.skill)
  assert.equal(recorded.skill.action, 'appended')
  const meta = skill().meta
  assert.equal(Object.keys(meta.obstacles).length, 1)
  assert.equal(Object.values(meta.obstacles)[0].total, 1)
  const row = readStore(dataDir).experiences.find((item) => item.id === recorded.id)
  assert.equal(row.skillId, `skill:${made.slug}`)
})

check('record 带 skillId 成功：技能 confidence helped +1', () => {
  const { call, made, skill } = setup()
  call('exp_record', {
    intent: INTENT, action: '用 BOM 保存并 CRLF', outcome: 'success', type: '环境 / 部署',
    skillId: made.slug,
  })
  assert.equal(skill().meta.confidence.helped, 1)
  assert.equal(skill().meta.confidence.uses, 1)
})

check('feedback skill:hurt 降级：后续召回不再只返回技能', () => {
  const { call, made, dataDir } = setup()
  for (let i = 0; i < 3; i += 1) applySkillOutcome(dataDir, made.slug, 'helped')
  const before = call('exp_recall', { intent: INTENT })
  assert.equal(before.mode, 'skill')
  for (let i = 0; i < 2; i += 1) call('exp_feedback', { id: `skill:${made.slug}`, result: 'hurt' })
  const after = call('exp_recall', { intent: INTENT })
  assert.notEqual(after.mode, 'skill')
})

check('feedback skill:neutral：不改 confidence，返回 skill-neutral', () => {
  const { call, made, skill, dataDir } = setup()
  applySkillOutcome(dataDir, made.slug, 'helped')
  const before = skill().meta.confidence
  const out = call('exp_feedback', { id: `skill:${made.slug}`, result: 'neutral' })
  assert.equal(out.action, 'skill-neutral')
  assert.deepEqual(skill().meta.confidence, before)
})

check('一次撞多个签名：blockedBy 数组各记各的', () => {
  const { call, made, skill } = setup()
  const recorded = call('exp_record', {
    intent: INTENT, action: '按技能做', outcome: 'failed', type: '环境 / 部署',
    skillId: `skill:${made.slug}`, blockedBy: ['utf8-bom：BOM 错误', 'crlf：LF 错误'],
  })
  assert.equal(recorded.skill.action, 'multi')
  assert.equal(recorded.skill.results.length, 2)
  assert.equal(Object.keys(skill().meta.obstacles).length, 2)
})

check('技能缺失：record 不报错，经验照记，skill.action=missing', () => {
  const { call, dataDir } = setup()
  const recorded = call('exp_record', {
    intent: INTENT, action: '按不存在的技能做', outcome: 'failed', type: '环境 / 部署',
    skillId: 'skill:no-such-skill', blockedBy: 'err-A：问题 A',
  })
  assert.equal(recorded.skill.action, 'missing')
  assert.ok(readStore(dataDir).experiences.some((item) => item.id === recorded.id && !item.superseded_by))
})

check('usage 日志：exp_record 带技能操作（action/slug/commit/warned）', () => {
  const { call, made, dataDir } = setup()
  call('exp_record', {
    intent: INTENT, action: '按技能做', outcome: 'failed', type: '环境 / 部署',
    skillId: made.slug, blockedBy: 'utf8-bom：BOM 错误',
  })
  const usageFile = path.join(dataDir, 'usage.jsonl')
  const lines = fs.readFileSync(usageFile, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
  const entry = lines.find((item) => item.tool === 'exp_record' && item.skill)
  assert.ok(entry, '应有一条带 skill 的 exp_record usage')
  assert.equal(entry.skill.action, 'appended')
  assert.equal(entry.skill.slug, made.slug)
  assert.equal(entry.skill.commit, true)
})

check('pendingSkills 可见：recall 报待补提交数，成功提交后归零', () => {
  const { call, made, dataDir } = setup()
  const metaFile = path.join(skillsRootOf(dataDir), made.slug, 'skill.json')
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'))
  meta.pendingCommit = true
  fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2), 'utf8')
  assert.equal(call('exp_recall', { intent: INTENT }).pendingSkills, 1)
  call('exp_feedback', { id: `skill:${made.slug}`, result: 'helped' })
  assert.equal(call('exp_recall', { intent: INTENT }).pendingSkills, 0)
})

check('错误但存在的 skillId：照记经验并给 skillWarning', () => {
  const { call, made } = setup()
  // 把技能改成环境/部署，然后用一个完全不相干的意图去戳它。
  const recorded = call('exp_record', {
    intent: '给研学课 PPT 插一页过渡页', action: '按技能做', outcome: 'failed', type: 'PPT / 课件',
    skillId: made.slug, blockedBy: '页脚错位 第 3 行',
  })
  assert.ok(typeof recorded.skillWarning === 'string', JSON.stringify(recorded.skillWarning))
  assert.ok(recorded.skillWarning.includes('相似度'))
})

check('技能修订不影响经验条：经验仍可见、不被技能取代', () => {
  const { call, made, skill, dataDir } = setup()
  const rec = call('exp_record', {
    intent: INTENT, action: '按技能做', outcome: 'failed', type: '环境 / 部署',
    skillId: made.slug, blockedBy: 'utf8-bom：BOM 错误',
  })
  for (let i = 0; i < 2; i += 1) call('exp_record', {
    intent: INTENT, action: '按技能做', outcome: 'failed', type: '环境 / 部署',
    skillId: made.slug, blockedBy: 'utf8-bom：BOM 错误',
  })
  assert.equal(skill().meta.revisions, 1)
  const row = readStore(dataDir).experiences.find((item) => item.id === rec.id)
  assert.ok(row)
  assert.equal(row.superseded_by, null)
})

console.log('')
console.log(`结果：通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exit(1)
