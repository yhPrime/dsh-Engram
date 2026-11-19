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
/**
 * manifest.taskIndex 最多登记几个键（0.21.3 R1 缺陷 1/3）。
 *
 * 为什么要它：记录快路径只读目标类型分片（task-9 的结构判据），看不到别的类型下
 * 「同 intent + 同做法」的旧条——于是「用户说这条分类错了 → 带正确 typeName 重记」
 * 会新开一条，而不是就地改类型。索引只存 `同做法键 → 出现过的 typeId`，
 * 记录时用它判断「要不要多读一个类型」，真正的合并判据仍在 store.js（sameTask/相似度）。
 *
 * 它是**可重建缓存**：丢了只会让某条旧记录少一次就地纠正（退化成新开一条），不会丢数据。
 * 上限按最近的行保留（manifest 有 128 KiB 预算，索引必须是数量级的，不是全量的）。
 */
export const TASK_INDEX_LIMIT = 600
/**
 * `manifest.taskIndexDropped` 最多记几个被截断甩掉的同做法键（0.21.3 R7 缺陷 D1）。
 * 只是「缺键是否可信」的判别名单，不参与定位；16 hex 一个键，2000 个约 38 KiB，
 * 仍在 manifest 128 KiB 预算内。超了就不存名单（只留 truncated 标记，缺键一律退慢）。
 */
export const TASK_INDEX_DROPPED_LIMIT = 2000
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

/**
 * 「同做法键」：intent + action（做法按 `actionKeyOf` 的口径 trim + lower）。
 *
 * 只用于 `manifest.taskIndex` 的**定位**，不参与合并判定——`upsertExperience` 里
 * 仍要过 kind/stepIndex/taskId + actionKey + 状态相似度这几关。
 * 与 store.js 的 `taskKeyOf` 同一口径：那边先把 intent/action 清洗+截断，这里只做哈希，
 * 存量行的 intent/action 已是清洗后的值，所以两边算出来的是同一个键。
 */
export function taskKeyHash(intent, action) {
  const text = String(intent === undefined || intent === null ? '' : intent)
  if (text === '') return ''
  // 0.21.3 R4 缺陷 D1：只有 C0/C1 控制字符（或控制字符+空白）的 intent 等同于空意图——
  // 不能因为一串不可见字符就造出一个「同做法键」，让残渣行进入 taskIndex 参与定位。
  // 注意只判「整串是否只剩不可见字符」：正常正文里夹带的控制字符仍原样参与哈希（R3/R4 白盒用例守着）。
  if (text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim() === '') return ''
  const actionKey = String(action === undefined || action === null ? '' : action).trim().toLowerCase()
  return createHash('sha1').update(`${text}\u0000${actionKey}`).digest('hex').slice(0, 16)
}

/** 一批行 → `{同做法键: 'typeId' | 'typeId,typeId'}`（行已在调用方筛过可见性）。 */
function indexOfRows(rows) {
  const index = {}
  for (const row of rows) {
    const key = taskKeyHash(row.intent, row.action)
    if (key === '') continue
    const typeId = String(row.typeId || 'ty_other')
    const previous = index[key]
    if (previous === undefined) index[key] = typeId
    else if (!previous.split(',').includes(typeId)) index[key] = `${previous},${typeId}`
  }
  return index
}

/**
 * 一批行 → `{index, dropped, truncated}`（只收可见行：合并只发生在可见条之间）。
 * 超过上限时按**行顺序取最近的一段**（数组顺序=写入顺序），前面的老行丢掉。
 *
 * `dropped`（0.21.3 R7 缺陷 D1）：被上限甩掉的行涉及的**同做法键**名单。
 * 快路径拿它区分「这个键从没出现过」（可放心新建）与「这个键的行被截断甩掉了」
 * （索引里可能没有它/类型不全 → 必须退慢路径）。只记键、不记类型（16 hex × N，
 * 比再存一份全量索引省得多）；名单本身超预算时丢掉并只留 `truncated`。
 * `truncated` 为 true 表示索引**不完整**；`dropped` 缺失 + truncated=true 表示
 * 「记不清甩过哪些键」——此时缺键一律不可信。
 */
function taskIndexEntries(rows, limit = TASK_INDEX_LIMIT) {
  const list = (Array.isArray(rows) ? rows : [])
    .filter((row) => row !== null && typeof row === 'object' && !Array.isArray(row) && !row.deleted_at && !row.superseded_by && !row.retired_at)
  const capped = list.length > limit ? list.slice(list.length - limit) : list
  const index = indexOfRows(capped)
  if (list.length <= limit) return { index, dropped: [], truncated: false }
  // 被甩掉的行里的键：只要出现过就记下来（同一键在保留段里也留着，覆盖可能不全 → 一并退慢）。
  const dropped = Object.keys(indexOfRows(list.slice(0, list.length - limit)))
    .filter((key) => key !== '')
  return { index, dropped, truncated: dropped.length > 0 }
}

/**
 * 增量维护同做法键索引：先摘掉 touched 类型贡献的 typeId（该类型的行被整体替换），
 * 再按 `rowsByType` 里的新行补回。顺序 = 老键在前、新键在后，超上限时摘掉最前面的（最老）。
 *
 * `previous`：`{index, dropped, truncated}`（来自 manifest；老 manifest 没有索引时由调用方
 * 用未触碰类型的现存分片补基线）。返回同形：被摘掉的键进 `dropped`，名单超预算则退化为
 * `dropped: null` + `truncated: true`（缺键一律不可信，宁可慢不可错）。
 */
function mergeTaskIndex(previous, touched, rowsByType) {
  const touchedSet = new Set((Array.isArray(touched) ? touched : []).map(String))
  const previousIndex = previous !== null && previous !== undefined && previous.index !== null && previous.index !== undefined
    && typeof previous.index === 'object' && !Array.isArray(previous.index)
    ? previous.index
    : null
  const previousDropped = previous !== null && previous !== undefined && Array.isArray(previous.dropped) ? previous.dropped : null
  const previousTruncated = previous !== null && previous !== undefined && previous.truncated === true
  const next = {}
  if (previousIndex !== null) {
    for (const [key, value] of Object.entries(previousIndex)) {
      if (key === '') continue
      const kept = String(value === undefined || value === null ? '' : value)
        .split(',')
        .map((typeId) => typeId.trim())
        .filter((typeId) => typeId !== '' && !touchedSet.has(typeId))
      if (kept.length > 0) next[key] = [...new Set(kept)].join(',')
    }
  }
  const freshRows = []
  for (const typeId of touchedSet) {
    if (Array.isArray(rowsByType[typeId])) freshRows.push(...rowsByType[typeId])
  }
  // 上限只对最终结果生效：先把这次的行全量展开（它们是最新的，不该被自己的上限截掉）。
  const fresh = taskIndexEntries(freshRows, Number.MAX_SAFE_INTEGER).index
  for (const [key, value] of Object.entries(fresh)) {
    const previousValue = next[key]
    if (previousValue === undefined) next[key] = value
    else {
      const merged = new Set([...previousValue.split(','), ...value.split(',')].map((typeId) => typeId.trim()).filter((typeId) => typeId !== ''))
      next[key] = [...merged].join(',')
    }
  }
  const keys = Object.keys(next)
  const overflow = keys.length - TASK_INDEX_LIMIT
  const droppedSet = new Set(previousDropped === null ? [] : previousDropped)
  if (overflow > 0) {
    for (const key of keys.slice(0, overflow)) {
      delete next[key]
      droppedSet.add(key)
    }
  }
  // 之前已经「记不清」过，或这次名单超预算：只留 truncated 信号，缺键一律退慢路径。
  const forgotten = (previousTruncated && previousDropped === null) || droppedSet.size > TASK_INDEX_DROPPED_LIMIT
  const dropped = forgotten ? null : [...droppedSet]
  return { index: next, dropped, truncated: forgotten || previousTruncated || overflow > 0 || dropped.length > 0 }
}

/**
 * 同做法键索引（0.21.3 R1 缺陷 1/3）：`{键: 'typeId[,typeId]'}`。
 *
 * 消费方只有 `exp_record` 的快路径：显式给了 `typeName` 且索引里同一个键挂在**别的类型**下时，
 * 把那些类型的分片一起读进来，让 upsert 有机会把旧条就地改类型（而不是新开一条）。
 * 没有索引（老 manifest）时快路径不敢断言「没有跨类型旧条」，会退回慢路径一次，之后由写盘补上。
 */
export function taskIndexOf(manifest) {
  const raw = manifest === null || manifest === undefined ? null : manifest.taskIndex
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) return null
  return raw
}

function normalizeManifest(raw) {
  // 被截断甩掉的键名单（R7-D1）：只在名单完整且不超预算时保留；超预算=记不清，
  // 不能截一段留下（漏掉的键会被当成新键），改用 truncated 标记让缺键一律退慢。
  const droppedRaw = Array.isArray(raw.taskIndexDropped)
    ? raw.taskIndexDropped.filter((key) => typeof key === 'string' && key !== '')
    : null
  const droppedExact = droppedRaw !== null && droppedRaw.length > 0 && droppedRaw.length <= TASK_INDEX_DROPPED_LIMIT
  const indexTruncated = raw.taskIndexTruncated === true || (droppedRaw !== null && droppedRaw.length > TASK_INDEX_DROPPED_LIMIT)
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
    // null = 「老 manifest 没有这份索引」（与「索引为空」区分：前者要退回慢路径一次补基线）。
    taskIndex: raw.taskIndex !== null && raw.taskIndex !== undefined && typeof raw.taskIndex === 'object' && !Array.isArray(raw.taskIndex)
      ? raw.taskIndex
      : null,
    // 重建时看到过的重复 id 副本数（R6-D2，派生缓存）：>0 时 exp_record 走全量读—改—写清掉副本。
    ...(Number(raw.duplicates) > 0 ? { duplicates: Math.trunc(Number(raw.duplicates)) } : {}),
    // 同做法键索引被截断过（R7-D1，派生缓存）：缺键不再等于「别的类型没有旧条」，快路径要退慢一次。
    ...(indexTruncated ? { taskIndexTruncated: true } : {}),
    // 被截断甩掉的具体键名单（R7-D1）：有名单时只有名单内的键不可信；缺名单=记不清，缺键一律不可信。
    ...(droppedExact ? { taskIndexDropped: droppedRaw } : {}),
    cold: normalizeCold(raw.cold),
    ...(typeof raw.migratedFrom === 'string' && raw.migratedFrom !== '' ? { migratedFrom: raw.migratedFrom } : {}),
    // 布局标记（0.27.0 分族布局）：必须原样保留，否则读路径会当成旧布局而误重建。
    ...(typeof raw.layout === 'string' && raw.layout !== '' ? { layout: raw.layout } : {}),
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

function resolveBucketPath(dataDir, rel) {
  const root = path.resolve(String(dataDir || ''))
  const resolved = path.resolve(root, rel)
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`经验库 manifest 里的分片路径越界：${rel}`)
  }
  return resolved
}

