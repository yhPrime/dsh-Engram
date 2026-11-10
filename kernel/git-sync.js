/**
 * 经验库的 Git 备份/同步（像记忆插件那样把库推到远端仓库）。
 *
 * 直接在数据目录里做 git：`<dataDir>/.git` 就是仓库本身。
 *  - 只 `git add -A -- .`（当前数据目录），不碰父目录；
 *  - 只做 fast-forward 拉取（`pull --ff-only`），冲突就交回给人；
 *  - token 只用于 https 的 `http.extraHeader`，错误信息里会被打码；
 *  - 任何失败都返回结构化原因，不 throw 到工具层（除了参数校验）。
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const GIT_TIMEOUT_MS = 30000
const BRANCH_PATTERN = /^(?![-/])[A-Za-z0-9._/-]{1,80}$/u
const MAX_TOKEN_LENGTH = 2000

/** 校验分支名（和设置页表单同一口径）。 */
export function validateBranch(value) {
  const name = String(value || '').trim()
  if (!BRANCH_PATTERN.test(name) || name.endsWith('/') || name.includes('..')) {
    throw new Error('分支名不合法：只能是字母、数字、. _ - /，且不能以 - 或 / 开头')
  }
  return name
}

/** 校验远端地址：https / ssh / git@host:path / 本地绝对路径；不许内嵌账号密码。 */
export function validateRepoUrl(value) {
  const url = String(value || '').trim()
  if (url === '' || url.includes('\0')) throw new Error('远端地址不能为空')
  const withCredentials = /^[a-z]+:\/\/[^/]*@/iu.test(url)
  if (withCredentials) throw new Error('远端地址里不要写账号密码/token，请填到下面的 token 字段')
  if (/^https?:\/\//iu.test(url) || /^ssh:\/\//iu.test(url) || /^git@[^:]+:.+/u.test(url) || path.isAbsolute(url)) return url
  throw new Error('远端地址只支持 https://、ssh://、git@host:path 或本机绝对路径')
}

/** 规整配置（不校验，校验只在动作时做，免得存一半）。 */
export function resolveGitConfig(config = {}) {
  const branch = String(config.branch || 'main').trim() || 'main'
  const autoBackupMinutes = Math.max(0, Math.min(10080, Math.trunc(Number(config.autoBackupMinutes) || 0)))
  // 冲突时谁赢：overwrite = 本地覆盖云端（默认，经验库是本机资产，云端只是备份）；
  // fast-forward = 只允许快进，分叉就交回给人。
  const strategyValue = String(config.pushStrategy || 'ask').trim()
  const pushStrategy = ['ask', 'overwrite', 'fast-forward'].includes(strategyValue) ? strategyValue : 'ask'
  return {
    repoUrl: String(config.repoUrl || '').trim(),
    branch,
    token: String(config.token || '').trim(),
    authorName: String(config.authorName || '').trim(),
    authorEmail: String(config.authorEmail || '').trim(),
    autoBackupMinutes,
    pushStrategy,
  }
}

function runGit(args, options = {}) {
  return new Promise((resolve) => {
    execFile('git', args, {
      cwd: options.cwd,
      timeout: options.timeout || GIT_TIMEOUT_MS,
      windowsHide: true,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: '',
        ...(options.env || {}),
      },
    }, (error, stdout, stderr) => {
      const code = error === null ? 0 : (typeof error.code === 'number' ? error.code : 1)
      resolve({ code, stdout: String(stdout || ''), stderr: String(stderr || error?.message || '') })
    })
  })
}

function mask(text, token) {
  const raw = String(text || '')
  if (token === '') return raw
  return raw.split(token).join('***')
}

function tail(text, max = 400) {
  const raw = String(text || '').trim()
  return raw.length <= max ? raw : raw.slice(raw.length - max)
}

