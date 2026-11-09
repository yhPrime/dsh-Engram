/**
 * GitHub 请求的传输层。
 *
 * 背景（2026-11-10 实测）：本机装了 TLS 拦截代理，根证书只在 **Windows 证书存储**里，
 * Node 自带的 CA 列表验不过 → 宿主里的 `fetch()` 直接 `UNABLE_TO_VERIFY_LEAF_SIGNATURE`，
 * 界面上就显示成 `fetch failed`。`node --use-system-ca` 能通，但没法给运行中的宿主加启动参数。
 *
 * 做法：先用全局 fetch（正常环境最快）；失败且像是证书问题时，
 * 导出一份 Windows 根证书 PEM（缓存到 ~/.dsh/engram/system-ca.pem），
 * 再用 node:https 带 `ca` 重试一次。非 Windows 或导出失败就原样抛出。
 *
 * 测试通过 options.fetch 注入假实现，走不到真实网络。
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import { URL } from 'node:url'

const REQUEST_TIMEOUT_MS = 20000
const TLS_CODES = /UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN|CERT_HAS_EXPIRED|UNABLE_TO_GET_ISSUER_CERT|ERR_TLS_CERT_ALTNAME_INVALID|fetch failed/iu

function caFile() {
  const home = String(process.env.DSH_HOME || '').trim() || path.join(os.homedir(), '.dsh')
  return path.join(home, 'engram', 'system-ca.pem')
}

function readCachedCA() {
  try {
    const text = fs.readFileSync(caFile(), 'utf8')
    return text.includes('BEGIN CERTIFICATE') ? text : ''
  } catch {
    return ''
  }
}

/** 导出 Windows 根证书（一次性，随后缓存到文件）。 */
function exportSystemCA() {
  const script = [
    '$out = New-Object System.Text.StringBuilder',
    'foreach ($c in Get-ChildItem Cert:\\LocalMachine\\Root) {',
    '  try {',
    '    $b = $c.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert)',
    '    [void]$out.AppendLine("-----BEGIN CERTIFICATE-----")',
    '    [void]$out.AppendLine([Convert]::ToBase64String($b, [System.Base64FormattingOptions]::InsertLineBreaks))',
    '    [void]$out.AppendLine("-----END CERTIFICATE-----")',
    '  } catch {}',
    '}',
    '[Console]::Out.Write($out.ToString())',
  ].join('\n')
  const shells = ['pwsh.exe', 'powershell.exe']
  return new Promise((resolve) => {
    const tryNext = (index) => {
      if (index >= shells.length) return resolve('')
      execFile(shells[index], ['-NoProfile', '-NonInteractive', '-Command', script], {
        timeout: 30000,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
      }, (error, stdout) => {
        if (error || !String(stdout || '').includes('BEGIN CERTIFICATE')) return tryNext(index + 1)
        resolve(String(stdout))
      })
    }
    tryNext(0)
  })
}

/** 取系统根证书：内存 → 文件缓存 → 现场导出（导出后落盘）。 */
export async function systemCA() {
  if (process.platform !== 'win32') return ''
  if (systemCA.cached !== undefined) return systemCA.cached
  const cached = readCachedCA()
  if (cached !== '') {
    systemCA.cached = cached
    return cached
  }
  const exported = await exportSystemCA()
  if (exported !== '') {
    try {
      fs.mkdirSync(path.dirname(caFile()), { recursive: true })
      fs.writeFileSync(caFile(), exported, 'utf8')
    } catch {
      // 写不进去也不影响本次使用
    }
  }
  systemCA.cached = exported
  return exported
}

/** 用 node:https 发一次请求（带自定义 CA）。 */
function httpsJson({ url, method = 'GET', headers = {}, body, ca, timeoutMs = REQUEST_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const request = https.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: `${parsed.pathname}${parsed.search}`,
      method,
      headers,
      ...(ca === '' ? {} : { ca }),
      timeout: timeoutMs,
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let payload = null
        try {
          payload = text === '' ? null : JSON.parse(text)
        } catch {
          payload = null
        }
        resolve({ status: Number(response.statusCode) || 0, payload, text })
      })
    })
    request.on('timeout', () => {
      request.destroy(new Error('GitHub 请求超时（20 秒）'))
    })
    request.on('error', reject)
    if (body !== undefined) request.write(body)
    request.end()
  })
}

/**
 * 请求 GitHub JSON。
 * @param {{url:string, method?:string, headers?:object, body?:string, fetch?:Function, timeoutMs?:number}} options
 * @returns {Promise<{status:number, payload:any}>}
 */
export async function requestJson(options) {
  const { url, method = 'GET', headers = {}, body } = options
  if (typeof options.fetch === 'function') {
    const response = await options.fetch(url, { method, headers, ...(body === undefined ? {} : { body }) })
    let payload = null
    try {
      payload = await response.json()
    } catch {
      payload = null
    }
    return { status: Number(response.status) || 0, payload }
  }

  const doFetch = globalThis.fetch
  let firstError = null
  if (typeof doFetch === 'function') {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), options.timeoutMs || REQUEST_TIMEOUT_MS)
    try {
      const response = await doFetch(url, { method, headers, ...(body === undefined ? {} : { body }), signal: controller.signal })
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      return { status: Number(response.status) || 0, payload }
    } catch (error) {
      firstError = error
    } finally {
      clearTimeout(timer)
    }
  } else {
    firstError = new Error('当前环境没有 fetch')
  }

  const reason = String((firstError && (firstError.cause && firstError.cause.code || firstError.message)) || '')
  if (!TLS_CODES.test(reason) && !(firstError && firstError.name === 'AbortError')) {
    throw firstError || new Error('GitHub 请求失败')
  }

  // 证书问题：带系统根证书重试一次。
  const ca = await systemCA()
  if (ca === '') throw firstError || new Error('GitHub 请求失败（证书校验失败，且拿不到系统根证书）')
  const retried = await httpsJson({ url, method, headers, body, ca, timeoutMs: options.timeoutMs })
  return retried
}