/** 行的 id（字符串）；空/缺失返回 ''（没有 id 的行无法判定重复，原样保留）。 */
function recordIdOf(row) {
  const id = row !== null && typeof row === 'object' && !Array.isArray(row) ? row.id : undefined
  return id === undefined || id === null ? '' : String(id)
}

/** 副本的「归属是否正确」：行里的 typeId 与它所在分片的类型一致得 1 分（复制进别的类型分片得 0）。 */
function recordPlacementOf(entry) {
  const bucketTypeId = entry.bucketTypeId === undefined || entry.bucketTypeId === null ? '' : String(entry.bucketTypeId)
  if (bucketTypeId === '') return 1
  const rowTypeId = String((entry.row && entry.row.typeId) || 'ty_other')
  return rowTypeId === bucketTypeId ? 1 : 0
}

/** 副本是否是「已终结」状态（删/取代/退休）：终结状态只会在记录生命后期出现，优先于旧副本。 */
function isTerminalCopy(entry) {
  const row = entry.row
  return Boolean(row && (row.deleted_at || row.superseded_by || row.retired_at))
}

/** 同一 id 的两份副本：已终结优先，其次归属正确，再次 hits 更大，最后更晚见到（字符串 ISO 可直接比较）。 */
function betterRecordCopy(candidate, current) {
  const terminal = Number(isTerminalCopy(candidate)) - Number(isTerminalCopy(current))
  if (terminal !== 0) return terminal > 0
  const placed = recordPlacementOf(candidate) - recordPlacementOf(current)
  if (placed !== 0) return placed > 0
  const hits = (Number(candidate.row && candidate.row.hits) || 0) - (Number(current.row && current.row.hits) || 0)
  if (hits !== 0) return hits > 0
  const candidateSeen = String((candidate.row && (candidate.row.lastSeenAt || candidate.row.ts)) || '')
  const currentSeen = String((current.row && (current.row.lastSeenAt || current.row.ts)) || '')
  return candidateSeen > currentSeen
}

/**
 * 分片出现重复 id（Git 合并取错一边 / 外部复制 / 手改追加）时的读侧口径（R6 缺陷 D2）：
 * **同一条只能算一条**。保留「已终结（删/取代/退休）> 归属正确 > hits 更大 > 更晚见到」的那份完整行，
 * 其余副本从读视图里丢掉——统计不会翻倍、召回不会把同一条证据给两次，也不会把已删的行复活；
 * 下一次写回该类型时按完整行集重写，盘上自然收敛成一份。
 *
 * 读侧去重而不是抛错：重复 id 是缓存/合并事故，抛错会让整库不可读（召回、列表全挂），
 * 而两份内容是同一行，丢掉较弱的一份不会损失任何字段。
 */
function dedupeRecordEntries(entries) {
  const list = Array.isArray(entries) ? entries : []
  const best = new Map()
  for (const entry of list) {
    const id = recordIdOf(entry.row)
    if (id === '') continue
    const current = best.get(id)
    if (current === undefined || betterRecordCopy(entry, current)) best.set(id, entry)
  }
  const seen = new Set()
  const out = []
  for (const entry of list) {
    const id = recordIdOf(entry.row)
    if (id === '') {
      out.push(entry)
      continue
    }
    // 不能「先到先得」：弱副本先出现时它既不是 best、又会把 id 标成已见，
    // 随后真正的 best 也被跳过 → 两份都丢（R7 缺陷 R7-D2）。只在真正输出 best 时占位。
    if (best.get(id) !== entry || seen.has(id)) continue
    seen.add(id)
    out.push(entry)
  }
  return out
}

/** 纯行数组的去重入口（没有分片归属可比）：旧单库/聚合路径用，按 hits + 时间取较强的一份。 */
export function dedupeRecordsById(rows) {
  return dedupeRecordEntries((Array.isArray(rows) ? rows : []).map((row) => ({ row }))).map((entry) => entry.row)
}

/**
 * 读全部分片记录（按 manifest 登记顺序）。同 id 多份只返回一条（R6-D2）。
 * 单桶损坏/丢失/UTF-8 非法/行数少于 manifest 声明都抛错，不静默少读——
 * 少读会被下一次写回覆盖成永久丢失（D3，2026-11-12）。
 */
export function anchoredBucketFile(bucket) {
  const rel = String(bucket && bucket.file || '')
  if (rel === '') return rel
  if (rel.includes('/') || rel.includes('\\') || path.isAbsolute(rel)) return rel
  const typeId = String(bucket && bucket.typeId || 'ty_other')
  return `${LIBRARY_DIR}/${safeTypeDirName(typeId)}/${rel}`
}

export function readShardRecords(dataDir, manifest, options = {}) {
  if (manifest === null || manifest === undefined) throw new Error('readShardRecords 需要 manifest')
  const entries = []
  for (const bucket of manifest.buckets) {
    const bucketFile = anchoredBucketFile(bucket)
    const file = resolveBucketPath(dataDir, bucketFile)
    const loaded = readBucketRows(file, bucketFile, { missing: 'throw', bucket })
    if (options.verifyHash === true && typeof bucket.hash === 'string' && bucket.hash !== '') {
      const text = bucketTextOf(loaded)
      if (contentHash(text) !== bucket.hash) throw new Error(`经验库分片内容与 manifest 声明不一致：${bucket.file}（hash 不符，拒绝把替换/篡改内容当经验返回）`)
    }
    for (const row of loaded) entries.push({ row, bucketTypeId: String(bucket.typeId || '') })
  }
  return dedupeRecordEntries(entries).map((entry) => entry.row)
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
    if (!name.toLowerCase().endsWith('.jsonl')) continue
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
      if (fs.readdirSync(sub).some((name) => name.toLowerCase().endsWith('.jsonl'))) return true
    } catch {
      // 目录不存在
    }
  }
  // 分族布局（0.27.0）：`library/<typeId>/*.jsonl`
  const library = path.join(String(dataDir || ''), LIBRARY_DIR)
  try {
    if (!fs.statSync(library).isDirectory()) return true
  } catch { /* 不存在 */ }
  try {
    for (const name of fs.readdirSync(library)) {
      if (isIgnoredLibraryDir(name)) continue
      // R10 缺陷：library 下的无扩展名普通文件不是「有分族布局」的证据，只认目录。
      try { if (!fs.statSync(path.join(library, name)).isDirectory()) continue } catch { continue }
      return true
    }
  } catch {
    // library 不存在
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
  const entries = []
  const bucketMeta = []
  for (const name of names) {
    const full = path.join(dirBuckets, name)
    // R13 缺陷：形如 <type>.<n>.jsonl 的同名目录不是分片，扫描必须跳过（否则读/迁移 EISDIR）。
    try { if (!fs.lstatSync(full).isFile()) continue } catch { continue }
    const rel = `${BUCKETS_DIR}/${name}`
    const bucketTypeId = BUCKET_NAME_RE.exec(name)[1]
    // 重建路径同样逐行做 UTF-8 校验：坏字节不能因为「manifest 坏了要重建」就被吞成 U+FFFD。
    const rows = readBucketRows(full, rel)
    for (const row of rows) entries.push({ row, bucketTypeId, file: rel })
    bucketMeta.push({ file: rel, typeId: bucketTypeId, bytes: fs.statSync(full).size })
  }
  // 重复 id 只算一条（R6-D2）：重建出的 manifest 也不能把同一条当两条计（stats/桶声明都按去重后的行算）。
  const kept = dedupeRecordEntries(entries)
  const keptByFile = new Map()
  for (const entry of kept) {
    if (!keptByFile.has(entry.file)) keptByFile.set(entry.file, [])
    keptByFile.get(entry.file).push(entry.row)
  }
  const buckets = bucketMeta.map((bucket) => {
    const keptRows = keptByFile.get(bucket.file) || []
    return { ...bucket, count: keptRows.length, latestTs: latestTsOf(keptRows) }
  })
  // 重建时看到的重复副本数（R6-D2）：manifest 里留个标记，下一次 exp_record 据此退全量
  // 读—改—写（writeStore 会重写所有类型的分片，副本自然清掉）；没有标记就只能在 touched
  // 类型里收敛，别的类型分片里的副本会一直留着、盘上仍两份。
  return { records: kept.map((entry) => entry.row), buckets, cold: scanCold(dir), duplicates: entries.length - kept.length }
}

/**
 * manifest 与磁盘是否对不上（分片文件集合 / 字节数）。
 * 字节数对不上就是「两台设备各写一半、manifest 只取了一边」的典型症状 → 缓存过期。
 */
