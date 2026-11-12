/**
 * 技能沉淀带脚本（工具层）：exp_consolidate 的 body/files/install，exp_skill_attach。
 * Run: node kernel/tests/skill-attach-tools.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { buildTools } from '../tools.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-tools-skill-'))
const dataDir = path.join(root, 'exp')
fs.mkdirSync(dataDir, { recursive: true })
process.env.DSH_HOME = path.join(root, 'dsh-home')

const scriptA = path.join(root, 'submit.py')
fs.writeFileSync(scriptA, 'print("submit")\n', 'utf8')
const scriptB = path.join(root, 'check.sh')
fs.writeFileSync(scriptB, 'echo check\n', 'utf8')

const tools = buildTools((definition) => definition, { dataDir, maxTypes: 30 })
const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]))
const call = (name, args) => byName[name].execute(args)

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
    console.log(`       ${error && error.stack ? error.stack : error}`)
  }
}

await check('新工具已注册：exp_skill_attach', () => {
  assert.equal(typeof byName.exp_skill_attach, 'object')
  assert.equal(typeof byName.exp_skill_attach.execute, 'function')
})

// 播种同族经验：2 正 1 负，同一做法
const seed = [
  { intent: '向 awesome-dsh-plugin 提交收录 PR', action: '走 GitHub API 开 PR', outcome: 'success' },
  { intent: '向 awesome-dsh-plugin 提交收录 PR（第二次）', action: '走 GitHub API 开 PR', outcome: 'success' },
  { intent: '向 awesome-dsh-plugin 提交收录 PR 失败', action: '走 GitHub API 开 PR', outcome: 'failed' },
]
for (const item of seed) call('exp_record', { ...item, type: '代码 / 插件' })

await check('exp_consolidate：body 覆盖正文 + files 挂脚本，且不再往 DSH skills 装', () => {
  const customBody = '# 何时用\n用户要求把插件提交到插件市场时。\n\n## 做法\n1. 读 README\n2. 走 API 开 PR\n\n## 脚本\n见下方清单。'
  const result = call('exp_consolidate', {
    intent: '向 awesome-dsh-plugin 提交收录 PR',
    type: '插件市场收录申请测试',
    body: customBody,
    files: [scriptA],
    // 旧参数：现在应被忽略（技能只进经验库）
    install: true,
  })
  assert.equal(result.action, 'created')
  const slug = result.slug
  assert.deepEqual(result.files, ['scripts/submit.py'])
  assert.equal(result.installedPath, undefined, '不该再返回 installedPath')
  const dir = path.join(dataDir, 'skills', slug)
  const md = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8')
  assert.match(md, /读 README/)
  assert.match(md, /## 脚本/)
  assert.match(md, /scripts\/submit\.py/)
  assert.equal(fs.existsSync(path.join(dir, 'scripts', 'submit.py')), true)
  assert.equal(fs.existsSync(path.join(process.env.DSH_HOME, 'skills', slug)), false, '技能被复制进了 DSH skills 目录')
})

await check('exp_skill_attach：给已有技能追加脚本与正文', () => {
  const slug = call('exp_type', { action: 'list' }) && '插件市场收录申请测试'
  const result = call('exp_skill_attach', {
    slug,
    files: [scriptB],
    body: '# 何时用\n用户要求把插件提交到插件市场时。\n\n## 做法\n1. 读 README\n2. 走 API 开 PR\n\n## 补记\n先确认仓库满 1 天。',
  })
  assert.equal(result.action, 'attached')
  assert.equal(result.files.length, 2)
  const dir = path.join(dataDir, 'skills', slug)
  const md = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8')
  assert.match(md, /先确认仓库满 1 天/)
  assert.match(md, /scripts\/check\.sh/)
})

await check('exp_skill_attach：不存在的技能报错', () => {
  assert.throws(() => call('exp_skill_attach', { slug: 'no-such', files: [scriptA] }), /没有这个技能/)
})

fs.rmSync(root, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
