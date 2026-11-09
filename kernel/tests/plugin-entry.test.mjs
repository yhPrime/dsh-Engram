/**
 * 单插件入口（仓库根 plugin.js）契约：一个 apply 同时挂工具面与控制台 API。
 *
 * 重点回归：Cordis 规定「没在 inject 里声明的服务，读属性直接报
 * cannot get property "webServer" without inject」——0.11.0 就栽在这。
 * 所以这里用一个 Proxy 把 webServer 变成一读就炸的属性，
 * 保证入口只在 ctx.inject(['webServer'], …) 的回调里碰它。
 *
 * Run: node kernel/tests/plugin-entry.test.mjs
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..', '..')

const entry = await import(pathToFileURL(path.join(root, 'plugin.js')).href)

const tools = []
const sections = []
const injected = []
const registered = []

const serviceCtx = {
  register(definition) {
    registered.push(definition)
    return () => {}
  },
}

/** 外层上下文：没声明 webServer，读它必须抛。 */
const ctx = new Proxy({
  tools: { register(tool) { tools.push(tool) } },
  systemPrompt: { section(section) { sections.push(section) } },
  effect(callback) { return callback() },
  inject(deps, callback) {
    injected.push(deps.join(','))
    // 模拟服务就绪后回调，并给回调上下文声明 webServer。
    callback(new Proxy({ webServer: serviceCtx, effect: (fn) => fn() }, {
      get(target, key) {
        if (key === 'webServer') return target.webServer
        return target[key]
      },
    }))
  },
}, {
  get(target, key) {
    if (key === 'webServer') throw new Error('cannot get property "webServer" without inject')
    return target[key]
  },
})

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

await check('入口形状：name=dsh-engram，inject 声明 tools/systemPrompt，有 apply', () => {
  assert.equal(entry.name, 'dsh-engram')
  assert.deepEqual([...entry.inject], ['tools', 'systemPrompt'])
  assert.equal(typeof entry.apply, 'function')
})

await check('apply 不直接读 ctx.webServer（Cordis 会报 without inject）', async () => {
  await entry.apply(ctx, { hint: false, dataDir: path.join(root, '_tmp', 'entry-test-data') })
})

await check('一次 apply 同时挂上工具面与控制台 API', () => {
  assert.ok(tools.length >= 4, `工具数 ${tools.length}`)
  assert.equal(injected.includes('webServer'), true, '没有等待 webServer')
  const mount = registered.find((definition) => definition.path === '/exp-ui/api')
  assert.ok(mount, '没注册 /exp-ui/api')
  assert.equal(mount.kind, 'prefix')
  assert.equal(typeof mount.handler, 'function')
})

await check('webServer 注册抛错时不拖垮工具面', async () => {
  const boom = {
    tools: { register() {} },
    systemPrompt: { section() {} },
    effect(callback) { return callback() },
    inject(_deps, callback) {
      callback({
        webServer: { register() { throw new Error('boom') } },
        effect(callbackInner) { return callbackInner() },
      })
    },
  }
  await entry.apply(boom, { hint: false, dataDir: path.join(root, '_tmp', 'entry-test-data') })
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