export function shardsMismatch(dataDir, manifest) {
  if (manifest === null || manifest === undefined) return true
  if (manifest.layout === FAMILY_LAYOUT || manifest.layout === FLAT_LAYOUT) return familyShardsMismatch(dataDir, manifest)
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
    // R7 缺陷 R7-D4：这里原来用 catch 把所有读取错误都吞成 actual=0，`null` 行这类
    // 「不是对象」的坏行会把 6 行有效数据谎报成「实际 0 行」，排障直接被误导。
    // 只把「文件不在」（readBucketRows 返回 null）记作 0 行；其余损坏带着原始
    // 文件+行号的错误直接抛出去。
    const rows = readBucketRows(file, label)
    const actual = rows === null ? 0 : rows.length
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

/** 分族布局的 manifest 与实际文件比对：路径集合 + 字节数（append/rename 都会改字节）。 */
function familyShardsMismatch(dataDir, manifest) {
  const declared = new Map()
  for (const bucket of manifest.buckets) {
    const rel = String(bucket.file || '')
    if (rel === '') continue
    declared.set(rel, bucket)
  }
  const actual = new Map()
  for (const entry of scanFamilyShards(dataDir)) actual.set(entry.file, entry)
  if (declared.size !== actual.size) return true
  for (const [rel, entry] of declared) {
    const found = actual.get(rel)
    if (found === undefined) return true
    // R7-C2：桶登记的 typeId 必须与文件所在分类一致。
    if (String(entry.typeId || '') !== '' && String(found.typeId || '') !== '' && String(entry.typeId).toLowerCase() !== String(found.typeId).toLowerCase()) return true
    if (Number(entry.bytes) !== found.bytes) return true
    // R6 缺陷：同字节数的内容篡改只能靠 hash 发现。
    if (typeof entry.hash === 'string' && entry.hash !== '' && typeof found.hash === 'string' && found.hash !== entry.hash) return true
  }
  return false
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
  // 同做法键索引也是可重建缓存：仍超限就摘最老的键（代价只是那条旧记录少一次就地纠正，不丢数据）。
  let indexKeys = manifest.taskIndex !== null && manifest.taskIndex !== undefined && typeof manifest.taskIndex === 'object'
    ? Object.keys(manifest.taskIndex)
    : []
  while (indexKeys.length > 0) {
    text = `${JSON.stringify(manifest, null, 2)}\n`
    if (Buffer.byteLength(text, 'utf8') <= MANIFEST_MAX_BYTES) return manifest
    // 体积降采样同样会摘键（R7-D1）：摘掉的键要进 dropped 名单，否则快路径会把它们当新键。
    manifest.taskIndexTruncated = true
    const half = Math.ceil(indexKeys.length / 2)
    const removed = indexKeys.slice(0, half)
    indexKeys = indexKeys.slice(half)
    const trimmed = {}
    for (const key of indexKeys) trimmed[key] = manifest.taskIndex[key]
    manifest.taskIndex = trimmed
    const dropped = [...new Set([
      ...(Array.isArray(manifest.taskIndexDropped) ? manifest.taskIndexDropped : []),
      ...removed,
    ])]
    if (dropped.length <= TASK_INDEX_DROPPED_LIMIT) manifest.taskIndexDropped = dropped
    else delete manifest.taskIndexDropped
  }
  // 索引已摘空还超限：先放弃精确 dropped 名单（退化为「缺键不可信」）。
  if (manifest.taskIndexDropped !== undefined) {
    delete manifest.taskIndexDropped
    manifest.taskIndexTruncated = true
    text = `${JSON.stringify(manifest, null, 2)}\n`
    if (Buffer.byteLength(text, 'utf8') <= MANIFEST_MAX_BYTES) return manifest
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
  const builtIndex = options.taskIndex !== undefined && options.taskIndex !== null
    ? { index: options.taskIndex, dropped: [], truncated: false }
    : taskIndexEntries(store && store.experiences)
  const manifest = {
    schema: options.schema !== undefined && options.schema !== null ? Number(options.schema) : SHARD_SCHEMA,
    version: Number(store && store.version) || 1,
    types: types.map((type) => ({ ...type })),
    clusters: manifestClusters(store, previous),
    buckets: Array.isArray(buckets) ? buckets : [],
    pending: pendingEntries(store),
    recent: Array.isArray(options.recent) ? options.recent : recentEntries(store),
    stats: options.stats !== undefined && options.stats !== null ? options.stats : statsEntries(store),
    // 同做法键索引（0.21.3 R1）：全量重建时直接用全部行重算，增量路径由 writeTypeShards 维护。
    taskIndex: builtIndex.index,
    cold: normalizeCold(previousCold),
  }
  // 索引被截断过（R7-D1）：快路径不能把缺键当成「没有跨类型旧条」。
  // 名单在预算内就记下来（缺键可精确判别）；超预算只留 truncated 标记（缺键一律退慢）。
  if (builtIndex.truncated) manifest.taskIndexTruncated = true
  if (Array.isArray(builtIndex.dropped) && builtIndex.dropped.length > 0 && builtIndex.dropped.length <= TASK_INDEX_DROPPED_LIMIT) {
    manifest.taskIndexDropped = builtIndex.dropped
  }
  const migratedFrom = options.migratedFrom
    || (previous !== null && previous !== undefined && typeof previous.migratedFrom === 'string' ? previous.migratedFrom : '')
  if (typeof migratedFrom === 'string' && migratedFrom !== '') manifest.migratedFrom = migratedFrom
  // 重建时发现的重复 id 副本数（R6-D2）：只在显式传入（readManifest 自愈）时登记，写盘路径一律清掉。
  if (Number(options.duplicates) > 0) manifest.duplicates = Math.trunc(Number(options.duplicates))
  // 布局标记（0.27.0）：分族布局只加一个字段，buckets 结构与旧版兼容。
  if (options.layout !== undefined && options.layout !== null && String(options.layout) !== '') manifest.layout = String(options.layout)
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
  // R2 缺陷：分族布局下 family 文件在 library/，指纹必须覆盖，否则缓存会返回旧数据。
  const libraryRoot = path.join(dir, LIBRARY_DIR)
  let libraryTypes = []
  try { libraryTypes = fs.readdirSync(libraryRoot).sort() } catch { libraryTypes = [] }
  for (const typeId of libraryTypes) {
    const typeDir = path.join(libraryRoot, typeId)
    let names = []
    try { names = fs.readdirSync(typeDir).sort() } catch { names = [] }
    for (const name of names) {
      if (!name.toLowerCase().endsWith('.jsonl')) continue
      statPart(`f/${typeId}/${name}`, path.join(typeDir, name))
    }
  }
  statPart('l', path.join(dir, LEGACY_SOURCE_FILE))
  for (const [label, sub] of [['b', bucketsPath(dir)], ['c', coldPath(dir)]]) {
    let names = []
    try {
      names = fs.readdirSync(sub).filter((name) => name.toLowerCase().endsWith('.jsonl')).sort()
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
    const unchanged = before !== undefined && before.hash === hash && fs.existsSync(path.join(dir, group.rel))
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

/** 生成一个分类目录的 _type/_index 内容（不写盘，供两阶段写与索引一起提交）。 */
function familyIndexFiles(dataDir, typeId, typeName, entries, created = false) {
  const families = entries.map((entry) => ({ file: entry.file, family: entry.family, count: entry.count, bytes: entry.bytes, latestTs: entry.latestTs, hash: entry.hash }))
  const unfiled = entries.filter((entry) => entry.family === UNFILED_FAMILY).reduce((sum, entry) => sum + entry.count, 0)
  const total = entries.reduce((sum, entry) => sum + entry.count, 0)
  const isEmptyType = families.length === 0
  // 0.33：flat 布局只有根 _index.json，不再写 _type.json。
  if (isFlatLayout(dataDir)) {
    return [{ rel: `${LIBRARY_DIR}/_index.json`, text: `${JSON.stringify({ families, unfiled, total, ...(isEmptyType ? { created: true } : {}) }, null, 2)}\n` }]
  }
  const dirName = safeTypeDirName(typeId)
  return [
    { rel: `${LIBRARY_DIR}/${dirName}/_type.json`, text: `${JSON.stringify({ typeId, name: typeName }, null, 2)}\n` },
    { rel: `${LIBRARY_DIR}/${dirName}/_index.json`, text: `${JSON.stringify({ typeId, families, unfiled, total, ...(isEmptyType ? { created: true } : {}) }, null, 2)}\n` },
  ]
}

/** R13 缺陷：分类目录必须是库内真实目录（链接/junction 指向库外时一律不算分类）。 */
function isTypeDirInsideLibrary(libraryRoot, typeDir) {
  try {
    const libraryReal = fs.realpathSync(libraryRoot)
    const typeReal = fs.realpathSync(typeDir)
    return typeReal === libraryReal || typeReal.startsWith(libraryReal + path.sep)
  } catch { return false }
}

/** R12 缺陷：.bak/.tmp 目录是备份/临时物，不属于分类；隐藏目录也不算。 */
function isIgnoredLibraryDir(name) {
  const value = String(name || '')
  return value.startsWith('.') || value.toLowerCase().endsWith('.bak') || value.toLowerCase().endsWith('.tmp')
}

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
 * 同 id 多份（本类型桶内重复 / 复制进别的类型桶）只返回一条（R6-D2）。
 * @returns {{records: object[], files: string[]}}
 */
export function readShardRecordsOfTypes(dataDir, manifest, typeIds = []) {
  if (manifest === null || manifest === undefined) throw new Error('readShardRecordsOfTypes 需要 manifest')
  // R12 缺陷：桶 typeId 与文件目录仅大小写不同时也必须算同一分类（否则快速路径读不到旧行）。
  const wanted = new Set((Array.isArray(typeIds) ? typeIds : [typeIds]).map((id) => String(id).toLowerCase()).filter((id) => id !== ''))
  const files = []
  const entries = []
  for (const bucket of manifest.buckets) {
    if (wanted.size > 0 && !wanted.has(String(bucket.typeId || '').toLowerCase())) continue
    const bucketFile = anchoredBucketFile(bucket)
    files.push(bucketFile)
    const rows = readBucketRows(resolveBucketPath(dataDir, bucketFile), bucketFile, { bucket })
    for (const row of rows) entries.push({ row, bucketTypeId: String(bucket.typeId || '') })
  }
  return { records: dedupeRecordEntries(entries).map((entry) => entry.row), files }
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

/** 分族布局的局部写：只重写 touched 类型的族文件，未触及的类型原样保留。 */
function writeTypeFamilyShards(dataDir, manifest, payload) {
  const dir = String(dataDir || '')
  const flatLayout = isFlatLayout(dir)
  const touched = [...new Set((Array.isArray(payload.touchedTypeIds) ? payload.touchedTypeIds : []).map(String))]
  const rowsByType = payload.rowsByType !== null && typeof payload.rowsByType === 'object' ? payload.rowsByType : {}
  for (const typeId of Object.keys(rowsByType)) {
    if (!touched.includes(String(typeId))) {
      throw new Error(`writeTypeShards：rowsByType 里的类型 ${typeId} 不在 touchedTypeIds 里（局部写不许碰没声明的类型）`)
    }
  }
  const previousByName = new Map()
  for (const bucket of manifest.buckets) {
    const rel = String(bucket.file || '')
    if (rel !== '') previousByName.set(rel, bucket)
  }
  const touchedLower = new Set(touched.map((id) => String(id).toLowerCase()))
  const untouched = manifest.buckets.filter((bucket) => !touchedLower.has(String(bucket.typeId || '').toLowerCase()))
  // R7-C2：未触及桶登记的文件一律保护，局部写不得删除别的分类声明的文件。
  const protectedOtherFiles = new Set(untouched.map((bucket) => String(bucket && bucket.file || '')).filter(Boolean))
  const keepByType = new Map()
  const written = []
  const pendingWrites = []
  const indexJobs = []
  const staleBaks = []
  const typeNames = new Map((Array.isArray(payload.types) ? payload.types : manifest.types).map((type) => [String(type && type.id), String(type && type.name || '')]))
  for (const typeId of touched) {
    const guardDir = familyDirOf(dir, typeId)
    if (fs.existsSync(guardDir) && !isTypeDirInsideLibrary(path.join(dir, LIBRARY_DIR), guardDir)) {
      throw new Error(`分类目录越界（链接指向库外，拒绝写入）：${guardDir}`)
    }
    const rows = Array.isArray(rowsByType[typeId])
      ? rowsByType[typeId].filter((row) => row !== null && typeof row === 'object' && !Array.isArray(row))
      : []
    const groups = new Map()
    for (const row of rows) {
      const family = familyOf(row)
      if (!groups.has(family)) groups.set(family, [])
      groups.get(family).push(row)
    }
    const typeDir = flatLayout ? path.join(dir, LIBRARY_DIR) : familyDirOf(dir, typeId)
    fs.mkdirSync(typeDir, { recursive: true })
    const keep = new Set()
    for (const [family, familyRows] of [...groups.entries()].sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))) {
      let chunk = []
      let chunkIndex = 0
      let bytes = 0
      const flush = () => {
        if (chunk.length === 0) return
        const rel = familyRelPath(typeId, family, chunkIndex, dir)
        const text = bucketTextOf(chunk)
        const hash = contentHash(text)
        const before = previousByName.get(rel)
        if (before === undefined || before.hash !== hash || !fs.existsSync(path.join(dir, rel))) pendingWrites.push({ rel, text })
        keep.add(path.basename(rel))
        written.push({ file: rel, typeId, family, count: chunk.length, bytes: Buffer.byteLength(text, 'utf8'), latestTs: latestTsOf(chunk), hash })
        chunk = []
        bytes = 0
        chunkIndex += 1
      }
      for (const row of familyRows) {
        const rowBytes = Buffer.byteLength(JSON.stringify(row), 'utf8') + 1
        if (chunk.length > 0 && bytes + rowBytes > MAX_BUCKET_BYTES) flush()
        chunk.push(row)
        bytes += rowBytes
      }
      flush()
    }
    keepByType.set(typeId, keep)
    // touched 类型里本次没产出的旧族文件删掉（族改成别的 / 清空）
    // R11 缺陷：GC 必须在隔离之前跑，否则 rename 保留的老 mtime 会让 .bak 在提交前被 GC 掉，失败无法回滚。
    // flat：所有类型共享 library 根，不能按单个类型 GC（会误删其它类型的族文件），统一在循环后做一次。
    if (!flatLayout) {
    cleanupStaleTemps(typeDir)
    let names = []
    try { names = fs.readdirSync(typeDir) } catch { names = [] }
    try {
      for (const name of names) {
        const currentRel = `${LIBRARY_DIR}/${path.basename(typeDir)}/${name}`
        if (!name.toLowerCase().endsWith('.jsonl') || keep.has(name) || protectedOtherFiles.has(currentRel)) continue
        const stalePath = path.join(typeDir, name)
        // R11 缺陷：同名目录不是族文件，不能 rename 成 .bak（否则用户目录被移走且清不掉）。
        try { if (!fs.lstatSync(stalePath).isFile()) continue } catch { continue }
        const bakPath = `${stalePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.bak`
        fs.renameSync(stalePath, bakPath)
        staleBaks.push({ bakPath, stalePath })
      }
    } catch (error) {
      for (const item of staleBaks) { try { fs.renameSync(item.bakPath, item.stalePath) } catch { /* 恢复失败也继续 */ } }
      throw error
    }
    }
    // R11 缺陷：隔离出来的 .bak 在提交前不能被 GC（mtime 老会被误删），这里不再调用 cleanupStaleTemps。
    const createdBefore = (() => { try { return JSON.parse(fs.readFileSync(path.join(typeDir, '_index.json'), 'utf8')).created === true } catch { return false } })()
    // R8 缺陷：_index 必须最后写（数据文件→_index→manifest 的提交顺序）；否则强杀在 _index 之后会留下「新索引 + 旧文件」。
    indexJobs.push({ typeId, entries: written.filter((entry) => entry.typeId === typeId), createdBefore })
  }
  if (flatLayout) {
    // 一次性 GC：保留所有类型本次写出的族文件，删除根下陈旧 .jsonl。
    cleanupStaleTemps(path.join(dir, LIBRARY_DIR))
    const keepAll = new Set([...keepByType.values()].flatMap((set) => [...set]))
    // 未触及类型的族文件也必须在 flat GC 里保留。
    for (const bucket of untouched) keepAll.add(path.basename(String(bucket && bucket.file || '')))
    let names = []
    try { names = fs.readdirSync(path.join(dir, LIBRARY_DIR)) } catch { names = [] }
    const flatBaks = []
    try {
      for (const name of names) {
        if (!name.toLowerCase().endsWith('.jsonl') || keepAll.has(name)) continue
        const stalePath = path.join(dir, LIBRARY_DIR, name)
        try { if (!fs.lstatSync(stalePath).isFile()) continue } catch { continue }
        const bakPath = `${stalePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.bak`
        fs.renameSync(stalePath, bakPath)
        flatBaks.push({ bakPath, stalePath })
      }
    } catch (error) {
      for (const item of flatBaks) { try { fs.renameSync(item.bakPath, item.stalePath) } catch { /* ignore */ } }
      throw error
    }
    for (const item of flatBaks) { try { fs.unlinkSync(item.bakPath) } catch { /* 留给 GC */ } }
    indexJobs.length = 0
    indexJobs.push({ typeId: '', entries: [...untouched, ...written], createdBefore: false })
  }
  // R9 缺陷：把 _type/_index 也并入同一事务（数据文件+索引一起提交），_index 写失败时整体回滚。
  for (const job of indexJobs) pendingWrites.push(...familyIndexFiles(dir, job.typeId, typeNames.get(job.typeId) || '', job.entries, job.createdBefore))
  try {
    writeManyAtomicFiles(dir, pendingWrites)
  } catch (error) {
    for (const item of staleBaks) { try { fs.renameSync(item.bakPath, item.stalePath) } catch { /* 恢复失败也继续 */ } }
    throw error
  }
  // R10 缺陷：陈旧族文件先改名隔离再提交；提交成功后才真正删除（删不掉留 .bak，读路径不会把它当族文件）。
  for (const item of staleBaks) { try { fs.unlinkSync(item.bakPath) } catch { /* 留给 GC */ } }
  // R5 缺陷：局部写也要维护「档案柜」——payload.types 里声明的空分类若目录缺失，补建目录与 created 索引。
  const declaredTypes = Array.isArray(payload.types) ? payload.types : manifest.types
  for (const type of (flatLayout ? [] : (Array.isArray(declaredTypes) ? declaredTypes : []))) {
    const typeId = String(type && type.id)
    if (typeId === '' || typeId === 'ty_other') continue
    const typeDirNow = familyDirOf(dir, typeId)
    if (fs.existsSync(path.join(typeDirNow, '_type.json')) && fs.existsSync(path.join(typeDirNow, '_index.json'))) continue
    // 未触及但仍有族文件的分类：按磁盘文件重建它的 _index（不能补成空档案柜，也不能只跳过）。
    let familyFileNames = []
    try { familyFileNames = fs.readdirSync(typeDirNow).filter((name) => name.toLowerCase().endsWith('.jsonl')) } catch { familyFileNames = [] }
    if (familyFileNames.length > 0) {
      const typeDirName = path.basename(typeDirNow)
      const entriesOfType = []
      for (const name of familyFileNames) {
        try {
          const rows = readBucketRows(path.join(typeDirNow, name), `${LIBRARY_DIR}/${typeDirName}/${name}`) || []
          const text = bucketTextOf(rows)
          entriesOfType.push({
            file: `${LIBRARY_DIR}/${typeDirName}/${name}`,
            family: familyNameFromFile(name),
            count: rows.length,
            bytes: Buffer.byteLength(text, 'utf8'),
            latestTs: latestTsOf(rows),
            hash: contentHash(text),
          })
        } catch { /* 损坏文件交给读路径报错 */ }
      }
      if (entriesOfType.length > 0) writeFamilyIndexes(dir, typeId, String(type && type.name || ''), entriesOfType, false)
      continue
    }
    markFamilyTypeCreated(dir, typeId, String(type && type.name || ''))
  }

  // stats / recent / taskIndex 就地合并（与旧布局同口径）
  const computedByType = new Map()
  for (const typeId of touched) {
    computedByType.set(typeId, typeStatsOfRows(Array.isArray(rowsByType[typeId]) ? rowsByType[typeId] : []))
  }
  const nextStats = mergeTypeStats(dir, manifest.stats, touched, computedByType)
  const nextRecent = mergeRecent(manifest.recent, touched, computedByType)
  let taskIndexPrevious = {
    index: taskIndexOf(manifest),
    dropped: Array.isArray(manifest.taskIndexDropped) ? manifest.taskIndexDropped : null,
    truncated: manifest.taskIndexTruncated === true,
  }
  if (taskIndexPrevious.index === null) {
    const untouchedTypeIds = [...new Set(untouched.map((bucket) => String(bucket.typeId)))]
      .filter((typeId) => !touched.includes(typeId))
    taskIndexPrevious = {
      index: taskIndexEntries(readShardRecordsOfTypes(dir, manifest, untouchedTypeIds).records, Number.MAX_SAFE_INTEGER).index,
      dropped: [],
      truncated: false,
    }
  }
  const mergedIndex = mergeTaskIndex(taskIndexPrevious, touched, rowsByType)
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
    taskIndex: mergedIndex.index,
    ...(Array.isArray(payload.pending) ? { pending: payload.pending } : {}),
    ...(payload.cold !== undefined && payload.cold !== null ? { cold: normalizeCold(payload.cold) } : {}),
  }
  if (mergedIndex.truncated) next.taskIndexTruncated = true
  else delete next.taskIndexTruncated
  if (mergedIndex.dropped !== null && mergedIndex.dropped.length > 0) next.taskIndexDropped = mergedIndex.dropped
  else delete next.taskIndexDropped
  writeManifest(dir, next)
  return next
}
export function writeTypeShards(dataDir, manifest, payload = {}) {
  if (manifest === null || manifest === undefined) throw new Error('writeTypeShards 需要 manifest（先 readManifest）')
  const dir = String(dataDir || '')
  if (dir === '') throw new Error('writeTypeShards 需要 dataDir（.exp 根目录）')
  const touched = [...new Set((Array.isArray(payload.touchedTypeIds) ? payload.touchedTypeIds : []).map(String))]
  if (touched.length === 0) return manifest
  if (manifest.layout === FAMILY_LAYOUT || manifest.layout === FLAT_LAYOUT) return writeTypeFamilyShards(dataDir, manifest, payload)
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
      if (before === undefined || before.hash !== hash || !fs.existsSync(path.join(dirBuckets, name))) writeFileAtomic(path.join(dirBuckets, name), text)
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
  // 同做法键索引（0.21.3 R1）：老 manifest 没有索引时，用**没被本次写过的类型**的现存分片补出基线
  // （touched 类型的分片刚被替换，不能按旧 manifest 去读，否则会读到半写状态）。
  // 只补一次：写回之后 manifest 就带索引，后续都是纯增量。
  let taskIndexPrevious = {
    index: taskIndexOf(manifest),
    dropped: Array.isArray(manifest.taskIndexDropped) ? manifest.taskIndexDropped : null,
    truncated: manifest.taskIndexTruncated === true,
  }
  if (taskIndexPrevious.index === null) {
    const untouchedTypeIds = [...new Set(untouched.map((bucket) => String(bucket.typeId)))]
      .filter((typeId) => !touched.includes(typeId))
    taskIndexPrevious = {
      index: taskIndexEntries(readShardRecordsOfTypes(dir, manifest, untouchedTypeIds).records, Number.MAX_SAFE_INTEGER).index,
      dropped: [],
      truncated: false,
    }
  }
  const mergedIndex = mergeTaskIndex(taskIndexPrevious, touched, rowsByType)
  const nextTaskIndex = mergedIndex.index
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
    taskIndex: nextTaskIndex,
    ...(Array.isArray(payload.pending) ? { pending: payload.pending } : {}),
    ...(payload.cold !== undefined && payload.cold !== null ? { cold: normalizeCold(payload.cold) } : {}),
  }
  // 索引完整性标记（R7-D1）：增量写无法证明索引完整，老 manifest 截断过就仍是截断；
  // 只有全量写（buildManifest）才会重新判定并清掉。
  if (mergedIndex.truncated) next.taskIndexTruncated = true
  else delete next.taskIndexTruncated
  if (mergedIndex.dropped !== null && mergedIndex.dropped.length > 0) next.taskIndexDropped = mergedIndex.dropped
  else delete next.taskIndexDropped
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
  // 分族布局不做压缩下沉（族文件已按 2 MiB 拆片；冷档逻辑待后续版本）。
  if (current.layout === FAMILY_LAYOUT || current.layout === FLAT_LAYOUT) return current

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
      names = fs.readdirSync(sub).filter((name) => name.toLowerCase().endsWith('.jsonl')).sort()
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
/** library/ 下全部族文件（分族布局的热档）。 */
function familyJsonlFiles(dataDir) {
  const root = path.join(String(dataDir || ''), LIBRARY_DIR)
  const out = []
  let names = []
  try { names = fs.readdirSync(root) } catch { return out }
  // flat：族文件直接在 library/ 根。
  if (isFlatLayout(dataDir)) {
    for (const name of names) {
      if (!name.toLowerCase().endsWith('.jsonl')) continue
      const file = path.join(root, name)
      try { if (fs.statSync(file).isFile()) out.push(file) } catch { /* skip */ }
    }
    return out
  }
  for (const typeId of names) {
    let files = []
    try { files = fs.readdirSync(path.join(root, typeId)) } catch { files = [] }
    for (const name of files) if (name.endsWith('.jsonl')) out.push(path.join(root, typeId, name))
  }
  return out
}
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
  // R3 缺陷：分族布局的热档在 library/，用量必须算进去。
  for (const file of familyJsonlFiles(dir)) addFile(file)
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
    layout: 'legacy',
    typeDirs: 0,
    familyFiles: 0,
    familyBytes: 0,
    indexFiles: 0,
    indexBytes: 0,
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
      names = fs.readdirSync(sub).filter((name) => name.toLowerCase().endsWith('.jsonl'))
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
  // R3 缺陷：分族布局的族文件计入热档（bucketBytes/bucketFiles/fileCount）。
  for (const file of familyJsonlFiles(dir)) {
    const size = fileSizeOf(file)
    if (size < 0) continue
    usage.bucketBytes += size
    usage.bucketFiles += 1
    usage.familyBytes += size
    usage.familyFiles += 1
    usage.fileCount += 1
  }
  // 0.31 UI：分族布局的分类目录数与索引文件也进报表（只用于展示，不改任何读写）。
  if (isFlatLayout(dir)) {
    usage.typeDirs = 0
    const size = fileSizeOf(path.join(dir, LIBRARY_DIR, '_index.json'))
    if (size >= 0) { usage.indexBytes += size; usage.indexFiles += 1; usage.fileCount += 1 }
    usage.layout = 'family-flat'
  } else {
    let familyDirs = []
    try { familyDirs = fs.readdirSync(path.join(dir, LIBRARY_DIR)).filter((name) => !isIgnoredLibraryDir(name)) } catch { familyDirs = [] }
    usage.typeDirs = familyDirs.length
    for (const typeId of familyDirs) {
      for (const name of ['_type.json', '_index.json']) {
        const size = fileSizeOf(path.join(dir, LIBRARY_DIR, typeId, name))
        if (size < 0) continue
        usage.indexBytes += size
        usage.indexFiles += 1
        usage.fileCount += 1
      }
    }
    usage.layout = familyDirs.length > 0 ? 'family' : 'legacy'
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
  // R3 缺陷：分族布局的族文件也要计数。
  count += familyJsonlFiles(dir).length
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

// ─────────────────────────────────────────────────────────────────────────────
// 0.27.0 P0：分族存储（分类 → 文件夹 / 族 → 文件 / 经验 → 行）
// 目标：分类只决定目录，族决定文件；检索读路径仍走 manifest.buckets 列表，形状不变。
// 约束：不引入新存储引擎，复用现有 bucket 文本/哈希/原子写/manifest 构建。
// ─────────────────────────────────────────────────────────────────────────────

export const FAMILY_LAYOUT = 'family'
export const FLAT_LAYOUT = 'family-flat'
export const LIBRARY_DIR = 'library'

/** 0.33：单层族布局（library/<族~hash>.jsonl）。 */
export function isFlatLayout(dataDir) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(String(dataDir || ''), 'manifest.json'), 'utf8'))
    return manifest.layout === FLAT_LAYOUT
  } catch { return false }
}
export const UNFILED_FAMILY = '未分族'
export const FAMILY_SCHEMA = 3

