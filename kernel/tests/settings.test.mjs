/**
 * 数据位置解析测试（独立化）
 *  - config.dataDir > ENGRAM_DATA_DIR > settings.currentRoot > 默认 $DSH_HOME/engram/data；
 *  - settings 读写、setCurrentRoot 生效；
 *  - 不依赖记忆插件、不读 providerStateFile。
 * Run: node tests/settings.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { readSettings, resolveEngramDataDir, setCurrentRoot, settingsFile } from '../settings.js'

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

const newEnv = () => ({ DSH_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'engram-settings-')) })

check('设置文件在 $DSH_HOME/engram/settings.json', () => {
  const env = newEnv()
  assert.equal(settingsFile(env), path.join(env.DSH_HOME, 'engram', 'settings.json'))
})

check('默认目录：$DSH_HOME/engram/data', () => {
  const env = newEnv()
  assert.equal(resolveEngramDataDir({}, env), path.join(env.DSH_HOME, 'engram', 'data'))
})

check('settings.currentRoot 生效；config.dataDir 优先', () => {
  const env = newEnv()
  const root = path.join(env.DSH_HOME, 'my-root')
  setCurrentRoot(root, env)
  assert.equal(readSettings(env).currentRoot, path.resolve(root))
  assert.equal(resolveEngramDataDir({}, env), path.resolve(root))
  assert.equal(resolveEngramDataDir({ dataDir: 'D:/explicit' }, env), path.resolve('D:/explicit'))
})

check('ENGRAM_DATA_DIR 压过 currentRoot', () => {
  const env = newEnv()
  setCurrentRoot(path.join(env.DSH_HOME, 'root'), env)
  const fromEnv = resolveEngramDataDir({}, { ...env, ENGRAM_DATA_DIR: path.join(env.DSH_HOME, 'env-data') })
  assert.equal(fromEnv, path.join(env.DSH_HOME, 'env-data'))
})

check('不读 providerStateFile：独立解析与它无关', () => {
  const env = newEnv()
  const stateFile = path.join(env.DSH_HOME, 'memory-providers.json')
  fs.writeFileSync(stateFile, JSON.stringify({ services: { 'exp-lib': { dataDir: path.join(env.DSH_HOME, 'wrong') } } }), 'utf8')
  const resolved = resolveEngramDataDir({ providerStateFile: stateFile }, env)
  assert.equal(resolved, path.join(env.DSH_HOME, 'engram', 'data'))
})

console.log('')
console.log(`结果：通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exit(1)
