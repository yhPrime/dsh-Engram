/**
 * 生命周期证据测试（0.15.0）
 *  - 召回证据带 lifecycle（最近一次取代/复活/退休/删除事件 + 时间 + reason）；
 *  - 普通条不带 lifecycle 字段；
 *  - brief 里对有复活过的做法给一句提示。
 * Run: node tests/lifecycle-evidence.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-lifeev-'))
  const tools = buildTools((definition) => definition, { dataDir: dir })
  const call = (name, args) => tools.find((item) => item.name === name).execute(args)
  return {
    record: (input) => call('exp_record', input),
    recall: (intent, extra = {}) => call('exp_recall', { intent, ...extra }),
  }
}

check('复活过的条：证据带 lifecycle.revived + 时间', () => {
  const agent = newAgent()
  agent.record({ intent: '发布插件到 GitHub', action: '法甲', outcome: 'success', type: '代码 / 插件' })
  agent.record({ intent: '发布插件到 GitHub', action: '法乙', outcome: 'success', type: '代码 / 插件' })
  agent.record({ intent: '发布插件到 GitHub', action: '法甲', outcome: 'success', type: '代码 / 插件' })
  const recalled = agent.recall('发布插件到 GitHub')
  const evidence = recalled.candidates.flatMap((candidate) => candidate.evidence)
  const revived = evidence.find((item) => item.lifecycle)
  assert.ok(revived, '应有 lifecycle 字段')
  assert.equal(revived.lifecycle.type, 'revived')
  assert.ok(Number.isFinite(Date.parse(revived.lifecycle.at)))
})

check('普通条不带 lifecycle（不占字符）', () => {
  const agent = newAgent()
  agent.record({ intent: '改 PPT 页码', action: '重算物理页序', outcome: 'success', type: 'PPT / 课件' })
  const evidence = agent.recall('改 PPT 页码').candidates.flatMap((candidate) => candidate.evidence)[0]
  assert.equal('lifecycle' in evidence, false)
})

check('brief 提示复活过', () => {
  const agent = newAgent()
  agent.record({ intent: '发布插件到 GitHub', action: '法甲', outcome: 'success', type: '代码 / 插件' })
  agent.record({ intent: '发布插件到 GitHub', action: '法乙', outcome: 'success', type: '代码 / 插件' })
  agent.record({ intent: '发布插件到 GitHub', action: '法甲', outcome: 'success', type: '代码 / 插件' })
  const recalled = agent.recall('发布插件到 GitHub')
  assert.ok(typeof recalled.brief === 'string')
  assert.ok(recalled.brief.includes('复活过'), recalled.brief)
})

console.log('')
console.log(`结果：通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exit(1)