/** 行的族键：`family` 字段优先；缺省 / 空值 → 未分族。 */
export function familyOf(row) {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return UNFILED_FAMILY
  const raw = typeof row.family === 'string' ? row.family.trim() : ''
  return raw === '' ? UNFILED_FAMILY : raw
}

/**
 * 族名 → 文件名（0.27.0 R1 修复）：**清洗名 + 原名哈希尾缀**保证单射。
 * - 非法字符/空白折叠/大小写不同的族名不会撞同一文件（哈希取自原族名）；
 * - `.`/`..`/空名 → `_~hash`，避免与「未分族」或路径穿越混淆；
 * - 按码点截断 40 字（不劈代理对），哈希尾缀保证截断后仍可区分；
 * - 分片后缀 `.N` 追加在哈希段之后，族名里形如 `.1` 的尾巴不会再与分片撞名。
 */
function safeFamilyFileName(family) {
  const raw = String(family === undefined || family === null ? '' : family)
  const cleaned = raw.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/gu, ' ').trim()
  const base = cleaned === '' || cleaned === '.' || cleaned === '..' ? '_' : cleaned
  const head = [...base].slice(0, 40).join('')
  return `${head}~${contentHash(raw).slice(0, 8)}`
}

function safeTypeDirName(typeId) {
  const raw = String(typeId === undefined || typeId === null || typeId === '' ? 'ty_other' : typeId)
  const cleaned = raw.replace(/[\\/:*?"<>|.]/g, '_')
  return cleaned === '' ? 'ty_other' : cleaned
}

/** 族文件相对路径：`library/<typeId>/<族~hash>.jsonl`（第 2 片起 `.1.jsonl`）。 */
export function familyRelPath(typeId, family, index = 0, dataDir = '') {
  const name = safeFamilyFileName(family)
  // 0.33：单层族布局不再有分类目录。
  if (dataDir !== '' && isFlatLayout(dataDir)) return `${LIBRARY_DIR}/${name}${index > 0 ? `.${index}` : ''}.jsonl`
  const safeType = safeTypeDirName(typeId)
  return `${LIBRARY_DIR}/${safeType}/${name}${index > 0 ? `.${index}` : ''}.jsonl`
}

/** 是否已经切到分族布局（有 library/ 目录即视为是）。 */
export function hasFamilyLayout(dataDir) {
  return fs.existsSync(path.join(String(dataDir || ''), LIBRARY_DIR))
}
export function familyDirOf(dataDir, typeId) {
  // 与 familyRelPath 使用同一套清洗，避免「文件在 library/a_b/、索引写到 library/a/b/」的分叉。
  return path.join(String(dataDir || ''), LIBRARY_DIR, safeTypeDirName(typeId))
}

/**
 * 按 (typeId, family) 分组；未知类型落 `ty_other`；空族落 `未分族`。
 * @returns {Map<string, {typeId:string, family:string, rel:string, rows:object[]}>}
 */
export function groupRecordsByFamily(store) {
  const types = Array.isArray(store && store.types) ? store.types : []
  const known = new Set(types.filter((type) => type && typeof type === 'object').map((type) => String(type.id)))
  const groups = new Map()
  for (const row of Array.isArray(store && store.experiences) ? store.experiences : []) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) continue
    const rawTypeId = String(row.typeId || '')
    const typeId = known.has(rawTypeId) ? rawTypeId : 'ty_other'
    const family = familyOf(row)
    const key = `${typeId}\u0000${family}`
    let group = groups.get(key)
    if (group === undefined) {
      group = { typeId, family, rel: familyRelPath(typeId, family, 0), rows: [] }
      groups.set(key, group)
    }
    group.rows.push(row)
  }
  return groups
}

