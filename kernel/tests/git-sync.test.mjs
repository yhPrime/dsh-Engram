/**
 * Git 备份/同步（kernel/git-sync.js）：本地裸仓库当远端，全离线验证。
 *
 * 覆盖：参数校验、初始化、提交推送、无改动推送、状态、fast-forward 拉取、非快进拒绝。
 * Run: node kernel/tests/git-sync.test.mjs
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const gitSync = await import('../git-sync.js')
const { gitInit, gitPull, gitPush, gitStatus, validateBranch, validateRepoUrl } = gitSync

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-git-'))
const remote = path.join(root, 'remote.git')
const work = path.join(root, 'work')
const clone = path.join(root, 'clone')
fs.mkdirSync(work, { recursive: true })

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
git(root, ['init', '--bare', '-b', 'main', remote])

const config = {
  repoUrl: remote,
  branch: 'main',
  authorName: 'Engram Test',
  authorEmail: 'engram@test.local',
  autoBackupMinutes: 0,
}

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

await check('参数校验：分支名与远端地址', () => {
  assert.equal(validateBranch('main'), 'main')
  assert.throws(() => validateBranch('-bad'), /分支名不合法/)
  assert.throws(() => validateBranch('a..b'), /分支名不合法/)
  assert.equal(validateRepoUrl(remote), remote)
  assert.equal(validateRepoUrl('https://github.com/a/b.git'), 'https://github.com/a/b.git')
  assert.equal(validateRepoUrl('git@github.com:a/b.git'), 'git@github.com:a/b.git')
  assert.throws(() => validateRepoUrl('https://user:pass@github.com/a/b.git'), /不要写账号密码/)
  assert.throws(() => validateRepoUrl('ftp://x/y'), /只支持/)
})

await check('未初始化时状态：isRepo=false，但 configured=true', async () => {
  const status = await gitStatus(work, config)
  assert.equal(status.available, true)
  assert.equal(status.isRepo, false)
  assert.equal(status.configured, true)
  assert.equal(status.targetBranch, 'main')
})

await check('初始化：建仓库 + 设 origin', async () => {
  const result = await gitInit(work, config)
  assert.equal(result.ok, true)
  assert.equal(result.created, true)
  const status = await gitStatus(work, config)
  assert.equal(status.isRepo, true)
  assert.equal(status.remote, remote)
})

await check('推送：提交并推到远端，克隆能看到文件', async () => {
  fs.writeFileSync(path.join(work, 'exp-lib.json'), JSON.stringify({ version: 1, experiences: [{ id: 'ex_1' }] }), 'utf8')
  const push = await gitPush(work, config, { message: '测试备份' })
  assert.equal(push.ok, true)
  assert.equal(push.committed, true)
  assert.equal(push.pushed, true)
  assert.ok(push.commit.length >= 7)
  git(root, ['clone', '--quiet', remote, clone])
  const cloned = JSON.parse(fs.readFileSync(path.join(clone, 'exp-lib.json'), 'utf8'))
  assert.equal(cloned.experiences[0].id, 'ex_1')
  const log = git(clone, ['log', '-1', '--format=%an|%s']).trim()
  assert.equal(log, 'Engram Test|测试备份')
})

await check('无改动再推：committed=false，pushed=true，信息是「没有新的改动」', async () => {
  const push = await gitPush(work, config)
  assert.equal(push.ok, true)
  assert.equal(push.committed, false)
  assert.equal(push.pushed, true)
  assert.match(push.reason, /没有新的改动/)
})

await check('状态：干净、远程一致、有最近提交', async () => {
  const status = await gitStatus(work, config)
  assert.equal(status.isRepo, true)
  assert.equal(status.dirtyCount, 0)
  assert.equal(status.ahead, 0)
  assert.equal(status.behind, 0)
  assert.ok(status.lastCommitAt !== '')
  assert.equal(status.lastCommitSubject, '测试备份')
})

await check('fast-forward 拉取：远端新增文件能拉下来', async () => {
  fs.writeFileSync(path.join(clone, 'skills.md'), '技能目录', 'utf8')
  git(clone, ['add', '-A'])
  git(clone, ['-c', 'user.name=C', '-c', 'user.email=c@d', 'commit', '--quiet', '-m', 'another'])
  git(clone, ['push', '--quiet', 'origin', 'main'])
  const pull = await gitPull(work, config)
  assert.equal(pull.ok, true)
  assert.equal(fs.existsSync(path.join(work, 'skills.md')), true)
})

await check('非快进拉取：本地有独立提交时拒绝自动合并', async () => {
  fs.writeFileSync(path.join(clone, 'remote-only.md'), 'r', 'utf8')
  git(clone, ['add', '-A'])
  git(clone, ['-c', 'user.name=C', '-c', 'user.email=c@d', 'commit', '--quiet', '-m', 'remote side'])
  git(clone, ['push', '--quiet', 'origin', 'main'])
  // 本地只提交不推送（远端有新提交时推送本来就会被拒，这里直接造分叉）
  fs.writeFileSync(path.join(work, 'local-only.md'), 'l', 'utf8')
  git(work, ['add', '-A'])
  git(work, ['-c', 'user.name=L', '-c', 'user.email=l@d', 'commit', '--quiet', '-m', 'local side'])
  const pull = await gitPull(work, config)
  assert.equal(pull.ok, false)
  assert.match(pull.reason, /需要手动合并/)
})

await check('未初始化就推送：给出可操作的原因', async () => {
  const other = path.join(root, 'not-a-repo')
  fs.mkdirSync(other, { recursive: true })
  const result = await gitPush(other, config)
  assert.equal(result.ok, false)
  assert.match(result.reason, /还不是 git 仓库/)
})

fs.rmSync(root, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
