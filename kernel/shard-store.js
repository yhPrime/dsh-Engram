/**
 * 存储分片层（0.14.0 P1）：manifest + `buckets/<typeId>.<k>.jsonl` + 一次性迁移。
 *
 * 为什么切「类型」：召回先 routeCluster 再打分，命中类型只要读该类型的分片；
 * 而 `sameTask` 强制 `rowTypeId === thisTypeId`（store.js），跨类型的合并/取代本来就不存在，
 * 所以按类型分片后写入语义逐字节不变。
 *
 * 目录（计划书 §4.1）：
 *   manifest.json                  # 索引与元数据，唯一入口
 *   buckets/<typeId>.<0|1>.jsonl   # 定数 K=2，一行一条记录，无缩进
 *   cold/<year>.jsonl              # 冷档（P2 才写；本层只读 manifest 里的登记）
 *   exp-lib.legacy.json            # 迁移时由 exp-lib.json 改名保留，只读，回滚用
 *
 * 本文件只管「目录形态」：路径、分片读写、manifest 结构、迁移落盘。
 * 归一化语义（typeId 悬空、G 重放、结构校验）留在 store.js，两条读路径共用同一份归一化，
 * 这样迁移前后逐字段等价是结构性保证，而不是靠两边各写一遍。
 */

import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

import { tokenize } from './kernel.js'
import { buildCluster } from './cluster.js'

/** manifest schema 版本（2 = 分片布局；1 = 旧的单文件 exp-lib.json）。 */
export const SHARD_SCHEMA = 2
/** 每类型定数桶数：调大只增加粒度与文件数，不改语义。 */
export const SHARD_K = 2
export const MANIFEST_FILE = 'manifest.json'
export const BUCKETS_DIR = 'buckets'
export const COLD_DIR = 'cold'
/** 迁移后的旧库文件名（rollback = 改回 exp-lib.json 再删 manifest+buckets）。 */
export const LEGACY_FILE = 'exp-lib.legacy.json'
/** 迁移来源（旧单文件名）；本文件不 import store.js，避免循环依赖。 */
export const LEGACY_SOURCE_FILE = 'exp-lib.json'
/**
 * 单桶上限，超过触发压缩（P2）。2026-11-12 计划书 §7.10 定调：容量机制是**安全阀**，
 * 正常使用（经验量受使用范围限制）永不触发淘汰；参数为此上调 1 MiB → 2 MiB。
 */
export const MAX_BUCKET_BYTES = 2 * 1024 * 1024
/** 压缩后目标水位。 */
export const COMPACT_TARGET_RATIO = 0.8
/** 全库可见条数上限（安全阀，计划书 §7.10 上调 6000 → 20000）。 */
export const N_MAX = 20000
/**
 * 热档字节闸（D4，2026-11-12；计划书 §7.10 上调 12 MiB → 32 MiB）：所有 `buckets/*.jsonl`
 * 字节之和超过它就压缩当前最大的分片。与类型分布无关；与 `N_MAX` 取先到。
 * 为什么需要它：实测热点类型 ty_code 占 33.6%，单桶 490 条就撞旧 1 MB 闸，条数闸永远到不了，
 * 原来的「热档 ≈ 8 MB」只是桶上限凑出来的巧合。定调后只当安全阀，正常使用不触发。
 */
export const HOT_MAX_BYTES = 32 * 1024 * 1024
/**
 * 单条记录落盘的平均字节数（D5，2026-11-12）：1.4 KB 是 `JSON.stringify` 的码元长度，
 * UTF-8 落盘实测 2,138 B/条。凡按字节算上限、算压缩触发的地方都用这个，别用条数×1.4KB。
 */
export const AVG_RECORD_BYTES = 2138
/**
 * 冷档单文件上限：超了按字母顺序**新开一片** `cold/<year>-<a|b|…>.jsonl`。
 * 原「合并到下一档」作废——合并不会变小，等于没解决（D2/D5）。
 */
export const COLD_MAX_BYTES = 8 * 1024 * 1024
/** 冷档保留年数。 */
export const COLD_RETAIN_YEARS = 3
/** manifest 上限；超出就降采样簇签名，不涨文件。 */
export const MANIFEST_MAX_BYTES = 128 * 1024
/** 分片读缓存上限。 */
export const CACHE_MAX_BYTES = 32 * 1024 * 1024
/** manifest.pending 最多登记几条（提示段只需要最近几条）。 */
export const PENDING_INDEX_LIMIT = 50
/** manifest.recent 每会话最多几条 / 总共最多几条（G5）。 */
export const RECENT_PER_SESSION = 5
export const RECENT_LIMIT = 100
/** manifest.stats 的体积上限（G6）。 */
export const STATS_MAX_BYTES = 3 * 1024
/** 墓碑保留天数（与 store.js 的 DEFAULT_TOMBSTONE_DAYS 同值；本文件不 import store.js 以免循环）。 */
export const TOMBSTONE_DAYS = 30
/** 压缩前备份目录（相对 dataDir）。 */
export const COMPACT_BACKUP_DIR = '.locks'

/** 文件数上界：1 manifest + maxTypes×K + 冷档(≤4 年) + legacy(1)。 */
export function shardFileBudget(maxTypes = 24) {
  return 1 + Math.max(0, Math.trunc(Number(maxTypes) || 0)) * SHARD_K + COLD_RETAIN_YEARS + 1 + 1
}

export function manifestPath(dataDir) {
  return path.join(String(dataDir || ''), MANIFEST_FILE)
}

export function bucketsPath(dataDir) {
  return path.join(String(dataDir || ''), BUCKETS_DIR)
}

export function coldPath(dataDir) {
  return path.join(String(dataDir || ''), COLD_DIR)
}

export function legacyPath(dataDir) {
  return path.join(String(dataDir || ''), LEGACY_FILE)
}

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    const until = Date.now() + ms
    while (Date.now() < until) { /* 退化为忙等 */ }
  }
}

/**
 * 稳定桶号：`hash(record.id) % K`。同一条记录永远落同一个桶（跨进程、跨机器一致），
 * 压缩/重写只移动内容、不改变归属。
 */
export function shardBucketIndex(id, k = SHARD_K) {
  const width = Math.max(1, Math.trunc(Number(k) || SHARD_K))
  const digest = createHash('sha1').update(String(id === undefined || id === null ? '' : id)).digest()
  return digest.readUInt32BE(0) % width
}

/** 文件名里的类型 id 只保留安全字符（类型 id 是 ty_<hex>，这里只是防御）。 */
export function shardFileName(typeId, index) {
  const safe = String(typeId || 'ty_other').replace(/[^A-Za-z0-9_-]/g, '_')
  return `${safe}.${Math.max(0, Math.trunc(Number(index) || 0))}.jsonl`
}

/** manifest 里登记的相对路径（统一正斜杠，Git 跨平台一致）。 */
export function shardRelPath(typeId, index) {
  return `${BUCKETS_DIR}/${shardFileName(typeId, index)}`
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
      throw new Error(`${label}读取失败（文件可能正被写入）：${lastError && lastError.message ? lastError.message : lastError}`)
    }
  }
  return raw
}

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

function normalizeManifest(raw) {
  return {
    schema: Number(raw.schema) || SHARD_SCHEMA,
    version: Number(raw.version) || 1,
    types: Array.isArray(raw.types) ? raw.types : [],
    clusters: Array.isArray(raw.clusters) ? raw.clusters : [],
    buckets: Array.isArray(raw.buckets)
      ? raw.buckets.filter((bucket) => bucket && typeof bucket === 'object' && typeof bucket.file === 'string' && bucket.file !== '')
      : [],
    pending: Array.isArray(raw.pending) ? raw.pending : [],
    recent: Array.isArray(raw.recent) ? raw.recent : [],
    stats: raw.stats !== null && typeof raw.stats === 'object' && !Array.isArray(raw.stats) ? raw.stats : null,
    cold: normalizeCold(raw.cold),
    ...(typeof raw.migratedFrom === 'string' && raw.migratedFrom !== '' ? { migratedFrom: raw.migratedFrom } : {}),
  }
}

/**
 * 只读 manifest 文件本身（不判断它是否过期）。
 *
 * **manifest 是可重建缓存，事实源只有 `buckets/*.jsonl` + `cold/*.jsonl`**：
 * 它只是「索引 + 派生统计」，Git 冲突随便取一边，下次读取会由 store.js 的
 * `readManifest()` 自愈重建。所以这里的解析失败只是「缓存坏了」，不是数据坏了。
 */
export function readManifestFile(dataDir) {
  const raw = readJsonFile(manifestPath(dataDir), '经验库 manifest ')
  if (raw === null) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('经验库 manifest 结构损坏：顶层应为对象')
  if (raw.types !== undefined && raw.types !== null && !Array.isArray(raw.types)) {
    throw new Error(`经验库 manifest 结构损坏：types 应为数组，实际是 ${typeof raw.types}`)
  }
  if (raw.buckets !== undefined && raw.buckets !== null && !Array.isArray(raw.buckets)) {
    throw new Error(`经验库 manifest 结构损坏：buckets 应为数组，实际是 ${typeof raw.buckets}`)
  }
  return normalizeManifest(raw)
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
    if (!name.endsWith('.tmp')) continue
    const full = path.join(dir, name)
    try {
      if (now - fs.statSync(full).mtimeMs > 600000) fs.unlinkSync(full)
    } catch {
      // 正被别的进程使用
    }
  }
}

