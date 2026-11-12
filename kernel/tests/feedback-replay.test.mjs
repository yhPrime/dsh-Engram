/**
 * 反馈事件重放测试（0.9.0）：G 不再是「随手改的数」，而是 GOutcome + feedback_log 重放的结果。
 *  - 重记只改基准，反馈历史不被抹掉；
 *  - 事件封顶 20 条；neutral 不动 G、也不标 feedback；
 *  - 旧数据（无 GOutcome）读入时按 outcome 补基准，有日志则重放。
 * Run: node tests/feedback-replay.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { FEEDBACK_LOG_LIMIT, applyFeedback, readStore, replayFeedback, upsertExperience, writeStore } from '../store.js'

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

const newDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'exp-replay-'))

check('replayFeedback：按顺序重放 helped/hurt，逐步 EMA、封顶 ±1', () => {
  assert.equal(replayFeedback(0.8, []), 0.8)
  assert.equal(replayFeedback(0.8, [{ result: 'hurt' }]), 0.17)
  assert.equal(replayFeedback(0.8, [{ result: 'hurt' }, { result: 'hurt' }]), -0.2395)
  assert.equal(replayFeedback(0.8, [{ result: 'hurt' }, { result: 'hurt' }, { result: 'helped' }]), 0.1943)
  assert.equal(replayFeedback(0.8, [{ result: 'neutral' }]), 0.8)
})

check('重记只改基准：同符号更新后，G = 新基准 + 旧反馈历史', () => {
  const dir = newDir()
  const store = readStore(dir)
  const made = upsertExperience(store, { intent: '给插件跑测试', action: '先跑 npm test', outcome: 'success', type: '代码 / 插件' })
  applyFeedback(store, made.experience.id, { result: 'helped' })
  applyFeedback(store, made.experience.id, { result: 'helped' })
  assert.equal(made.experience.G, 0.9155)
  const again = upsertExperience(store, { intent: '给插件跑测试', action: '先跑 npm test', outcome: 'success', type: '代码 / 插件' })
  assert.equal(again.action, 'updated')
  assert.equal(again.experience.GOutcome, 0.8)
  assert.equal(again.experience.G, 0.9155, '反馈历史不应被重记抹掉')
  writeStore(dir, store)
  const reread = readStore(dir).experiences[0]
  assert.equal(reread.G, 0.9155, '写盘再读仍一致（不是同一对象自证）')
  assert.equal(reread.feedback.helped, 2)
  assert.equal(again.experience.feedback.helped, 2)
})

check('同符号失败重记：G = -0.6 + 旧 hurt 历史，不被重置', () => {
  const dir = newDir()
  const store = readStore(dir)
  const made = upsertExperience(store, { intent: '装插件到 profile', action: '用目录装', outcome: 'failed', type: '环境 / 部署' })
  applyFeedback(store, made.experience.id, { result: 'hurt' })
  assert.equal(made.experience.G, -0.74)
  const again = upsertExperience(store, { intent: '装插件到 profile', action: '用目录装', outcome: 'failed', type: '环境 / 部署' })
  assert.equal(again.experience.GOutcome, -0.6)
  assert.equal(again.experience.G, -0.74)
  assert.equal(again.experience.feedback.hurt, 1)
})

check('neutral 不动 G、不标 feedback；events 仍进日志', () => {
  const dir = newDir()
  const store = readStore(dir)
  const made = upsertExperience(store, { intent: '查论文结论', action: '先读摘要', outcome: 'success', type: '调研 / 资料' })
  applyFeedback(store, made.experience.id, { result: 'neutral' })
  assert.equal(made.experience.G, 0.8)
  assert.equal(made.experience.GSource, 'outcome')
  assert.equal(made.experience.feedback.neutral, 1)
  assert.equal(made.experience.feedback_log.length, 1)
})

check('日志封顶：超过 20 条只保留最近 20 条，G 按保留的事件重放', () => {
  const dir = newDir()
  const store = readStore(dir)
  const made = upsertExperience(store, { intent: '改 PPT 页码', action: '重算物理页序', outcome: 'success', type: 'PPT / 课件' })
  for (let i = 0; i < FEEDBACK_LOG_LIMIT + 5; i += 1) applyFeedback(store, made.experience.id, { result: 'hurt' })
  assert.equal(made.experience.feedback_log.length, FEEDBACK_LOG_LIMIT)
  assert.equal(made.experience.feedback.hurt, FEEDBACK_LOG_LIMIT + 5, '计数是终身的，日志只留最近 20 条')
  // 独立算一遍（不调用被测函数自证）：20 次 hurt 的 EMA。
  let expected = 0.8
  for (let i = 0; i < FEEDBACK_LOG_LIMIT; i += 1) expected = Math.round((expected + 0.35 * (-1 - expected)) * 1e4) / 1e4
  assert.equal(made.experience.G, expected)
})

check('neutral 洪水不能把 hurt 挤出窗口、洗白 G', () => {
  const dir = newDir()
  const store = readStore(dir)
  const made = upsertExperience(store, { intent: '改 PPT 页码', action: '重算物理页序', outcome: 'success', type: 'PPT / 课件' })
  for (let i = 0; i < FEEDBACK_LOG_LIMIT; i += 1) applyFeedback(store, made.experience.id, { result: 'hurt' })
  const before = made.experience.G
  for (let i = 0; i < FEEDBACK_LOG_LIMIT; i += 1) applyFeedback(store, made.experience.id, { result: 'neutral' })
  assert.equal(made.experience.G, before, 'neutral 不参与重放，也不该挤掉信号事件')
  assert.ok(made.experience.G < -0.9)
  assert.equal(made.experience.feedback.hurt, FEEDBACK_LOG_LIMIT)
  assert.equal(made.experience.feedback.neutral, FEEDBACK_LOG_LIMIT)
})

check('分支判符号用基准回报：成功但被 hurt 两次，重记失败要新开负条', () => {
  const dir = newDir()
  const store = readStore(dir)
  const made = upsertExperience(store, { intent: '改 PPT 页码', action: '重算物理页序', outcome: 'success', type: 'PPT / 课件' })
  applyFeedback(store, made.experience.id, { result: 'hurt' })
  applyFeedback(store, made.experience.id, { result: 'hurt' })
  assert.ok(made.experience.G < 0)
  const failed = upsertExperience(store, { intent: '改 PPT 页码', action: '重算物理页序', outcome: 'failed', type: 'PPT / 课件' })
  assert.equal(failed.action, 'added', 'outcome 基准是正的，重记失败应新开负条')
  const old = store.experiences.find((item) => item.id === made.experience.id)
  assert.equal(old.outcome, 'success')
  assert.ok(old.feedback.hurt === 2)
})

check('旧数据迁移：无 GOutcome 读入时补基准，有日志则按日志重放', () => {
  const dir = newDir()
  const payload = {
    version: 1,
    types: [{ id: 'ty_x', name: '代码 / 插件', description: '', system: false }],
    experiences: [
      {
        id: 'ex_old', taskId: 'ex_old', kind: 'task',
        intent: '给插件跑测试', action: '先跑 npm test',
        ts: new Date().toISOString(), lastSeenAt: new Date().toISOString(), hits: 1,
        G: 0.5, outcome: 'success', GSource: 'feedback',
        feedback_log: [{ at: new Date().toISOString(), result: 'hurt' }],
        feedback: { helped: 0, hurt: 1, neutral: 0 },
        state: { tokens: [], cgrams: [], artifacts: [] },
        step_rewards: [0.5], typeId: 'ty_x', typeName: '代码 / 插件',
      },
    ],
  }
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'exp-lib.json'), JSON.stringify(payload), 'utf8')
  const store = readStore(dir)
  const row = store.experiences[0]
  assert.equal(row.GOutcome, 0.8, '基准由 outcome 补')
  assert.equal(row.G, 0.17, 'G 由基准 + 日志重放')
  assert.equal(row.GSource, 'feedback')
  writeStore(dir, store)
})

check('迁移保真：没有反馈日志的旧行保持原 G，不被 outcome 基准覆盖', () => {
  const dir = newDir()
  const payload = {
    version: 1,
    types: [{ id: 'ty_y', name: '表格 / 数据', description: '', system: false }],
    experiences: [
      {
        id: 'ex_keep', taskId: 'ex_keep', kind: 'task',
        intent: '整理 Excel', action: '先清洗再透视',
        ts: new Date().toISOString(), lastSeenAt: new Date().toISOString(), hits: 1,
        G: 1, outcome: 'success',
        state: { tokens: [], cgrams: [], artifacts: [] },
        step_rewards: [1], typeId: 'ty_y', typeName: '表格 / 数据',
      },
    ],
  }
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'exp-lib.json'), JSON.stringify(payload), 'utf8')
  const row = readStore(dir).experiences[0]
  assert.equal(row.G, 1, '读一次不能把 1 静默改成 0.8')
  assert.equal(row.GOutcome, 1)
  assert.equal(row.GSource, 'outcome')
})

check('迁移：GSource=feedback 但没有日志时，保持原 G（不能重置成 outcome 基准）', () => {
  const dir = newDir()
  const payload = {
    version: 1,
    types: [{ id: 'ty_z', name: '环境 / 部署', description: '', system: false }],
    experiences: [
      {
        id: 'ex_nolog', taskId: 'ex_nolog', kind: 'task',
        intent: '装插件', action: '用 tgz 装',
        ts: new Date().toISOString(), lastSeenAt: new Date().toISOString(), hits: 1,
        G: 0.95, outcome: 'success', GSource: 'feedback',
        feedback: { helped: 1, hurt: 0, neutral: 0 },
        state: { tokens: [], cgrams: [], artifacts: [] },
        step_rewards: [0.95], typeId: 'ty_z', typeName: '环境 / 部署',
      },
    ],
  }
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'exp-lib.json'), JSON.stringify(payload), 'utf8')
  const row = readStore(dir).experiences[0]
  assert.equal(row.G, 0.95, '没有日志就不该重算')
  assert.equal(row.GOutcome, 0.95)
})

console.log('')
console.log(`结果：通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exit(1)
