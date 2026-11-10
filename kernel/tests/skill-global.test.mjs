/**
 * 技能的「注册到全局 / 取消注册 / 忘记技能」：临时目录全离线验证。
 * Run: node kernel/tests/skill-global.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const skills = await import('../skills.js')
const { createSkill, forgetSkill, globalRegistrationOf, listSkills, readSkillBySlug, registerSkillGlobally, unregisterSkillFromDsh } = skills

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-global-'))
const dataDir = path.join(root, 'exp')
const globalRoot = path.join(root, 'dsh-home', 'skills')
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

createSkill(dataDir, { slug: 'global-demo', name: '全局演示', description: '测试', body: '# 何时用\n测试', typeName: '代码 / 插件' })

await check('注册到全局：DSH skills 目录里出现（链接或副本），meta 记下路径', () => {
  const out = registerSkillGlobally(dataDir, 'global-demo', { root: globalRoot })
  assert.equal(out.registered, true)
  assert.equal(out.targetDir, path.join(globalRoot, 'global-demo'))
  assert.ok(fs.existsSync(out.targetDir), '目标目录没建出来')
  assert.equal(fs.existsSync(path.join(out.targetDir, 'SKILL.md')), true)
  assert.ok(['junction', 'copy'].includes(out.mode))
  const meta = readSkillBySlug(dataDir, 'global-demo').meta
  assert.equal(meta.globalRegistered.path, out.targetDir)
  assert.equal(meta.globalRegistered.mode, out.mode)
})

await check('注册后经验库不再把它放进排序池（listSkills onlyLocal 过滤）', () => {
  const all = listSkills(dataDir)
  assert.equal(all.length, 1, '列表本身还要能看到它（控制台要显示并允许取消注册）')
  assert.equal(all[0].globalRegistered, undefined)
  assert.ok(globalRegistrationOf(all[0]) !== null, 'meta 里应该有注册记录')
  const local = listSkills(dataDir, { onlyLocal: true })
  assert.equal(local.length, 0, '注册过的技能不该再参与经验库排序/召回')
})

await check('重复注册幂等：不报错，仍指向同一个目标', () => {
  const again = registerSkillGlobally(dataDir, 'global-demo', { root: globalRoot })
  assert.equal(again.targetDir, path.join(globalRoot, 'global-demo'))
})

await check('取消注册：链接/副本被删、meta 清空、重新进入排序池', () => {
  const out = unregisterSkillFromDsh(dataDir, 'global-demo')
  assert.equal(out.registered, false)
  assert.equal(fs.existsSync(out.targetDir), false, '目标目录还在')
  assert.equal(readSkillBySlug(dataDir, 'global-demo').meta.globalRegistered, undefined)
  assert.equal(listSkills(dataDir, { onlyLocal: true }).length, 1)
})

await check('取消注册幂等：没注册过也不报错', () => {
  const out = unregisterSkillFromDsh(dataDir, 'global-demo')
  assert.equal(out.removed, false)
})

await check('目标被别的技能占用时拒绝注册（不覆盖别人的技能）', () => {
  fs.mkdirSync(path.join(globalRoot, 'global-demo'), { recursive: true })
  fs.writeFileSync(path.join(globalRoot, 'global-demo', 'SKILL.md'), '---\nname: 别人的\n---\n', 'utf8')
  assert.throws(() => registerSkillGlobally(dataDir, 'global-demo', { root: globalRoot }), /目标已被占用/)
  fs.rmSync(path.join(globalRoot, 'global-demo'), { recursive: true, force: true })
})

await check('junction 取消注册：链接真的被删掉（Windows 重解析点不能只靠 isSymbolicLink）', () => {
  createSkill(dataDir, { slug: 'junction-demo', name: '链接演示', description: '测试', body: '# 何时用\n测试', typeName: '代码 / 插件' })
  const linkRoot = path.join(root, 'junction-root')
  const out = registerSkillGlobally(dataDir, 'junction-demo', { root: linkRoot })
  assert.ok(fs.existsSync(out.targetDir), '链接没建出来')
  let isLink = false
  try {
    isLink = fs.lstatSync(out.targetDir).isSymbolicLink() || fs.readlinkSync(out.targetDir) !== ''
  } catch {
    isLink = false
  }
  assert.equal(isLink, true, '目标不是链接（注册时退成了复制）')
  // 库里再放一个脚本，专门验证「删链接不会顺着 junction 把目标内容删掉」
  fs.mkdirSync(path.join(dataDir, 'skills', 'junction-demo', 'scripts'), { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'skills', 'junction-demo', 'scripts', 'keep.py'), 'print(1)\n', 'utf8')
  const removed = unregisterSkillFromDsh(dataDir, 'junction-demo')
  assert.equal(removed.removed, true, '取消注册没真的删掉链接')
  assert.equal(fs.existsSync(out.targetDir), false, '链接还在')
  assert.equal(fs.existsSync(path.join(dataDir, 'skills', 'junction-demo', 'SKILL.md')), true, '库里的 SKILL.md 被删了')
  assert.equal(fs.existsSync(path.join(dataDir, 'skills', 'junction-demo', 'scripts', 'keep.py')), true, '库里的 scripts/ 被删了（递归删链接时跟进了目标）')
  forgetSkill(dataDir, 'junction-demo')
})

await check('忘记技能：删掉技能目录；注册着的先取消注册，不留悬空链接', () => {
  const out = registerSkillGlobally(dataDir, 'global-demo', { root: globalRoot })
  assert.ok(fs.existsSync(out.targetDir))
  const forgotten = forgetSkill(dataDir, 'global-demo')
  assert.equal(forgotten.deleted, true)
  assert.equal(fs.existsSync(path.join(dataDir, 'skills', 'global-demo')), false, '技能目录还在')
  assert.equal(fs.existsSync(out.targetDir), false, '全局注册的链接没清掉')
  assert.equal(listSkills(dataDir).length, 0)
})

fs.rmSync(root, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
