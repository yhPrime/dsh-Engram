/**
 * GitHub 登录/选仓库/建仓库（kernel/github.js）：注入假 fetch，全离线。
 * Run: node kernel/tests/github.test.mjs
 */
import assert from 'node:assert/strict'

const { githubCreateRepo, githubLogin, githubRepos, validateRepoName } = await import('../github.js')

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

function stub(response) {
  const calls = []
  const fetch = async (url, init) => {
    calls.push({ url, init })
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      async json() { return response.body },
    }
  }
  return { fetch, calls }
}

await check('仓库名校验', () => {
  assert.equal(validateRepoName('engram-backup'), 'engram-backup')
  assert.equal(validateRepoName('a.b_c-d'), 'a.b_c-d')
  assert.throws(() => validateRepoName(''), /仓库名只能/)
  assert.throws(() => validateRepoName('a b'), /仓库名只能/)
  assert.throws(() => validateRepoName('中文仓库'), /仓库名只能/)
})

await check('没 token：直接给出可操作提示', async () => {
  await assert.rejects(() => githubLogin(''), /先填访问 token/)
  await assert.rejects(() => githubRepos(''), /先填访问 token/)
  await assert.rejects(() => githubCreateRepo('', { name: 'x' }), /先填访问 token/)
})

await check('登录：返回 login/name/avatarUrl，请求头带 Bearer', async () => {
  const { fetch, calls } = stub({ status: 200, body: { login: 'octocat', name: 'The Octocat', avatar_url: 'https://x/a.png' } })
  const user = await githubLogin('tok123', { fetch })
  assert.deepEqual(user, { ok: true, login: 'octocat', name: 'The Octocat', avatarUrl: 'https://x/a.png' })
  assert.equal(calls[0].url, 'https://api.github.com/user')
  assert.equal(calls[0].init.headers.authorization, 'Bearer tok123')
})

await check('登录失败：401 消息原样带出，token 打码', async () => {
  const { fetch } = stub({ status: 401, body: { message: 'Bad credentials for tok123' } })
  await assert.rejects(
    () => githubLogin('tok123', { fetch }),
    (error) => {
      assert.match(error.message, /Bad credentials/)
      assert.equal(error.message.includes('tok123'), false, 'token 没有打码')
      assert.equal(error.code, 'github')
      return true
    },
  )
})

await check('列仓库：只保留完整条目，按 pushed 排序，最多 100', async () => {
  const { fetch, calls } = stub({
    status: 200,
    body: [
      { full_name: 'me/engram', name: 'engram', private: true, default_branch: 'main', clone_url: 'https://github.com/me/engram.git', ssh_url: 'git@github.com:me/engram.git', html_url: 'https://github.com/me/engram', updated_at: '2026-11-09T16:00:00Z', description: '经验库' },
      { name: 'no-full-name' },
      null,
    ],
  })
  const result = await githubRepos('tok', { fetch })
  assert.equal(result.total, 1)
  assert.deepEqual(result.repos[0], {
    fullName: 'me/engram',
    name: 'engram',
    private: true,
    defaultBranch: 'main',
    cloneUrl: 'https://github.com/me/engram.git',
    sshUrl: 'git@github.com:me/engram.git',
    htmlUrl: 'https://github.com/me/engram',
    updatedAt: '2026-11-09T16:00:00Z',
    description: '经验库',
  })
  assert.match(calls[0].url, /per_page=100/)
  assert.match(calls[0].url, /sort=pushed/)
})

await check('建仓库：POST /user/repos，private 默认 true，auto_init=false', async () => {
  const { fetch, calls } = stub({
    status: 201,
    body: { full_name: 'me/new-repo', name: 'new-repo', private: true, default_branch: 'main', clone_url: 'https://github.com/me/new-repo.git' },
  })
  const result = await githubCreateRepo('tok', { fetch, name: 'new-repo' })
  assert.equal(result.ok, true)
  assert.equal(result.repo.cloneUrl, 'https://github.com/me/new-repo.git')
  assert.equal(calls[0].url, 'https://api.github.com/user/repos')
  assert.equal(calls[0].init.method, 'POST')
  const body = JSON.parse(calls[0].init.body)
  assert.deepEqual(body, { name: 'new-repo', private: true, auto_init: false })
})

await check('建仓库：422 已存在 → 原因可读', async () => {
  const { fetch } = stub({ status: 422, body: { message: 'Repository creation failed, name already exists' } })
  await assert.rejects(() => githubCreateRepo('tok', { fetch, name: 'dup' }), /already exists/)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
