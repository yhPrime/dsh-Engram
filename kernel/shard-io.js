/**
 * 存储原子 IO（从 shard-store.js 拆出）：JSON 读取、原子写、临时文件清理、分片行解码。
 * 不 import shard-store.js / store.js，避免循环依赖。
 */

import fs from 'node:fs'
import path from 'node:path'


function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    const until = Date.now() + ms
    while (Date.now() < until) { /* 退化为忙等 */ }
  }
}

/**
 * 读 JSON 文件：文件不存在返回 null；损坏/被占用时重试 10 次后抛错。
 * 绝不静默返回空——空快照被写回会清空整库（0.13.0 的守卫）。
 */
export function readJsonFile(file, label) {
  let raw = null
  let lastError = null
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    lastError = error
    for (let attempt = 0; attempt < 10 && raw === null; attempt += 1) {
      sleepSync(20)
      try {
        raw = JSON.parse(fs.readFileSync(file, 'utf8'))
      } catch (retryError) {
        lastError = retryError
      }
    }
    if (raw === null) {
      throw new Error(`${label}读取失败（已重试 10 次，文件可能正被写入或已损坏）：${file}：${lastError && lastError.message ? lastError.message : lastError}`)
    }
  }
  return raw
}

/** 写临时文件再 rename（沿用旧 writeStore 的写盘手法，绝不退化成直接覆盖）。 */
function writeFileAtomic(file, text) {
  // D2（2026-11-12）：目标目录里的陈旧 *.tmp 一并清——manifest 的临时文件在根目录，
  // 原来只清 buckets/，根目录 `manifest.json.*.tmp` 会永久残留。
  cleanupStaleTemps(path.dirname(file))
  const temp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  try {
    fs.writeFileSync(temp, text, 'utf8')
    let renamed = false
    let lastError = null
    for (let attempt = 0; attempt < 20 && !renamed; attempt += 1) {
      try {
        fs.renameSync(temp, file)
        renamed = true
      } catch (error) {
        lastError = error
        if (error && (error.code === 'EPERM' || error.code === 'EBUSY' || error.code === 'EACCES')) {
          sleepSync(25)
          continue
        }
        throw error
      }
    }
    if (!renamed) {
      throw new Error(`经验库写入被占用（rename 重试 20 次仍失败）：${lastError && lastError.message ? lastError.message : String(lastError)}`)
    }
  } finally {
    try {
      fs.unlinkSync(temp)
    } catch {
      // 已 rename 掉 / 不存在
    }
  }
}

/** 清掉崩溃留下的 *.tmp（>10 分钟）。 */
function cleanupStaleTemps(dir) {
  const now = Date.now()
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    // R9 缺陷：崩溃残留的 .tmp/.bak 都要 GC（.bak 是两阶段写备份，正常路径会删，崩溃窗口会留）。
    if (!name.endsWith('.tmp') && !name.endsWith('.bak')) continue
    const full = path.join(dir, name)
    try {
      if (now - fs.statSync(full).mtimeMs > 600000) fs.unlinkSync(full)
    } catch {
      // 正被别的进程使用
    }
  }
}

/** 读一个分片文件成记录数组；文件不存在返回 null，损坏抛错。 */
const UTF8_FATAL_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/**
 * 逐行读分片（D3/D4，2026-11-12）：
 *  - 用 `TextDecoder(fatal:true)` 解码每行，非法 UTF-8 **报错并指出文件+行号**（不静默变 U+FFFD）；
 *  - 缺文件默认返回 null（调用方决定语义）；`options.missing === 'throw'` 时明确报错；
 *  - `options.bucket` 给了声明 count 时校验行数：**少于声明即判损坏并报错**，拒绝返回不完整快照；
 *    多于声明说明 manifest 只是旧缓存（D1），交由调用方的自愈逻辑重建，不在这里报错。
 */