/** 写一个分类目录下的 `_type.json` 与 `_index.json`（人肉可读 + 族清单）。 */
function writeFamilyIndexes(dataDir, typeId, typeName, entries, created = false) {
  const dir = familyDirOf(dataDir, typeId)
  fs.mkdirSync(dir, { recursive: true })
  writeFileAtomic(path.join(dir, '_type.json'), `${JSON.stringify({ typeId, name: typeName }, null, 2)}\n`)
  const families = entries.map((entry) => ({ file: entry.file, family: entry.family, count: entry.count, bytes: entry.bytes, latestTs: entry.latestTs, hash: entry.hash }))
  const unfiled = entries.filter((entry) => entry.family === UNFILED_FAMILY).reduce((sum, entry) => sum + entry.count, 0)
  const total = entries.reduce((sum, entry) => sum + entry.count, 0)
  // 空分类（没有任何族文件）带 created:true；一旦拿到行就撤掉该标记（R7-C01：索引不随历史漂移）。
  const isEmptyType = families.length === 0
  writeFileAtomic(path.join(dir, '_index.json'), `${JSON.stringify({ typeId, families, unfiled, total, ...(isEmptyType ? { created: true } : {}) }, null, 2)}\n`)
}

/**
 * 分族布局写盘：只重写内容变化的族文件（按 hash 比对），清理已消失的族文件。
 * 返回新 manifest（layout: 'family', schema: 3）。
 */
