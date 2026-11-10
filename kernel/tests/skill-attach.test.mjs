/**
 * 技能附件（scripts/）与装成 DSH 真技能：临时目录全离线验证。
 * Run: node kernel/tests/skill-attach.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const skills = await import('../skills.js')
const { attachSkillFiles, createSkill, exportSkillToDsh, listSkills, readSkillBySlug, validateAllSkills } = skills

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-skill-'))
const dataDir = path.join(root, 'exp')
fs.mkdirSync(dataDir, { recursive: true })
process.env.DSH_HOME = path.join(root, 'dsh-home')

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

const scriptA = path.join(root, 'submit_pr.py')
fs.writeFileSync(scriptA, 'print("hello")\n', 'utf8')
const scriptB = path.join(root, 'helper.sh')
fs.writeFileSync(scriptB, 'echo hi\n', 'utf8')

await check('建技能：只有 SKILL.md + skill.json，没有 scripts', () => {
  const made = createSkill(dataDir, {
    slug: 'demo-skill',
    name: '演示技能',
    description: '验证附件管道',
    body: '# 何时用\n验证用。\n\n## 做法\n- 第一步',
    typeName: '代码 / 插件',
    triggers: ['demo'],
  })
  assert.equal(made.action, 'created')
  const dir = path.join(dataDir, 'skills', 'demo-skill')
  assert.deepEqual(fs.readdirSync(dir).sort(), ['SKILL.md', 'skill.json'])
})

await check('挂附件：复制到 scripts/，登记 files，SKILL.md 出现「## 脚本」', () => {
  const attached = attachSkillFiles(dataDir, 'demo-skill', [scriptA, scriptB])
  assert.equal(attached.added.length, 2)
  const dir = path.join(dataDir, 'skills', 'demo-skill')
  assert.equal(fs.existsSync(path.join(dir, 'scripts', 'submit_pr.py')), true)
  assert.equal(fs.existsSync(path.join(dir, 'scripts', 'helper.sh')), true)
  const md = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8')
  assert.match(md, /## 脚本/)
  assert.match(md, /scripts\/submit_pr\.py/)
  assert.match(md, /scripts\/helper\.sh/)
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'skill.json'), 'utf8'))
  assert.equal(meta.files.length, 2)
  assert.ok(meta.files.every((item) => typeof item.sha256 === 'string' && item.sha256.length === 64))
  assert.equal(validateAllSkills(dataDir).length, 0)
})

await check('重复挂同一个文件：就地更新，不重复登记', () => {
  attachSkillFiles(dataDir, 'demo-skill', [scriptA])
  const meta = readSkillBySlug(dataDir, 'demo-skill').meta
  assert.equal(meta.files.filter((item) => item.path === 'scripts/submit_pr.py').length, 1)
  assert.equal(meta.files.length, 2)
})

await check('附件缺失时 validate 会报出来', () => {
  const dir = path.join(dataDir, 'skills', 'demo-skill')
  fs.rmSync(path.join(dir, 'scripts', 'helper.sh'))
  const problems = validateAllSkills(dataDir)
  assert.equal(problems.length, 1)
  assert.match(problems[0].problems.join('；'), /附件缺失：scripts\/helper\.sh/)
})

await check('安全：路径穿越的 basename 被收敛，不写到技能目录外', () => {
  const evil = path.resolve(root, '..', 'evil.py')
  fs.writeFileSync(evil, 'bad\n', 'utf8')
  attachSkillFiles(dataDir, 'demo-skill', [evil])
  const dir = path.join(dataDir, 'skills', 'demo-skill')
  assert.equal(fs.existsSync(path.join(dir, 'scripts', 'evil.py')), true)
  assert.equal(fs.existsSync(path.join(dataDir, 'skills', 'evil.py')), false)
})

await check('超过 2MB 的附件被拒绝', () => {
  const big = path.join(root, 'big.bin')
  fs.writeFileSync(big, Buffer.alloc(2 * 1024 * 1024 + 1))
  assert.throws(() => attachSkillFiles(dataDir, 'demo-skill', [big]), /不能超过 2MB/)
})

await check('不存在的技能：明确报错', () => {
  assert.throws(() => attachSkillFiles(dataDir, 'no-such-skill', [scriptA]), /没有这个技能/)
})

await check('装成 DSH 技能：SKILL.md + scripts/ 复制到 $DSH_HOME/skills/<slug>/', () => {
  const exported = exportSkillToDsh(dataDir, 'demo-skill')
  assert.equal(exported.targetDir, path.join(process.env.DSH_HOME, 'skills', 'demo-skill'))
  const target = exported.targetDir
  assert.equal(fs.existsSync(path.join(target, 'SKILL.md')), true)
  assert.equal(fs.existsSync(path.join(target, 'scripts', 'submit_pr.py')), true)
  const meta = readSkillBySlug(dataDir, 'demo-skill').meta
  assert.equal(meta.installedPath, target)
  assert.ok(meta.installedAt)
})

fs.rmSync(root, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
