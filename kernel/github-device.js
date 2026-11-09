/**
 * GitHub OAuth 设备码登录（不用让用户贴 PAT）。
 *
 * 和记忆插件同一套流程：
 *   1. POST /login/device/code（公开 client_id + scope=repo）→ 用户码与验证地址；
 *   2. 用户在浏览器打开 https://github.com/login/device 输入用户码并授权；
 *   3. 轮询 POST /login/oauth/access_token（device_code 换 token）。
 *
 * token 由调用方（shell）落盘；本模块不写任何文件。
 */
import { requestJson } from './github-transport.js'

const DEVICE_CODE_URL = 'https://github.com/login/device/code'
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token'

/** 经验库自己的 OAuth App client id（设备流不需要 client secret；可用设置里的 git.oauthClientId 覆盖）。 */
export const DEFAULT_CLIENT_ID = 'Ov23lil51OhGc9CesSML'
export const DEFAULT_SCOPE = 'repo'

async function postForm(url, fields, { fetchImpl } = {}) {
  const { status, payload } = await requestJson({
    url,
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': 'dsh-engram',
    },
    body: new URLSearchParams(fields).toString(),
    fetch: fetchImpl,
  })
  if (status < 200 || status >= 300) {
    const message = payload && payload.error_description
      ? String(payload.error_description)
      : (payload && payload.error ? String(payload.error) : `HTTP ${status}`)
    const error = new Error(`GitHub 登录请求失败：${message}`)
    error.code = 'github'
    throw error
  }
  return payload || {}
}

/**
 * 开始设备流。
 * @returns {{deviceCode:string, userCode:string, verificationUri:string, expiresIn:number, interval:number}}
 */
export async function startDeviceFlow(options = {}) {
  const clientId = String(options.clientId || DEFAULT_CLIENT_ID)
  const scope = String(options.scope || DEFAULT_SCOPE)
  const payload = await postForm(DEVICE_CODE_URL, { client_id: clientId, scope }, { fetchImpl: options.fetch })
  const deviceCode = String(payload.device_code || '')
  const userCode = String(payload.user_code || '')
  if (deviceCode === '' || userCode === '') {
    const error = new Error('GitHub 没有返回设备码，稍后再试')
    error.code = 'github'
    throw error
  }
  return {
    deviceCode,
    userCode,
    verificationUri: String(payload.verification_uri || 'https://github.com/login/device'),
    expiresIn: Math.max(60, Math.trunc(Number(payload.expires_in) || 900)),
    interval: Math.max(5, Math.trunc(Number(payload.interval) || 5)),
  }
}

/**
 * 轮询一次。
 * @returns {{status:'authorized', token:string} | {status:'pending'|'slow-down'|'expired'|'denied'}}
 */
export async function pollDeviceFlow(options = {}) {
  const clientId = String(options.clientId || DEFAULT_CLIENT_ID)
  const deviceCode = String(options.deviceCode || '')
  if (deviceCode === '') {
    const error = new Error('没有正在进行的登录：先点「用 GitHub 登录」')
    error.code = 'github'
    throw error
  }
  const payload = await postForm(ACCESS_TOKEN_URL, {
    client_id: clientId,
    device_code: deviceCode,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  }, { fetchImpl: options.fetch })
  const token = String(payload.access_token || '')
  if (token !== '') return { status: 'authorized', token, scope: String(payload.scope || '') }
  const error = String(payload.error || 'unknown')
  if (error === 'authorization_pending') return { status: 'pending' }
  if (error === 'slow_down') return { status: 'slow-down' }
  if (error === 'expired_token') return { status: 'expired' }
  if (error === 'access_denied') return { status: 'denied' }
  const failure = new Error(`GitHub 登录失败：${String(payload.error_description || error)}`)
  failure.code = 'github'
  throw failure
}
