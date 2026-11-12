/**
 * 技能 git 回归（0.13.0，技能复验发现）：
 *  - 残留 index.lock 的清理路径必须是 dataDir/.git/index.lock（仓库根），不是 skills/.git；
 *  - 残留判定要够「老」（>10 分钟），活锁不能删（长提交可能持锁几分钟）；
 *  - attach / updateSkillMeta 成功后 pendingCommit 必须复位，且复位要进提交快照。
 *
 * Run: node tests/skill-git-lock.test.mjs
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { attachSkillFiles, commitSkills, createSkill, ensureSkillsRepo, readSkillBySlug, updateSkillMeta } from '../skills.js'

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

const fresh = () => fs.mkdtempSync(path.join(os.tmpdir(), 'engram-skillgit-'))

/** 读 git HEAD 里的文件（沙箱里 pipe 会 EPERM，落临时文件再读）。 */
function gitShow(cwd, relPath) {
  const tmp = path.join(os.tmpdir(), `engram-skillgit-show-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`)
  const fd = fs.openSync(tmp, 'w')
  try {
    execFileSync('git', ['-C', cwd, 'show', `HEAD:${relPath}`], { stdio: ['ignore', fd, 'ignore'], timeout: 30000, windowsHide: true })
  } finally {
    fs.closeSync(fd)
  }
  try {
    return fs.readFileSync(tmp, 'utf8')
  } finally {
    try {
      fs.unlinkSync(tmp)
    } catch {
      // 临时文件已删
    }
  }
}

check('残留 index.lock（>10 分钟）清在 dataDir/.git，提交成功', () => {
  const dir = fresh()
  ensureSkillsRepo(dir)
  const lock = path.join(dir, '.git', 'index.lock')
  fs.writeFileSync(lock, 'stale', 'utf8')
  const old = new Date(Date.now() - 11 * 60 * 1000)
  fs.utimesSync(lock, old, old)
  const committed = commitSkills(dir, 'test: stale lock')
  assert.equal(committed, true)
  assert.equal(fs.existsSync(lock), false, '残留锁应被清掉')
})

check('活锁（刚刚创建）不删，提交失败但不破坏锁', () => {
  const dir = fresh()
  const skill = createSkill(dir, { slug: 'alive-test', name: 'alive-test', description: '活锁测试', body: '# t' })
  // 造出真实变更，逼 commitSkills 真的去 add/commit（无变更时它会短路返回 true，测不到锁）。
  fs.writeFileSync(path.join(skill.dir, 'note.txt'), 'change\n', 'utf8')
  const lock = path.join(dir, '.git', 'index.lock')
  fs.writeFileSync(lock, 'alive', 'utf8')
  const committed = commitSkills(dir, 'test: alive lock')
  assert.equal(committed, false)
  assert.equal(fs.existsSync(lock), true, '活锁不能被当成残留删掉')
  fs.unlinkSync(lock)
  assert.ok(fs.existsSync(path.join(skill.dir, 'SKILL.md')))
})

check('attach 成功后 pendingCommit=false 且写进 HEAD 快照', () => {
  const dir = fresh()
  const skill = createSkill(dir, { slug: 'attach-test', name: 'attach-test', description: '测试 attach 复位', body: '# t' })
  const metaFile = path.join(skill.dir, 'skill.json')
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'))
  meta.pendingCommit = true
  fs.writeFileSync(metaFile, JSON.stringify(meta), 'utf8')

  const source = path.join(dir, 'mirror.py')
  fs.writeFileSync(source, 'print("hi")\n', 'utf8')
  const out = attachSkillFiles(dir, 'attach-test', [source])
  assert.equal(out.commit, true)
  assert.equal(readSkillBySlug(dir, 'attach-test').meta.pendingCommit, false, '磁盘上必须复位')
  const head = JSON.parse(gitShow(dir, 'skills/attach-test/skill.json'))
  assert.equal(head.pendingCommit, false, 'HEAD 快照里也必须是 false')
})

check('updateSkillMeta 成功后 pendingCommit 复位', () => {
  const dir = fresh()
  const skill = createSkill(dir, { slug: 'meta-test', name: 'meta-test', description: '测试 meta 复位', body: '# t' })
  const metaFile = path.join(skill.dir, 'skill.json')
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'))
  meta.pendingCommit = true
  fs.writeFileSync(metaFile, JSON.stringify(meta), 'utf8')
  const out = updateSkillMeta(dir, 'meta-test', { notes: ['一条便签'] })
  assert.equal(out.commit, true)
  assert.equal(readSkillBySlug(dir, 'meta-test').meta.pendingCommit, false)
  const head = JSON.parse(gitShow(dir, 'skills/meta-test/skill.json'))
  assert.equal(head.pendingCommit, false)
})

check('同内容再次 attach：无变更短路，commit=true 且 pending=false', () => {
  const dir = fresh()
  const skill = createSkill(dir, { slug: 'same-test', name: 'same-test', description: '同内容测试', body: '# t' })
  const source = path.join(dir, 'same.py')
  fs.writeFileSync(source, 'print(1)\n', 'utf8')
  const first = attachSkillFiles(dir, 'same-test', [source])
  const second = attachSkillFiles(dir, 'same-test', [source])
  assert.equal(first.commit, true)
  assert.equal(second.commit, true, '没有变更也不该报提交失败')
  assert.equal(readSkillBySlug(dir, 'same-test').meta.pendingCommit, false)
})
console.log('')
console.log(`结果：通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exit(1)
