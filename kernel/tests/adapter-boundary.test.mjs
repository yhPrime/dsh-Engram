/**
 * 适配器边界测试（M3）
 *  - index 暴露 engine 入口；
 *  - plugin 只做注册：工具构建走 engine.createTools，不再直接 buildTools；
 *  - engine 不反向依赖 provider/plugin/index。
 * Run: node tests/adapter-boundary.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as plugin from '../plugin.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const kernelDir = path.dirname(here)

let passed = 0
let failed = 0

function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}`)
    console.log(`       ${error && error.message ? error.message : error}`)
  }
}

check('index 暴露 createEngine / createTools（静态检查，不加载 Provider SDK）', () => {
  const text = fs.readFileSync(path.join(kernelDir, 'index.js'), 'utf8')
  assert.ok(text.includes("createEngine, createTools"), 'index 应 re-export engine')
  assert.ok(text.includes("export { buildTools }"), 'index 应继续导出 buildTools')
  assert.ok(!text.includes('provider-sdk') && !text.includes('buildProvider'), 'index 不应再依赖记忆插件 Provider SDK')
})

check('plugin 只做注册：通过 createTools 建工具，不再直接 import buildTools', () => {
  const text = fs.readFileSync(path.join(kernelDir, 'plugin.js'), 'utf8')
  assert.ok(text.includes("from './engine.js'"), 'plugin 应从 engine 取 createTools')
  assert.ok(text.includes('createTools(config, defineTool)'))
  assert.ok(!/import\s*\{[^}]*buildTools[^}]*\}\s*from\s*'\.\/tools\.js'/.test(text), 'plugin 不应再直接 import buildTools')
  assert.equal(typeof plugin.apply, 'function')
  assert.equal(plugin.name, 'dsh-engram')
})

check('engine 不反向依赖适配器', () => {
  const text = fs.readFileSync(path.join(kernelDir, 'engine.js'), 'utf8')
  for (const bad of ['provider.js', 'plugin.js', 'index.js', '@deepseek-ai/']) {
    assert.ok(!text.includes(bad), `engine.js 出现 ${bad}`)
  }
})

check('发布面：exports 有 ./core ./engine，files 收录两者', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(kernelDir, 'package.json'), 'utf8'))
  assert.equal(pkg.exports['./core'], './core.js')
  assert.equal(pkg.exports['./engine'], './engine.js')
  for (const file of ['core.js', 'engine.js']) assert.ok(pkg.files.includes(file), `files 缺少 ${file}`)
})

console.log('')
console.log(`结果：通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exit(1)
