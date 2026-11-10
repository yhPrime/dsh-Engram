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

await check('本地分支 master、配置分支 main：推 HEAD，不报 src refspec does not match any', async () => {
  const bare = path.join(root, 'fresh-remote.git')
  git(root, ['init', '--bare', '-b', 'main', bare])
  const dir = path.join(root, 'legacy-work')
  fs.mkdirSync(dir, { recursive: true })
  git(dir, ['init', '-b', 'master'])
  git(dir, ['config', 'user.name', 'Legacy'])
  git(dir, ['config', 'user.email', 'legacy@test.local'])
  fs.writeFileSync(path.join(dir, 'exp-lib.json'), '{"version":1}\n', 'utf8')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', 'init'])
  // 真实流程：新建仓库后先 init（把 origin 指到新仓库、分支名用配置里的 main），再 push
  const init = await gitInit(dir, { ...config, repoUrl: bare, branch: 'main' })
  assert.equal(init.ok, true, init.reason)
  const result = await gitPush(dir, { ...config, repoUrl: bare, branch: 'main' })
  assert.equal(result.ok, true, result.reason)
  assert.equal(result.pushed, true)
  assert.equal(result.remoteBranch, 'main')
  // 远端确实收到了 main 分支，并且本地分支建立了上游
  const sha = git(bare, ['rev-parse', 'refs/heads/main']).trim()
  assert.match(sha, /^[0-9a-f]{40}$/u)
  const upstream = git(dir, ['rev-parse', '--abbrev-ref', 'master@{upstream}']).trim()
  assert.equal(upstream, 'origin/main')
})

await check('推送策略：默认本地覆盖云端（强推 + 备份旧远端 HEAD）；可选只允许快进', async () => {
  const bare = path.join(root, 'strategy-remote.git')
  git(root, ['init', '--bare', '-b', 'main', bare])
  const mine = path.join(root, 'strategy-mine')
  fs.mkdirSync(mine, { recursive: true })
  git(mine, ['init', '-b', 'main'])
  git(mine, ['config', 'user.name', 'Mine'])
  git(mine, ['config', 'user.email', 'mine@test.local'])
  fs.writeFileSync(path.join(mine, 'exp-lib.json'), '{"v":1}\n', 'utf8')
  git(mine, ['add', '-A'])
  git(mine, ['commit', '-q', '-m', 'v1'])
  const base = { repoUrl: bare, branch: 'main' }
  const init = await gitInit(mine, { ...base, pushStrategy: 'overwrite' })
  assert.equal(init.ok, true, init.reason)
  const first = await gitPush(mine, { ...base, pushStrategy: 'overwrite' })
  assert.equal(first.ok, true, first.reason)

  // 另一台设备推了一条，云端领先本地
  const other = path.join(root, 'strategy-other')
  git(root, ['clone', '-q', bare, other])
  git(other, ['config', 'user.name', 'Other'])
  git(other, ['config', 'user.email', 'other@test.local'])
  fs.writeFileSync(path.join(other, 'from-other.txt'), 'other\n', 'utf8')
  git(other, ['add', '-A'])
  git(other, ['commit', '-q', '-m', 'other commit'])
  git(other, ['push', '-q', 'origin', 'main'])
  const otherHead = git(other, ['rev-parse', 'HEAD']).trim()

  // 本地又加了一条（与云端分叉）
  fs.writeFileSync(path.join(mine, 'local.txt'), 'local\n', 'utf8')
  git(mine, ['add', '-A'])
  git(mine, ['commit', '-q', '-m', 'local commit'])
  const myHead = git(mine, ['rev-parse', 'HEAD']).trim()

  const strict = await gitPush(mine, { ...base, pushStrategy: 'fast-forward' })
  assert.equal(strict.ok, false, '只允许快进时不该覆盖云端')
  assert.match(strict.reason, /非快进|fast-forward|rejected/i)

  const overwrite = await gitPush(mine, { ...base, pushStrategy: 'overwrite' })
  assert.equal(overwrite.ok, true, overwrite.reason)
  assert.equal(overwrite.overwrote, true, '应该报告覆盖了远端')
  assert.ok(overwrite.backupRef.startsWith('refs/engram/overwritten/'), '覆盖前要留本地备份 ref')
  assert.equal(git(bare, ['rev-parse', 'refs/heads/main']).trim(), myHead, '云端应该等于本地 HEAD')
  assert.equal(git(mine, ['rev-parse', overwrite.backupRef]).trim(), otherHead, '备份 ref 指向被覆盖的旧远端 HEAD')
})
await check('推送策略 ask：远端有新提交时不自作主张，交给界面决定；force/另建分支才继续', async () => {
  const bare = path.join(root, 'ask-remote.git')
  git(root, ['init', '--bare', '-b', 'main', bare])
  const mine = path.join(root, 'ask-mine')
  fs.mkdirSync(mine, { recursive: true })
  git(mine, ['init', '-b', 'main'])
  git(mine, ['config', 'user.name', 'Ask'])
  git(mine, ['config', 'user.email', 'ask@test.local'])
  fs.writeFileSync(path.join(mine, 'exp-lib.json'), '{"v":1}\n', 'utf8')
  git(mine, ['add', '-A'])
  git(mine, ['commit', '-q', '-m', 'v1'])
  const askConfig = { repoUrl: bare, branch: 'main', pushStrategy: 'ask' }
  const init = await gitInit(mine, askConfig)
  assert.equal(init.ok, true, init.reason)
  assert.equal((await gitPush(mine, askConfig)).ok, true)

  // 另一台设备推了一条
  const other = path.join(root, 'ask-other')
  git(root, ['clone', '-q', bare, other])
  git(other, ['config', 'user.name', 'Other'])
  git(other, ['config', 'user.email', 'other@test.local'])
  fs.writeFileSync(path.join(other, 'other.txt'), 'x\n', 'utf8')
  git(other, ['add', '-A'])
  git(other, ['commit', '-q', '-m', 'other'])
  git(other, ['push', '-q', 'origin', 'main'])
  const otherHead = git(other, ['rev-parse', 'HEAD']).trim()

  fs.writeFileSync(path.join(mine, 'local.txt'), 'y\n', 'utf8')
  git(mine, ['add', '-A'])
  git(mine, ['commit', '-q', '-m', 'local'])
  const myHead = git(mine, ['rev-parse', 'HEAD']).trim()

  const asked = await gitPush(mine, askConfig)
  assert.equal(asked.ok, false)
  assert.equal(asked.pushed, false)
  assert.equal(asked.needsDecision, true, '应该把决定权交给界面')
  assert.ok(asked.remoteAhead >= 1, '要告诉用户远端多几个提交')
  assert.equal(git(bare, ['rev-parse', 'refs/heads/main']).trim(), otherHead, 'ask 策略下不许动远端')

  const forced = await gitPush(mine, askConfig, { force: true })
  assert.equal(forced.ok, true, forced.reason)
  assert.equal(forced.overwrote, true)
  assert.equal(git(bare, ['rev-parse', 'refs/heads/main']).trim(), myHead)

  const branched = await gitPush(mine, askConfig, { branch: 'engram-rescue' })
  assert.equal(branched.ok, true, branched.reason)
  assert.equal(branched.remoteBranch, 'engram-rescue')
  assert.equal(git(bare, ['rev-parse', 'refs/heads/engram-rescue']).trim(), myHead)
  assert.equal(git(bare, ['rev-parse', 'refs/heads/main']).trim(), myHead, '另建分支不该改 main')
})
fs.rmSync(root, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
