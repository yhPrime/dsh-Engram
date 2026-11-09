/**
 * 用法日志（usage.jsonl）测试：零 token 的调用计数，用来回答「召回有没有被用起来」。
 * 覆盖：四工具字段、recall 诊断字段（limit/route_score/ids）、脱敏与截断、
 *       失败调用留痕、usageLog 关闭、轮转与跨文件读回、JSON 合法。
 * Run: node tests/usage.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { USAGE_FILE_NAME, readUsage } from '../store.js'
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

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'exp-usage-'))
}

const tool = (tools, name) => tools.find((item) => item.name === name)

check('exp_record 写一行：op / intent / action / outcome / typeName', () => {
  const dir = tempDir()
  const tools = buildTools((definition) => definition, { dataDir: dir })
  tool(tools, 'exp_record').execute({ intent: '做研学课 PPT', action: '先定主题色', outcome: 'success', type: 'PPT / 课件' })
  const rows = readUsage(dir)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].tool, 'exp_record')
  assert.equal(rows[0].op, 'added')
  assert.equal(rows[0].intent, '做研学课 PPT')
  assert.equal(rows[0].action, '先定主题色')
  assert.equal(rows[0].outcome, 'success')
  assert.equal(rows[0].typeName, 'PPT / 课件')
  assert.ok(Number.isFinite(Date.parse(rows[0].at)), 'at 应为 ISO 时间')
})

check('exp_recall 写一行：hit / candidates / mode / route / route_score / limit / ids / induction', () => {
  const dir = tempDir()
  const tools = buildTools((definition) => definition, { dataDir: dir })
  tool(tools, 'exp_record').execute({ intent: '做研学课 PPT', action: '先定主题色', outcome: 'success', type: 'PPT / 课件' })
  tool(tools, 'exp_recall').execute({ intent: '做研学课 PPT', limit: 5 })
  const recall = readUsage(dir).find((row) => row.tool === 'exp_recall')
  assert.ok(recall)
  assert.equal(recall.hit, true)
  assert.ok(recall.candidates >= 1)
  assert.equal(recall.limit, 5)
  assert.ok(typeof recall.mode === 'string')
  assert.ok(Number.isFinite(recall.route_score))
  assert.equal(recall.ids.length, 1, '应带 top 候选 id，便于与 feedback 关联')
  assert.equal(recall.induction, false)
})

check('exp_feedback 写一行：result / G_before / G_after', () => {
  const dir = tempDir()
  const tools = buildTools((definition) => definition, { dataDir: dir })
  const made = tool(tools, 'exp_record').execute({ intent: '测试反馈', action: '做法', outcome: 'success', type: '代码 / 插件' })
  tool(tools, 'exp_feedback').execute({ id: made.id, result: 'hurt' })
  const row = readUsage(dir).find((item) => item.tool === 'exp_feedback')
  assert.ok(row)
  assert.equal(row.result, 'hurt')
  assert.equal(row.G_before, 0.8)
  assert.ok(row.G_after < row.G_before)
})

check('exp_type 写一行：op / target', () => {
  const dir = tempDir()
  const tools = buildTools((definition) => definition, { dataDir: dir })
  tool(tools, 'exp_type').execute({ action: 'create', name: '新类型', description: '测试' })
  const row = readUsage(dir).find((item) => item.tool === 'exp_type')
  assert.ok(row)
  assert.equal(row.op, 'create')
  assert.equal(row.target, '新类型')
})

check('失败调用也留痕（ok:false + error），且原错误照常抛出', () => {
  const dir = tempDir()
  const tools = buildTools((definition) => definition, { dataDir: dir })
  assert.throws(() => tool(tools, 'exp_record').execute({ action: '没有意图', outcome: 'success' }))
  const rows = readUsage(dir)
  const failure = rows.find((row) => row.ok === false)
  assert.ok(failure, '失败调用应写一行')
  assert.equal(failure.tool, 'exp_record')
  assert.ok(typeof failure.error === 'string' && failure.error.length > 0)
})

check('usageLog:false 时完全不写（成功与失败都不写）', () => {
  const dir = tempDir()
  const tools = buildTools((definition) => definition, { dataDir: dir, usageLog: false })
  tool(tools, 'exp_record').execute({ intent: '静默测试', action: '做法', outcome: 'success' })
  assert.throws(() => tool(tools, 'exp_record').execute({ action: '坏调用' }))
  assert.equal(readUsage(dir).length, 0)
  assert.equal(fs.existsSync(path.join(dir, USAGE_FILE_NAME)), false)
})

check('intent 与 action 都截断到 120 字', () => {
  const dir = tempDir()
  const tools = buildTools((definition) => definition, { dataDir: dir })
  tool(tools, 'exp_record').execute({
    intent: `长意图 ${'很'.repeat(200)}`,
    action: `长做法 ${'长'.repeat(600)}`,
    outcome: 'success',
  })
  const row = readUsage(dir)[0]
  assert.equal(row.intent.length, 120)
  assert.equal(row.action.length, 120)
})

check('日志脱敏：家目录折叠、凭据样式打码', () => {
  const dir = tempDir()
  const tools = buildTools((definition) => definition, { dataDir: dir })
  const home = os.homedir()
  tool(tools, 'exp_record').execute({
    intent: `在 ${home}\\proj 里跑 token=sk-abc123456789 的脚本`,
    action: 'password=hunter2 这样写',
    outcome: 'success',
  })
  const row = readUsage(dir)[0]
  assert.ok(!row.intent.includes(home), '家目录应折叠成 ~')
  assert.ok(!row.intent.includes('sk-abc123456789'), `凭据原文不应落盘，got ${row.intent}`)
  assert.ok(row.intent.includes('token=***'), `key=value 样式应打码，got ${row.intent}`)
  assert.ok(!row.action.includes('hunter2'), 'password 值应打码')
})

check('轮转：产生 usage.jsonl.1；readUsage 跨文件读回，不会静默少计', () => {
  const dir = tempDir()
  const tools = buildTools((definition) => definition, { dataDir: dir, usageLogMaxBytes: 1024 })
  const record = tool(tools, 'exp_record')
  for (let i = 0; i < 30; i += 1) record.execute({ intent: `轮转测试 ${i}`, action: '做法', outcome: 'success' })
  assert.equal(fs.existsSync(path.join(dir, `${USAGE_FILE_NAME}.1`)), true, '应产生轮转文件')
  const currentLines = fs.readFileSync(path.join(dir, USAGE_FILE_NAME), 'utf8').trim().split('\n').length
  const rows = readUsage(dir, 500)
  assert.ok(rows.length > currentLines, `跨文件读回应多于当前文件（${rows.length} vs ${currentLines}）`)
  assert.ok(rows.length <= 30)
  for (const line of fs.readFileSync(path.join(dir, USAGE_FILE_NAME), 'utf8').trim().split('\n')) JSON.parse(line)
})

check('每行都是合法 JSON；行数随调用增长', () => {
  const dir = tempDir()
  const tools = buildTools((definition) => definition, { dataDir: dir })
  const record = tool(tools, 'exp_record')
  for (let i = 0; i < 5; i += 1) record.execute({ intent: `调用 ${i}`, action: '做法', outcome: 'success' })
  const rows = readUsage(dir, 500)
  assert.equal(rows.length, 5)
  const raw = fs.readFileSync(path.join(dir, USAGE_FILE_NAME), 'utf8').trim().split('\n')
  assert.equal(raw.length, 5)
  for (const line of raw) JSON.parse(line)
})

console.log('')
console.log(`结果：通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exit(1)
