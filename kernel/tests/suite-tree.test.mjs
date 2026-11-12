/**
 * 套件树内核：路径 id、递归扫描、子树集合、子树注册/取消/删除、移出套件。
 * Run: node kernel/tests/suite-tree.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-suite-tree-home-'))
process.env.DSH_HOME = home

const skills = await import('../skills.js')
const {
  applySkillNodeAction,
  applySkillOutcome,
  assertSafeRelPath,
  buildSkillTree,
  createSkill,
  forgetSkillTree,
  listSkills,
  moveSkillToTop,
  readSkillBySlug,
  skillsRootOf,
  subtreeSkills,
  unregisterSkillTree,
} = skills

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-suite-tree-'))
const dataDir = path.join(root, 'exp')
const globalRoot = path.join(home, 'skills')

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
    console.log(`       ${error && error.stack ? error.stack : error}`)
  }
}

function make(id, name) {
  return createSkill(dataDir, {
    id,
    name,
    description: `${name} 描述`,
    body: `# 何时用\n${name}\n\n## 做法\n- 做${name}`,
    typeName: '代码 / 插件',
  })
}

make('suite-a/skill-1', '树甲')
make('suite-a/skill-2', '树乙')
make('suite-a/deep/skill-3', '树丙')
make('standalone', '独立')

check('扫描：子技能 id 是相对路径，树按目录聚合', () => {
  const rows = listSkills(dataDir)
  assert.equal(rows.length, 4)
  const ids = rows.map((row) => row.id).sort()
  assert.deepEqual(ids, ['standalone', 'suite-a/deep/skill-3', 'suite-a/skill-1', 'suite-a/skill-2'])
  const tree = buildSkillTree(rows)
  assert.equal(tree.length, 2)
  const suite = tree.find((node) => node.path === 'suite-a')
  assert.equal(suite.kind, 'group')
  assert.equal(suite.skillCount, 3)
  assert.equal(suite.childCount, 3)
  const deep = suite.children.find((node) => node.path === 'suite-a/deep')
  assert.equal(deep.kind, 'group')
  assert.equal(deep.skillCount, 1)
})

check('子树集合：父节点含全部后代，叶子只含自身', () => {
  const rows = listSkills(dataDir)
  assert.equal(subtreeSkills(rows, 'suite-a').length, 3)
  assert.equal(subtreeSkills(rows, 'suite-a/deep').length, 1)
  assert.equal(subtreeSkills(rows, 'standalone').length, 1)
})

check('路径校验：多段可用，穿越/绝对/反斜杠/保留名被拒', () => {
  assert.equal(assertSafeRelPath('套件 甲/子技能'), '套件 甲/子技能')
  for (const bad of ['../evil', 'a/../../evil', 'C:/evil', 'a\\b', '/abs', 'a//b', 'CON', 'name.', 'name ']) {
    assert.throws(() => assertSafeRelPath(bad), /./, `应拒绝：${bad}`)
  }
})

check('注册整棵子树：父节点一次带全部后代', () => {
  const out = applySkillNodeAction(dataDir, 'register', 'suite-a')
  assert.equal(out.total, 3)
  assert.equal(out.ok, 3)
  assert.deepEqual(out.failed, [])
  for (const leaf of ['skill-1', 'skill-2', 'skill-3']) {
    assert.equal(fs.existsSync(path.join(globalRoot, leaf, 'SKILL.md')), true, `${leaf} 没有注册到全局`)
  }
})

check('取消注册整棵子树', () => {
  const out = unregisterSkillTree(dataDir, 'suite-a')
  assert.equal(out.total, 3)
  assert.equal(out.ok, 3)
  for (const leaf of ['skill-1', 'skill-2', 'skill-3']) {
    assert.equal(fs.existsSync(path.join(globalRoot, leaf)), false, `${leaf} 的链接还在`)
  }
})

check('删除整棵子树：数量不符拒绝，匹配后连目录一起删', () => {
  assert.throws(() => forgetSkillTree(dataDir, 'suite-a', { expect: 2 }), /数量不匹配/)
  assert.throws(() => forgetSkillTree(dataDir, 'suite-a', {}), /expect/)
  const out = forgetSkillTree(dataDir, 'suite-a', { expect: 3 })
  assert.equal(out.deleted, true)
  assert.equal(out.total, 3)
  assert.equal(fs.existsSync(path.join(skillsRootOf(dataDir), 'suite-a')), false)
  assert.deepEqual(listSkills(dataDir).map((row) => row.id), ['standalone'])
})

check('移出套件：目录移到顶层，id 跟着变', () => {
  make('suite-b/child-b', '拖出')
  const moved = moveSkillToTop(dataDir, 'suite-b/child-b')
  assert.equal(moved.moved, true)
  assert.equal(moved.to, 'child-b')
  assert.ok(fs.existsSync(path.join(skillsRootOf(dataDir), 'child-b', 'SKILL.md')))
  assert.equal(readSkillBySlug(dataDir, 'child-b').id, 'child-b')
  const meta = JSON.parse(fs.readFileSync(path.join(skillsRootOf(dataDir), 'child-b', 'skill.json'), 'utf8'))
  assert.equal(meta.id, 'child-b')
})

check('移出套件：顶层同名直接拒绝，不覆盖', () => {
  make('suite-c/child-c', '冲突')
  make('child-c', '顶层占位')
  assert.throws(() => moveSkillToTop(dataDir, 'suite-c/child-c'), /同名/)
  assert.equal(fs.existsSync(path.join(skillsRootOf(dataDir), 'suite-c', 'child-c', 'SKILL.md')), true)
})

check('组节点没有技能时动作报错', () => {
  const emptyGroup = path.join(skillsRootOf(dataDir), 'not-a-skill')
  fs.mkdirSync(emptyGroup, { recursive: true })
  assert.throws(() => applySkillNodeAction(dataDir, 'register', 'not-a-skill'), /没有这个节点/)
})

check('applySkillNodeAction 拒绝未知动作', () => {
  assert.throws(() => applySkillNodeAction(dataDir, 'nope', 'standalone'), /不认识的节点动作/)
})

check('套件子技能反馈：id 不被打回叶子名，账本照常更新', () => {
  make('suite-d/child-d', '反馈')
  const out = applySkillOutcome(dataDir, 'suite-d/child-d', 'helped')
  assert.equal(out.action, 'feedback')
  const row = readSkillBySlug(dataDir, 'suite-d/child-d')
  assert.equal(row.id, 'suite-d/child-d')
  assert.equal(row.meta.id, 'suite-d/child-d')
  assert.equal(row.meta.confidence.uses, 1)
  assert.equal(row.meta.confidence.helped, 1)
})

fs.rmSync(root, { recursive: true, force: true })
fs.rmSync(home, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
