/**
 * core 边界测试（M1）
 *
 * 1. 导入图守卫：core.js 递归 import 只允许核心模块，禁止 provider/plugin/index 与 @deepseek-ai；
 * 2. 纯 Node 可用：core 在无 DSH 的情况下能加载，工具工厂能建出工具并完成一次记录/召回。
 *
 * Run: node tests/core-boundary.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const kernelDir = path.dirname(here)

let passed = 0
let failed = 0

async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}`)
    console.log(`       ${error && error.message ? error.message : error}`)
  }
}

const ALLOWED_CORE = new Set(['kernel.js', 'retrieval.js', 'cluster.js', 'store.js', 'skills.js', 'tools.js', 'settings.js', 'brief.js', 'session.js', 'token-budget.js'])
const FORBIDDEN_IMPORTS = ['@deepseek-ai/', './provider', './plugin', './index']

function importsOf(file) {
  const text = fs.readFileSync(file, 'utf8')
  const found = []
  for (const match of text.matchAll(/from\s+['"]([^'"]+)['"]/g)) found.push(match[1])
  for (const match of text.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) found.push(match[1])
  return { text, found }
}

function walk(file, seen) {
  const base = path.basename(file)
  if (seen.has(base)) return
  seen.add(base)
  const { found } = importsOf(file)
  for (const spec of found) {
    for (const bad of FORBIDDEN_IMPORTS) {
      assert.ok(!spec.includes(bad), `${base} 引用了禁止的模块：${spec}`)
    }
    if (spec.startsWith('@deepseek-ai/')) assert.fail(`${base} 引用了 DSH 包：${spec}`)
    if (spec.startsWith('node:')) continue
    if (!spec.startsWith('.')) continue
    const target = path.resolve(path.dirname(file), spec)
    const relativeBase = path.basename(target)
    assert.ok(ALLOWED_CORE.has(relativeBase), `core 不应依赖 ${relativeBase}（来自 ${base}）`)
    walk(target, seen)
  }
}

await check('导入图：core 只依赖核心模块，不含 DSH/provider', () => {
  const seen = new Set()
  walk(path.join(kernelDir, 'core.js'), seen)
  assert.ok(seen.size >= 3, `core 导入图过小：${[...seen].join(',')}`)
})

await check('core 可在纯 Node 下加载，稳定导出齐全', async () => {
  const core = await import('../core.js')
  for (const name of ['buildTools', 'readStore', 'writeStore', 'rankExperiences', 'createSkill', 'readSkill', 'validateSkill', 'matchSkill', 'renderHint']) {
    assert.equal(typeof core[name], 'function', `缺少导出：${name}`)
  }
})

await check('core 工具工厂：无 DSH 也能建出工具并记录/召回', async () => {
  const core = await import('../core.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-core-'))
  const tools = core.buildTools((definition) => definition, { dataDir: dir })
  const names = tools.map((tool) => tool.name).sort()
  assert.deepEqual(names, ['exp_consolidate', 'exp_feedback', 'exp_recall', 'exp_record', 'exp_skill_attach', 'exp_type'])
  const call = (name, args) => tools.find((tool) => tool.name === name).execute(args)
  const recorded = call('exp_record', { intent: '冒烟：给插件跑测试', action: '先跑 npm test', outcome: 'success', type: '代码 / 插件' })
  assert.equal(recorded.action, 'added')
  const recalled = call('exp_recall', { intent: '给插件跑测试' })
  assert.ok(recalled.candidates.length >= 1)
})

console.log('')
console.log(`结果：通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exit(1)
