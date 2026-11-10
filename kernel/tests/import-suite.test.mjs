/**
 * 技能套件导入：一个文件夹里多个子技能 + 多分类/便签。
 * Run: node kernel/tests/import-suite.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const mod = await import('../import-skill.js')
const { importSkills, readImportSources } = mod
const skills = await import('../skills.js')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-suite-'))
const dataDir = path.join(root, 'exp')
const suite = path.join(root, 'my-suite')
fs.mkdirSync(path.join(suite, 'alpha'), { recursive: true })
fs.mkdirSync(path.join(suite, 'beta'), { recursive: true })
fs.mkdirSync(path.join(suite, 'empty-dir'), { recursive: true })
fs.writeFileSync(path.join(suite, 'alpha', 'SKILL.md'), '---\nname: 套件甲\ndescription: 甲\n---\n\n# 甲\n正文甲\n', 'utf8')
fs.writeFileSync(path.join(suite, 'beta', 'SKILL.md'), '---\nname: 套件乙\ndescription: 乙\n---\n\n# 乙\n正文乙\n', 'utf8')

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

await check('套件文件夹：根上没有 SKILL.md 时按子目录各取一条', () => {
  const sources = readImportSources({ filePath: suite })
  assert.equal(sources.length, 2, '子目录里的 SKILL.md 没被收齐')
  const names = sources.map((item) => item.text.includes('套件甲') ? '甲' : '乙').sort()
  assert.deepEqual([...names], ['乙', '甲'])
})

await check('根上有 SKILL.md 且子目录也各自有：按「总入口 + 子技能」一起导入', () => {
  const withRoot = path.join(root, 'with-root')
  fs.mkdirSync(path.join(withRoot, 'child-a'), { recursive: true })
  fs.mkdirSync(path.join(withRoot, 'child-b'), { recursive: true })
  fs.writeFileSync(path.join(withRoot, 'SKILL.md'), '---\nname: 套件总入口\ndescription: 入口\n---\n\n# 入口\n', 'utf8')
  fs.writeFileSync(path.join(withRoot, 'child-a', 'SKILL.md'), '---\nname: 子技能甲\ndescription: 甲\n---\n\n# 甲\n', 'utf8')
  fs.writeFileSync(path.join(withRoot, 'child-b', 'SKILL.md'), '---\nname: 子技能乙\ndescription: 乙\n---\n\n# 乙\n', 'utf8')
  const sources = readImportSources({ filePath: withRoot })
  assert.equal(sources.length, 3, `总入口 + 两个子技能应得 3 条，实际 ${sources.length}`)
})

await check('套件文件夹：一个 SKILL.md 都没有时报清楚', () => {
  const empty = path.join(root, 'nothing')
  fs.mkdirSync(path.join(empty, 'scripts'), { recursive: true })
  assert.throws(() => readImportSources({ filePath: empty }), /技能套件要求每个技能一个子目录/)
})

await check('importSkills：套件逐个入库，分类与便签写到每个技能上', async () => {
  const out = await importSkills({ dataDir, filePath: suite, categories: ['套件分类', '第二分类'], notes: ['便签一'] })
  assert.equal(out.suite, true)
  assert.equal(out.count, 2)
  assert.equal(out.items.length, 2)
  const listed = skills.listSkills(dataDir)
  assert.equal(listed.length, 2, '技能没入库')
  for (const skill of listed) {
    assert.deepEqual([...skill.meta.typeNames], ['套件分类', '第二分类'])
    assert.deepEqual([...skill.meta.notes], ['便签一'])
  }
})

await check('单个技能文件夹仍按一条导入（不是套件）', async () => {
  const single = path.join(root, 'single-skill')
  fs.mkdirSync(single, { recursive: true })
  fs.writeFileSync(path.join(single, 'SKILL.md'), '---\nname: 单体技能\ndescription: 单体\n---\n\n# 单体\n正文\n', 'utf8')
  const out = await importSkills({ dataDir, filePath: single })
  assert.equal(out.suite, false)
  assert.equal(out.count, 1)
})

await check('整包导入：scripts/references 等随 SKILL.md 一起复制，并记 package 摘要', async () => {
  const pkg = path.join(root, 'pkg-skill')
  fs.mkdirSync(path.join(pkg, 'scripts'), { recursive: true })
  fs.mkdirSync(path.join(pkg, 'references'), { recursive: true })
  fs.writeFileSync(path.join(pkg, 'SKILL.md'), '---\nname: 整包技能\ndescription: 包\n---\n\n# 包\n正文\n', 'utf8')
  fs.writeFileSync(path.join(pkg, 'scripts', 'run.py'), 'print(1)\n', 'utf8')
  fs.writeFileSync(path.join(pkg, 'references', 'notes.md'), '# notes\n', 'utf8')
  fs.writeFileSync(path.join(pkg, 'requirements.txt'), 'requests\n', 'utf8')
  const out = await importSkills({ dataDir, filePath: pkg })
  assert.equal(out.suite, false)
  const item = out.items[0]
  assert.ok(item.package && item.package.fileCount >= 4, `整包复制太少：${JSON.stringify(item.package)}`)
  const dir = path.join(dataDir, 'skills', item.slug)
  assert.equal(fs.existsSync(path.join(dir, 'scripts', 'run.py')), true, 'scripts 没复制')
  assert.equal(fs.existsSync(path.join(dir, 'references', 'notes.md')), true, 'references 没复制')
  assert.equal(fs.existsSync(path.join(dir, 'requirements.txt')), true, '根目录文件没复制')
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'skill.json'), 'utf8'))
  assert.ok(Array.isArray(meta.files) && meta.files.some((file) => file.path === 'scripts/run.py'), 'scripts 没登记到 files')
  assert.ok(meta.package.dirs.includes('references'), 'package.dirs 没记 references')
})

await check('updateSkillMeta：改分类/便签并落盘', () => {
  const slug = skills.listSkills(dataDir)[0].slug
  const out = skills.updateSkillMeta(dataDir, slug, { typeNames: ['改后分类'], notes: ['新便签', '第二条'] })
  assert.deepEqual([...out.typeNames], ['改后分类'])
  assert.deepEqual([...out.notes], ['新便签', '第二条'])
  const again = skills.readSkillBySlug(dataDir, slug)
  assert.deepEqual([...again.meta.typeNames], ['改后分类'])
  assert.deepEqual([...again.meta.notes], ['新便签', '第二条'])
})

fs.rmSync(root, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
