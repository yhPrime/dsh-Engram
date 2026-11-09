/**
 * dsh-exp-ui — Host 插件入口。
 *
 * 只做三件事：等 webServer 就绪、把 `/exp-ui/api` 挂上去、把 config 交给 data source。
 * 界面在 client.js；数据在 mock.js / live.js。工具面刻意不含：本包是外壳，不写经验库。
 */

import { API_PREFIX, APP_NAME, createApi } from './shell.js'

export { API_PREFIX, APP_NAME } from './shell.js'
export { createSource, buildState, buildExperiences } from './shell.js'

export const name = 'dsh-exp-ui'
export const inject = ['webServer']

/**
 * @param {any} ctx - Host 插件上下文。
 * @param {{source?: 'mock' | 'live', dataDir?: string}} config - 插件行 config。
 */
export function apply(ctx, config = {}) {
  const api = createApi(config)
  return ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: api,
  }))
}