export function writeFamilyShards(dataDir, store, previousManifest = null, options = {}) {
  const dir = String(dataDir || '')
  if (dir === '') throw new Error('writeFamilyShards 需要 dataDir（.exp 根目录）')
  const groups = groupRecordsByFamily(store)
  // 0.27.0：即使本次没有行，也要建 library/ 根——布局标记必须能从磁盘看出来（空库丢 manifest 后不能退回 schema 2）。
  fs.mkdirSync(path.join(dir, LIBRARY_DIR), { recursive: true })
  const previousByName = new Map()
  if (previousManifest !== null && previousManifest !== undefined && Array.isArray(previousManifest.buckets)) {
    for (const bucket of previousManifest.buckets) {
      const name = path.basename(String(bucket.file || ''))
      if (name !== '') previousByName.set(`${String(bucket.typeId || '')}/${name}`, bucket)
    }
  }
  const entries = []
  const keepByType = new Map()
  const pendingWritesFull = []
  const typeNames = new Map((Array.isArray(store && store.types) ? store.types : []).map((type) => [String(type && type.id), String(type && type.name || '')]))
  // R3 缺陷：分类（含 0 条经验的空分类）必须有自己的目录与 _type.json；全量写不能把它当空壳删掉。
  const knownTypeIds = new Set(typeNames.keys())
  for (const group of groups.values()) {
    let chunk = []
    let chunkIndex = 0
    let bytes = 0
    const flush = () => {
      if (chunk.length === 0) return
      const rel = familyRelPath(group.typeId, group.family, chunkIndex, dir)
      const text = bucketTextOf(chunk)
      const hash = contentHash(text)
      const before = previousByName.get(`${group.typeId}/${path.basename(rel)}`)
        if (before === undefined || before.hash !== hash || !fs.existsSync(path.join(dir, rel))) pendingWritesFull.push({ rel, text })
      const keep = keepByType.get(group.typeId) || new Set()
      keep.add(path.basename(rel))
      keepByType.set(group.typeId, keep)
      entries.push({ file: rel, typeId: group.typeId, family: group.family, count: chunk.length, bytes: Buffer.byteLength(text, 'utf8'), latestTs: latestTsOf(chunk), hash })
      chunk = []
      bytes = 0
      chunkIndex += 1
    }
    for (const row of group.rows) {
      const rowBytes = Buffer.byteLength(JSON.stringify(row), 'utf8') + 1
      if (chunk.length > 0 && bytes + rowBytes > MAX_BUCKET_BYTES) flush()
      chunk.push(row)
      bytes += rowBytes
    }
    flush()
  }
  // R10 缺陷：数据文件 + _type/_index 并入同一事务；陈旧族先改名隔离，提交成功后再删。
  const staleBaksFull = []
  const dirsToRemoveFull = []
  // 清理消失的族文件与临时文件（每个分类目录独立）
  // R1 缺陷 D4：整库/某个分类被清空时，旧类型目录不在本次 groups 里，也必须把它的族文件删掉，
  // 否则下一次读的自愈重建会把已删除的行「复活」。
  // 分类=档案柜（终口径）：store.types 里声明的分类都保目录与 _type/_index（空分类 created:true）；
  // R4 缺陷：外部删掉空分类目录后再全量写，目录会被重建，manifest 与磁盘不再分叉。
  // 系统「未分类」不预建目录（无行时没有意义，R2 合并用例也按此口径）。
  const declaredTypeIds = [...knownTypeIds].filter((typeId) => typeId !== 'ty_other')
  const typeIds = new Set([...keepByType.keys(), ...declaredTypeIds, ...entries.map((entry) => entry.typeId)])
  if (previousManifest !== null && previousManifest !== undefined && Array.isArray(previousManifest.buckets)) {
    for (const bucket of previousManifest.buckets) {
      const typeId = String(bucket && bucket.typeId ? bucket.typeId : '')
      if (typeId !== '') typeIds.add(typeId)
    }
  }
  // 物理目录映射（Windows 大小写不敏感：`TY_A` 与 `ty_a` 是同一个目录）：
  // 先按磁盘上的真实名字解析每个 typeId 的目录，再逐个目录用**自己的** keep 清理——
  // 不能用全局 keep 并集（R7-G02：会把别的分类的同名族文件留成幽灵，读自愈后行复活）。
  const libraryRoot = path.join(dir, LIBRARY_DIR)
  let rootDirs = []
  try { rootDirs = fs.readdirSync(libraryRoot).filter((name) => !name.startsWith('.')) } catch { rootDirs = [] }
  const physicalByLower = new Map(rootDirs.map((name) => [name.toLowerCase(), name]))
  const actualDirOf = (typeId) => physicalByLower.get(safeTypeDirName(typeId).toLowerCase()) || safeTypeDirName(typeId)
  // typeId 大小写归一：声明类型里有同一个 id（忽略大小写）时以声明为准，
  // 避免扫描目录名（TY_A）与 store.typeId（ty_a）被当成两个分类互相删文件。
  const declaredByLower = new Map([...knownTypeIds].map((id) => [String(id).toLowerCase(), String(id)]))
  // flat：所有类型共享 library 根，GC 必须用全量 keep 一次算，不能按空类型逐个目录清。
  const flatGlobalKeep = new Set([...keepByType.values()].flatMap((set) => [...set]))
  const canonicalTypeIds = new Set([...typeIds].map((id) => declaredByLower.get(String(id).toLowerCase()) || id))
  for (const typeId of canonicalTypeIds) {
    const guardDir = familyDirOf(dir, typeId)
    if (fs.existsSync(guardDir) && !isTypeDirInsideLibrary(libraryRoot, guardDir)) {
      throw new Error(`分类目录越界（链接指向库外，拒绝写入）：${guardDir}`)
    }
    const dirName = actualDirOf(typeId)
    const canonical = safeTypeDirName(typeId)
    const flat = isFlatLayout(dir)
    // Windows 大小写不敏感、但部分目录开启了 case-sensitive：把物理目录名规范成 canonical，
    // 否则后续以 canonical 路径读写会 ENOENT（R6-H06）。flat 布局没有分类目录，跳过。
    if (!flat && dirName !== canonical) {
      try { fs.renameSync(path.join(libraryRoot, dirName), path.join(libraryRoot, canonical)) } catch { /* 改不动就按原名用 */ }
    }
    const typeDir = flat ? libraryRoot : path.join(libraryRoot, canonical)
    const keepByPhysical = new Map()
    for (const [key, set] of keepByType) {
      const physical = safeTypeDirName(key).toLowerCase()
      if (!keepByPhysical.has(physical)) keepByPhysical.set(physical, new Set())
      for (const name of set) keepByPhysical.get(physical).add(name.toLowerCase())
    }
    const directKeep = keepByType.get(typeId) || [...keepByType.entries()].find(([key]) => key.toLowerCase() === typeId.toLowerCase())?.[1]
    const keepLower = flat
      ? new Set([...flatGlobalKeep].map((name) => name.toLowerCase()))
      : (directKeep !== undefined ? new Set([...directKeep].map((name) => name.toLowerCase())) : (keepByPhysical.get(safeTypeDirName(typeId).toLowerCase()) || new Set()))
    cleanupStaleTemps(typeDir)
    let names = []
    try { names = fs.readdirSync(typeDir) } catch { names = [] }
    try {
      for (const name of names) {
        if (!name.toLowerCase().endsWith('.jsonl')) continue
        if (keepLower.has(name.toLowerCase())) continue
        const stalePath = path.join(typeDir, name)
        try { if (!fs.lstatSync(stalePath).isFile()) continue } catch { continue }
        const bakPath = `${stalePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.bak`
        fs.renameSync(stalePath, bakPath)
        staleBaksFull.push({ bakPath, stalePath })
      }
    } catch (error) {
      for (const item of staleBaksFull) { try { fs.renameSync(item.bakPath, item.stalePath) } catch { /* 恢复失败也继续 */ } }
      throw error
    }
    const typeEntries = entries.filter((entry) => String(entry.typeId).toLowerCase() === typeId.toLowerCase())
    const createdBefore = (() => { try { return JSON.parse(fs.readFileSync(path.join(typeDir, '_index.json'), 'utf8')).created === true } catch { return false } })()
    // 分类=档案柜（终口径）：types 里声明的分类即使 0 行也保留目录与 _type/_index。
    if (typeEntries.length === 0 && knownTypeIds.has(typeId)) { pendingWritesFull.push(...familyIndexFiles(dir, typeId, typeNames.get(typeId) || '', [], createdBefore)); continue }


    if (typeEntries.length === 0) {
      if (typeDir.startsWith(libraryRoot + path.sep)) dirsToRemoveFull.push(typeDir)
      continue
    }
    pendingWritesFull.push(...familyIndexFiles(dir, typeId, typeNames.get(typeId) || '', typeEntries, createdBefore))
  }
  // R3 缺陷：全量写以当前 store 为准，清扫不属于本次结果的分类目录（幽灵目录/去重后变空的目录）。
  // 隐藏目录（.git/.locks/.trash 等）不是分类，跳过（R7-D1：不能把它们当族文件读，也不能删）。
  const typeDirNames = new Set([...canonicalTypeIds].map((typeId) => safeTypeDirName(typeId).toLowerCase()))
  for (const name of rootDirs) {
    if (isIgnoredLibraryDir(name)) continue
    if (typeDirNames.has(name.toLowerCase())) continue
    // 非分类目录（没有 _type/_index）是用户自己的目录，不读也不删（R7-D1）。
    const foreignDir = path.join(libraryRoot, name)
    try { if (!fs.statSync(foreignDir).isDirectory()) continue } catch { continue }
    let isClassDir = false
    try { isClassDir = fs.existsSync(path.join(foreignDir, '_index.json')) || fs.existsSync(path.join(foreignDir, '_type.json')) } catch { isClassDir = false }
    if (!isClassDir && !/^ty_/i.test(name)) continue
    removeFamilyTypeDir(dir, name)
  }
  try {
    writeManyAtomicFiles(dir, pendingWritesFull)
  } catch (error) {
    for (const item of staleBaksFull) { try { fs.renameSync(item.bakPath, item.stalePath) } catch { /* 恢复失败也继续 */ } }
    throw error
  }
  for (const item of staleBaksFull) { try { fs.unlinkSync(item.bakPath) } catch { /* 留给 GC */ } }
  for (const typeDir of dirsToRemoveFull) { try { fs.rmSync(typeDir, { recursive: true, force: true }) } catch { /* 删不掉不影响本次写 */ } }
  // R4 缺陷 20：manifest.types 与磁盘保持一致——无行且无目录的类型不再写进 manifest。
  const manifestStore = {
    ...store,
    types: (Array.isArray(store.types) ? store.types : []).filter((type) => {
      const typeId = String(type && type.id)
      if (typeId === '' || typeId === 'ty_other') return true
      if (entries.some((entry) => entry.typeId === typeId)) return true
      return fs.existsSync(familyDirOf(dir, typeId))
    }),
  }

  const flat = isFlatLayout(dir)
  const manifest = buildManifest(store, entries, previousManifest, { ...options, layout: flat ? FLAT_LAYOUT : FAMILY_LAYOUT, schema: flat ? 4 : FAMILY_SCHEMA })
  writeManifest(dir, manifest)
  return manifest
}