/** https 推送时用 extraHeader 带 token（不落 argv 的 URL 里，也不进 remote url）。 */
function tokenArgs(repoUrl, token) {
  if (token === '' || !/^https?:\/\//iu.test(repoUrl)) return []
  const basic = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64')
  return ['-c', `http.extraHeader=AUTHORIZATION: basic ${basic}`]
}

export async function gitAvailable() {
  const result = await runGit(['--version'], { timeout: 8000 })
  return result.code === 0
}

/**
 * 仓库状态：是否仓库、远程、分支、未提交数量、领先/落后、最近一次提交。
 * 任何一步失败都只记进 `error`，其余字段给默认值（界面照常显示）。
 */
export async function gitStatus(dataDir, config = {}) {
  const resolved = resolveGitConfig(config)
  const state = {
    available: await gitAvailable(),
    dataDir,
    isRepo: false,
    branch: '',
    remote: '',
    dirtyCount: 0,
    ahead: 0,
    behind: 0,
    lastCommitAt: '',
    lastCommitSubject: '',
    configured: resolved.repoUrl !== '',
    targetBranch: resolved.branch,
    autoBackupMinutes: resolved.autoBackupMinutes,
    error: '',
  }
  if (!state.available) {
    state.error = '这台机器上找不到 git 命令'
    return state
  }
  if (!fs.existsSync(path.join(dataDir, '.git'))) return state
  state.isRepo = true
  const top = await runGit(['rev-parse', '--show-toplevel'], { cwd: dataDir })
  if (top.code !== 0) {
    state.isRepo = false
    state.error = mask(tail(top.stderr), resolved.token)
    return state
  }
  const branch = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dataDir })
  state.branch = branch.code === 0 ? branch.stdout.trim() : ''
  if (state.branch === 'HEAD') state.branch = ''
  const remote = await runGit(['config', '--get', 'remote.origin.url'], { cwd: dataDir })
  state.remote = remote.code === 0 ? remote.stdout.trim() : ''
  const dirty = await runGit(['status', '--porcelain'], { cwd: dataDir })
  state.dirtyCount = dirty.code === 0 && dirty.stdout.trim() !== '' ? dirty.stdout.trim().split(/\r?\n/u).length : 0
  const counts = await runGit(['rev-list', '--left-right', '--count', '@{upstream}...HEAD'], { cwd: dataDir })
  if (counts.code === 0) {
    const [behind, ahead] = counts.stdout.trim().split(/\s+/u)
    state.behind = Math.trunc(Number(behind) || 0)
    state.ahead = Math.trunc(Number(ahead) || 0)
  }
  const last = await runGit(['log', '-1', '--format=%cI%x09%s'], { cwd: dataDir })
  if (last.code === 0 && last.stdout.trim() !== '') {
    const [at, subject] = last.stdout.trim().split('\t')
    state.lastCommitAt = at || ''
    state.lastCommitSubject = subject || ''
  }
  return state
}

/** 在数据目录里初始化仓库并设置 origin。已存在则只更新 origin。 */
export async function gitInit(dataDir, config = {}) {
  const resolved = resolveGitConfig(config)
  const repoUrl = validateRepoUrl(resolved.repoUrl)
  const branch = validateBranch(resolved.branch)
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true })
  const hasRepo = fs.existsSync(path.join(dataDir, '.git'))
  if (!hasRepo) {
    const init = await runGit(['init', '-b', branch], { cwd: dataDir })
    if (init.code !== 0) return { ok: false, action: 'init', reason: mask(tail(init.stderr), resolved.token) }
  }
  const existing = await runGit(['config', '--get', 'remote.origin.url'], { cwd: dataDir })
  const remoteUrl = existing.code === 0 ? existing.stdout.trim() : ''
  const setRemote = remoteUrl === ''
    ? await runGit(['remote', 'add', 'origin', repoUrl], { cwd: dataDir })
    : (remoteUrl === repoUrl ? { code: 0, stderr: '' } : await runGit(['remote', 'set-url', 'origin', repoUrl], { cwd: dataDir }))
  if (setRemote.code !== 0) return { ok: false, action: 'init', reason: mask(tail(setRemote.stderr), resolved.token) }
  return { ok: true, action: 'init', created: !hasRepo, branch, repoUrl }
}

