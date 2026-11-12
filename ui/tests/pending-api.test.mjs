/**
 * 控制台待判定/token 汇总的接口层测试（0.13.0 P4）。
 * 只测 build* 纯函数与数据源契约，不启 HTTP 服务。
 *
 * Run: node tests/pending-api.test.mjs
 */
import assert from 'node:assert/strict'

import { buildPending, buildSkills, buildState, buildUsageSummary, buildVerdicts, buildExperiences } from '../shell.js'
import { detailOf, visibleOf } from '../data-source.js'

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

const source = {
  pending(limit) {
    return [{ id: 'ex_a', intent: '插页' }, { id: 'ex_b', intent: '导出' }].slice(0, limit)
  },
  verdicts(list) {
    return list.map((item) => ({ id: item.id, ok: true, outcome: item.outcome }))
  },
  usageSummary() {
    return { calls: 3, chars: 900, avgChars: 300, byTool: { exp_recall: 2, exp_record: 1 } }
  },
}

check('buildPending：最多 5 条', () => {
  assert.equal(buildPending(source).length, 2)
  assert.deepEqual(buildPending({}) , [])
})

check('buildVerdicts：透传逐条结果', () => {
  const out = buildVerdicts(source, [{ id: 'ex_a', outcome: 'success' }])
  assert.deepEqual(out, [{ id: 'ex_a', ok: true, outcome: 'success' }])
})

check('buildVerdicts：数据源不支持时明确报错', () => {
  assert.throws(() => buildVerdicts({}, []), /不支持判定回填/)
})

check('buildUsageSummary：默认值 + 透传', () => {
  assert.deepEqual(buildUsageSummary({}), { calls: 0, chars: 0, avgChars: 0, byTool: {} })
  assert.equal(buildUsageSummary(source).chars, 900)
})

check('build* 对 null 源不抛 TypeError', () => {
  assert.doesNotThrow(() => buildState(null))
  assert.doesNotThrow(() => buildExperiences(null, null))
  assert.doesNotThrow(() => buildSkills(null))
  assert.doesNotThrow(() => buildPending(null))
  assert.doesNotThrow(() => buildUsageSummary(null))
})

check('null 行不崩：visibleOf/detailOf 过滤', () => {
  assert.deepEqual(visibleOf({ experiences: [null, {}, { id: 'a', deleted_at: null }] }).length, 2)
  assert.equal(detailOf({ experiences: [null] }, 'a'), null)
})
console.log('')
console.log(`结果：通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exit(1)
