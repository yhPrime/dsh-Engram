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

check('锁：真残留（pid 不存在 / 心跳过期）→ ≤200ms 清理并成功', () => {
  const timeIt = (fn) => {
    const t0 = process.hrtime.bigint()
    const value = fn()
    return [Number(process.hrtime.bigint() - t0) / 1e6, value]
  }
  // 死 pid + 心跳过期
  const deadDir = fresh()
  fs.mkdirSync(deadDir, { recursive: true })
  const deadLock = `${storeFile(deadDir)}.lock`
  fs.mkdirSync(deadLock)
  fs.writeFileSync(path.join(deadLock, 'pid'), '999999', 'utf8')
  fs.writeFileSync(path.join(deadLock, 'heartbeat'), JSON.stringify({ pid: 999999, at: Date.now() - 60000 }), 'utf8')
  const [deadMs, deadValue] = timeIt(() => withStoreLock(deadDir, () => 42))
  assert.equal(deadValue, 42)
  assert.ok(deadMs <= 200, `死 pid 残留锁应在 200ms 内清理，实际 ${deadMs.toFixed(1)}ms`)
  assert.equal(fs.existsSync(deadLock), false, '残留锁目录应被清掉')
  // 活 pid 但心跳过期（持锁进程卡死/被杀）→ 同样判残留
  const staleDir = fresh()
  fs.mkdirSync(staleDir, { recursive: true })
  const staleLock = `${storeFile(staleDir)}.lock`
  fs.mkdirSync(staleLock)
  fs.writeFileSync(path.join(staleLock, 'pid'), String(process.pid), 'utf8')
  fs.writeFileSync(path.join(staleLock, 'heartbeat'), JSON.stringify({ pid: process.pid, at: Date.now() - 60000 }), 'utf8')
  const [staleMs, staleValue] = timeIt(() => withStoreLock(staleDir, () => 7))
  assert.equal(staleValue, 7)
  assert.ok(staleMs <= 200, `心跳过期锁应在 200ms 内清理，实际 ${staleMs.toFixed(1)}ms`)
})

check('锁：真占用（活进程 + 新鲜心跳）→ 明确错误且不抢锁', () => {
  const dir = fresh()
  fs.mkdirSync(dir, { recursive: true })
  const lockDir = `${storeFile(dir)}.lock`
  fs.mkdirSync(lockDir)
  // 伪造「另一个活进程正持锁」：pid 是当前进程（判活成功），心跳新鲜。
  fs.writeFileSync(path.join(lockDir, 'pid'), String(process.pid), 'utf8')
  fs.writeFileSync(path.join(lockDir, 'heartbeat'), JSON.stringify({ pid: process.pid, at: Date.now() }), 'utf8')
  try {
    // 等 300ms 就抛错（真占用最多等 10s）；关键是**不能**被误判成残留而抢锁。
    assert.throws(() => withStoreLock(dir, () => 'never', { waitMs: 300 }), /正被另一个进程写入/)
    assert.equal(fs.existsSync(lockDir), true, '活进程的锁不能被抢走/删掉')
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true })
  }
})

check('experiences 非数组：抛结构损坏，不返回空库', () => {
  const dir = fresh()
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(storeFile(dir), JSON.stringify({ version: 1, types: [{ id: 'ty_a', name: '甲' }], experiences: { bad: true } }), 'utf8')
  assert.throws(() => readStore(dir), /结构损坏/)
})

check('types 非数组：抛结构损坏', () => {
  const dir = fresh()
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(storeFile(dir), JSON.stringify({ version: 1, types: 'oops', experiences: [] }), 'utf8')
  assert.throws(() => readStore(dir), /结构损坏/)
})

check('types 含 null：过滤掉，不崩', () => {
  const dir = fresh()
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(storeFile(dir), JSON.stringify({ version: 1, types: [null, { id: 'ty_a', name: '甲' }], experiences: [] }), 'utf8')
  const store = readStore(dir)
  assert.ok(store.types.every((type) => type && typeof type.id === 'string'))
})

check('typeId 悬空：读时归未分类', () => {
  const dir = fresh()
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(storeFile(dir), JSON.stringify({ version: 1, types: [], experiences: [{ id: 'ex_a', intent: 'x', action: 'y', outcome: 'success', typeId: 'ty_ghost', typeName: '幽灵' }] }), 'utf8')
  const store = readStore(dir)
  assert.equal(store.experiences[0].typeId, 'ty_other')
})

/**
 * 数据安全回归（0.13.0，2026-11-11 复核发现后补）：
 *  - 库文件损坏时必须抛错，绝不静默返回空库（空快照被写回会清空整库）；
 *  - 文件不存在时仍按空库处理（首次运行）；
 *  - 写盘不留 .tmp / .lock 残留；锁异常时也会释放。
 *
 * Run: node tests/store-safety.test.mjs
 */
check('崩溃残留 tmp：写入后清理掉旧的临时文件', () => {
  const dir = fresh()
  fs.mkdirSync(dir, { recursive: true })
  writeStore(dir, { types: [], experiences: [] })
  const tmp = path.join(dir, 'exp-lib.json.999.1.tmp')
  fs.writeFileSync(tmp, '{"half":', 'utf8')
  const old = new Date(Date.now() - 11 * 60 * 1000)
  fs.utimesSync(tmp, old, old)
  writeStore(dir, { types: [], experiences: [] })
  assert.equal(fs.existsSync(tmp), false, '旧 tmp 应被清掉')
})
console.log('')
console.log(`结果：通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exit(1)
