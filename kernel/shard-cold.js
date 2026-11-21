/**
 * 冷档读写（从 shard-store.js 拆出）：扫描、归一化、读取、追加、失败回滚、缺失校验。
 * 不 import shard-store.js / store.js，避免循环依赖。
 */

import fs from 'node:fs'
import path from 'node:path'

import {
  COLD_DIR,
  COLD_NAME_RE,
  coldPath,
  resolveBucketPath,
} from './shard-paths.js'

import {
  bucketTextOf,
  readBucketRows,
} from './shard-io.js'

/**
 * 冷档单文件上限：超了按字母顺序**新开一片** `cold/<year>-<a|b|…>.jsonl`。
 * 原「合并到下一档」作废——合并不会变小，等于没解决（D2/D5）。
 */
export const COLD_MAX_BYTES = 8 * 1024 * 1024

/**
 * 冷档登记规范化：`{years:[{year, count, bytes, files:[{file, count, bytes}]}]}`。
 * 兼容两种落盘形状（早期扁平条目 / D5 的 files[] 分片条目），读侧不用关心写的是哪版。
 */
export function normalizeCold(raw) {
  const source = raw !== null && typeof raw === 'object' && Array.isArray(raw.years) ? raw.years : []
  const byYear = new Map()
  const ensureYear = (year) => {
    const key = Number(year) || 0
    if (!byYear.has(key)) byYear.set(key, { year: key, count: 0, bytes: 0, files: [] })
    return byYear.get(key)
  }
  for (const entry of source) {
    if (entry === null || typeof entry !== 'object') continue
    const year = Number(entry.year) || 0
    if (Array.isArray(entry.files)) {
      const group = ensureYear(year)
      for (const file of entry.files) {
        if (file === null || typeof file !== 'object' || typeof file.file !== 'string' || file.file === '') continue
        group.files.push({ file: file.file, count: Number(file.count) || 0, bytes: Number(file.bytes) || 0 })
      }
      continue
    }
    if (typeof entry.file === 'string' && entry.file !== '') {
      ensureYear(year).files.push({ file: entry.file, count: Number(entry.count) || 0, bytes: Number(entry.bytes) || 0 })
    }
  }
  const years = [...byYear.values()].sort((left, right) => left.year - right.year)
  for (const year of years) {
    year.files.sort((left, right) => (left.file < right.file ? -1 : left.file > right.file ? 1 : 0))
    year.count = year.files.reduce((sum, file) => sum + (Number(file.count) || 0), 0)
    year.bytes = year.files.reduce((sum, file) => sum + (Number(file.bytes) || 0), 0)
  }
  return { years }
}

function scanCold(dataDir) {
  let names = []
  try {
    names = fs.readdirSync(coldPath(dataDir)).filter((name) => COLD_NAME_RE.test(name)).sort()
  } catch {
    names = []
  }
  const years = new Map()
  for (const name of names) {
    let text
    try {
      text = fs.readFileSync(path.join(coldPath(dataDir), name), 'utf8')
    } catch {
      continue
    }
    const year = Number(COLD_NAME_RE.exec(name)[1]) || 0
    if (!years.has(year)) years.set(year, { year, count: 0, bytes: 0, files: [] })
    const group = years.get(year)
    group.files.push({
      file: `${COLD_DIR}/${name}`,
      count: text.split('\n').filter((line) => line.trim() !== '').length,
      bytes: Buffer.byteLength(text, 'utf8'),
    })
  }
  return normalizeCold({ years: [...years.values()] })
}

/** 扫描冷档并归一成 manifest.cold 形状（重建时用：manifest 丢了也不能把冷档登记清空）。 */
export function scanColdNormalized(dataDir) {
  return normalizeCold(scanCold(dataDir))
}
/** 冷档相对旧 manifest 的净增条数（用于识别「行被压缩搬进冷档」的合法少行）。 */
function coldGrowthTotal(dataDir, cold) {
  const declared = normalizeCold(cold)
  let declaredTotal = 0
  for (const year of declared.years) declaredTotal += Number(year.count) || 0
  let actualTotal = 0
  for (const year of scanCold(dataDir).years) actualTotal += Number(year.count) || 0
  return actualTotal - declaredTotal
}

/** D5：manifest.cold 登记了但文件不在的那些冷档文件（空数组 = 全在）。 */
export function missingColdFiles(dataDir, cold) {
  const declared = normalizeCold(cold)
  const missing = []
  for (const year of declared.years) {
    for (const file of year.files) {
      const label = String(file.file || '')
      if (label === '') continue
      try {
        fs.statSync(resolveBucketPath(dataDir, label))
      } catch {
        missing.push(label)
      }
    }
  }
  return missing
}

function coldLetterOf(index) {
  let value = Math.max(0, Math.trunc(Number(index) || 0))
  let letters = ''
  do {
    letters = String.fromCharCode(97 + (value % 26)) + letters
    value = Math.floor(value / 26) - 1
  } while (value >= 0)
  return letters
}

/**
 * 读冷档记录（G3）：`options.years` 给了就只读那几个年份；`manifest.cold` 是登记表。
 * 冷档默认不参与召回、不进关系图/簇统计——调用方（`exp_recall cold:true`）显式来取。
 *
 * 冷档记录**不可反馈**（`exp_feedback`）：它们不在热档 store 里，`applyFeedback` 按 id 找不到
 * 会明确报「没有这条经验」。这是 §7.1 的预期行为，不是 bug——要反馈就先让它回到热档。
 */
