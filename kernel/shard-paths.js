/**
 * 存储路径与布局（从 shard-store.js 拆出）：纯路径/布局常量与函数。
 * 不 import shard-store.js / store.js，避免循环依赖。
 */

import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

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

/** 压缩前备份目录（相对 dataDir）。 */
export const COMPACT_BACKUP_DIR = '.locks'

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

function resolveBucketPath(dataDir, rel) {
  const root = path.resolve(String(dataDir || ''))
  const resolved = path.resolve(root, rel)
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`经验库 manifest 里的分片路径越界：${rel}`)
  }
  return resolved
}

/** 分片内容指纹：增量写只重写指纹变了的文件（字节相等 ⇒ 内容相等）。 */
export function contentHash(text) {
  return createHash('sha1').update(String(text)).digest('hex')
}

const BUCKET_NAME_RE = /^(.+)\.(\d+)\.jsonl$/
const COLD_NAME_RE = /^(\d{4})(?:-[a-z]+)?\.jsonl$/

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
export {
  safeFamilyFileName,
  safeTypeDirName,
  resolveBucketPath,
  BUCKET_NAME_RE,
  COLD_NAME_RE,
}