/** 读全部分族记录（重建用）：返回 {entries, records}，损坏按 readBucketRows 规则抛错。 */
export function readFamilyRecords(dataDir) {
  // R4 缺陷：目录名伪装成 .jsonl 时读取必须显式报错（scanFamilyShards 对非文件是跳过，这里补严格检查）。
  const rootDir = path.join(String(dataDir || ''), LIBRARY_DIR)
  let names = []
  try { names = fs.readdirSync(rootDir) } catch { names = [] }
  for (const typeId of names) {
    if (isIgnoredLibraryDir(typeId)) continue
    const typeDir = path.join(rootDir, typeId)
    if (!isTypeDirInsideLibrary(rootDir, typeDir)) continue
    let hasMeta = false
    try { hasMeta = fs.existsSync(path.join(typeDir, '_index.json')) || fs.existsSync(path.join(typeDir, '_type.json')) } catch { hasMeta = false }
    if (!hasMeta && !/^ty_/i.test(typeId)) continue
    let files = []
    try { files = fs.readdirSync(typeDir) } catch { continue }
    for (const name of files) {
      if (!name.toLowerCase().endsWith('.jsonl')) continue
      const file = path.join(typeDir, name)
      let stat
      try { stat = fs.lstatSync(file) } catch (error) { throw new Error(`经验库族文件读取失败：${LIBRARY_DIR}/${typeId}/${name}：${error && error.message ? error.message : error}`) }
      if (!stat.isFile()) throw new Error(`经验库族文件读取失败：${LIBRARY_DIR}/${typeId}/${name}：EISDIR（同名的不是普通文件）`)
    }
  }

  const entries = scanFamilyShards(dataDir)
  const records = []
  for (const entry of entries) {
    const file = resolveBucketPath(dataDir, entry.file)
    const rows = readBucketRows(file, entry.file, { missing: 'throw', bucket: entry }) || []
    for (const row of rows) records.push(row)
  }
  return { entries, records }
}
/** 扫描 library/ 下所有族文件（重建索引用；不信任 manifest）。 */
/** 从文件名反推族名（无 _index.json 时的兜底）：去掉 `.N` 分片后缀与 `~hash` 尾缀。 */
export function familyNameFromFile(name) {
  const base = String(name || '').replace(/\.jsonl$/i, '').replace(/\.\d+$/, '')
  const cut = base.lastIndexOf('~')
  return cut > 0 ? base.slice(0, cut) : base
}

/** 读某分类目录 `_index.json` 的 file→family 映射（没有/坏了返回空 Map）。 */
function familyIndexMap(typeDir) {
  const map = new Map()
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(typeDir, '_index.json'), 'utf8'))
    for (const item of Array.isArray(parsed.families) ? parsed.families : []) {
      const file = path.basename(String(item.file || ''))
      if (file !== '' && typeof item.family === 'string' && item.family !== '') map.set(file, item.family)
    }
  } catch {
    // 索引缺失/损坏：调用方退回文件名推断
  }
  return map
}

export function scanFamilyShards(dataDir) {
  const dir = String(dataDir || '')
  const root = path.join(dir, LIBRARY_DIR)
  const entries = []
  let names = []
  try { names = fs.readdirSync(root) } catch { return entries }
  // flat：族文件直接在 library/ 根，typeId 从行里取（仅作元数据，不再分目录）。
  if (isFlatLayout(dataDir)) {
    const indexMap = familyIndexMap(root)
    for (const name of names) {
      if (!name.toLowerCase().endsWith('.jsonl')) continue
      const file = path.join(root, name)
      try { if (!fs.lstatSync(file).isFile()) continue } catch { continue }
      let rows = []
      try { rows = readBucketRows(file, `${LIBRARY_DIR}/${name}`) || [] } catch (error) { throw new Error(`经验库族文件读取失败：${LIBRARY_DIR}/${name}：${error && error.message ? error.message : error}`) }
      const text = bucketTextOf(rows)
      const family = indexMap.get(name) || familyNameFromFile(name)
      const typeId = String((rows.find((row) => row && row.typeId) || {}).typeId || 'ty_action')
      entries.push({ file: `${LIBRARY_DIR}/${name}`, typeId, family, count: rows.length, bytes: Buffer.byteLength(text, 'utf8'), latestTs: latestTsOf(rows), hash: contentHash(text) })
    }
    return entries
  }
  for (const typeId of names) {
    if (isIgnoredLibraryDir(typeId)) continue
    const typeDir = path.join(root, typeId)
    // R7-D1：只有带 _type.json 或 _index.json 的目录才是分类目录；用户自己放的其他目录不是经验。
    let hasMeta = false
    try { hasMeta = fs.existsSync(path.join(typeDir, '_index.json')) || fs.existsSync(path.join(typeDir, '_type.json')) } catch { hasMeta = false }
    // 有元数据，或目录名像分类 id（ty_*，兼容外部直接摆放的族文件/旧测试夹具）。
    if (!hasMeta && !/^ty_/i.test(typeId)) continue
    if (!isTypeDirInsideLibrary(root, typeDir)) continue
    let files = []
    try { files = fs.readdirSync(typeDir) } catch { files = [] }
    const indexMap = familyIndexMap(typeDir)
    for (const name of files) {
      if (!name.toLowerCase().endsWith('.jsonl')) continue
      const file = path.join(typeDir, name)
      // R11 缺陷：同名目录不是族文件，扫描必须跳过（否则读成 EISDIR）。
      try { if (!fs.lstatSync(file).isFile()) continue } catch { continue }
      // R2 缺陷：损坏族文件不能静默跳过（重建会把整族写丢）；带文件+原因抛错。
      let rows = []
      try { rows = readBucketRows(file, `${LIBRARY_DIR}/${typeId}/${name}`) || [] } catch (error) { throw new Error(`经验库族文件读取失败：${LIBRARY_DIR}/${typeId}/${name}：${error && error.message ? error.message : error}`) }
      const text = bucketTextOf(rows)
      const family = indexMap.get(name) || familyNameFromFile(name)
      entries.push({ file: `${LIBRARY_DIR}/${typeId}/${name}`, typeId, family, count: rows.length, bytes: Buffer.byteLength(text, 'utf8'), latestTs: latestTsOf(rows), hash: contentHash(text) })
    }
  }
  return entries
}

/** 标记「显式创建的空分类」：_index.json 带 created:true，重建/清理都据此保留（R3 缺陷）。 */
export function markFamilyTypeCreated(dataDir, typeId, name) {
  const dir = familyDirOf(dataDir, typeId)
  fs.mkdirSync(dir, { recursive: true })
  writeFileAtomic(path.join(dir, '_type.json'), `${JSON.stringify({ typeId: String(typeId), name: String(name || '') }, null, 2)}\n`)
  writeFileAtomic(path.join(dir, '_index.json'), `${JSON.stringify({ typeId: String(typeId), families: [], unfiled: 0, total: 0, created: true }, null, 2)}\n`)
}

/** 分类改名后同步 `_type.json`（目录用 typeId，不搬）。 */
export function syncFamilyTypeName(dataDir, typeId, name) {
  const file = path.join(familyDirOf(dataDir, typeId), '_type.json')
  if (!fs.existsSync(file)) return
  try {
    const meta = JSON.parse(fs.readFileSync(file, 'utf8'))
    writeFileAtomic(file, `${JSON.stringify({ ...meta, name: String(name || '') }, null, 2)}\n`)
  } catch {
    // 元数据坏了不阻断改名
  }
}

/** 分类被删除/合并后移除目录。 */
export function removeFamilyTypeDir(dataDir, typeId) {
  // R8 缺陷：同名普通文件不是分类目录，读自愈不得删用户文件。
  try { if (!fs.statSync(familyDirOf(dataDir, typeId)).isDirectory()) return } catch { return }
  const dir = familyDirOf(dataDir, typeId)
  if (!dir.startsWith(path.join(String(dataDir || ''), LIBRARY_DIR) + path.sep)) return
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 删不掉不影响 */ }
}
/** 枚举 library/ 下所有分类目录（含 0 行空分类），返回 typeId→名字（用于重建）。 */
export function scanFamilyTypeDirs(dataDir) {
  const dir = String(dataDir || '')
  const root = path.join(dir, LIBRARY_DIR)
  const out = new Map()
  let types = []
  try { types = fs.readdirSync(root) } catch { return out }
  for (const typeId of types) {
    if (isIgnoredLibraryDir(typeId)) continue
    // 只认「显式创建的空分类」（_index.json 带 created:true）：幽灵 _type.json 不建类（R2-17）。
    // 有 _index.json 就认为这是一个合法的分类目录（空分类或曾有行）；只有 _type.json 的幽灵目录不建类。
    if (!isTypeDirInsideLibrary(root, path.join(root, typeId))) continue
    if (!fs.existsSync(path.join(root, typeId, '_index.json'))) continue
    let name = ''
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(root, typeId, '_type.json'), 'utf8'))
      if (typeof meta.name === 'string' && meta.name !== '') name = meta.name
    } catch {
      name = ''
    }
    out.set(String(typeId), name)
  }
  return out
}
/** 重建时恢复类型名：读每个分类目录的 `_type.json`。 */
export function readFamilyTypeNames(dataDir) {
  const dir = String(dataDir || '')
  const root = path.join(dir, LIBRARY_DIR)
  const names = new Map()
  // flat：没有 _type.json，类型名从 manifest.types 取（字段仅兼容）。
  if (isFlatLayout(dataDir)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
      for (const type of Array.isArray(manifest.types) ? manifest.types : []) names.set(String(type.id), String(type.name || ''))
    } catch { /* ignore */ }
    return names
  }
  let types = []
  try { types = fs.readdirSync(root) } catch { return names }
  for (const typeId of types) {
    if (isIgnoredLibraryDir(typeId)) continue
    if (!isTypeDirInsideLibrary(root, path.join(root, typeId))) continue
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(root, typeId, '_type.json'), 'utf8'))
      if (typeof meta.name === 'string' && meta.name !== '') names.set(String(meta.typeId || typeId), meta.name)
    } catch {
      // 没有 _type.json：名退化为 typeId
    }
  }
  return names
}

