/**
 * 数据安全回归（0.13.0，2026-11-11 复核发现后补）：
 *  - 库文件损坏时必须抛错，绝不静默返回空库（空快照被写回会清空整库）；
 *  - 文件不存在时仍按空库处理（首次运行）；
 *  - 写盘不留 .tmp / .lock 残留；锁异常时也会释放。
 *
 * Run: node tests/store-safety.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { readStore, storeFile, withStoreLock, writeStore } from '../store.js'

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

const fresh = () => fs.mkdtempSync(path.join(os.tmpdir(), 'engram-safety-'))

check('文件不存在：按空库处理', () => {
  const dir = fresh()
  const store = readStore(dir)
  assert.equal(store.experiences.length, 0)
  assert.ok(Array.isArray(store.types))
})

check('库文件损坏：抛错，不返回空库', () => {
  const dir = fresh()
  fs.mkdirSync(dir, { recursive: true })
  const file = storeFile(dir)
  fs.writeFileSync(file, '{"version":1,"experiences":[{"id":"x"', 'utf8')
  assert.throws(() => readStore(dir), /读取失败/, '损坏时必须抛错')
})

check('写盘正常：round-trip + 无 .tmp/.lock 残留', () => {
  const dir = fresh()
  const store = readStore(dir)
  store.experiences.push({ id: 'ex_a', intent: '冒烟', action: '写一条', outcome: 'success', G: 0.8, GOutcome: 0.8, ts: new Date().toISOString(), verdict: 'decided' })
  writeStore(dir, store)
  const back = readStore(dir)
  assert.equal(back.experiences.length, 1)
  const leftovers = fs.readdirSync(dir).filter((name) => name.endsWith('.tmp') || name.endsWith('.lock'))
  assert.deepEqual(leftovers, [])
})

check('锁：异常时也会释放（不会永久锁死）', () => {
  const dir = fresh()
  fs.mkdirSync(dir, { recursive: true })
  assert.throws(() => withStoreLock(dir, () => { throw new Error('boom') }), /boom/)
  const leftovers = fs.existsSync(`${storeFile(dir)}.lock`)
  assert.equal(leftovers, false, '锁目录应被清掉')
  // 还能再次加锁
  const value = withStoreLock(dir, () => 42)
  assert.equal(value, 42)
})

check('锁：同进程重入不互锁（writeStore 在锁内被调用）', () => {
  const dir = fresh()
  fs.mkdirSync(dir, { recursive: true })
  const value = withStoreLock(dir, () => withStoreLock(dir, () => 'inner'))
  assert.equal(value, 'inner')
})

check('锁：被占用时给出明确错误而不是静默失败', () => {
  const dir = fresh()
  fs.mkdirSync(dir, { recursive: true })
  const lockDir = `${storeFile(dir)}.lock`
  fs.mkdirSync(lockDir)
  try {
    assert.throws(() => withStoreLock(dir, () => 'never'), /正被另一个进程写入/)
  } finally {
    fs.rmdirSync(lockDir)
  }
})

console.log('')
console.log(`结果：通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exit(1)
