/**
 * engine headless 测试（M2）
 *
 * 不加载 Provider/插件，只 import engine.js，在临时目录跑完整经验循环：
 * 记录 → 召回 → 反馈 → 沉淀技能 → 采用 → 遇阻覆盖 → hurt 降级 → validate。
 *
 * Run: node tests/engine-headless.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createEngine } from '../engine.js'

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

const newEngine = () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-engine-'))
  return createEngine({ dataDir: path.join(base, '.exp') })
}

function seed(engine) {
  const type = 'PPT / 课件'
  const taskId = 'task-engine-m2'
  engine.record({ intent: '给 PPT 插页：第一步', action: '先克隆相邻页再改字', outcome: 'success', type, taskId, kind: 'step', stepIndex: 1, stepTotal: 3 })
  engine.record({ intent: '给 PPT 插页：第二步', action: '先克隆相邻页再重画', outcome: 'success', type, taskId, kind: 'step', stepIndex: 2, stepTotal: 3 })
  engine.record({ intent: '给 PPT 插页：第三步', action: '直接套模板不做克隆', outcome: 'failed', type, taskId, kind: 'step', stepIndex: 3, stepTotal: 3 })
}

await check('createEngine：缺 dataDir 直接报错', () => {
  assert.throws(() => createEngine({}), /dataDir/)
  assert.throws(() => createEngine(), /dataDir/)
})

await check('engine 暴露稳定方法，不依赖 DSH', () => {
  const engine = newEngine()
  for (const name of ['record', 'recall', 'feedback', 'consolidate', 'types', 'listSkills', 'readSkill', 'validate', 'hint', 'tools']) {
    assert.equal(typeof engine[name], 'function', `缺少方法：${name}`)
  }
  assert.deepEqual(engine.tools().sort(), ['exp_consolidate', 'exp_feedback', 'exp_recall', 'exp_record', 'exp_skill_attach', 'exp_type'])
  assert.ok(engine.hint().includes('exp_recall'))
})

await check('headless 全链路：记录 → 沉淀 → 采用 → 遇阻覆盖 → hurt 降级', () => {
  const engine = newEngine()
  seed(engine)
  const made = engine.consolidate({ intent: '给 PPT 插页' })
  assert.equal(made.action, 'created')
  assert.equal(engine.listSkills().length, 1)
  for (let i = 0; i < 3; i += 1) engine.feedback({ id: `skill:${made.slug}`, result: 'helped' })
  const hit = engine.recall({ intent: '给 PPT 插页' })
  assert.equal(hit.mode, 'skill')
  assert.equal(hit.candidates.length, 0)

  let last = null
  for (let i = 0; i < 3; i += 1) {
    last = engine.record({
      intent: '给 PPT 插页', action: '按技能做', outcome: 'failed', type: 'PPT / 课件',
      skillId: `skill:${made.slug}`, blockedBy: '页脚错位 第 3 行',
    })
  }
  assert.equal(last.skill.action, 'replaced')
  const skill = engine.readSkill(made.slug)
  assert.ok(skill.meta.revisions >= 1)
  assert.deepEqual(engine.validate(), [])

  for (let i = 0; i < 2; i += 1) engine.feedback({ id: `skill:${made.slug}`, result: 'hurt' })
  assert.notEqual(engine.recall({ intent: '给 PPT 插页' }).mode, 'skill')
})

await check('engine 导入图：不含 provider/plugin/index/@deepseek-ai', () => {
  const text = fs.readFileSync(path.join(kernelDir, 'engine.js'), 'utf8')
  for (const bad of ['provider.js', 'plugin.js', 'index.js', '@deepseek-ai/']) {
    assert.ok(!text.includes(bad), `engine.js 出现 ${bad}`)
  }
  for (const match of text.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
    assert.ok(!match[1].includes('provider') && !match[1].includes('plugin') && !match[1].includes('index'), match[1])
  }
})

console.log('')
console.log(`结果：通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exit(1)