function resolveBucketPath(dataDir, rel) {
  const root = path.resolve(String(dataDir || ''))
  const resolved = path.resolve(root, rel)
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`经验库 manifest 里的分片路径越界：${rel}`)
  }
  return resolved
}

/**
 * 读全部分片记录（按 manifest 登记顺序）。
 * 单桶损坏/丢失/UTF-8 非法/行数少于 manifest 声明都抛错，不静默少读——
 * 少读会被下一次写回覆盖成永久丢失（D3，2026-11-12）。
 */
export function readShardRecords(dataDir, manifest) {
  if (manifest === null || manifest === undefined) throw new Error('readShardRecords 需要 manifest')
  const rows = []
  for (const bucket of manifest.buckets) {
    const file = resolveBucketPath(dataDir, bucket.file)
    const loaded = readBucketRows(file, bucket.file, { missing: 'throw', bucket })
    rows.push(...loaded)
  }
  return rows
}

function latestTsOf(rows) {
  let latest = ''
  for (const row of rows) {
    const ts = String(row.lastSeenAt || row.ts || row.registeredAt || '')
    if (ts > latest) latest = ts
  }
  return latest
}

/** 分片内容指纹：增量写只重写指纹变了的文件（字节相等 ⇒ 内容相等）。 */
export function contentHash(text) {
  return createHash('sha1').update(String(text)).digest('hex')
}

/** 记录的分片文本（一行一条，JSON 转义内部换行，保证 Git 行级 diff/merge 可用）。 */
export function bucketTextOf(rows) {
  return `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`
}

/**
 * 记录分桶（§4.3）：按 `record.typeId` 归类型，类型不存在或为系统兜底 → `ty_other`；
 * 桶号 = `hash(record.id) % K`。空桶不落文件。
 * @returns {Map<string, {rel: string, typeId: string, index: number, rows: object[]}>}
 */
export function groupRecordsByBucket(store, k = SHARD_K) {
  const types = Array.isArray(store && store.types) ? store.types : []
  const known = new Set(types.filter((type) => type && typeof type === 'object').map((type) => String(type.id)))
  const groups = new Map()
  for (const row of Array.isArray(store && store.experiences) ? store.experiences : []) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) continue
    const rawTypeId = String(row.typeId || '')
    const typeId = known.has(rawTypeId) ? rawTypeId : 'ty_other'
    const index = shardBucketIndex(row.id, k)
    const rel = shardRelPath(typeId, index)
    let group = groups.get(rel)
    if (group === undefined) {
      group = { rel, typeId, index, rows: [] }
      groups.set(rel, group)
    }
    group.rows.push(row)
  }
  return groups
}

/** 删掉不再登记的分片（桶变空 / 桶号变了 / 类型被删）；空桶不落文件。 */
function removeStaleBuckets(dir, keepNames) {
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue
    if (keepNames.has(name)) continue
    try {
      fs.unlinkSync(path.join(dir, name))
    } catch {
      // 删不掉只是多一个文件，不影响正确性（manifest 不登记它就不会被读）
    }
  }
}

const BUCKET_NAME_RE = /^(.+)\.(\d+)\.jsonl$/
const COLD_NAME_RE = /^(\d{4})(?:-[a-z]+)?\.jsonl$/

