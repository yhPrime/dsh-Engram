/**
 * GitHub 登录 / 选仓库 / 建仓库（给「Git 仓库备份」用）。
 *
 * 只做三件事，全部走 REST：
 *   1. 校验 token：GET /user → 登录名与头像；
 *   2. 列仓库：GET /user/repos（owner + collaborator，按最近更新排序）；
 *   3. 建仓库：POST /user/repos（auto_init=false，空仓库，第一次 push 不会撞历史）。
 *
 * token 只在请求头里出现，错误信息里打码；不做任何本地落盘（落盘由 settings 的 git.token 负责）。
 */
const API_ROOT = 'https://api.github.com'
const REQUEST_TIMEOUT_MS = 20000
const REPO_NAME_PATTERN = /^[A-Za-z0-9._-]{1,100}$/u

export function validateRepoName(value) {
  const name = String(value || '').trim()
  if (!REPO_NAME_PATTERN.test(name) || name === '.' || name === '..') {
    throw fail('仓库名只能包含字母、数字、点、下划线、减号（1~100 个字符）')
  }
  return name
}

function fail(message) {
  const error = new Error(message)
  error.code = 'github'
  return error
}

function mask(text, token) {
  const raw = String(text || '')
  if (token === '') return raw
  return raw.split(token).join('***')
}

function normalizeRepo(entry) {
  if (entry === null || typeof entry !== 'object') return null
  const fullName = String(entry.full_name || '')
  if (fullName === '') return null
  return {
    fullName,
    name: String(entry.name || fullName.split('/').pop() || ''),
    private: entry.private === true,
    defaultBranch: String(entry.default_branch || 'main'),
    cloneUrl: String(entry.clone_url || ''),
    sshUrl: String(entry.ssh_url || ''),
    htmlUrl: String(entry.html_url || ''),
    updatedAt: String(entry.updated_at || ''),
    description: String(entry.description || ''),
  }
}

async function request(path, { token, method = 'GET', body, fetchImpl }) {
  const doFetch = fetchImpl || globalThis.fetch
  if (typeof doFetch !== 'function') throw new Error('当前运行环境没有 fetch，无法访问 GitHub')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await doFetch(`${API_ROOT}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'user-agent': 'dsh-engram',
        'x-github-api-version': '2022-11-28',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    })
    let payload = null
    try {
      payload = await response.json()
    } catch {
      payload = null
    }
    if (!response.ok) {
      const message = payload && payload.message ? String(payload.message) : `HTTP ${response.status}`
      const error = fail(mask(`GitHub 请求失败：${message}`, token))
      error.status = response.status
      throw error
    }
    return payload
  } catch (error) {
    if (error && error.name === 'AbortError') throw fail('GitHub 请求超时（20 秒）')
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/** 登录校验：token 有效就返回账号信息。 */
export async function githubLogin(token, options = {}) {
  const raw = String(token || '').trim()
  if (raw === '') throw fail('先填访问 token（GitHub → Settings → Developer settings → Personal access tokens）')
  const user = await request('/user', { token: raw, fetchImpl: options.fetch })
  return {
    ok: true,
    login: String(user && user.login ? user.login : ''),
    name: String(user && user.name ? user.name : ''),
    avatarUrl: String(user && user.avatar_url ? user.avatar_url : ''),
  }
}

/** 列仓库：owner + collaborator，按最近推送排序，最多 100 个。 */
export async function githubRepos(token, options = {}) {
  const raw = String(token || '').trim()
  if (raw === '') throw fail('先填访问 token')
  const list = await request('/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator', { token: raw, fetchImpl: options.fetch })
  const rows = Array.isArray(list) ? list.map(normalizeRepo).filter((item) => item !== null) : []
  return { ok: true, total: rows.length, repos: rows }
}

/** 建仓库：默认 private，auto_init=false（空仓库，第一次 push 不会撞历史）。 */
export async function githubCreateRepo(token, options = {}) {
  const raw = String(token || '').trim()
  if (raw === '') throw fail('先填访问 token')
  const name = validateRepoName(options.name)
  const isPrivate = options.private !== false
  const created = await request('/user/repos', {
    token: raw,
    method: 'POST',
    body: { name, private: isPrivate, auto_init: false },
    fetchImpl: options.fetch,
  })
  const repo = normalizeRepo(created)
  if (repo === null) throw fail('仓库已创建，但返回内容读不出来')
  return { ok: true, repo }
}
