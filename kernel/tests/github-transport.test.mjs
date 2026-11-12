/**
 * GitHub 传输层（kernel/github-transport.js）。
 * 默认全离线：注入假 fetch；真实网络用例只在 ENGRAM_TEST_NETWORK=1 时跑。
 * Run: node kernel/tests/github-transport.test.mjs
 */
import assert from 'node:assert/strict'

const { requestJson, systemCA } = await import('../github-transport.js')

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

await check('注入 fetch：正常返回 status + payload，不改请求', async () => {
  let seen = null
  const fetch = async (url, init) => {
    seen = { url, init }
    return { status: 200, async json() { return { ok: 1 } } }
  }
  const result = await requestJson({
    url: 'https://api.github.com/zen',
    method: 'POST',
    headers: { accept: 'application/json' },
    body: 'x=1',
    fetch,
  })
  assert.equal(result.status, 200)
  assert.deepEqual(result.payload, { ok: 1 })
  assert.equal(seen.url, 'https://api.github.com/zen')
  assert.equal(seen.init.method, 'POST')
  assert.equal(seen.init.body, 'x=1')
})

await check('注入 fetch：JSON 解析失败时 payload=null，status 照旧', async () => {
  const fetch = async () => ({ status: 204, async json() { throw new Error('no body') } })
  const result = await requestJson({ url: 'https://api.github.com/x', fetch })
  assert.equal(result.status, 204)
  assert.equal(result.payload, null)
})

await check('注入 fetch：普通网络错误原样抛（不触发系统 CA 重试）', async () => {
  const boom = new Error('boom')
  boom.cause = { code: 'ENOTFOUND' }
  const fetch = async () => { throw boom }
  await assert.rejects(() => requestJson({ url: 'https://api.github.com/x', fetch }), /boom/)
})

await check('系统根证书：Windows 上能导出 PEM（非 Windows 返回空）', async () => {
  if (process.platform !== 'win32') {
    assert.equal(await systemCA(), '')
    return
  }
  const ca = await systemCA()
  assert.match(ca, /BEGIN CERTIFICATE/)
  assert.ok(ca.length > 10000, `CA 数量看起来太少：${ca.length} 字节`)
})

if (process.env.ENGRAM_TEST_NETWORK === '1') {
  await check('真实网络：api.github.com/zen 返回 200（走系统 CA 兜底）', async () => {
    const result = await requestJson({ url: 'https://api.github.com/zen', headers: { 'user-agent': 'dsh-engram', accept: 'application/json' } })
    assert.equal(result.status, 200)
  })
} else {
  console.log('  skip 真实网络用例（设 ENGRAM_TEST_NETWORK=1 才跑）')
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
