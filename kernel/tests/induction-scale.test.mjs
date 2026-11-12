/**
 * 归纳提示 · 大数据量测试（合成数据，不落盘）
 *
 * 目的：确认在「假数据量大一些」时行为仍然正确、输出不膨胀、耗时可接受。
 *  - 6 个类型 × 200 条 = 1200 条合成经验；
 *  - 6 个查询各跑一次 rankExperiences(routing='on')；
 *  - 断言：候选 ≥1、induction 是一句提示、JSON 输出有界；
 *  - 打印耗时与样例，便于看趋势（不做硬性耗时断言，避免机器差异）。
 *
 * Run: node tests/induction-scale.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { buildInduction, createType, readStore, rankExperiences } from '../store.js'
import { abstractState } from '../kernel.js'

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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-scale-'))
const store = readStore(dir)

const TYPES = [
  ['PPT / 课件', '做幻灯片、课件类任务：研学课、常规课 PPT、插页、改版式'],
  ['文档 / 教案', '写或改 Word 文档、教案、讲义、学习任务单'],
  ['代码 / 插件', '写代码、改插件、修 bug、重构、跑测试'],
  ['表格 / 数据', 'Excel、CSV、表格整理与数据报表'],
  ['环境 / 部署', '装环境、部署、改配置'],
  ['调研 / 资料', '查资料、读论文、做调研与总结'],
]
const types = TYPES.map(([name, description]) => createType(store, name, description))

const INTENTS = [
  (i) => `做研学课 PPT 第 ${i} 页：插一页过渡页并改版式`,
  (i) => `写一份教案任务单，第 ${i} 版`,
  (i) => `给插件修 bug 并跑测试，第 ${i} 个`,
  (i) => `整理 Excel 表格数据，第 ${i} 批`,
  (i) => `安装依赖到用户目录，第 ${i} 次`,
  (i) => `查论文结论，第 ${i} 篇`,
]
const ACTIONS = ['先定主题色再排版', '先排版再统一调色', '直接套模板', '先读底稿再落字', '整页克隆再改字', '按索引局部改']
const TOTAL = 1200
for (let i = 0; i < TOTAL; i += 1) {
  const type = types[i % types.length]
  const intent = INTENTS[i % INTENTS.length](i)
  const action = `${ACTIONS[i % ACTIONS.length]}（变体 ${i % 11}）`
  const G = i % 9 === 0 ? -0.6 : (i % 3 === 0 ? 0.3 : 0.8)
  const ts = new Date(Date.now() - i * 60000).toISOString()
  store.experiences.push({
    id: `ex_syn${String(i).padStart(5, '0')}`,
    ts,
    lastSeenAt: ts,
    hits: (i % 4) + 1,
    intent,
    action,
    state: abstractState(intent, action),
    step_rewards: [G],
    G,
    outcome: G < 0 ? 'failed' : (G >= 0.8 ? 'success' : 'partial'),
    note: `合成备注 ${i}：${action}`,
    origin: 'manual',
    typeId: type.id,
    typeName: type.name,
    deleted_at: null,
    superseded_by: null,
  })
}

const QUERIES = [
  '做研学课 PPT 插一页过渡页',
  '写一份教案的任务单',
  '给插件修一个 bug 并跑测试',
  '整理 Excel 表格数据',
  '安装依赖到用户目录',
  '查一下这篇论文的结论',
]

let totalMs = 0
let maxJson = 0
let induced = 0
const sample = []
for (const intent of QUERIES) {
  const started = Date.now()
  const ranked = rankExperiences(store, intent, 8, { routing: 'on' })
  totalMs += Date.now() - started
  const json = JSON.stringify(ranked)
  maxJson = Math.max(maxJson, json.length)
  const ind = buildInduction(ranked.candidates)
  if (typeof ind === 'string') induced += 1
  if (sample.length === 0 && ind) sample.push({ intent, ind })
  assert.ok(ranked.candidates.length >= 1, `${intent} 没有候选`)
}

check(`1200 条合成数据下，${QUERIES.length} 个查询都能召回且输出不膨胀`, () => {
  assert.ok(maxJson < 60000, `最大输出 ${maxJson} 字符，超出预期`)
})

check('归纳提示在多数查询上触发，且都只有一句', () => {
  assert.ok(induced >= 3, `只有 ${induced}/${QUERIES.length} 个查询触发`)
  for (const intent of QUERIES) {
    const ranked = rankExperiences(store, intent, 8, { routing: 'on' })
    const out = buildInduction(ranked.candidates)
    if (typeof out === 'string') {
      assert.equal(out.includes('\n'), false)
      assert.ok(out.length <= 160, `len=${out.length}`)
    }
  }
})

check('大数据下同一 evidence 仍只算一次（去重不依赖数据量）', () => {
  const ranked = rankExperiences(store, QUERIES[0], 8, { routing: 'on' })
  const ids = []
  for (const candidate of ranked.candidates) for (const evidence of candidate.evidence) ids.push(evidence.id)
  assert.equal(new Set(ids).size, ids.length, '证据出现重复 id')
})

check('buildInduction 在 1200 条证据上仍返回一句、字数有界', () => {
  const ranked = rankExperiences(store, QUERIES[2], 8, { routing: 'on' })
  const out = buildInduction(ranked.candidates)
  assert.ok(out === null || (typeof out === 'string' && out.length <= 160 && !out.includes('\n')))
})

console.log('')
console.log(`数据量 ${TOTAL} 条｜查询 ${QUERIES.length} 个｜总耗时 ${totalMs}ms｜最大输出 ${maxJson} 字符｜触发归纳 ${induced}/${QUERIES.length}`)
if (sample.length > 0) console.log(`样例：${sample[0].ind}`)
console.log(`结果：通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exit(1)