/** 有没有分片数据——用来区分「manifest 缺失」是未迁移的老库，还是缓存丢了。 */
export function hasShardFiles(dataDir) {
  for (const sub of [bucketsPath(dataDir), coldPath(dataDir)]) {
    try {
      if (fs.readdirSync(sub).some((name) => name.endsWith('.jsonl'))) return true
    } catch {
      // 目录不存在
    }
  }
  return false
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

/**
 * 扫全部分片（事实源）：`buckets/*.jsonl` → 记录 + manifest 需要的索引项。
 * 只给「重建 manifest」用；正常读由 manifest 直接给出文件清单，不必扫目录。
 */
export function scanShards(dataDir) {
  const dir = String(dataDir || '')
  const dirBuckets = bucketsPath(dir)
  let names = []
  try {
    names = fs.readdirSync(dirBuckets).filter((name) => BUCKET_NAME_RE.test(name)).sort()
  } catch {
    names = []
  }
  const records = []
  const buckets = []
  for (const name of names) {
    const full = path.join(dirBuckets, name)
    // 重建路径同样逐行做 UTF-8 校验：坏字节不能因为「manifest 坏了要重建」就被吞成 U+FFFD。
    const rows = readBucketRows(full, `${BUCKETS_DIR}/${name}`)
    records.push(...rows)
    buckets.push({
      file: `${BUCKETS_DIR}/${name}`,
      typeId: BUCKET_NAME_RE.exec(name)[1],
      count: rows.length,
      bytes: fs.statSync(full).size,
      latestTs: latestTsOf(rows),
    })
  }
  return { records, buckets, cold: scanCold(dir) }
}

/**
 * manifest 与磁盘是否对不上（分片文件集合 / 字节数）。
 * 字节数对不上就是「两台设备各写一半、manifest 只取了一边」的典型症状 → 缓存过期。
 */
export function shardsMismatch(dataDir, manifest) {
  if (manifest === null || manifest === undefined) return true
  const dirBuckets = bucketsPath(dataDir)
  const entries = new Map()
  for (const bucket of manifest.buckets) {
    const name = path.basename(bucket.file)
    if (name !== '') entries.set(name, bucket)
  }
  let names = []
  try {
    names = fs.readdirSync(dirBuckets).filter((name) => BUCKET_NAME_RE.test(name))
  } catch {
    names = []
  }
  if (names.length !== entries.size) return true
  for (const name of names) {
    const entry = entries.get(name)
    if (entry === undefined) return true
    try {
      if (Number(entry.bytes) !== fs.statSync(path.join(dirBuckets, name)).size) return true
    } catch {
      return true
    }
  }
  // 冷档也按字节核一遍（append-only，字节数是可靠指纹）。
  const cold = normalizeCold(manifest.cold)
  const coldNames = new Set()
  try {
    for (const name of fs.readdirSync(coldPath(dataDir))) {
      if (COLD_NAME_RE.test(name)) coldNames.add(name)
    }
  } catch {
    coldNames.clear()
  }
  let declaredCold = 0
  for (const year of cold.years) {
    for (const file of year.files) {
      declaredCold += 1
      const name = path.basename(file.file)
      if (!coldNames.has(name)) return true
      try {
        if (Number(file.bytes) !== fs.statSync(path.join(coldPath(dataDir), name)).size) return true
      } catch {
        return true
      }
    }
  }
  if (declaredCold !== coldNames.size) return true
  return false
}

/**
 * D3（2026-11-12）：自愈重建前核对旧 manifest 的声明，**不允许用少行结果抹平丢行**。
 *
 * 只检查「旧 manifest 说 count > 0」的分片：
 *  - 文件不在 → 报错（重建会把它当没登记过，数据就永久消失）；
 *  - 实际行数 < 声明 → 报错（被清空/截断，重建会把损失写进新 manifest）。
 * 行数 > 声明不算损坏（manifest 只是可重建缓存，外部追加/另一侧写入了更多行），交给重建自愈。
 * 旧 manifest 本身坏了/缺失时调用方没有声明可比，跳过（没有事实可对照，只能按现有分片重建）。
 */
export function assertDeclaredBucketsIntact(dataDir, buckets, cold = null) {
  if (!Array.isArray(buckets)) return
  const shrunk = []
  for (const bucket of buckets) {
    if (bucket === null || bucket === undefined) continue
    const declared = Number(bucket.count)
    if (!Number.isFinite(declared) || declared <= 0) continue
    const label = String(bucket.file || '')
    if (label === '') continue
    const file = resolveBucketPath(dataDir, label)
    let actual = 0
    try {
      const rows = readBucketRows(file, label)
      actual = rows.length
    } catch (error) {
      // UTF-8/JSON 损坏照常抛出（那是另一种损坏，不在这里放行）。
      if (error && String(error.message).includes('不是合法 UTF-8')) throw error
      if (error && String(error.message).includes('不是合法 JSON')) throw error
      actual = 0
    }
    if (actual < declared) shrunk.push({ label, declared, actual })
  }
  if (shrunk.length === 0) return
  const missing = shrunk.reduce((sum, item) => sum + (item.declared - item.actual), 0)
  // 压缩/半提交的合法形态：热档桶少行、但冷档比旧 manifest 记录的多（行被搬进 cold 了）。
  // 这时重建是安全的——`rebuildManifest` 用 scanCold 把冷档原样登记，不会丢。
  if (coldGrowthTotal(dataDir, cold) >= missing) return
  const first = shrunk[0]
  throw new Error(`经验库分片损坏：${first.label} 声明 count=${first.declared}，实际 ${first.actual} 行（拒绝用不完整快照重建 manifest）`)
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

/**
 * 簇签名落 manifest（§4.2 / §7.3）：只维护「变了的类型」。
 * 与上一条完全相同的签名/统计原样沿用（对象引用都不换），类型被删则整条移除。
 * 之所以能这样：簇是 type 的派生视图，同一批记录必然算出同一份签名。
 */
export function manifestClusters(store, previous = null) {
  const previousById = new Map()
  if (previous !== null && previous !== undefined && Array.isArray(previous.clusters)) {
    for (const cluster of previous.clusters) {
      const key = String((cluster && (cluster.typeId || cluster.id)) || '')
      if (key !== '') previousById.set(key, cluster)
    }
  }
  const known = new Set((Array.isArray(store && store.types) ? store.types : []).map((type) => String(type && type.id)))
  const clusters = Array.isArray(store && store.clusters) ? store.clusters : []
  const out = []
  for (const cluster of clusters) {
    if (cluster === null || typeof cluster !== 'object') continue
    const typeId = String(cluster.typeId || cluster.id || '')
    if (typeId === '' || !known.has(typeId)) continue
    const signature = cluster.signature !== null && typeof cluster.signature === 'object' ? cluster.signature : {}
    const stats = cluster.stats !== null && typeof cluster.stats === 'object' ? cluster.stats : {}
    const before = previousById.get(typeId)
    if (before !== undefined
      && sameJson(before.signature, signature)
      && sameJson(before.stats, stats)
      && before.name === cluster.name) {
      out.push(before)
      continue
    }
    out.push({
      id: cluster.id,
      typeId,
      name: cluster.name,
      description: cluster.description,
      system: cluster.system,
      version: cluster.version,
      signature: {
        artifacts: Array.isArray(signature.artifacts) ? signature.artifacts : [],
        tokens: Array.isArray(signature.tokens) ? signature.tokens : [],
        cgrams: Array.isArray(signature.cgrams) ? signature.cgrams : [],
      },
      stats: { ...stats },
    })
  }
  return out
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

/** 提示段「待判定」只读 manifest（§4.2），不加载经验正文。 */
function pendingEntries(store) {
  const rows = (Array.isArray(store && store.experiences) ? store.experiences : [])
    .filter((row) => row && !row.deleted_at && !row.superseded_by && !row.retired_at && row.verdict === 'pending')
    .sort((left, right) => String(right.registeredAt || right.ts || '').localeCompare(String(left.registeredAt || left.ts || '')))
    .slice(0, PENDING_INDEX_LIMIT)
  return rows.map((row) => ({
    id: String(row.id || ''),
    typeId: String(row.typeId || 'ty_other'),
    intent: String(row.intent || '').slice(0, 120),
  }))
}

/** recent 的统一排序：at 倒序、id 升序（同秒也确定，全量与增量两条路才对得上）。 */
function compareRecent(left, right) {
  return String(right.at || '').localeCompare(String(left.at || ''))
    || String(left.id || '').localeCompare(String(right.id || ''))
}

/** 每会话 ≤perSession、总 ≤limit。全量（recentEntries）与增量（writeTypeShards）共用同一套。 */
function capRecentList(list, perSession = RECENT_PER_SESSION, limit = RECENT_LIMIT) {
  const groups = new Map()
  for (const item of Array.isArray(list) ? list : []) {
    if (item === null || typeof item !== 'object') continue
    const sessionId = String(item.sessionId || '')
    if (sessionId === '') continue
    if (!groups.has(sessionId)) groups.set(sessionId, [])
    groups.get(sessionId).push(item)
  }
  const out = []
  for (const group of groups.values()) {
    group.sort(compareRecent)
    out.push(...group.slice(0, perSession))
  }
  out.sort(compareRecent)
  return out.slice(0, limit)
}

/** 最近写入（G5）：每会话 ≤5、总计 ≤100；只收有 sessionId 的行。
 *  每条带 `typeId`：P3 的 recent 段要按 `{id, typeId}` 定向取行（G2），缺它就只能扫全部分片。 */
export function recentEntries(store, options = {}) {
  const perSession = Math.max(1, Math.trunc(Number(options.perSession) || RECENT_PER_SESSION))
  const limit = Math.max(1, Math.trunc(Number(options.limit) || RECENT_LIMIT))
  const list = []
  for (const row of Array.isArray(store && store.experiences) ? store.experiences : []) {
    if (row === null || typeof row !== 'object') continue
    const sessionId = typeof row.sessionId === 'string' ? row.sessionId : ''
    if (sessionId === '') continue
    list.push({
      sessionId,
      id: String(row.id || ''),
      typeId: String(row.typeId || 'ty_other'),
      intent: String(row.intent || '').slice(0, 80),
      at: String(row.lastSeenAt || row.ts || row.registeredAt || ''),
    })
  }
  return capRecentList(list, perSession, limit)
}

/** 单类型统计的空壳：count 是全部行，visible 是可见行，其余按各自的标记独立计数。 */
function emptyTypeStats() {
  return { count: 0, visible: 0, deleted: 0, superseded: 0, retired: 0, topTokens: [] }
}

function topTokensOf(tokens) {
  return [...tokens.entries()]
    .sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
    .slice(0, 8)
    .map(([entity, count]) => ({ entity, count }))
}

/**
 * 一批行 → 该类型的统计项 + 唯一 taskId 集合 + recent 条目。
 * `visible` 是行数、taskId 去重后是任务数（多步任务 kind=step 同 taskId 只算 1 个）。
 */
function typeStatsOfRows(rows) {
  const entry = emptyTypeStats()
  const tasks = new Set()
  const tokens = new Map()
  const valid = (Array.isArray(rows) ? rows : []).filter((row) => row !== null && typeof row === 'object' && !Array.isArray(row))
  for (const row of valid) {
    entry.count += 1
    if (row.deleted_at) entry.deleted += 1
    if (row.superseded_by) entry.superseded += 1
    if (row.retired_at) entry.retired += 1
    if (!row.deleted_at && !row.superseded_by && !row.retired_at) {
      entry.visible += 1
      tasks.add(String(row.taskId || row.id || ''))
      for (const token of new Set(tokenize(String(row.intent || '')))) {
        if (String(token).length >= 2) tokens.set(token, (tokens.get(token) || 0) + 1)
      }
    }
  }
  entry.topTokens = topTokensOf(tokens)
  return { entry, tasks, recent: recentEntries({ experiences: valid }) }
}

/**
 * 全局 topEntities = 各类型前 8 词合并后取前 8。
 *
 * 为什么不直接数「全库每个词的频次」：那样无法增量维护（改一个类型要减掉它的旧贡献，
 * 而全量词频表放不进 3 KiB 的 stats）。改成「每类型前 8 合并」后，全量路径与
 * `writeTypeShards` 的增量路径**逐字段一致**，代价是某个类型排第 9+ 的词不会进全局榜——
 * 词频榜本来就只是概览，这个折中是显式的。
 */
function mergeTopTokens(byType) {
  const counts = new Map()
  for (const entry of Object.values(byType)) {
    for (const token of Array.isArray(entry.topTokens) ? entry.topTokens : []) {
      if (token === null || typeof token !== 'object' || typeof token.entity !== 'string' || token.entity === '') continue
      counts.set(token.entity, (counts.get(token.entity) || 0) + (Number(token.count) || 0))
    }
  }
  return topTokensOf(counts)
}

function summarizeStats(byType, tasksByType) {
  const totals = { all: 0, visible: 0, deleted: 0, superseded: 0, retired: 0 }
  for (const entry of Object.values(byType)) {
    totals.all += Number(entry.count) || 0
    totals.visible += Number(entry.visible) || 0
    totals.deleted += Number(entry.deleted) || 0
    totals.superseded += Number(entry.superseded) || 0
    totals.retired += Number(entry.retired) || 0
  }
  return downsampleStats({ ...totals, byType, tasksByType, topEntities: mergeTopTokens(byType) })
}

/**
 * manifest.stats（G6）：控制台概览只读这里，不必加载全量经验。
 * 口径与 store.js 的 statsOf 一致（`deleted_at` 优先，其次 superseded_by / retired_at）。
 *
 * `byType[typeId].visible` 是**行数**；`tasksByType[typeId]` 是**按 taskId 去重的任务数**
 * （多步任务 kind=step 同一个 taskId 只算一次）——`exp_type list` 的 count 用后者，
 * 两者不可互推，缺了 multi-step 就会对不上（P3-B 实测）。
 */
export function statsEntries(store) {
  const rows = Array.isArray(store && store.experiences) ? store.experiences : []
  const groups = new Map()
  for (const row of rows) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) continue
    const typeId = String(row.typeId || 'ty_other')
    if (!groups.has(typeId)) groups.set(typeId, [])
    groups.get(typeId).push(row)
  }
  const byType = {}
  const tasksByType = {}
  for (const [typeId, groupRows] of groups) {
    const computed = typeStatsOfRows(groupRows)
    byType[typeId] = computed.entry
    if (computed.tasks.size > 0) tasksByType[typeId] = computed.tasks.size
  }
  return summarizeStats(byType, tasksByType)
}

/** stats 超过 3 KiB 就逐级降采样（先砍全局词表、再砍各类型词表、最后砍零可见类型），总量口径不动。 */
function downsampleStats(stats) {
  const sizeOf = () => Buffer.byteLength(JSON.stringify(stats), 'utf8')
  if (sizeOf() <= STATS_MAX_BYTES) return stats
  for (const limit of [4, 0]) {
    stats.topEntities = mergeTopTokens(stats.byType).slice(0, limit)
    if (sizeOf() <= STATS_MAX_BYTES) return stats
  }
  for (const limit of [4, 0]) {
    for (const entry of Object.values(stats.byType)) entry.topTokens = (Array.isArray(entry.topTokens) ? entry.topTokens : []).slice(0, limit)
    stats.topEntities = limit === 0 ? [] : mergeTopTokens(stats.byType)
    if (sizeOf() <= STATS_MAX_BYTES) return stats
  }
  const compactByType = {}
  const compactTasks = {}
  for (const [typeId, entry] of Object.entries(stats.byType)) {
    if ((Number(entry.visible) || 0) > 0) {
      compactByType[typeId] = entry
      if (stats.tasksByType[typeId] !== undefined) compactTasks[typeId] = stats.tasksByType[typeId]
    }
  }
  stats.byType = compactByType
  stats.tasksByType = compactTasks
  if (sizeOf() <= STATS_MAX_BYTES) return stats
  stats.byType = {}
  stats.tasksByType = {}
  return stats
}

/** manifest 超上限就降采样签名（不涨文件、不丢记录）。 */
function downsampleManifest(manifest) {
  let text = `${JSON.stringify(manifest, null, 2)}\n`
  if (Buffer.byteLength(text, 'utf8') <= MANIFEST_MAX_BYTES) return manifest
  manifest.clusters = manifest.clusters.map((cluster) => ({
    ...cluster,
    signature: {
      artifacts: Array.isArray(cluster.signature && cluster.signature.artifacts) ? [...cluster.signature.artifacts] : [],
      tokens: Array.isArray(cluster.signature && cluster.signature.tokens) ? [...cluster.signature.tokens] : [],
      cgrams: Array.isArray(cluster.signature && cluster.signature.cgrams) ? [...cluster.signature.cgrams] : [],
    },
    stats: { ...(cluster.stats || {}) },
  }))
  let limit = 8
  while (limit >= 1) {
    for (const cluster of manifest.clusters) {
      for (const key of ['artifacts', 'tokens', 'cgrams']) {
        const list = cluster.signature[key]
        if (Array.isArray(list) && list.length > limit) cluster.signature[key] = list.slice(0, limit)
      }
    }
    text = `${JSON.stringify(manifest, null, 2)}\n`
    if (Buffer.byteLength(text, 'utf8') <= MANIFEST_MAX_BYTES) return manifest
    limit = Math.floor(limit / 2)
  }
  for (const cluster of manifest.clusters) cluster.signature = { artifacts: [], tokens: [], cgrams: [] }
  return manifest
}

export function buildManifest(store, buckets, previous = null, options = {}) {
  const types = Array.isArray(store && store.types) ? store.types.filter((type) => type && typeof type === 'object') : []
  const previousCold = previous !== null && previous !== undefined && previous.cold !== null && previous.cold !== undefined
    ? previous.cold
    : options.cold
  // 故意不写 updated_at（D1，2026-11-12）：manifest 每次记录都会重写，
  // 时间戳是纯噪音，而且正是 Git 冲突里最容易被两边都改的一行。
  const manifest = {
    schema: SHARD_SCHEMA,
    version: Number(store && store.version) || 1,
    types: types.map((type) => ({ ...type })),
    clusters: manifestClusters(store, previous),
    buckets: Array.isArray(buckets) ? buckets : [],
    pending: pendingEntries(store),
    recent: Array.isArray(options.recent) ? options.recent : recentEntries(store),
    stats: options.stats !== undefined && options.stats !== null ? options.stats : statsEntries(store),
    cold: normalizeCold(previousCold),
  }
  const migratedFrom = options.migratedFrom
    || (previous !== null && previous !== undefined && typeof previous.migratedFrom === 'string' ? previous.migratedFrom : '')
  if (typeof migratedFrom === 'string' && migratedFrom !== '') manifest.migratedFrom = migratedFrom
  return downsampleManifest(manifest)
}

/**
 * 写盘通知（task-7）：`writeManifest` 是「一次写盘收尾」的唯一入口，写完就通知监听者。
 * store.js 在这里挂读缓存失效（`onDataDirWritten` → `clearStoreReadCache`），
 * 这样 writeStore / writeTypeShards / rebuildManifest / 迁移 全都自动覆盖，不用各写一遍。
 * 用登记表而不是直接 import store.js，是为了避免 store ↔ shard-store 循环依赖。
 */
const writeNotifiers = new Set()

export function onDataDirWritten(listener) {
  if (typeof listener !== 'function') return () => {}
  writeNotifiers.add(listener)
  return () => writeNotifiers.delete(listener)
}

function notifyWritten(dataDir) {
  for (const listener of writeNotifiers) {
    try {
      listener(dataDir)
    } catch {
      // 监听者自己的问题，不影响落盘结果
    }
  }
}

/** 写 manifest（永远最后写：读者看到 manifest 就说明数据已就位）。 */
export function writeManifest(dataDir, manifest) {
  const file = manifestPath(dataDir)
  const text = `${JSON.stringify(manifest, null, 2)}\n`
  writeFileAtomic(file, text)
  notifyWritten(dataDir)
  return { file, bytes: Buffer.byteLength(text, 'utf8') }
}

/**
 * 读缓存指纹（task-7 / §4.8）：manifest + 旧单文件 + 每个 `buckets|cold` 文件的
 * `mtimeNs:size:ino`。分片后 `readStore` 要 open+parse ≤50 个文件（4.4 MB 量级），
 * 而指纹只是一串 stat（~0.2 ms）——指纹不变就直接用缓存对象。
 *
 * 写盘必然改这些文件的 mtimeNs/size/ino，所以 P3 直接调 `writeTypeShards` 也不会让缓存读到旧数据；
 * `writeManifest` 末尾另有主动失效通知（同进程立刻一致）。
 */
export function storageFingerprint(dataDir) {
  const dir = String(dataDir || '')
  const parts = []
  const statPart = (label, file) => {
    try {
      const stat = fs.statSync(file, { bigint: true })
      parts.push(`${label}:${stat.mtimeNs}:${stat.size}:${stat.ino}`)
    } catch {
      parts.push(`${label}:-`)
    }
  }
  statPart('m', manifestPath(dir))
  statPart('l', path.join(dir, LEGACY_SOURCE_FILE))
  for (const [label, sub] of [['b', bucketsPath(dir)], ['c', coldPath(dir)]]) {
    let names = []
    try {
      names = fs.readdirSync(sub).filter((name) => name.endsWith('.jsonl')).sort()
    } catch {
      names = []
    }
    for (const name of names) statPart(`${label}/${name}`, path.join(sub, name))
  }
  return parts.join('|')
}

/**
 * 把整个 store 落成「分片 + manifest」。
 *
 * 增量（P2）：按内容指纹比对——指纹没变的分片**一个字节都不碰**（mtime 不变），
 * 只有变更类型的分片被重写。顺序固定：先写全部分片，最后写 manifest。
 * @returns {object} 写出的 manifest
 */
export function writeShards(dataDir, store, previousManifest = null, options = {}) {
  const dir = String(dataDir || '')
  if (dir === '') throw new Error('writeShards 需要 dataDir（.exp 根目录）')
  const k = Number.isFinite(Number(options.k)) ? Math.max(1, Math.trunc(Number(options.k))) : SHARD_K
  const dirBuckets = bucketsPath(dir)
  fs.mkdirSync(dirBuckets, { recursive: true })
  const groups = groupRecordsByBucket(store, k)
  const typeOrder = new Map((Array.isArray(store && store.types) ? store.types : [])
    .map((type, index) => [String(type && type.id), index]))
  const files = [...groups.values()].sort((left, right) => (
    (typeOrder.get(left.typeId) ?? Number.MAX_SAFE_INTEGER) - (typeOrder.get(right.typeId) ?? Number.MAX_SAFE_INTEGER)
    || left.index - right.index
    || (left.rel < right.rel ? -1 : left.rel > right.rel ? 1 : 0)
  ))
  const previousByName = new Map()
  if (previousManifest !== null && previousManifest !== undefined && Array.isArray(previousManifest.buckets)) {
    for (const bucket of previousManifest.buckets) {
      const name = path.basename(String(bucket.file || ''))
      if (name !== '') previousByName.set(name, bucket)
    }
  }
  const entries = []
  const keepNames = new Set()
  for (const group of files) {
    const name = path.basename(group.rel)
    const text = bucketTextOf(group.rows)
    const hash = contentHash(text)
    const before = previousByName.get(name)
    const unchanged = before !== undefined && before.hash === hash
    if (!unchanged) writeFileAtomic(path.join(dir, group.rel), text)
    keepNames.add(name)
    entries.push({
      file: group.rel,
      typeId: group.typeId,
      count: group.rows.length,
      bytes: Buffer.byteLength(text, 'utf8'),
      latestTs: latestTsOf(group.rows),
      hash,
    })
  }
  removeStaleBuckets(dirBuckets, keepNames)
  cleanupStaleTemps(dirBuckets)
  const manifest = buildManifest(store, entries, previousManifest, options)
  writeManifest(dir, manifest)
  return manifest
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

/**
 * 只读指定类型的分片（G1，P3 的省读入口）：`typeIds` 为空表示全部。
 * @returns {{records: object[], files: string[]}}
 */
export function readShardRecordsOfTypes(dataDir, manifest, typeIds = []) {
  if (manifest === null || manifest === undefined) throw new Error('readShardRecordsOfTypes 需要 manifest')
  const wanted = new Set((Array.isArray(typeIds) ? typeIds : [typeIds]).map(String).filter((id) => id !== ''))
  const files = []
  const records = []
  for (const bucket of manifest.buckets) {
    if (wanted.size > 0 && !wanted.has(String(bucket.typeId))) continue
    files.push(bucket.file)
    const rows = readBucketRows(resolveBucketPath(dataDir, bucket.file), bucket.file, { bucket })
    records.push(...rows)
  }
  return { records, files }
}

/**
 * 按 id 定向取记录（G2）：`refs: [{id, typeId}]`，按 `hash(id) % K` 只读命中的那几个分片。
 * 返回顺序与 refs 一致；不存在的 id 直接跳过（调用方自己判）。
 */
export function readRecordsByIds(dataDir, manifest, refs = []) {
  if (manifest === null || manifest === undefined) throw new Error('readRecordsByIds 需要 manifest')
  const knownTypes = new Set((Array.isArray(manifest.types) ? manifest.types : []).map((type) => String(type && type.id)))
  const byFile = new Map()
  const order = []
  for (const ref of Array.isArray(refs) ? refs : []) {
    if (ref === null || typeof ref !== 'object') continue
    const id = String(ref.id === undefined || ref.id === null ? '' : ref.id)
    if (id === '') continue
    const rawTypeId = String(ref.typeId || '')
    const typeId = knownTypes.has(rawTypeId) ? rawTypeId : 'ty_other'
    const file = shardRelPath(typeId, shardBucketIndex(id))
    if (!byFile.has(file)) byFile.set(file, [])
    byFile.get(file).push(id)
    order.push({ id, file })
  }
  const found = new Map()
  for (const file of byFile.keys()) {
    const rows = readBucketRows(resolveBucketPath(dataDir, file), file)
    if (rows === null) continue
    for (const row of rows) {
      if (row && typeof row === 'object' && !Array.isArray(row)) found.set(String(row.id), row)
    }
  }
  const out = []
  for (const item of order) {
    const row = found.get(item.id)
    if (row !== undefined) out.push(row)
  }
  return out
}

/** 旧 manifest.stats 是否带分项（P2 早期的 entry 只有 count/visible，拼不出全局计数）。 */
function statsHaveBreakdown(stats) {
  if (stats === null || stats === undefined || typeof stats !== 'object') return false
  const byType = stats.byType
  if (byType === null || typeof byType !== 'object') return false
  return Object.values(byType).every((entry) => entry !== null && typeof entry === 'object'
    && Number.isFinite(Number(entry.count)) && Number.isFinite(Number(entry.visible))
    && Number.isFinite(Number(entry.deleted)) && Number.isFinite(Number(entry.superseded))
    && Number.isFinite(Number(entry.retired)) && Array.isArray(entry.topTokens))
}

/**
 * 增量重算 stats（task-6）：只替换 touched 类型，其它类型原样保留；全局计数由各类型汇总。
 * 旧 manifest 缺分项时退回一次全量扫（一次性，之后 manifest 就带分项、走增量）。
 */
function mergeTypeStats(dataDir, previousStats, touched, computedByType) {
  if (!statsHaveBreakdown(previousStats)) {
    return statsEntries({ experiences: scanShards(dataDir).records })
  }
  const byType = {}
  for (const [typeId, entry] of Object.entries(previousStats.byType)) {
    byType[typeId] = { ...emptyTypeStats(), ...entry, topTokens: Array.isArray(entry.topTokens) ? entry.topTokens : [] }
  }
  const previousTasks = previousStats.tasksByType !== null && typeof previousStats.tasksByType === 'object' ? previousStats.tasksByType : {}
  const tasksByType = { ...previousTasks }
  for (const typeId of touched) {
    const computed = computedByType.get(typeId)
    if (computed === undefined || computed.entry.count === 0) {
      delete byType[typeId]
      delete tasksByType[typeId]
      continue
    }
    byType[typeId] = computed.entry
    if (computed.tasks.size === 0) delete tasksByType[typeId]
    else tasksByType[typeId] = computed.tasks.size
  }
  return summarizeStats(byType, tasksByType)
}

/**
 * 增量重算 recent（task-6）：换掉 touched 类型的条目，再按同一套「at 倒序、id 升序、每会话 ≤5、
 * 总 ≤100」排序截断；其它类型的条目原样保留。
 *
 * 注意：全局 ≤100 是硬上限——一旦饱和，被挤掉的旧条目已经不在索引里，无法从这里恢复；
 * 正常规模（会话数×5 < 100）下与全量重算逐字段一致。
 */
function mergeRecent(previousRecent, touched, computedByType) {
  const touchedSet = new Set(touched)
  const kept = (Array.isArray(previousRecent) ? previousRecent : [])
    .filter((item) => item !== null && typeof item === 'object' && !touchedSet.has(String(item.typeId)))
  const fresh = []
  for (const typeId of touched) {
    const computed = computedByType.get(typeId)
    if (computed === undefined) continue
    fresh.push(...computed.recent)
  }
  return capRecentList([...kept, ...fresh])
}

/**
 * 局部写（G4，P2 增量写与 P3 省写的共同内核）：**只替换 `touchedTypeIds` 的分桶**，
 * 其它类型的文件一个字节都不碰（mtime 不变），最后写 manifest。
 *
 * 调用方必须保证 `rowsByType` 是那些类型的**完整行集合**（不是增量 diff，**也不是只有可见行**）——
 * 墓碑 / superseded / retired 行也要带上：漏了它们等于把它们物理删掉，压缩的清理规则与
 * `exp_type` 的计数都会跟着失真。这个函数按类型整体替换，漏传的行会被当成删除。
 * **反之，任何 partial store 都不许交给 `store.writeStore()`**——那是全量重写，会把其它类型删掉。
 *
 * stats / recent 由本函数**就地维护**（单一真相，task-6）：只按写入的行重算 touched 类型，
 * 其它类型保留原值；调用方不要自己算一遍（两份口径必然漂移）。`payload.stats` / `payload.recent`
 * 保留字段只为兼容旧调用，**会被忽略**。pending 索引传了就替换、不传保持。
 *
 * @param {object} payload
 * @param {string[]} payload.touchedTypeIds
 * @param {Record<string, object[]>} payload.rowsByType
 * @param {object[]} [payload.types] 新类型目录（不传保留）
 * @param {object[]} [payload.clusters] 新簇缓存（不传保留）
 * @param {object[]} [payload.pending] 待判定索引（传了才更新）
 */
export function writeTypeShards(dataDir, manifest, payload = {}) {
  if (manifest === null || manifest === undefined) throw new Error('writeTypeShards 需要 manifest（先 readManifest）')
  const dir = String(dataDir || '')
  if (dir === '') throw new Error('writeTypeShards 需要 dataDir（.exp 根目录）')
  const touched = [...new Set((Array.isArray(payload.touchedTypeIds) ? payload.touchedTypeIds : []).map(String))]
  if (touched.length === 0) return manifest
  const rowsByType = payload.rowsByType !== null && typeof payload.rowsByType === 'object' ? payload.rowsByType : {}
  for (const typeId of Object.keys(rowsByType)) {
    if (!touched.includes(String(typeId))) {
      throw new Error(`writeTypeShards：rowsByType 里的类型 ${typeId} 不在 touchedTypeIds 里（局部写不许碰没声明的类型）`)
    }
  }
  const dirBuckets = bucketsPath(dir)
  fs.mkdirSync(dirBuckets, { recursive: true })
  const previousByName = new Map()
  for (const bucket of manifest.buckets) {
    const name = path.basename(String(bucket.file || ''))
    if (name !== '') previousByName.set(name, bucket)
  }
  const untouched = manifest.buckets.filter((bucket) => !touched.includes(String(bucket.typeId)))
  const keepNames = new Set(untouched.map((bucket) => path.basename(bucket.file)))
  const written = []
  for (const typeId of touched) {
    const rows = Array.isArray(rowsByType[typeId])
      ? rowsByType[typeId].filter((row) => row !== null && typeof row === 'object' && !Array.isArray(row))
      : []
    const groups = new Map()
    for (const row of rows) {
      const index = shardBucketIndex(row.id)
      if (!groups.has(index)) groups.set(index, [])
      groups.get(index).push(row)
    }
    for (const [index, groupRows] of [...groups.entries()].sort((left, right) => left[0] - right[0])) {
      const rel = shardRelPath(typeId, index)
      const name = path.basename(rel)
      const text = bucketTextOf(groupRows)
      const hash = contentHash(text)
      const before = previousByName.get(name)
      // 指纹一样就不写：这是「写局部性」的来源（别的类型、甚至本类型的未变桶都不碰）。
      if (before === undefined || before.hash !== hash) writeFileAtomic(path.join(dirBuckets, name), text)
      keepNames.add(name)
      written.push({
        file: rel,
        typeId,
        count: groupRows.length,
        bytes: Buffer.byteLength(text, 'utf8'),
        latestTs: latestTsOf(groupRows),
        hash,
      })
    }
  }
  // 被 touched 的类型里，本次没有产出的旧分片要删掉（该类型清空 / 桶号变了的残留）
  for (const bucket of manifest.buckets) {
    if (!touched.includes(String(bucket.typeId))) continue
    const name = path.basename(bucket.file)
    if (keepNames.has(name)) continue
    try {
      fs.unlinkSync(path.join(dirBuckets, name))
    } catch {
      // 已经不在了
    }
  }
  cleanupStaleTemps(dirBuckets)
  // stats / recent 就地重算（只管 touched 类型；别的类型原样）。调用方传的 stats/recent 被忽略。
  const computedByType = new Map()
  for (const typeId of touched) {
    computedByType.set(typeId, typeStatsOfRows(Array.isArray(rowsByType[typeId]) ? rowsByType[typeId] : []))
  }
  const nextStats = mergeTypeStats(dir, manifest.stats, touched, computedByType)
  const nextRecent = mergeRecent(manifest.recent, touched, computedByType)
  const nextTypes = Array.isArray(payload.types) ? payload.types.map((type) => ({ ...type })) : manifest.types
  const typeOrder = new Map((Array.isArray(nextTypes) ? nextTypes : []).map((type, index) => [String(type && type.id), index]))
  const next = {
    ...manifest,
    types: nextTypes,
    clusters: Array.isArray(payload.clusters) ? payload.clusters : manifest.clusters,
    buckets: [...untouched, ...written].sort((left, right) => (
      (typeOrder.get(String(left.typeId)) ?? Number.MAX_SAFE_INTEGER) - (typeOrder.get(String(right.typeId)) ?? Number.MAX_SAFE_INTEGER)
      || (left.file < right.file ? -1 : left.file > right.file ? 1 : 0)
    )),
    stats: nextStats,
    recent: nextRecent,
    ...(Array.isArray(payload.pending) ? { pending: payload.pending } : {}),
    ...(payload.cold !== undefined && payload.cold !== null ? { cold: normalizeCold(payload.cold) } : {}),
  }
  // 先写数据、后写 manifest（manifest 是唯一入口）。
  writeManifest(dir, next)
  return next
}

/** 一批行 → 待判定索引条目（与 buildManifest 里的口径一致）。 */
function pendingEntriesOfRows(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => row && !row.deleted_at && !row.superseded_by && !row.retired_at && row.verdict === 'pending')
    .sort((left, right) => String(right.registeredAt || right.ts || '').localeCompare(String(left.registeredAt || left.ts || '')))
    .slice(0, PENDING_INDEX_LIMIT)
    .map((row) => ({
      id: String(row.id || ''),
      typeId: String(row.typeId || 'ty_other'),
      intent: String(row.intent || '').slice(0, 120),
    }))
}

/** 增量维护 pending 索引：只替换 touched 类型的条目；顺序对消费者不重要（只按 id/typeId 定向取行）。 */
function mergePending(previousPending, touched, rowsByType) {
  const touchedSet = new Set(touched.map(String))
  const kept = (Array.isArray(previousPending) ? previousPending : [])
    .filter((entry) => entry !== null && typeof entry === 'object' && !touchedSet.has(String(entry.typeId)))
  const fresh = []
  for (const typeId of touched) fresh.push(...pendingEntriesOfRows(rowsByType[typeId]))
  const seen = new Set()
  const out = []
  for (const entry of [...fresh, ...kept]) {
    const id = String(entry.id || '')
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    out.push(entry)
    if (out.length >= PENDING_INDEX_LIMIT) break
  }
  return out
}

/**
 * touched 类型的簇缓存重建（task-9）：只换被写的类型，其它类型沿用旧条目。
 * 返回完整的 clusters 数组（顺序按 types），写盘时整块替换 manifest.clusters。
 */
function mergeTouchedClusters(manifest, types, touched, rowsByType) {
  const previous = new Map()
  for (const cluster of Array.isArray(manifest && manifest.clusters) ? manifest.clusters : []) {
    const id = String((cluster && (cluster.id || cluster.typeId)) || '')
    if (id !== '') previous.set(id, cluster)
  }
  const touchedSet = new Set(touched.map(String))
  const out = []
  for (const type of Array.isArray(types) ? types : []) {
    if (type === null || typeof type !== 'object' || typeof type.id !== 'string' || type.id === '') continue
    const typeId = String(type.id)
    if (!touchedSet.has(typeId)) {
      const kept = previous.get(typeId)
      out.push(kept !== undefined ? kept : buildCluster(type, []))
      continue
    }
    const rows = (Array.isArray(rowsByType[typeId]) ? rowsByType[typeId] : [])
      .filter((row) => row && typeof row === 'object' && !row.deleted_at && !row.superseded_by && !row.retired_at)
    out.push(buildCluster(type, rows))
  }
  return out
}

/**
 * 定向写 + 压缩触发（task-9）：`exp_record` 的落盘入口（把记录路径从 `writeStore` 的全量
 * 重写里解放出来，10x 库单条记录从 315 ms 降到毫秒级）。
 *
 * 1. 先 `writeTypeShards`：只替换 touched 类型的桶，stats/recent 由它就地维护；
 * 2. 三闸判断只看「touched 类型分桶 + 热档总字节 + 可见条数」，不扫全量；
 * 3. 需要压缩时**只压 touched 类型**里最大的桶（复用 `compactBucket`，不复制逻辑）；
 * 4. 压缩后按剩余行重算 touched 类型的 stats/recent/clusters，**manifest 最后写一次**。
 *
 * 红线：
 *  - `rowsByType` 必须是 touched 类型的**全部行**（含 tombstone/superseded/retired）；
 *  - partial store 绝不许交给 `writeStore`（本函数根本不调它）。
 */
export function recordShardWrite(dataDir, manifest, payload = {}) {
  if (manifest === null || manifest === undefined) throw new Error('recordShardWrite 需要 manifest（先 readManifest）')
  const dir = String(dataDir || '')
  if (dir === '') throw new Error('recordShardWrite 需要 dataDir（.exp 根目录）')
  const touched = [...new Set((Array.isArray(payload.touchedTypeIds) ? payload.touchedTypeIds : []).map(String))]
  if (touched.length === 0) return manifest
  const rowsByType = payload.rowsByType !== null && typeof payload.rowsByType === 'object' ? payload.rowsByType : {}
  const options = payload.compact !== null && typeof payload.compact === 'object' ? payload.compact : {}
  const types = Array.isArray(payload.types) ? payload.types : manifest.types
  // 簇缓存也随这次写更新（否则下一次召回路由读到陈旧签名/统计，记录会被路由到错类型）。
  const clusters = Array.isArray(payload.clusters) ? payload.clusters : mergeTouchedClusters(manifest, types, touched, rowsByType)
  // pending 索引同样增量维护（partial 路径必须带上，否则新记的 pending 在提示段/回填入口里查不到）。
  const pending = Array.isArray(payload.pending) ? payload.pending : mergePending(manifest.pending, touched, rowsByType)
  let current = writeTypeShards(dir, manifest, { ...payload, types, clusters, pending })

  // 容量闸（D4）：只看 touched 类型 + 热档总量 + 可见条数。
  const maxBucketBytes = Number.isFinite(Number(options.maxBucketBytes)) ? Number(options.maxBucketBytes) : MAX_BUCKET_BYTES
  const hotMaxBytes = Number.isFinite(Number(options.hotMaxBytes)) ? Number(options.hotMaxBytes) : HOT_MAX_BYTES
  const nMax = Number.isFinite(Number(options.nMax)) ? Number(options.nMax) : N_MAX
  const ratio = Number.isFinite(Number(options.compactRatio)) ? Number(options.compactRatio) : COMPACT_TARGET_RATIO
  const hotBytesOf = (state) => state.buckets.reduce((sum, bucket) => sum + (Number(bucket.bytes) || 0), 0)
  const visibleOf = (state) => (Number.isFinite(Number(state.stats && state.stats.visible)) ? Number(state.stats.visible) : 0)
  const touchedOver = (state) => state.buckets
    .filter((bucket) => touched.includes(String(bucket.typeId)))
    .some((bucket) => (Number(bucket.bytes) || 0) > maxBucketBytes)
  if (!touchedOver(current) && hotBytesOf(current) <= hotMaxBytes && visibleOf(current) <= nMax) return current

  // 只压 touched 类型：每轮挑其中最大的桶（沿用 compactBucket 的清理 + 下沉 + 守恒 + 备份逻辑）。
  const rounds = Math.max(1, Math.min(32, Math.trunc(Number(options.maxRounds) || 8)))
  for (let round = 0; round < rounds; round += 1) {
    const candidates = current.buckets
      .filter((bucket) => touched.includes(String(bucket.typeId)))
      .sort((left, right) => (Number(right.bytes) || 0) - (Number(left.bytes) || 0))
    const live = candidates[0]
    if (live === undefined) break
    const hotBytes = hotBytesOf(current)
    if (!((Number(live.bytes) || 0) > maxBucketBytes) && hotBytes <= hotMaxBytes && visibleOf(current) <= nMax) break
    let targetBytes = options.targetBytes
    if (hotBytes > hotMaxBytes) {
      // 热档超闸：至少把溢出的那部分从当前最大桶里挪走，否则「压了但总量没降」会死循环。
      const overflow = Math.max(1, hotBytes - hotMaxBytes)
      targetBytes = Math.max(0, Math.min(Math.trunc(maxBucketBytes * ratio), (Number(live.bytes) || 0) - overflow))
    }
    const result = compactBucket(dir, current, live, { ...options, targetBytes })
    if (result === null || result.changed !== true) break
    const entries = []
    for (const bucket of current.buckets) {
      if (bucket.file !== live.file) {
        entries.push(bucket)
        continue
      }
      if (result.remainingCount > 0) {
        entries.push({
          ...bucket,
          count: result.remainingCount,
          bytes: result.remainingBytes,
          latestTs: result.latestTs,
          hash: result.hash,
        })
      }
    }
    current = { ...current, buckets: entries, cold: result.cold }
  }

  // 压缩后按「剩余行」把 touched 类型的 stats/recent/clusters 校准到真实值，manifest 最后写。
  const rowsAfter = {}
  for (const typeId of touched) rowsAfter[typeId] = readShardRecordsOfTypes(dir, current, [typeId]).records
  const computedByType = new Map()
  for (const typeId of touched) computedByType.set(typeId, typeStatsOfRows(rowsAfter[typeId] || []))
  const nextStats = mergeTypeStats(dir, current.stats, touched, computedByType)
  const nextRecent = mergeRecent(current.recent, touched, computedByType)
  const nextClusters = mergeTouchedClusters(current, current.types, touched, rowsAfter)
  const updated = { ...current, stats: nextStats, recent: nextRecent, clusters: nextClusters }
  writeManifest(dir, updated)
  return updated
}

/** 容量闸（D4）：单桶 / 热档总字节 / 全库可见条数，取先到。 */
export function compactionNeeded(dataDir, manifest, options = {}) {
  if (manifest === null || manifest === undefined) return { needed: false, reason: 'no-manifest' }
  const maxBucketBytes = Number.isFinite(Number(options.maxBucketBytes)) ? Number(options.maxBucketBytes) : MAX_BUCKET_BYTES
  const hotMaxBytes = Number.isFinite(Number(options.hotMaxBytes)) ? Number(options.hotMaxBytes) : HOT_MAX_BYTES
  const nMax = Number.isFinite(Number(options.nMax)) ? Number(options.nMax) : N_MAX
  let hotBytes = 0
  let largest = null
  for (const bucket of manifest.buckets) {
    const bytes = Number(bucket.bytes) || 0
    hotBytes += bytes
    if (largest === null || bytes > (Number(largest.bytes) || 0)) largest = bucket
  }
  if (largest !== null && (Number(largest.bytes) || 0) > maxBucketBytes) {
    return { needed: true, reason: 'bucket-bytes', bucket: largest, hotBytes }
  }
  if (hotBytes > hotMaxBytes) return { needed: true, reason: 'hot-bytes', bucket: largest, hotBytes }
  const visible = manifest.stats !== null && manifest.stats !== undefined && Number.isFinite(Number(manifest.stats.visible))
    ? Number(manifest.stats.visible)
    : manifest.buckets.reduce((sum, bucket) => sum + (Number(bucket.count) || 0), 0)
  if (visible > nMax) return { needed: true, reason: 'count', bucket: largest, hotBytes, visible }
  return { needed: false, hotBytes, bucket: largest }
}

/**
 * 压缩单个桶（§4.4）：
 *  1. 物理清掉过期墓碑(30 天) / 被取代 / 已退休的行（它们本来就不参与召回）；
 *  2. 仍超目标水位 → 按 G 升序 → hits 升序 → lastSeenAt 升序（**最差先走**，§4.5 的样例就是最差先走）
 *     把尾部整条下沉到冷档，直到剩余 ≤ `targetBytes`；
 *  3. 守恒：清掉 + 下沉 + 剩余 = 原条数，且实际追加行数 = 下沉条数；不成立就回滚。
 * 备份目标桶到 `.locks/compact-<ts>.bak`；返回的 `removedIds` 供调用方重建 manifest 统计。
 */
export function compactBucket(dataDir, manifest, bucket, options = {}) {
  const dir = String(dataDir || '')
  if (manifest === null || manifest === undefined) throw new Error('compactBucket 需要 manifest')
  if (bucket === null || bucket === undefined || typeof bucket.file !== 'string') throw new Error('compactBucket 需要 bucket 登记（manifest.buckets[] 的一项）')
  const file = path.join(dir, bucket.file)
  const loaded = readBucketRows(file, bucket.file)
  if (loaded === null) return { changed: false, reason: 'missing', removedIds: [] }
  const rows = loaded
  if (rows.length === 0) return { changed: false, reason: 'empty', removedIds: [] }
  const nowMs = options.now instanceof Date ? options.now.getTime() : (Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now())
  const tombstoneDays = Number.isFinite(Number(options.tombstoneDays)) ? Number(options.tombstoneDays) : TOMBSTONE_DAYS
  const maxBucketBytes = Number.isFinite(Number(options.maxBucketBytes)) ? Number(options.maxBucketBytes) : MAX_BUCKET_BYTES
  const ratio = Number.isFinite(Number(options.compactRatio)) ? Number(options.compactRatio) : COMPACT_TARGET_RATIO
  const fallbackTarget = Math.trunc(maxBucketBytes * ratio)
  const targetBytes = Number.isFinite(Number(options.targetBytes)) ? Math.max(0, Math.trunc(Number(options.targetBytes))) : fallbackTarget
  const keep = []
  const purged = []
  for (const row of rows) {
    const deletedAt = Date.parse(String(row.deleted_at || ''))
    const expiredTombstone = Boolean(row.deleted_at) && Number.isFinite(deletedAt) && nowMs - deletedAt >= tombstoneDays * 86400000
    if (expiredTombstone || row.superseded_by || row.retired_at) purged.push(row)
    else keep.push(row)
  }
  const byWorst = [...keep].sort((left, right) => (
    (Number(left.G) || 0) - (Number(right.G) || 0)
    || (Number(left.hits) || 1) - (Number(right.hits) || 1)
    || String(left.lastSeenAt || left.ts || '').localeCompare(String(right.lastSeenAt || right.ts || ''))
  ))
  const rowBytesById = new Map()
  for (const row of keep) rowBytesById.set(row, Buffer.byteLength(JSON.stringify(row), 'utf8') + 1)
  let remainingBytes = keep.reduce((sum, row) => sum + rowBytesById.get(row), 0)
  const sunk = []
  const sunkSet = new Set()
  for (const row of byWorst) {
    if (remainingBytes <= targetBytes) break
    // 至少留一条：全部下沉等于把整个类型搬进冷档（小闸/大记录时 target 可能比单条还小）。
    if (sunk.length >= keep.length - 1) break
    sunkSet.add(row)
    sunk.push(row)
    remainingBytes -= rowBytesById.get(row)
  }
  const remaining = keep.filter((row) => !sunkSet.has(row))
  // 守恒（先算后写）：清掉 + 下沉 + 剩余 = 原有条数
  if (purged.length + sunk.length + remaining.length !== rows.length) {
    return { changed: false, reason: 'conservation', removedIds: [] }
  }
  if (purged.length === 0 && sunk.length === 0) return { changed: false, reason: 'nothing-to-do', removedIds: [] }

  // 压缩前备份（计划书 §9）：备份放 .locks/，失败就中止——没有备份不许动数据。
  const backupDir = path.join(dir, COMPACT_BACKUP_DIR)
  fs.mkdirSync(backupDir, { recursive: true })
  const stamp = new Date(nowMs).toISOString().replace(/[:.]/g, '-')
  const backup = path.join(backupDir, `compact-${stamp}-${path.basename(bucket.file)}.bak`)
  try {
    fs.copyFileSync(file, backup)
  } catch (error) {
    throw new Error(`压缩前备份失败（已中止，数据未动）：${error && error.message ? error.message : error}`)
  }

  const coldResult = sunk.length > 0
    ? appendColdRecords(dir, manifest.cold, sunk, options)
    : { cold: normalizeCold(manifest.cold), appends: [] }
  try {
    if (remaining.length === 0) {
      fs.unlinkSync(file)
    } else {
      writeFileAtomic(file, bucketTextOf(remaining))
    }
  } catch (error) {
    rollbackColdAppends(dir, coldResult.appends)
    try {
      fs.copyFileSync(backup, file)
    } catch {
      // 备份还在 .locks/ 里
    }
    throw error
  }
  const appended = coldResult.appends.reduce((sum, item) => sum + (Number(item.rows) || 0), 0)
  if (appended !== sunk.length) {
    rollbackColdAppends(dir, coldResult.appends)
    try {
      fs.copyFileSync(backup, file)
    } catch {
      // 同上
    }
    throw new Error(`压缩守恒校验失败：应下沉 ${sunk.length} 条，实际追加 ${appended} 条（已回滚）`)
  }
  const remainingText = remaining.length === 0 ? '' : bucketTextOf(remaining)
  return {
    changed: true,
    purged: purged.length,
    purgedRows: purged,
    sunk,
    sunkCount: sunk.length,
    remainingCount: remaining.length,
    remainingBytes: Buffer.byteLength(remainingText, 'utf8'),
    latestTs: latestTsOf(remaining),
    hash: contentHash(remainingText),
    cold: coldResult.cold,
    backup,
    removedIds: [...purged, ...sunk].map((row) => String(row.id)),
  }
}

/**
 * 容量治理（D4）：反复压缩「当前最大的分片」，直到三闸都不超（或压不动了）。
 * **不写 manifest**——调用方（writeStore）拿到新 buckets/cold 后统一写一次，
 * 同时用 `removedIds` 把 manifest.stats/recent 重建准确。
 * @returns {{manifest: object, removedIds: string[], compacted: Array<{file: string, reason: string, purged: number, sunk: number, remaining: number}>}}
 */
export function compactStore(dataDir, manifest, options = {}) {
  const removedIds = []
  const compacted = []
  if (manifest === null || manifest === undefined) return { manifest, removedIds, compacted }
  let current = manifest
  const maxRounds = Math.max(1, Math.min(64, Math.trunc(Number(options.maxRounds) || 8)))
  for (let round = 0; round < maxRounds; round += 1) {
    const need = compactionNeeded(dataDir, current, options)
    if (!need.needed || need.bucket === undefined || need.bucket === null) break
    const bucketBytes = Number(need.bucket.bytes) || 0
    let targetBytes = options.targetBytes
    if (need.reason === 'hot-bytes') {
      const overflow = Math.max(1, (Number(need.hotBytes) || 0) - (Number(options.hotMaxBytes) || HOT_MAX_BYTES))
      // 至少要把溢出量从当前最大桶里挪走，否则「压了但总量没降」会变成死循环。
      const fallbackTarget = Math.trunc((Number(options.maxBucketBytes) || MAX_BUCKET_BYTES) * (Number(options.compactRatio) || COMPACT_TARGET_RATIO))
      targetBytes = Math.max(0, Math.min(fallbackTarget, bucketBytes - overflow))
      if (targetBytes >= bucketBytes) break
    }
    const result = compactBucket(dataDir, current, need.bucket, { ...options, targetBytes })
    if (result === null || result.changed !== true) break
    removedIds.push(...result.removedIds)
    const entries = []
    for (const bucket of current.buckets) {
      if (bucket.file !== need.bucket.file) {
        entries.push(bucket)
        continue
      }
      if (result.remainingCount > 0) {
        entries.push({
          ...bucket,
          count: result.remainingCount,
          bytes: result.remainingBytes,
          latestTs: result.latestTs,
          hash: result.hash,
        })
      }
    }
    current = { ...current, buckets: entries, cold: result.cold }
    compacted.push({
      file: need.bucket.file,
      reason: need.reason,
      purged: result.purged,
      sunk: result.sunkCount,
      remaining: result.remainingCount,
    })
  }
  return { manifest: current, removedIds, compacted }
}

function renameWithRetry(from, to) {
  let lastError = null
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      fs.renameSync(from, to)
      return
    } catch (error) {
      lastError = error
      if (error && (error.code === 'EPERM' || error.code === 'EBUSY' || error.code === 'EACCES')) {
        sleepSync(25)
        continue
      }
      throw error
    }
  }
  throw new Error(`旧库改名失败（rename 重试 20 次仍失败）：${lastError && lastError.message ? lastError.message : String(lastError)}`)
}

