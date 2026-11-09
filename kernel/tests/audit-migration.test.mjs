/**
 * 迁移留痕测试（0.16.0）
 *  - audit 的 migrationReport() 对比「文件里的 G」与「readStore 迁移后的 G」；
 *  - 有反馈日志的旧行会被重算、能报出 Δ 与样例；没有差异时 migrated=0。
 * Run: node tests/audit-migration.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { readStore } from '../store.js'
import { migrationReport } from '../tools/audit.mjs'

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

const newDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'exp-audit-mig-'))

function writeLegacy(dir, rows) {
  const payload = {
    version: 1,
    types: [{ id: 'ty_a', name: '代码 / 插件', description: '', system: false }],
    experiences: rows,
  }
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'exp-lib.json'), JSON.stringify(payload), 'utf8')
}

check('有反馈日志的旧行：报出重算行数、最大 Δ 与样例', () => {
  const dir = newDir()
  const now = new Date().toISOString()
  writeLegacy(dir, [{
    id: 'ex_legacy1', taskId: 'ex_legacy1', kind: 'task',
    intent: '给插件跑测试', action: '先跑 npm test', ts: now, lastSeenAt: now, hits: 1,
    G: 0.5, outcome: 'success', GSource: 'feedback',
    feedback_log: [{ at: now, result: 'hurt' }],
    feedback: { helped: 0, hurt: 1, neutral: 0 },
    state: { tokens: [], cgrams: [], artifacts: [] },
    step_rewards: [0.5], typeId: 'ty_a', typeName: '代码 / 插件',
  }])
  const store = readStore(dir)
  const report = migrationReport(store, dir)
  assert.equal(report.available, true)
  assert.equal(report.migrated, 1)
  assert.ok(Math.abs(report.maxDelta - 0.33) < 0.001, `maxDelta=${report.maxDelta}`)
  assert.ok(report.examples[0].startsWith('ex_legac'))
})

check('文件与读后一致：migrated=0', () => {
  const dir = newDir()
  const now = new Date().toISOString()
  writeLegacy(dir, [{
    id: 'ex_same', taskId: 'ex_same', kind: 'task',
    intent: '查论文', action: '先读摘要', ts: now, lastSeenAt: now, hits: 1,
    G: 0.8, GOutcome: 0.8, outcome: 'success',
    state: { tokens: [], cgrams: [], artifacts: [] },
    step_rewards: [0.8], typeId: 'ty_a', typeName: '代码 / 插件',
  }])
  const store = readStore(dir)
  const report = migrationReport(store, dir)
  assert.equal(report.migrated, 0)
})

check('没有文件：available=false，不抛错', () => {
  const dir = newDir()
  const store = readStore(dir)
  const report = migrationReport(store, dir)
  assert.equal(report.available, false)
})

console.log('')
console.log(`结果：通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exit(1)