/** 没有旧 manifest 时（manifest 丢失/损坏），用各分类 `_index.json` 的声明做核对。 */
export function assertFamilyIndexesIntact(dataDir, onlyTypeIds = null) {
  const dir = String(dataDir || '')
  const root = path.join(dir, LIBRARY_DIR)
  let types = []
  try { types = fs.readdirSync(root) } catch { return }
  for (const typeId of types) {
    if (onlyTypeIds !== null && !onlyTypeIds.has(typeId)) continue
    if (isIgnoredLibraryDir(typeId)) continue
    const typeDir = path.join(root, typeId)
    if (!isTypeDirInsideLibrary(root, typeDir)) continue
    let parsed = null
    try { parsed = JSON.parse(fs.readFileSync(path.join(typeDir, '_index.json'), 'utf8')) } catch { continue }
    // R6 缺陷：_index 是 null/数组/字符串时按「没有索引」处理，不能抛原生 TypeError。
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue
    for (const item of Array.isArray(parsed.families) ? parsed.families : []) {
      const declared = Number(item.count) || 0
      if (declared <= 0) continue
      const declaredFile = String(item.file || '')
      if (declaredFile === '') continue
      // R13 缺陷：_index 的文件名必须锚定在本分类目录下；带 ../ 或指向别处的声明按越界拒绝，basename 声明锚定到本分类。
      const expectedPrefix = `${LIBRARY_DIR}/${typeId}/`
      let normalizedDeclared = declaredFile.replace(/\\/g, '/')
      if (path.isAbsolute(declaredFile)) {
        // R14 缺陷：库内绝对路径合法，收敛成相对路径；库外绝对路径仍拒绝。
        const typeDirAbs = path.resolve(dir, LIBRARY_DIR, typeId)
        const abs = path.resolve(declaredFile)
        if (abs === typeDirAbs || abs.startsWith(typeDirAbs + path.sep)) normalizedDeclared = `${LIBRARY_DIR}/${typeId}/${path.basename(abs)}`
        else throw new Error(`经验库分族文件损坏：_index 的 file 越界（${declaredFile}，必须位于 ${expectedPrefix}）`)
      }
      if (normalizedDeclared.includes('/') && !normalizedDeclared.startsWith(expectedPrefix)) {
        throw new Error(`经验库分族文件损坏：_index 的 file 越界（${declaredFile}，必须位于 ${expectedPrefix}）`)
      }
      const rel = normalizedDeclared.includes('/') ? normalizedDeclared : `${LIBRARY_DIR}/${typeId}/${path.basename(normalizedDeclared)}`
      const rows = readBucketRows(resolveBucketPath(dir, rel), rel)
      const actual = rows === null ? 0 : rows.length
      if (actual < declared) throw new Error(`经验库分族文件损坏：${rel} 索引声明 count=${declared}，实际 ${actual} 行（拒绝用不完整快照重建 manifest）`)
      // R5/R6 缺陷：行数相同但内容被篡改（hash 不符）；hash 缺失时用 bytes 兜底。
      if (actual >= declared) {
        const text = rows === null ? '' : bucketTextOf(actual === declared ? rows : rows.slice(0, declared))
        if (typeof item.hash === 'string' && item.hash !== '') {
          if (contentHash(text) !== item.hash) throw new Error(`经验库分族文件损坏：${rel} 内容与 _index 声明不一致（hash 不符，拒绝用被改写的快照重建 manifest）`)
        } else if (Number(item.bytes) > 0 && Buffer.byteLength(text, 'utf8') !== Number(item.bytes)) {
          throw new Error(`经验库分族文件损坏：${rel} 内容与 _index 声明不一致（bytes 不符，拒绝用被改写的快照重建 manifest）`)
        }
      }
    }
  }
}
/** 旧布局（buckets/）是否有分片文件。 */
export function bucketsLayoutPresent(dataDir) {
  try { return fs.readdirSync(bucketsPath(dataDir)).some((name) => name.endsWith('.jsonl')) } catch { return false }
}

/** 分族布局（library/）是否有族文件。 */
export function familyLayoutPresent(dataDir) {
  const root = path.join(String(dataDir || ''), LIBRARY_DIR)
  try {
    for (const typeId of fs.readdirSync(root)) {
      try { if (fs.readdirSync(path.join(root, typeId)).some((name) => name.toLowerCase().endsWith('.jsonl'))) return true } catch { /* 子目录不可读 */ }
    }
  } catch { /* library 不存在 */ }
  return false
}

/**
 * 布局判定（R2 缺陷修复）：manifest 的 layout 优先；manifest 不可用时，
 * 「两套布局同时在」一律优先旧 buckets（旧数据完整，且避免半迁移被当成新布局读空）。
 */
export function resolveLayout(dataDir, manifest) {
  if (manifest !== null && manifest !== undefined && (manifest.layout === FAMILY_LAYOUT || manifest.layout === FLAT_LAYOUT)) return 'family'
  if (manifest !== null && manifest !== undefined && typeof manifest.layout === 'string' && manifest.layout !== '') return 'legacy'
  // manifest 不可用（丢失/损坏）时：
  //  - family 侧优先用 **_index 声明**的行数比较（族文件缺失时不能按现存文件把 library 判小，R5 缺陷）；
  //  - 声明数 ≥ buckets 行数 → family（缺文件由 _index 核对去报错，不静默回退旧桶）；
  //  - 声明数 < buckets（半迁移中途）→ legacy，保证旧桶完整可读；
  //  - 只有空分类目录 → family。
  const familyDeclared = countFamilyDeclaredRows(dataDir)
  const familyRows = familyDeclared !== null ? familyDeclared : countFamilyRows(dataDir)
  const bucketRows = countBucketRows(dataDir)
  if (familyRows === 0 && bucketRows === 0) return hasFamilyLayout(dataDir) ? 'family' : 'legacy'
  if (familyRows > 0 && familyRows >= bucketRows) return 'family'
  if (bucketRows > 0) return 'legacy'
  if (familyRows > 0) return 'family'
  return 'legacy'
}

/** 从各分类 `_index.json` 汇总声明行数；一个 _index 都没读到返回 null（退回按文件计数）。 */
function countFamilyDeclaredRows(dataDir) {
  const root = path.join(String(dataDir || ''), LIBRARY_DIR)
  let types = []
  try { types = fs.readdirSync(root) } catch { return null }
  let seen = false
  let total = 0
  for (const typeId of types) {
    if (isIgnoredLibraryDir(typeId)) continue
    const typeDir = path.join(root, typeId)
    let parsed = null
    try { parsed = JSON.parse(fs.readFileSync(path.join(typeDir, '_index.json'), 'utf8')) } catch { parsed = null }
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      seen = true
      for (const item of Array.isArray(parsed.families) ? parsed.families : []) total += Number(item.count) || 0
      continue
    }
    // 没有 _index 的目录：按族文件实际行数计（布局裁决不依赖索引，R4-L03）。
    let names = []
    try { names = fs.readdirSync(typeDir).filter((name) => name.toLowerCase().endsWith('.jsonl')) } catch { names = [] }
    for (const name of names) {
      seen = true
      try { total += fs.readFileSync(path.join(typeDir, name), 'utf8').split('\n').filter((line) => line.trim() !== '').length } catch { /* 读不到不计 */ }
    }
  }
  return seen ? total : null
}

function countBucketRows(dataDir) {
  let total = 0
  let names = []
  try { names = fs.readdirSync(bucketsPath(dataDir)).filter((name) => name.endsWith('.jsonl')) } catch { return 0 }
  for (const name of names) {
    try { total += fs.readFileSync(path.join(bucketsPath(dataDir), name), 'utf8').split('\n').filter((line) => line.trim() !== '').length } catch { /* 读不到不计 */ }
  }
  return total
}

function countFamilyRows(dataDir) {
  let total = 0
  const root = path.join(String(dataDir || ''), LIBRARY_DIR)
  let types = []
  try { types = fs.readdirSync(root) } catch { return 0 }
  for (const typeId of types) {
    if (isIgnoredLibraryDir(typeId)) continue
    let names = []
    try { names = fs.readdirSync(path.join(root, typeId)).filter((name) => name.toLowerCase().endsWith('.jsonl')) } catch { names = [] }
    for (const name of names) {
      try { total += fs.readFileSync(path.join(root, typeId, name), 'utf8').split('\n').filter((line) => line.trim() !== '').length } catch { /* 读不到不计 */ }
    }
  }
  return total
}
/** 分族重建前的声明核对：文件缺失/行数少于 manifest 声明即报错，拒绝把丢行写回。 */
export function assertFamilyBucketsIntact(dataDir, buckets) {
  if (!Array.isArray(buckets)) return
  for (const bucket of buckets) {
    if (bucket === null || bucket === undefined) continue
    const declared = Number(bucket.count)
    if (!Number.isFinite(declared) || declared <= 0) continue
    let label = String(bucket.file || '')
    if (label === '') continue
    if (!label.includes('/') && !label.includes('\\')) label = `${LIBRARY_DIR}/${safeTypeDirName(String(bucket.typeId || 'ty_other'))}/${label}`
    const rows = readBucketRows(resolveBucketPath(dataDir, label), label)
    const actual = rows === null ? 0 : rows.length
    if (actual < declared) {
      throw new Error(`经验库分族文件损坏：${label} 声明 count=${declared}，实际 ${actual} 行（拒绝用不完整快照重建 manifest）`)
    }
    // R6 缺陷：同 count 的内容篡改/替换（hash 不符）；增长（外部追加行）按自愈放行（R2 口径）。
    if (typeof bucket.hash === 'string' && bucket.hash !== '' && rows !== null) {
      const expected = actual === declared ? bucketTextOf(rows) : bucketTextOf(rows.slice(0, declared))
      if (contentHash(expected) !== bucket.hash) throw new Error(`经验库分族文件内容与 manifest 声明不一致：${label}（hash 不符，拒绝把替换/篡改内容当经验返回）`)
    }
  }
}