/**
 * 一次性迁移（§4.6）：先写分片、再写 manifest、最后把 exp-lib.json 改名为 legacy。
 * 任一步失败：删掉本次写出的 manifest / 分片，**保留 exp-lib.json 原样**，然后抛错。
 * 幂等性由调用方（store.js 的 migrateStore）判 manifest 是否存在保证——本函数不做检查，
 * 因为它本身就是「把给定 store 落成分片」这一个动作。
 * @returns {{migrated: true, manifest: object, buckets: number}}
 */
export function migrateToShards(dataDir, store, options = {}) {
  const dir = String(dataDir || '')
  const source = path.join(dir, LEGACY_SOURCE_FILE)
  const target = legacyPath(dir)
  let manifestWritten = false
  try {
    const manifest = writeShards(dir, store, null, { ...options, migratedFrom: LEGACY_SOURCE_FILE })
    manifestWritten = true
    if (fs.existsSync(source)) renameWithRetry(source, target)
    return { migrated: true, manifest, buckets: manifest.buckets.length }
  } catch (error) {
    if (manifestWritten) {
      try {
        fs.unlinkSync(manifestPath(dir))
      } catch {
        // 没写成功 / 已经被删
      }
    }
    // 半成品分片会让「manifest 不存在但 buckets 有东西」的状态变得难解释；迁移失败时清干净。
    try {
      fs.rmSync(bucketsPath(dir), { recursive: true, force: true })
    } catch {
      // 删不掉也只是残留文件，readStore 不会读它们（manifest 不存在）
    }
    throw error
  }
}

