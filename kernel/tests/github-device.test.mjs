/**
 * GitHub 设备码登录（kernel/github-device.js）：注入假 fetch，全离线。
 * Run: node kernel/tests/github-device.test.mjs
 */
import assert from 'node:assert/strict'

const { startDeviceFlow, pollDeviceFlow, DEFAULT_CLIENT_ID } = await import('../github-device.js')

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

await check('开始设备流：POST /login/device/code，带 client_id 与 repo scope', async () => {
  const { fetch, calls } = stub({
    status: 200,
    body: { device_code: 'dev-1', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 },
  })
  const flow = await startDeviceFlow({ fetch })
  assert.equal(flow.deviceCode, 'dev-1')
  assert.equal(flow.userCode, 'ABCD-1234')
  assert.equal(flow.verificationUri, 'https://github.com/login/device')
  assert.equal(flow.expiresIn, 900)
  assert.equal(flow.interval, 5)
  assert.equal(calls[0].url, 'https://github.com/login/device/code')
  const body = new URLSearchParams(calls[0].init.body)
  assert.equal(body.get('client_id'), DEFAULT_CLIENT_ID)
  assert.equal(body.get('scope'), 'repo')
  assert.equal(calls[0].init.headers.accept, 'application/json')
})

await check('开始设备流：缺字段就报可读错误', async () => {
  const { fetch } = stub({ status: 200, body: { error: 'bad' } })
  await assert.rejects(() => startDeviceFlow({ fetch }), /没有返回设备码/)
})

await check('轮询：authorization_pending → pending', async () => {
  const { fetch } = stub({ status: 200, body: { error: 'authorization_pending' } })
  const result = await pollDeviceFlow({ fetch, deviceCode: 'dev-1' })
  assert.equal(result.status, 'pending')
})

await check('轮询：slow_down → slow-down', async () => {
  const { fetch } = stub({ status: 200, body: { error: 'slow_down' } })
  assert.equal((await pollDeviceFlow({ fetch, deviceCode: 'dev-1' })).status, 'slow-down')
})

await check('轮询：expired_token / access_denied', async () => {
  assert.equal((await pollDeviceFlow({ fetch: stub({ status: 200, body: { error: 'expired_token' } }).fetch, deviceCode: 'd' })).status, 'expired')
  assert.equal((await pollDeviceFlow({ fetch: stub({ status: 200, body: { error: 'access_denied' } }).fetch, deviceCode: 'd' })).status, 'denied')
})

await check('轮询成功：返回 access_token', async () => {
  const { fetch, calls } = stub({ status: 200, body: { access_token: 'gho_xyz', scope: 'repo' } })
  const result = await pollDeviceFlow({ fetch, deviceCode: 'dev-1' })
  assert.equal(result.status, 'authorized')
  assert.equal(result.token, 'gho_xyz')
  const body = new URLSearchParams(calls[0].init.body)
  assert.equal(body.get('device_code'), 'dev-1')
  assert.equal(body.get('grant_type'), 'urn:ietf:params:oauth:grant-type:device_code')
})

await check('轮询：没有 device_code / 未知错误 给可读原因', async () => {
  await assert.rejects(() => pollDeviceFlow({ deviceCode: '' }), /没有正在进行的登录/)
  const { fetch } = stub({ status: 200, body: { error: 'server_error', error_description: 'boom' } })
  await assert.rejects(() => pollDeviceFlow({ fetch, deviceCode: 'd' }), /boom/)
})

await check('HTTP 失败：带 error_description，标记 code=github', async () => {
  const { fetch } = stub({ status: 500, body: { error: 'server_error', error_description: 'GitHub 挂了' } })
  await assert.rejects(
    () => startDeviceFlow({ fetch }),
    (error) => {
      assert.match(error.message, /GitHub 挂了/)
      assert.equal(error.code, 'github')
      return true
    },
  )
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