/**
 * 提交并推送。
 * @returns {{ok:boolean, action:'push', committed:boolean, pushed:boolean, reason?:string, commit?:string}}
 */
export async function gitPush(dataDir, config = {}, options = {}) {
  const resolved = resolveGitConfig(config)
  const branch = validateBranch(resolved.branch)
  if (!fs.existsSync(path.join(dataDir, '.git'))) {
    return { ok: false, action: 'push', committed: false, pushed: false, reason: '还不是 git 仓库：先点「初始化仓库」' }
  }
  const message = String(options.message || '').trim() || `经验库备份 ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`
  const add = await runGit(['add', '-A', '--', '.'], { cwd: dataDir })
  if (add.code !== 0) return { ok: false, action: 'push', committed: false, pushed: false, reason: mask(tail(add.stderr), resolved.token) }
  const staged = await runGit(['diff', '--cached', '--name-only'], { cwd: dataDir })
  const dirty = staged.code === 0 && staged.stdout.trim() !== ''
  let committed = false
  if (dirty) {
    const identity = []
    if (resolved.authorName !== '') identity.push('-c', `user.name=${resolved.authorName}`)
    if (resolved.authorEmail !== '') identity.push('-c', `user.email=${resolved.authorEmail}`)
    const commit = await runGit([...identity, 'commit', '--quiet', '-m', message, '--', '.'], { cwd: dataDir })
    if (commit.code !== 0) return { ok: false, action: 'push', committed: false, pushed: false, reason: mask(tail(commit.stderr), resolved.token) }
    committed = true
  }
  const remote = await runGit(['config', '--get', 'remote.origin.url'], { cwd: dataDir })
  const repoUrl = remote.code === 0 ? remote.stdout.trim() : resolved.repoUrl
  if (repoUrl === '') return { ok: false, action: 'push', committed, pushed: false, reason: '没有配置远端仓库（设置里填 repoUrl 或先初始化）' }
  // 先把远端分支同步到 origin/<branch>，才判断得清「会不会覆盖别人」。
  await runGit([...tokenArgs(repoUrl, resolved.token), 'fetch', '--quiet', 'origin', `${branch}:refs/remotes/origin/${branch}`], { cwd: dataDir })
  const remoteHead = await runGit(['rev-parse', 'origin/' + branch], { cwd: dataDir })
  const remoteSha = remoteHead.code === 0 ? remoteHead.stdout.trim() : ''
  const ancestor = remoteSha === '' ? null : await runGit(['merge-base', '--is-ancestor', remoteSha, 'HEAD'], { cwd: dataDir })
  const behindRemote = remoteSha !== '' && ancestor !== null && ancestor.code !== 0
  const targetBranch = String((options && options.branch) || branch).trim() || branch
  if (behindRemote && options.force !== true && resolved.pushStrategy !== 'overwrite') {
    if (resolved.pushStrategy === 'fast-forward') {
      const hint = '（远端有本机没有的提交；可在设置里把推送策略改成「先问我」或「本地覆盖云端」）'
      return { ok: false, action: 'push', committed, pushed: false, reason: '远端有本机没有的提交，拒绝非快进推送' + hint }
    }
    // 'ask'：不自作主张。把决定权交回界面：覆盖 / 换远端仓库 / 另建分支。
    const ahead = await runGit(['rev-list', '--count', `HEAD..origin/${branch}`], { cwd: dataDir })
    return {
      ok: false,
      action: 'push',
      committed,
      pushed: false,
      needsDecision: true,
      reason: `远端比本机多 ${ahead.code === 0 ? ahead.stdout.trim() : '若干'} 个提交`,
      remoteHead: remoteSha,
      remoteAhead: ahead.code === 0 ? Number(ahead.stdout.trim()) || 1 : 1,
      branch,
    }
  }
  let backupRef = ''
  if (behindRemote) {
    // 覆盖云端前把旧的远端 HEAD 留一个本地 ref，万一云端有别的设备的提交还能捞回来。
    backupRef = `refs/engram/overwritten/${new Date().toISOString().replace(/[:.]/gu, '-')}`
    const saved = await runGit(['update-ref', backupRef, remoteSha], { cwd: dataDir })
    if (saved.code !== 0) backupRef = ''
  }
  // 推 HEAD，不推「本地同名分支」：本地分支可能叫 master、配置里的目标分支叫 main
  // （新建仓库默认 main），直接 `push origin main` 会报 src refspec does not match any。
  const pushArgs = [...tokenArgs(repoUrl, resolved.token), 'push', '-u']
  if (behindRemote) pushArgs.push('--force')
  pushArgs.push('origin', `HEAD:refs/heads/${targetBranch}`)
  const push = await runGit(pushArgs, { cwd: dataDir })
  if (push.code !== 0) {
    return { ok: false, action: 'push', committed, pushed: false, reason: mask(tail(push.stderr || push.stdout), resolved.token) }
  }
  const head = await runGit(['rev-parse', '--short', 'HEAD'], { cwd: dataDir })
  // 用 HEAD:refs/heads/<branch> 推上去时 git 不一定给本地分支建上游，这里显式补一次
  // （失败也只是少了 upstream，不影响备份本身）。
  await runGit(['branch', `--set-upstream-to=origin/${targetBranch}`], { cwd: dataDir })
  return {
    ok: true,
    action: 'push',
    committed,
    pushed: true,
    remoteBranch: targetBranch,
    strategy: resolved.pushStrategy,
    overwrote: behindRemote,
    backupRef,
    commit: head.code === 0 ? head.stdout.trim() : '',
    message,
    reason: committed ? '' : '没有新的改动，已是最新',
  }
}

