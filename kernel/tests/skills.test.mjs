/**
 * 技能沉淀测试（0.29.0）
 *
 * 覆盖：目录/双文件、.exp/.git 自动提交、高确定、召回匹配、
 * 按签名事件流（追加 / 连续 3 次覆盖归档 / 干净成功各记 clean / 复发重新累计）、
 * 例外上限 5、git 失败回退 pendingCommit。
 *
 * Run: node tests/skills.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import {
  applySkillObstacle,
  applySkillOutcome,
  createSkill,
  highConfidence,
  listSkills,
  matchSkill,
  readSkill,
  skillsRootOf,
  validateSkill,
  writeFileAtomic,
} from '../skills.js'

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

const newDataDir = () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-skills-'))
  return path.join(base, '.exp')
}

const draft = (over = {}) => ({
  name: 'PowerShell 脚本写入',
  description: '写 ps1 时用 UTF-8 BOM 与 CRLF，路径含空格要加引号，避免编码与换行错误',
  typeName: '环境 / 部署',
  context: ['windows', 'powershell'],
  triggers: ['ps1', '编码', 'crlf'],
  derivedFrom: ['ex_a', 'ex_b'],
  procedure: '- 保存为 UTF-8 with BOM\n- CRLF 换行',
  ...over,
})

const gitOk = (dataDir, args) => spawnSync('git', ['-C', dataDir, ...args], { stdio: 'ignore' }).status === 0
const lastCommit = (dataDir) => fs.readFileSync(path.join(dataDir, '.git', 'COMMIT_EDITMSG'), 'utf8').trim()
const logSubject = (dataDir) => lastCommit(dataDir)
const countBullets = (body, title) => {
  const lines = body.split(/\r?\n/)
  const idx = lines.findIndex((line) => line.trim() === `## ${title}`)
  if (idx < 0) return 0
  let count = 0
  for (let i = idx + 1; i < lines.length && !/^##\s/.test(lines[i]); i += 1) if (/^-\s/.test(lines[i])) count += 1
  return count
}

check('创建：目录 + SKILL.md（仅标准 frontmatter）+ skill.json + 首次 commit', () => {
  const dataDir = newDataDir()
  const made = createSkill(dataDir, draft())
  assert.equal(made.action, 'created')
  const dir = path.join(skillsRootOf(dataDir), made.slug)
  const md = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8')
  assert.ok(md.startsWith('---\nname: PowerShell 脚本写入'))
  const front = md.split('---')[1].trim().split(/\r?\n/)
  assert.deepEqual(front.map((line) => line.split(':')[0].trim()), ['name', 'description'])
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'skill.json'), 'utf8'))
  assert.equal(meta.confidence.uses, 0)
  assert.deepEqual(meta.context, ['windows', 'powershell'])
  assert.ok(fs.existsSync(path.join(dataDir, '.git')))
  assert.ok(logSubject(dataDir).includes(made.slug))
  assert.ok(gitOk(dataDir, ['diff', '--quiet']) && gitOk(dataDir, ['diff', '--cached', '--quiet']))
})

check('扫描：listSkills 只收有 SKILL.md 的目录，损坏目录跳过', () => {
  const dataDir = newDataDir()
  createSkill(dataDir, draft())
  createSkill(dataDir, draft({ name: 'Excel 报表', description: '表格清洗与公式', slug: 'excel-report' }))
  fs.mkdirSync(path.join(skillsRootOf(dataDir), 'broken-dir'), { recursive: true })
  const skills = listSkills(dataDir)
  assert.equal(skills.length, 2)
  assert.equal(readSkill(path.join(skillsRootOf(dataDir), 'broken-dir')), null)
})

check('高确定判定：helped 3 次为真；hurt 拉低比例后为假', () => {
  const dataDir = newDataDir()
  const { slug } = createSkill(dataDir, draft())
  for (let i = 0; i < 3; i += 1) applySkillOutcome(dataDir, slug, 'helped')
  let skill = readSkill(path.join(skillsRootOf(dataDir), slug))
  assert.equal(highConfidence(skill.meta), true)
  applySkillOutcome(dataDir, slug, 'hurt')
  applySkillOutcome(dataDir, slug, 'hurt')
  skill = readSkill(path.join(skillsRootOf(dataDir), slug))
  assert.equal(highConfidence(skill.meta), false)
})

check('召回匹配：高确定技能命中；非高确定不返回', () => {
  const dataDir = newDataDir()
  const made = createSkill(dataDir, draft())
  let skills = listSkills(dataDir)
  assert.equal(matchSkill(skills, '写 PowerShell 脚本 ps1 编码'), null, '未高确定前不返回')
  for (let i = 0; i < 3; i += 1) applySkillOutcome(dataDir, made.slug, 'helped')
  skills = listSkills(dataDir)
  const hit = matchSkill(skills, '写 PowerShell 脚本 ps1 编码')
  assert.ok(hit, '高确定后应命中')
  assert.equal(hit.skill.slug, made.slug)
})

check('情境不匹配：技能登记了 context 时，零交集不召回', () => {
  const dataDir = newDataDir()
  const made = createSkill(dataDir, draft({ context: ['课件'] }))
  for (let i = 0; i < 3; i += 1) applySkillOutcome(dataDir, made.slug, 'helped')
  const skills = listSkills(dataDir)
  assert.equal(matchSkill(skills, '写 PowerShell 脚本 ps1 编码', { context: ['课件'] }).skill.slug, made.slug)
  assert.equal(matchSkill(skills, '写 PowerShell 脚本 ps1 编码', { context: ['教案'] }), null, '零交集应跳过')
  assert.ok(matchSkill(skills, '写 PowerShell 脚本 ps1 编码') !== null, '不带情境时不硬拦')
})

check('第一次障碍：追加例外，total=1 streak=1，commit 记录', () => {
  const dataDir = newDataDir()
  const { slug } = createSkill(dataDir, draft())
  const out = applySkillObstacle(dataDir, slug, { blockedBy: 'PS 5.1: 中文乱码 C:\\x\\y.ps1 第 12 行', label: 'PS5.1 中文乱码' })
  assert.equal(out.action, 'appended')
  assert.equal(out.total, 1)
  assert.equal(out.streak, 1)
  const skill = readSkill(path.join(skillsRootOf(dataDir), slug))
  assert.equal(skill.meta.obstacles[out.signature].total, 1)
  assert.ok(skill.body.includes('## 常见例外'))
  assert.ok(skill.body.includes('PS5.1 中文乱码'))
  assert.ok(logSubject(dataDir).includes('追加例外'))
})

check('同一签名第二次：追加但只有一条例外（不重复）', () => {
  const dataDir = newDataDir()
  const { slug } = createSkill(dataDir, draft())
  const payload = { blockedBy: 'PS 5.1 中文乱码 第 12 行', label: 'PS5.1 中文乱码' }
  applySkillObstacle(dataDir, slug, payload)
  const out = applySkillObstacle(dataDir, slug, { blockedBy: 'PS 5.1 中文乱码 第 40 行', label: 'PS5.1 中文乱码' })
  assert.equal(out.total, 2)
  assert.equal(out.streak, 2)
  const skill = readSkill(path.join(skillsRootOf(dataDir), slug))
  const lines = skill.body.split(/\r?\n/).filter((line) => line.startsWith('- PS5.1 中文乱码'))
  assert.equal(lines.length, 1)
  assert.equal(countBullets(skill.body, '常见例外'), 1)
})

check('连续第 3 次：覆盖并归档，streak/total 清空、revisions=1', () => {
  const dataDir = newDataDir()
  const { slug } = createSkill(dataDir, draft())
  const payload = { blockedBy: 'PS 5.1 中文乱码 第 12 行', label: 'PS5.1 中文乱码' }
  applySkillObstacle(dataDir, slug, payload)
  applySkillObstacle(dataDir, slug, { ...payload, blockedBy: 'PS 5.1 中文乱码 第 13 行' })
  const out = applySkillObstacle(dataDir, slug, { ...payload, blockedBy: 'PS 5.1 中文乱码 第 14 行' })
  assert.equal(out.action, 'replaced')
  assert.equal(out.streak, 0)
  const skill = readSkill(path.join(skillsRootOf(dataDir), slug))
  assert.equal(skill.meta.revisions, 1)
  assert.equal(skill.meta.obstacles[out.signature], undefined)
  assert.equal(skill.meta.resolved.length, 1)
  assert.equal(skill.meta.resolved[0].total, 3)
  assert.ok(skill.body.includes('## 已内化'))
  assert.ok(skill.body.includes('PS5.1 中文乱码'))
  assert.ok(!skill.body.split(/\r?\n/).some((line) => line.startsWith('- PS5.1 中文乱码') && !skill.body.includes('已内化')))
  assert.ok(logSubject(dataDir).includes('覆盖并归档'))
})

check('A/B 交错：A 到 3 触发覆盖，B 的 streak 不被清零', () => {
  const dataDir = newDataDir()
  const { slug } = createSkill(dataDir, draft())
  const A = { blockedBy: 'utf8-bom：文件头 BOM 错误', label: 'utf8-bom' }
  const B = { blockedBy: 'crlf：换行被写成 LF', label: 'crlf' }
  applySkillObstacle(dataDir, slug, A)
  applySkillObstacle(dataDir, slug, B)
  applySkillObstacle(dataDir, slug, A)
  applySkillObstacle(dataDir, slug, B)
  const outA = applySkillObstacle(dataDir, slug, A)
  assert.equal(outA.action, 'replaced')
  const skill = readSkill(path.join(skillsRootOf(dataDir), slug))
  const signatures = Object.keys(skill.meta.obstacles)
  assert.equal(signatures.length, 1, '只应剩下 B 活跃')
  const bEntry = Object.values(skill.meta.obstacles)[0]
  assert.equal(bEntry.streak, 2)
  assert.equal(bEntry.total, 2)
})

check('干净成功：每个活跃签名各记 clean 并归零，total 不变', () => {
  const dataDir = newDataDir()
  const { slug } = createSkill(dataDir, draft())
  const A = { blockedBy: 'utf8-bom：BOM 错误', label: 'utf8-bom' }
  const B = { blockedBy: 'crlf：LF 错误', label: 'crlf' }
  applySkillObstacle(dataDir, slug, A)
  applySkillObstacle(dataDir, slug, B)
  const out = applySkillOutcome(dataDir, slug, 'helped')
  assert.equal(out.confident, false)
  const skill = readSkill(path.join(skillsRootOf(dataDir), slug))
  for (const entry of Object.values(skill.meta.obstacles)) {
    assert.equal(entry.streak, 0)
    assert.equal(entry.total, 1)
    assert.ok(entry.events.includes('clean'))
  }
})

check('归档后复发：从 1 重新累计，已内化移回例外', () => {
  const dataDir = newDataDir()
  const { slug } = createSkill(dataDir, draft())
  const payload = { blockedBy: 'utf8-bom：BOM 错误 第 1 行', label: 'utf8-bom' }
  applySkillObstacle(dataDir, slug, payload)
  applySkillObstacle(dataDir, slug, { ...payload, blockedBy: 'utf8-bom：BOM 错误 第 2 行' })
  applySkillObstacle(dataDir, slug, { ...payload, blockedBy: 'utf8-bom：BOM 错误 第 3 行' })
  const again = applySkillObstacle(dataDir, slug, { ...payload, blockedBy: 'utf8-bom：BOM 错误 第 4 行' })
  assert.equal(again.action, 'reopened')
  assert.equal(again.total, 1)
  assert.equal(again.streak, 1)
  const skill = readSkill(path.join(skillsRootOf(dataDir), slug))
  assert.equal(skill.meta.resolved.length, 0, '复发后应从 resolved 移除，避免与活跃重叠')
  assert.equal(Object.keys(skill.meta.obstacles).length, 1)
  assert.ok(!skill.body.includes('## 已内化'), '复发后不应残留空的已内化段')
  const exceptions = skill.body.split(/\r?\n/).filter((line) => line.startsWith('- utf8-bom'))
  assert.equal(exceptions.length, 1)
  const internalized = skill.body.split(/\r?\n/).filter((line) => line.startsWith('- utf8-bom') && line.includes('覆盖'))
  assert.equal(internalized.length, 0)
})

check('例外上限：6 个不同签名只保留 5 条，多出合并', () => {
  const dataDir = newDataDir()
  const { slug } = createSkill(dataDir, draft())
  for (let i = 1; i <= 6; i += 1) {
    applySkillObstacle(dataDir, slug, { blockedBy: `err-${i}：问题 ${i}`, label: `err-${i}` })
  }
  const skill = readSkill(path.join(skillsRootOf(dataDir), slug))
  assert.equal(countBullets(skill.body, '常见例外'), 5)
  assert.ok(skill.body.includes('其它历史例外'))
})

check('git 失败回退：文件仍写入，pendingCommit=true', () => {
  const dataDir = newDataDir()
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(path.join(dataDir, '.git'), 'not a repo', 'utf8')
  const made = createSkill(dataDir, draft())
  assert.equal(made.commit, false)
  const skill = readSkill(path.join(skillsRootOf(dataDir), made.slug))
  assert.ok(skill !== null)
  assert.equal(skill.meta.pendingCommit, true)
})

check('损坏的 skill.json：用默认值兜底，不崩', () => {
  const dataDir = newDataDir()
  const { slug } = createSkill(dataDir, draft())
  fs.writeFileSync(path.join(skillsRootOf(dataDir), slug, 'skill.json'), 'not-json{', 'utf8')
  const skill = readSkill(path.join(skillsRootOf(dataDir), slug))
  assert.ok(skill !== null)
  assert.equal(skill.meta.confidence.helped, 0)
  assert.equal(listSkills(dataDir).length, 1)
})

check('pendingCommit：失败后修复 git，下一次写入成功提交并清零标记', () => {
  const dataDir = newDataDir()
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(path.join(dataDir, '.git'), 'not a repo', 'utf8')
  const made = createSkill(dataDir, draft())
  assert.equal(made.commit, false)
  assert.equal(readSkill(path.join(skillsRootOf(dataDir), made.slug)).meta.pendingCommit, true)
  fs.rmSync(path.join(dataDir, '.git'), { force: true })
  const out = applySkillOutcome(dataDir, made.slug, 'helped')
  assert.equal(out.commit, true)
  assert.equal(readSkill(path.join(skillsRootOf(dataDir), made.slug)).meta.pendingCommit, false)
})

check('二次沉淀（updated）保留正文里的例外与已内化，不丢账本状态', () => {
  const dataDir = newDataDir()
  const first = createSkill(dataDir, draft())
  const payload = { blockedBy: 'utf8-bom：BOM 错误 第 1 行', label: 'utf8-bom' }
  applySkillObstacle(dataDir, first.slug, payload)
  applySkillObstacle(dataDir, first.slug, { ...payload, blockedBy: 'utf8-bom：BOM 错误 第 2 行' })
  const before = readSkill(path.join(skillsRootOf(dataDir), first.slug))
  assert.ok(before.body.includes('## 常见例外'))
  assert.ok(before.body.includes('utf8-bom'))
  createSkill(dataDir, draft({ description: 'PowerShell 脚本写入（更新过的描述）' }))
  const after = readSkill(path.join(skillsRootOf(dataDir), first.slug))
  assert.ok(after.body.includes('## 常见例外'), '更新定义不能丢掉常见例外')
  assert.ok(after.body.includes('utf8-bom'), '更新定义不能丢掉已记录的签名')
  assert.equal(Object.keys(after.meta.obstacles).length, 1)
})

check('歧义守卫：两个技能分数相近时不返回技能', () => {
  const dataDir = newDataDir()
  const first = createSkill(dataDir, draft({ slug: 'ps-a', name: 'PowerShell A' }))
  const second = createSkill(dataDir, draft({ slug: 'ps-b', name: 'PowerShell B' }))
  for (const slug of [first.slug, second.slug]) {
    for (let i = 0; i < 3; i += 1) applySkillOutcome(dataDir, slug, 'helped')
  }
  const skills = listSkills(dataDir)
  assert.equal(matchSkill(skills, 'PowerShell 脚本写入 ps1 编码 crlf'), null, '分数接近应放弃技能、退回经验')
  fs.rmSync(path.join(skillsRootOf(dataDir), second.slug), { recursive: true, force: true })
  const single = matchSkill(listSkills(dataDir), 'PowerShell 脚本写入 ps1 编码 crlf')
  assert.ok(single !== null)
  assert.equal(single.skill.slug, first.slug)
})

check('validateSkill：total<streak / 归档与活跃重叠会被报出', () => {
  const dataDir = newDataDir()
  const made = createSkill(dataDir, draft())
  const dir = path.join(skillsRootOf(dataDir), made.slug)
  const metaFile = path.join(dir, 'skill.json')
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'))
  meta.obstacles = { 'bad-sig': { total: 1, streak: 5, events: ['hit'], lastAt: new Date().toISOString(), label: 'bad' } }
  meta.resolved = [{ signature: 'bad-sig', total: 3, revisions: 1, archivedAt: new Date().toISOString() }]
  fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2), 'utf8')
  const skill = readSkill(dir)
  const problems = validateSkill(skill)
  assert.ok(problems.some((item) => item.includes('total < streak')))
  assert.ok(problems.some((item) => item.includes('同时活跃与归档')))
})

check('并发锁：锁被占用时返回 busy，释放后成功', () => {
  const dataDir = newDataDir()
  const { slug } = createSkill(dataDir, draft())
  const lockDir = path.join(dataDir, '.locks')
  fs.mkdirSync(lockDir, { recursive: true })
  const lockFile = path.join(lockDir, `${slug}.lock`)
  fs.writeFileSync(lockFile, 'other', 'utf8')
  const busy = applySkillOutcome(dataDir, slug, 'helped', { timeoutMs: 100 })
  assert.equal(busy.action, 'busy')
  fs.rmSync(lockFile, { force: true })
  const ok = applySkillOutcome(dataDir, slug, 'helped', { timeoutMs: 500 })
  assert.equal(ok.action, 'feedback')
  assert.equal(fs.existsSync(lockFile), false, '成功路径必须释放锁')
})

check('并发锁：陈旧锁自动清理（mtime 超过 staleMs）', () => {
  const dataDir = newDataDir()
  const { slug } = createSkill(dataDir, draft())
  const lockDir = path.join(dataDir, '.locks')
  fs.mkdirSync(lockDir, { recursive: true })
  const lockFile = path.join(lockDir, `${slug}.lock`)
  fs.writeFileSync(lockFile, 'stale', 'utf8')
  const old = new Date(Date.now() - 60_000)
  fs.utimesSync(lockFile, old, old)
  const out = applySkillOutcome(dataDir, slug, 'helped', { timeoutMs: 500, staleMs: 5000 })
  assert.equal(out.action, 'feedback')
  assert.equal(fs.existsSync(lockFile), false)
})

check('路径校验：穿越/绝对路径/保留名/超长/尾点被拒，套件子路径可用', () => {
  const dataDir = newDataDir()
  for (const bad of ['../evil', '..\\evil', 'C:evil', 'CON', 'con', 'x'.repeat(101), 'name.', 'name ']) {
    assert.throws(() => createSkill(dataDir, draft({ slug: bad })), /./, `应拒绝：${bad}`)
  }
  assert.equal(listSkills(dataDir).length, 0)
  assert.ok(!fs.existsSync(path.join(path.dirname(dataDir), 'evil')))
  // 套件子技能：`套件/子技能` 是合法 id，目录嵌一层。
  const nested = createSkill(dataDir, draft({ slug: 'demo-suite/child-skill' }))
  assert.equal(nested.slug, 'demo-suite/child-skill')
  assert.ok(fs.existsSync(path.join(skillsRootOf(dataDir), 'demo-suite', 'child-skill', 'SKILL.md')))
  const rows = listSkills(dataDir)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, 'demo-suite/child-skill')
  assert.equal(rows[0].parentPath, 'demo-suite')
  assert.equal(rows[0].depth, 1)
})

check('符号链接技能目录：读取跳过、写入拒绝', () => {
  const dataDir = newDataDir()
  const root = skillsRootOf(dataDir)
  fs.mkdirSync(root, { recursive: true })
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-link-'))
  fs.writeFileSync(path.join(outside, 'SKILL.md'), '---\nname: linked\ndescription: x\n---\n\n## 做法\n- x\n')
  const link = path.join(root, 'linked')
  try {
    fs.symlinkSync(outside, link, 'junction')
  } catch {
    return // 环境不允许建链接：跳过
  }
  assert.equal(listSkills(dataDir).length, 0)
  assert.equal(applySkillObstacle(dataDir, 'linked', { blockedBy: 'err' }).action, 'invalid')
  assert.throws(() => createSkill(dataDir, draft({ slug: 'linked' })))
})

check('原子写：成功不留 tmp；rename 失败保留旧文件并清理 tmp', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-atomic-'))
  const file = path.join(dir, 'a.txt')
  writeFileAtomic(file, 'v1')
  assert.equal(fs.readFileSync(file, 'utf8'), 'v1')
  assert.equal(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')).length, 0)
  const originalRename = fs.renameSync
  fs.renameSync = () => { throw new Error('boom') }
  try {
    assert.throws(() => writeFileAtomic(file, 'v2'))
  } finally {
    fs.renameSync = originalRename
  }
  assert.equal(fs.readFileSync(file, 'utf8'), 'v1', '失败不能破坏旧文件')
  assert.equal(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')).length, 0, '失败要清 tmp')
})

check('git 只提交 skills 路径：用户已 staged 的无关文件不进提交', () => {
  const dataDir = newDataDir()
  createSkill(dataDir, draft())
  fs.writeFileSync(path.join(dataDir, 'unrelated.txt'), 'x', 'utf8')
  spawnSync('git', ['-C', dataDir, 'add', 'unrelated.txt'], { stdio: 'ignore' })
  createSkill(dataDir, draft({ description: 'PowerShell 脚本写入（更新定义）' }))
  const readGit = (args) => {
    const outFile = path.join(os.tmpdir(), `gitout-${Date.now()}-${Math.random()}.txt`)
    const fd = fs.openSync(outFile, 'w')
    try {
      spawnSync('git', ['-C', dataDir, ...args], { stdio: ['ignore', fd, 'ignore'] })
    } finally {
      fs.closeSync(fd)
    }
    const text = fs.readFileSync(outFile, 'utf8')
    fs.rmSync(outFile, { force: true })
    return text
  }
  const names = readGit(['-c', 'core.quotePath=false', 'show', '--name-only', '--pretty=format:', 'HEAD']).split(/\r?\n/).filter(Boolean)
  assert.ok(names.length > 0)
  assert.ok(names.every((name) => name.startsWith('skills/')), names.join(','))
  assert.ok(!names.includes('unrelated.txt'), '无关文件不能被提交')
  const status = readGit(['status', '--porcelain'])
  assert.ok(status.includes('unrelated.txt'), '无关文件应仍留在工作区/暂存区')
})

console.log('')
console.log(`结果：通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exit(1)