/**
 * 提示段读缓存的指纹（0.14.0 P0 的 readStore 缓存用）：manifest + 旧库 + 全部分片/冷档的
 * (mtime, size) 拼起来。任何一次落盘都会让它变，不靠猜；跨进程也有效。
 */
export function storageSignature(dataDir) {
  const dir = String(dataDir || '')
  const parts = []
  for (const [label, file] of [['m', manifestPath(dir)], ['l', path.join(dir, LEGACY_SOURCE_FILE)]]) {
    try {
      const stat = fs.statSync(file)
      parts.push(`${label}${stat.mtimeMs}:${stat.size}`)
    } catch {
      parts.push(`${label}-`)
    }
  }
  for (const [label, sub] of [['b', bucketsPath(dir)], ['c', coldPath(dir)]]) {
    let names = []
    try {
      names = fs.readdirSync(sub).filter((name) => name.endsWith('.jsonl')).sort()
    } catch {
      names = []
    }
    for (const name of names) {
      try {
        const stat = fs.statSync(path.join(sub, name))
        parts.push(`${label}${name}:${stat.mtimeMs}:${stat.size}`)
      } catch {
        parts.push(`${label}${name}-`)
      }
    }
  }
  return parts.join('|')
}

/** 库占用的字节数（**热档**：manifest + 分片 + 冷档，不含 legacy）。 */
export function storageBytes(dataDir) {
  const dir = String(dataDir || '')
  let total = 0
  const addFile = (file) => {
    try {
      total += fs.statSync(file).size
    } catch {
      // 不存在
    }
  }
  addFile(manifestPath(dir))
  for (const sub of [bucketsPath(dir), coldPath(dir)]) {
    let names = []
    try {
      names = fs.readdirSync(sub)
    } catch {
      names = []
    }
    for (const name of names) if (name.endsWith('.jsonl')) addFile(path.join(sub, name))
  }
  return total
}