export function readColdRecords(dataDir, manifest, options = {}) {
  const dir = String(dataDir || '')
  const cold = normalizeCold(manifest === null || manifest === undefined ? null : manifest.cold)
  const years = Array.isArray(options.years) && options.years.length > 0
    ? new Set(options.years.map((year) => Number(year) || 0))
    : null
  const rows = []
  for (const year of cold.years) {
    if (years !== null && !years.has(Number(year.year))) continue
    for (const file of year.files) {
      const absolute = resolveBucketPath(dir, file.file)
      // D5（2026-11-12）：manifest.cold 登记了但文件不在 → 明确报错，别静默返回 0 条。
      // 只影响 `cold:true` 的显式查询，热档召回与提示段不读这里。
      const loaded = readBucketRows(absolute, file.file, { missing: 'throw' })
      rows.push(...loaded)
    }
  }
  return rows
}

/**
 * 往冷档追加（D2/D5）：`cold/<year>-<a|b|…>.jsonl`，一年一档、单片 ≤ `COLD_MAX_BYTES`，
 * 超了按字母**新开一片**（不合并——合并不会变小）。
 * 每片登记 `{file, count, bytes}`；返回的 `appends` 用于失败回滚（truncate 回原大小）。
 */
export function appendColdRecords(dataDir, cold, records, options = {}) {
  const dir = String(dataDir || '')
  const current = normalizeCold(cold)
  const appends = []
  const list = Array.isArray(records) ? records.filter((row) => row !== null && typeof row === 'object' && !Array.isArray(row)) : []
  if (list.length === 0) return { cold: current, appends }
  const maxBytes = Number.isFinite(Number(options.coldMaxBytes)) ? Number(options.coldMaxBytes) : COLD_MAX_BYTES
  const byYear = new Map()
  for (const row of list) {
    const ts = String(row.lastSeenAt || row.ts || row.registeredAt || '')
    const parsed = Date.parse(ts)
    const year = Number.isFinite(parsed) ? new Date(parsed).getUTCFullYear() : new Date().getUTCFullYear()
    if (!byYear.has(year)) byYear.set(year, [])
    byYear.get(year).push(row)
  }
  fs.mkdirSync(coldPath(dir), { recursive: true })
  for (const [year, rows] of [...byYear.entries()].sort((left, right) => left[0] - right[0])) {
    const group = current.years.find((item) => Number(item.year) === year) || (() => {
      const created = { year, count: 0, bytes: 0, files: [] }
      current.years.push(created)
      current.years.sort((left, right) => left.year - right.year)
      return created
    })()
    const newColdFile = () => {
      const entry = { file: `${COLD_DIR}/${year}-${coldLetterOf(group.files.length)}.jsonl`, count: 0, bytes: 0 }
      group.files.push(entry)
      return entry
    }
    let target = group.files[group.files.length - 1] || newColdFile()
    let pending = []
    let pendingBytes = 0
    const flush = () => {
      if (pending.length === 0) return
      const text = bucketTextOf(pending)
      const bytes = Buffer.byteLength(text, 'utf8')
      const absolute = path.join(dir, target.file)
      let bytesBefore = 0
      try {
        bytesBefore = fs.statSync(absolute).size
      } catch {
        bytesBefore = 0
      }
      fs.appendFileSync(absolute, text, 'utf8')
      target.count = (Number(target.count) || 0) + pending.length
      target.bytes = bytesBefore + bytes
      appends.push({ file: target.file, bytesBefore, bytes, rows: pending.length })
      pending = []
      pendingBytes = 0
    }
    for (const row of rows) {
      const lineBytes = Buffer.byteLength(JSON.stringify(row), 'utf8') + 1
      if (pending.length === 0) {
        // 当前片已有内容且这条放不下 → 按字母新开一片（单片上限靠这里守住）
        if ((Number(target.bytes) || 0) > 0 && (Number(target.bytes) || 0) + lineBytes > maxBytes) target = newColdFile()
      } else if ((Number(target.bytes) || 0) + pendingBytes + lineBytes > maxBytes) {
        flush()
        target = newColdFile()
      }
      pending.push(row)
      pendingBytes += lineBytes
    }
    flush()
  }
  for (const year of current.years) {
    year.count = year.files.reduce((sum, file) => sum + (Number(file.count) || 0), 0)
    year.bytes = year.files.reduce((sum, file) => sum + (Number(file.bytes) || 0), 0)
  }
  return { cold: normalizeCold(current), appends }
}

/** 压缩失败回滚：把追加进冷档的内容截掉（append-only，截回原大小即可）。 */
function rollbackColdAppends(dir, appends) {
  for (const item of [...(Array.isArray(appends) ? appends : [])].reverse()) {
    const absolute = path.join(dir, item.file)
    try {
      if (Number(item.bytesBefore) <= 0) fs.unlinkSync(absolute)
      else fs.truncateSync(absolute, Number(item.bytesBefore))
    } catch {
      // 回滚失败只能留在日志里；数据仍在备份里
    }
  }
}
export {
  coldLetterOf,
  scanCold,
  coldGrowthTotal,
  rollbackColdAppends,
}