/** 只做 fast-forward 拉取；有分叉就返回原因，不自动合并。 */
export async function gitPull(dataDir, config = {}) {
  const resolved = resolveGitConfig(config)
  const branch = validateBranch(resolved.branch)
  if (!fs.existsSync(path.join(dataDir, '.git'))) {
    return { ok: false, action: 'pull', reason: '还不是 git 仓库：先点「初始化仓库」' }
  }
  const remote = await runGit(['config', '--get', 'remote.origin.url'], { cwd: dataDir })
  const repoUrl = remote.code === 0 ? remote.stdout.trim() : resolved.repoUrl
  if (repoUrl === '') return { ok: false, action: 'pull', reason: '没有配置远端仓库' }
  // 显式写目标 ref：只写 fetch origin <branch> 时不一定更新 origin/<branch>，后面 merge 就会找不到
  const fetch = await runGit([...tokenArgs(repoUrl, resolved.token), 'fetch', '--quiet', 'origin', `${branch}:refs/remotes/origin/${branch}`], { cwd: dataDir })
  if (fetch.code !== 0) return { ok: false, action: 'pull', reason: mask(tail(fetch.stderr || fetch.stdout), resolved.token) }
  const merge = await runGit(['merge', '--ff-only', '--quiet', `origin/${branch}`], { cwd: dataDir })
  if (merge.code !== 0) return { ok: false, action: 'pull', reason: `需要手动合并（本地有独立提交）：${mask(tail(merge.stderr || merge.stdout), resolved.token)}` }
  return { ok: true, action: 'pull', branch }
}

/** 给人看的仓库根（测试/调试用）。 */
export function gitDirOf(dataDir) {
  return path.join(dataDir, '.git')
}

/** 当前平台的默认提交身份提示（没配作者时用全局 git 身份）。 */
export function defaultAuthorHint() {
  return `默认用户名 ${os.userInfo().username}，可在上面填写提交作者`
}
