/**
 * dsh-engram 的 UI Host 半：等 webServer 就绪，挂接 /exp-ui/api。
 * 客户端半在 client.js。
 */
import { API_PREFIX, APP_NAME, createApi } from './shell.js'

export { API_PREFIX, APP_NAME } from './shell.js'
export { createSource, buildState, buildExperiences } from './shell.js'

export const name = 'dsh-engram-ui'
export const inject = ['webServer']

export function apply(ctx, config = {}) {
  const api = createApi(config)
  return ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: api,
  }))
}