function fileSizeOf(file) {
  try {
    return fs.statSync(file).size
  } catch {
    return -1
  }
}

/**
 * 存储用量（G7，2026-11-12）：控制台与 P3 用的一次性口径。
 *
 * **口径统一**：`fileCount` 与 `totalBytes` 都**含 legacy**（manifest + buckets + cold + legacy），
 * 与 `storageBytes()`（热档，不含 legacy）刻意区分——`storageBytes()` 服务热档上限，
 * `storageUsage()` 服务「这个库一共占多少」。两个数不自洽的坑就在这，用的时候看键名。
 *
 * `updatedAt` 恒为 `null`：D1（2026-11-12）起 manifest 不写 `updated_at`（时间戳是冲突噪音），
 * 这里不编一个假时间；要时间请看文件 mtime。
 *
 * **只统计分片布局**（manifest + buckets + cold + legacy）：迁移前的单文件 `exp-lib.json`
 * 不是这里的一项，需要的话由调用方自行计入（engine 就是这么补的）。
 */
export function storageUsage(dataDir) {
  const dir = String(dataDir || '')
  const usage = {
    manifestBytes: 0,
    bucketBytes: 0,
    bucketFiles: 0,
    coldBytes: 0,
    coldFiles: 0,
    legacy: { exists: false, bytes: 0 },
    fileCount: 0,
    totalBytes: 0,
    updatedAt: null,
  }
  const manifestSize = fileSizeOf(manifestPath(dir))
  if (manifestSize >= 0) {
    usage.manifestBytes = manifestSize
    usage.fileCount += 1
  }
  for (const [sub, bytesKey, filesKey] of [
    [bucketsPath(dir), 'bucketBytes', 'bucketFiles'],
    [coldPath(dir), 'coldBytes', 'coldFiles'],
  ]) {
    let names = []
    try {
      names = fs.readdirSync(sub).filter((name) => name.endsWith('.jsonl'))
    } catch {
      names = []
    }
    for (const name of names) {
      const size = fileSizeOf(path.join(sub, name))
      if (size < 0) continue
      usage[bytesKey] += size
      usage[filesKey] += 1
      usage.fileCount += 1
    }
  }
  const legacySize = fileSizeOf(legacyPath(dir))
  if (legacySize >= 0) {
    usage.legacy = { exists: true, bytes: legacySize }
    usage.fileCount += 1
  }
  usage.totalBytes = usage.manifestBytes + usage.bucketBytes + usage.coldBytes + usage.legacy.bytes
  return usage
}

/** 文件数（manifest + 分片 + 冷档 + legacy），验收判据 §8.3 用。 */
export function storageFileCount(dataDir) {
  const dir = String(dataDir || '')
  let count = 0
  const exists = (file) => {
    try {
      return fs.statSync(file).isFile()
    } catch {
      return false
    }
  }
  if (exists(manifestPath(dir))) count += 1
  if (exists(path.join(dir, LEGACY_SOURCE_FILE))) count += 1
  if (exists(legacyPath(dir))) count += 1
  for (const sub of [bucketsPath(dir), coldPath(dir)]) {
    let names = []
    try {
      names = fs.readdirSync(sub)
    } catch {
      names = []
    }
    for (const name of names) if (name.endsWith('.jsonl')) count += 1
  }
  return count
}
