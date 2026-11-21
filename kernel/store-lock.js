/**
 * 存储目录锁（0.45.0 D1 从 store.js 拆出，行为逐字保持）。
 *
 * store.js 重新导出 withStoreLock，外部调用方（engine / tools / chat-save / ui shell）
 * 的导入路径不变；sleepSync 供 store 的读等锁与重建重试复用。
 */
import fs from 'node:fs'
import path from 'node:path'

/** 旧单文件库名（锁文件由它派生：`<dataDir>/exp-lib.json.lock`）。与 store.js 的导出同名同值。 */
export const FILE_NAME = 'exp-lib.json'

export function storeFile(dataDir) {
  return path.join(dataDir, FILE_NAME)
}
/** 同步睡眠（不忙等，锁/重试用）。 */
export function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    const until = Date.now() + ms
    while (Date.now() < until) { /* 退化为忙等 */ }
  }
}

/**
 * 写盘锁（0.13.0；D1 强化 2026-11-12）：多进程并发写会「读-改-写」丢更新（对抗测试实测 27 条只剩 9 条）。
 * 用目录锁（mkdir 原子）做互斥；同进程重入直接放行（writeStore 在锁内被调用不算再次加锁）。
 *
 * 崩溃残留：锁目录里写 `pid` 与 `heartbeat`（持锁期间每 2s 刷新）。
 * 获取失败时若 pid 已不存在、或心跳超过 10s 未更新，**立即判残留并清理**，不再空等 60s；
 * `STALE_LOCK_MS` 仍作最后兜底（老版本锁目录没有 pid/心跳文件时靠目录 mtime）。
 */
const heldLocks = new Set()
const STALE_LOCK_MS = 60000
const LOCK_WAIT_MS = 10000
const LOCK_HEARTBEAT_MS = 2000
const LOCK_HEARTBEAT_STALE_MS = 10000
const LOCK_PID_MISSING_STALE_MS = 2000

function lockPidFile(lockDir) {
  return path.join(lockDir, 'pid')
}

function lockHeartbeatFile(lockDir) {
  return path.join(lockDir, 'heartbeat')
}

function readLockPid(lockDir) {
  try {
    const pid = Number(String(fs.readFileSync(lockPidFile(lockDir), 'utf8')).trim())
    return Number.isFinite(pid) && pid > 0 ? pid : NaN
  } catch {
    return NaN
  }
}

function readLockHeartbeat(lockDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(lockHeartbeatFile(lockDir), 'utf8'))
    const at = Number(raw && raw.at)
    return Number.isFinite(at) ? at : NaN
  } catch {
    return NaN
  }
}

/** pid 判活：ESRCH = 进程不存在（残留）；EPERM = 进程在但没权限（视为仍持有）。 */
function pidIsAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return Boolean(error && error.code !== 'ESRCH')
  }
}

function lockIsStale(lockDir) {
  let dirAge = Number.POSITIVE_INFINITY
  try {
    dirAge = Date.now() - fs.statSync(lockDir).mtimeMs
  } catch {
    return true
  }
  if (dirAge > STALE_LOCK_MS) return true
  const heartbeat = readLockHeartbeat(lockDir)
  if (Number.isFinite(heartbeat) && Date.now() - heartbeat > LOCK_HEARTBEAT_STALE_MS) return true
  const pid = readLockPid(lockDir)
  if (Number.isFinite(pid)) return !pidIsAlive(pid)
  // 没有 pid 文件：可能是刚 mkdir 还没写 pid 的窗口；超过 2s 还没有就按残留处理。
  return dirAge > LOCK_PID_MISSING_STALE_MS
}

function writeLockHeartbeat(lockDir) {
  try {
    fs.writeFileSync(lockHeartbeatFile(lockDir), JSON.stringify({ pid: process.pid, at: Date.now() }), 'utf8')
  } catch {
    // 心跳写不了不影响持锁；兜底靠 mtime
  }
}

function removeLockDir(lockDir) {
  try {
    fs.rmSync(lockDir, { recursive: true, force: true })
  } catch {
    // 已被别的进程清掉
  }
}

function lockBusyError(error) {
  return Boolean(error) && /正被另一个进程写入/.test(String(error.message || ''))
}

/** 当前进程是否正持有该库的锁（writeStore 用它决定要不要再加锁）。 */
export function isStoreLockHeld(dataDir) {
  return heldLocks.has(path.resolve(String(dataDir || '')))
}

export function withStoreLock(dataDir, fn, options = {}) {
  const key = path.resolve(String(dataDir || ''))
  if (heldLocks.has(key)) return fn()
  const lockDir = `${storeFile(key)}.lock`
  // 数据目录可能还不存在（首次记录）：先建父目录，否则 mkdir 锁目录会 ENOENT。
  fs.mkdirSync(path.dirname(lockDir), { recursive: true })
  const waitMs = Number.isFinite(Number(options.waitMs)) && Number(options.waitMs) >= 0 ? Number(options.waitMs) : LOCK_WAIT_MS
  const deadline = Date.now() + waitMs
  let acquired = false
  let reclaims = 0
  while (!acquired) {
    try {
      fs.mkdirSync(lockDir)
      acquired = true
      break
    } catch (error) {
      // Windows 并发时锁目录处于删除/创建中间态会返回 EPERM/EACCES（R2 缺陷）：按竞争重试。
      const retryable = error && (error.code === 'EEXIST' || error.code === 'EPERM' || error.code === 'EACCES')
      if (!retryable) throw error
    }
    // R4 缺陷：waitMs=0 时先把明显陈旧的锁回收一次（最多 3 次），再判超时——
    // 否则会因毫秒边界随机抛「正被另一个进程写入」。3 次上限保证持续 EPERM/EACCES 不会死循环。
    if (reclaims < 3 && lockIsStale(lockDir)) {
      removeLockDir(lockDir)
      reclaims += 1
      continue
    }
    if (Date.now() > deadline) throw new Error(`经验库正被另一个进程写入（锁 ${lockDir}），稍后重试`)
    sleepSync(20)
  }
  heldLocks.add(key)
  // 持锁先登记 pid + 心跳：后来者据此判断「持锁进程是否还活着 / 心跳是否停了」。
  try {
    fs.writeFileSync(lockPidFile(lockDir), String(process.pid), 'utf8')
    writeLockHeartbeat(lockDir)
  } catch {
    // 写不了 pid/心跳时退化为老行为（靠 mtime 判陈旧）
  }
  const heartbeatTimer = setInterval(() => writeLockHeartbeat(lockDir), LOCK_HEARTBEAT_MS)
  if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref()
  try {
    return fn()
  } finally {
    heldLocks.delete(key)
    clearInterval(heartbeatTimer)
    removeLockDir(lockDir)
  }
}