function readBucketRows(file, label, options = {}) {
  let buffer
  try {
    buffer = fs.readFileSync(file)
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      if (options.missing === 'throw') throw new Error(`经验库分片丢失：${label}（登记存在但文件不在，拒绝按空库继续）`)
      return null
    }
    throw new Error(`经验库分片读取失败：${label}：${error && error.message ? error.message : error}`)
  }
  const rows = []
  let lineNumber = 0
  let start = 0
  const length = buffer.length
  // BOM：TextDecoder 默认会把首 BOM 吃掉，这里按原始字节判定并明确报错（JSON 不允许 BOM）。
  if (length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    throw new Error(`经验库分片损坏：${label} 第 1 行带 UTF-8 BOM（非法前缀，拒绝静默容忍）`)
  }
  const decodeLine = (startAt, endAt) => {
    lineNumber += 1
    let text
    try {
      text = UTF8_FATAL_DECODER.decode(buffer.subarray(startAt, endAt))
    } catch {
      throw new Error(`经验库分片损坏：${label} 第 ${lineNumber} 行不是合法 UTF-8（编码错误，拒绝静默替换成 U+FFFD）`)
    }
    // UTF-8 BOM 出现在行首：JSON 不允许，Node 的 JSON.parse 却会容忍 → 明确报错，别静默接受。
    if (text.startsWith('\uFEFF')) {
      throw new Error(`经验库分片损坏：${label} 第 ${lineNumber} 行带 UTF-8 BOM（非法前缀，拒绝静默容忍）`)
    }
    if (text.endsWith('\r')) text = text.slice(0, -1)
    if (text.trim() === '') return null
    let row
    try {
      row = JSON.parse(text)
    } catch {
      throw new Error(`经验库分片损坏：${label} 第 ${lineNumber} 行不是合法 JSON`)
    }
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error(`经验库分片损坏：${label} 第 ${lineNumber} 行不是对象`)
    }
    return row
  }
  for (let index = 0; index < length; index += 1) {
    if (buffer[index] !== 0x0a) continue
    const row = decodeLine(start, index)
    if (row !== null) rows.push(row)
    start = index + 1
  }
  // 最后一行没有换行符也要解（JSONL 允许文件末尾无 \n）。
  if (start < length) {
    const row = decodeLine(start, length)
    if (row !== null) rows.push(row)
  }
  const bucket = options.bucket
  if (bucket !== null && bucket !== undefined) {
    const declared = Number(bucket.count)
    if (Number.isFinite(declared) && declared > 0 && rows.length < declared) {
      throw new Error(`经验库分片损坏：${label} 声明 count=${declared}，实际 ${rows.length} 行（拒绝用不完整快照继续）`)
    }
  }
  return rows
}

/**
 * R8 缺陷：多族写盘两边提交——先全部写临时文件，全部成功后再统一 rename。
 * 任何一步失败只删临时文件，已存在的族文件一个字节都不动（避免半写导致丢行/整库不可读）。
 */
function writeManyAtomicFiles(dataDir, writes) {
  if (!Array.isArray(writes) || writes.length === 0) return
  const temps = []
  const renamed = []
  try {
    for (const item of writes) {
      const target = path.join(dataDir, item.rel)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      const temp = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
      temps.push([temp, target])
      fs.writeFileSync(temp, item.text, 'utf8')
    }
    // R8 缺陷：rename 阶段也可能中途失败（只读文件 EPERM）；先把将被覆盖的原文件备份，失败时回滚。
    for (const [temp, target] of temps) {
      let backup = null
      if (fs.existsSync(target)) {
        // R14 缺陷：目标不是普通文件（被目录占位）时给可诊断错误，不把 copyfile/EPERM 抛给调用方。
        let isFile = false
        try { isFile = fs.lstatSync(target).isFile() } catch { isFile = false }
        if (!isFile) throw new Error(`经验库结构损坏：${target} 不是普通文件（拒绝覆盖）`)
        backup = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.bak`
        fs.copyFileSync(target, backup)
      }
      try {
        fs.renameSync(temp, target)
        renamed.push({ target, backup, created: backup === null })
      } catch (error) {
        if (backup !== null) { try { fs.unlinkSync(backup) } catch { /* ignore */ } }
        throw error
      }
    }
    for (const item of renamed) { if (item.backup !== null) { try { fs.unlinkSync(item.backup) } catch { /* ignore */ } } }
  } catch (error) {
    for (const [temp] of temps) { try { fs.unlinkSync(temp) } catch { /* ignore */ } }
    for (const item of renamed) {
      if (item.backup !== null) { try { fs.renameSync(item.backup, item.target) } catch { /* 回滚失败也要继续 */ } }
      else { try { fs.unlinkSync(item.target) } catch { /* 本次新建的文件回滚时删掉，避免未提交行被读自愈提交 */ } }
    }
    throw error
  }
}

/** 记录的分片文本（一行一条，JSON 转义内部换行，保证 Git 行级 diff/merge 可用）。 */
export function bucketTextOf(rows) {
  return `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`
}
export {
  sleepSync,
  writeFileAtomic,
  cleanupStaleTemps,
  writeManyAtomicFiles,
  readBucketRows,
}
