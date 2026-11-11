/**
 * 技能 git 回归（0.13.0，技能复验发现）：
 *  - 残留 index.lock 的清理路径必须是 dataDir/.git/index.lock（仓库根），不是 skills/.git；
 *  - attach 成功后必须把 pendingCommit 复位（否则 pendingSkills 永远报 1）。
 *
 * Run: node tests/skill-git-lock.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { attachSkillFiles, commitSkills, createSkill, ensureSkillsRepo, readSkillBySlug } from '../skills.js'

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

check('残留 index.lock 清在 dataDir/.git（不是 skills/.git）', () => {
  const dir = fresh()
  ensureSkillsRepo(dir)
  const lock = path.join(dir, '.git', 'index.lock')
  fs.writeFileSync(lock, 'stale', 'utf8')
  const old = new Date(Date.now() - 5 * 60 * 1000)
  fs.utimesSync(lock, old, old)
  const committed = commitSkills(dir, 'test: stale lock')
  assert.equal(committed, true)
  assert.equal(fs.existsSync(lock), false, '残留锁应被清掉')
})

check('attach 成功后退回 pendingCommit=false', () => {
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
  const after = readSkillBySlug(dir, 'attach-test')
  assert.equal(after.meta.pendingCommit, false, 'attach 成功后 pendingCommit 必须复位')
  assert.ok((after.meta.files || []).some((item) => item.path === 'scripts/mirror.py'))
})

console.log('')
console.log(`结果：通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exit(1)
