/**
 * 负样本退休测试（0.13.0）
 *  - 同一做法已有成功 → 旧的失败条退休（软隐、不召回、统计不计），写 retired_at/history；
 *  - 再次失败 → 复活那条退休负样本（不新开重复条）；
 *  - 反馈退休条报错；取代目标忽略退休条；删除退休条照常。
 * Run: node tests/retire.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { forgetExperience, readStore, visibleExperiences } from '../store.js'
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-retire-'))
  const tools = buildTools((definition) => definition, { dataDir: dir })
  const call = (name, args) => tools.find((item) => item.name === name).execute(args)
  return {
    dir,
    record: (input) => call('exp_record', input),
    recall: (intent, extra = {}) => call('exp_recall', { intent, ...extra }),
    feedback: (id, result) => call('exp_feedback', { id, result }),
    all: () => readStore(dir).experiences,
    visible: () => visibleExperiences(readStore(dir)),
  }
}

check('成功退休同做法的负样本：软隐 + history，不删数据', () => {
  const agent = newAgent()
  const bad = agent.record({ intent: '装插件到 profile', action: '用目录装', outcome: 'failed', type: '环境 / 部署' })
  const good = agent.record({ intent: '装插件到 profile', action: '用目录装', outcome: 'success', type: '环境 / 部署' })
  assert.deepEqual(good.retired, [bad.id], '成功应把同做法的负条退休')
  const rowBad = agent.all().find((item) => item.id === bad.id)
  assert.ok(typeof rowBad.retired_at === 'string')
  assert.equal(rowBad.retired_reason, 'superseded-by-success')
  assert.ok(rowBad.history.some((event) => event.type === 'retired'))
  assert.deepEqual(agent.visible().map((item) => item.id), [good.id])
  const withRetired = visibleExperiences(readStore(agent.dir), { includeRetired: true })
  assert.equal(withRetired.length, 2, '数据仍在，只是默认不可见')
})

check('退休条不参与召回', () => {
  const agent = newAgent()
  const bad = agent.record({ intent: '装插件到 profile', action: '用目录装', outcome: 'failed', type: '环境 / 部署' })
  agent.record({ intent: '装插件到 profile', action: '用目录装', outcome: 'success', type: '环境 / 部署' })
  const recalled = agent.recall('装插件到 profile')
  const ids = recalled.candidates.flatMap((candidate) => candidate.evidence.map((e) => e.id))
  assert.ok(!ids.includes(bad.id))
})

check('再次失败 → 复活退休负样本，不新开重复条', () => {
  const agent = newAgent()
  const bad = agent.record({ intent: '装插件到 profile', action: '用目录装', outcome: 'failed', type: '环境 / 部署' })
  agent.record({ intent: '装插件到 profile', action: '用目录装', outcome: 'success', type: '环境 / 部署' })
  const again = agent.record({ intent: '装插件到 profile', action: '用目录装', outcome: 'failed', type: '环境 / 部署' })
  assert.equal(again.action, 'revived')
  assert.equal(again.id, bad.id)
  const row = agent.all().find((item) => item.id === bad.id)
  assert.equal(row.retired_at, null)
  assert.equal(row.hits, 2)
  assert.ok(row.history.some((event) => event.type === 'revived' && event.reason === 'retired'))
  assert.equal(agent.all().length, 2, '没有新增第三条')
})

check('对退休条反馈会报错（提示会复活）', () => {
  const agent = newAgent()
  const bad = agent.record({ intent: '装插件', action: '用目录装', outcome: 'failed', type: '环境 / 部署' })
  agent.record({ intent: '装插件', action: '用目录装', outcome: 'success', type: '环境 / 部署' })
  assert.throws(() => agent.feedback(bad.id, 'hurt'), /已退休/)
})

check('取代目标忽略退休条', () => {
  const agent = newAgent()
  const bad = agent.record({ intent: '发布插件', action: '法甲', outcome: 'failed', type: '代码 / 插件' })
  const good = agent.record({ intent: '发布插件', action: '法甲', outcome: 'success', type: '代码 / 插件' })
  const next = agent.record({ intent: '发布插件', action: '法乙', outcome: 'success', type: '代码 / 插件' })
  assert.equal(next.action, 'superseded')
  assert.equal(next.supersededId, good.id, '只取代可见的正条')
  const rowBad = agent.all().find((item) => item.id === bad.id)
  assert.equal(rowBad.superseded_by, null, '退休条不被当作取代目标')
})

check('类型统计不含退休条', () => {
  const agent = newAgent()
  agent.record({ intent: '装插件', action: '用目录装', outcome: 'failed', type: '环境' })
  agent.record({ intent: '装插件', action: '用目录装', outcome: 'success', type: '环境' })
  const store = readStore(agent.dir)
  const cluster = store.clusters.find((item) => item.name === '环境')
  assert.equal(cluster.stats.count, 1)
  assert.equal(cluster.stats.success, 1)
  assert.equal(cluster.stats.fail, 0)
})

check('删除退休条照常（墓碑）', () => {
  const agent = newAgent()
  const bad = agent.record({ intent: '装插件', action: '用目录装', outcome: 'failed', type: '环境 / 部署' })
  agent.record({ intent: '装插件', action: '用目录装', outcome: 'success', type: '环境 / 部署' })
  const store = readStore(agent.dir)
  assert.equal(forgetExperience(store, bad.id), true)
  assert.ok(store.experiences.find((item) => item.id === bad.id).deleted_at)
})

console.log('')
console.log(`结果：通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exit(1)
