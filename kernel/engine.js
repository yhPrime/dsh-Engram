/**
 * dsh-Engram engine 门面（M2）
 *
 * 给非 DSH 宿主（外壳、CLI、脚本）的稳定入口：一个 dataDir，一套方法，
 * 不需要 DSH 运行时、不注册 Provider、不依赖 tools 协议。
 *
 *   const engine = createEngine({ dataDir: 'D:/proj/.exp' })
 *   engine.record(...) / engine.recall(...) / engine.feedback(...)
 *   engine.consolidate(...) / engine.listSkills() / engine.validate()
 *
 * 0.14.0（P3-A）起存储是分片布局（manifest.json + buckets/*.jsonl）：
 *  - `snapshot()` 只读 manifest + 存储用量，**不再加载全量经验**（概览/设置页用）；
 *  - 需要行的页面（经验列表、详情、关系图）走 `readHot()`——页面级全量热档读，不读冷档；
 *  - 记录/召回/反馈仍走工具面（语义不变）。
 */
import fs from 'node:fs'
import path from 'node:path'

import { buildTools } from './tools.js'
import { listSkills, readSkillBySlug, validateAllSkills } from './skills.js'
import { pendingRows, pendingTasks, readManifest, readStore, renderHint, resolveVerdicts, withStoreLock, writeStore } from './store.js'
import * as shardStore from './shard-store.js'
import { pendingBrief } from './brief.js'

/** 构建工具面（适配器与 headless 共用同一套配置解析）。 */
export function createTools(config = {}, defineTool = (definition) => definition) {
  return buildTools(defineTool, config)
}

function statSize(file) {
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}

function statIsFile(file) {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

function mtimeIso(file) {
  try {
    return fs.statSync(file).mtime.toISOString()
  } catch {
    return null
  }
}

/** 某目录下 *.jsonl 的字节/文件数。 */
function jsonlStat(dir) {
  let bytes = 0
  let files = 0
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue
      const full = path.join(dir, name)
      try {
        const stat = fs.statSync(full)
        if (!stat.isFile()) continue
        files += 1
        bytes += stat.size
      } catch {
        // 读不到的文件不计，不抛：/state 不能因为一个坏文件整页挂掉
      }
    }
  } catch {
    // 目录不存在
  }
  return { bytes, files }
}

function readManifestQuiet(dataDir) {
  try {
    return shardStore.readManifestFile(dataDir)
  } catch {
    return null
  }
}

/**
 * G7 `storageUsage` 未落地时的本地换算（字段形状与建议 API 一致）。
 * 注意：`storageBytes()` **不含 legacy**，所以这里不能直接拿它当总量。
 */
function fallbackStorageUsage(dataDir) {
  const dir = String(dataDir || '')
  const manifest = readManifestQuiet(dir)
  const manifestFile = shardStore.manifestPath(dir)
  const manifestBytes = statSize(manifestFile)
  const buckets = jsonlStat(shardStore.bucketsPath(dir))
  const cold = jsonlStat(shardStore.coldPath(dir))
  const legacyFile = shardStore.legacyPath(dir)
  const legacy = { exists: statIsFile(legacyFile), bytes: statSize(legacyFile) }
  const singleFile = path.join(dir, shardStore.LEGACY_SOURCE_FILE)
  const single = { exists: statIsFile(singleFile), bytes: statSize(singleFile) }
  const totalBytes = manifestBytes + buckets.bytes + cold.bytes + legacy.bytes + single.bytes
  // D1 之后 manifest 不写 updated_at：有就用，没有就 null（不编时间）。老库退回单文件 mtime。
  const updatedAt = manifest !== null && typeof manifest.updated_at === 'string'
    ? manifest.updated_at
    : (manifest === null && single.exists ? mtimeIso(singleFile) : null)
  return {
    manifestBytes,
    bucketBytes: buckets.bytes,
    bucketFiles: buckets.files,
    coldBytes: cold.bytes,
    coldFiles: cold.files,
    legacy,
    single,
    fileCount: shardStore.storageFileCount(dir),
    totalBytes,
    updatedAt,
  }
}

/**
 * 存储用量：优先用 storage-core 的 `storageUsage`（G7），没落地就用等价本地换算。
 *
 * 唯一补口：storageUsage 只统计分片布局（manifest/buckets/cold/legacy），**迁移前的
 * exp-lib.json 不计入**；这里统一补一次（bytes + fileCount）。`/state` 与设置页都只消费
 * `snapshot().storage`，不各算一套。
 */
function storageUsageOf(dataDir) {
  const dir = String(dataDir || '')
  const singleFile = path.join(dir, shardStore.LEGACY_SOURCE_FILE)
  const singleLocal = { exists: statIsFile(singleFile), bytes: statSize(singleFile) }
  if (typeof shardStore.storageUsage === 'function') {
    try {
      const usage = shardStore.storageUsage(dir)
      if (usage !== null && typeof usage === 'object') {
        const pick = (key, fallback) => (Number.isFinite(Number(usage[key])) ? Number(usage[key]) : fallback)
        // G7 只统计分片布局（manifest/buckets/cold/legacy），不含迁移前的 exp-lib.json；
        // 老库还没写过分片时必须把它补进来，否则 /state 会显示 0 字节。
        const officialSingle = usage.single !== null && typeof usage.single === 'object' ? usage.single : null
        const single = officialSingle !== null
          ? { exists: officialSingle.exists === true, bytes: Number(officialSingle.bytes) || 0 }
          : singleLocal
        const countedSingle = officialSingle !== null
        let totalBytes = pick('totalBytes', 0)
        let fileCount = pick('fileCount', 0)
        if (!countedSingle && single.exists) {
          totalBytes += single.bytes
          fileCount += 1
        }
        return {
          manifestBytes: pick('manifestBytes', 0),
          bucketBytes: pick('bucketBytes', 0),
          bucketFiles: pick('bucketFiles', 0),
          coldBytes: pick('coldBytes', 0),
          coldFiles: pick('coldFiles', 0),
          legacy: usage.legacy !== null && typeof usage.legacy === 'object'
            ? { exists: usage.legacy.exists === true, bytes: Number(usage.legacy.bytes) || 0 }
            : { exists: false, bytes: 0 },
          single,
          fileCount,
          totalBytes,
          updatedAt: usage.updatedAt === undefined ? null : usage.updatedAt,
        }
      }
    } catch {
      // storageUsage 自己抛错就退回本地换算：概览页不能因为统计函数坏了整页打不开
    }
  }
  return fallbackStorageUsage(dir)
}

export function createEngine(options = {}) {
  const dataDir = String(options.dataDir || '').trim()
  if (dataDir === '') throw new Error('createEngine 需要 dataDir（.exp 根目录）')
  const config = {
    ...(options.config || {}),
    dataDir,
    // 独立运行时没有 DSH Provider 状态文件，显式清空，避免误读 ~/.dsh。
    providerStateFile: '',
  }
  const tools = createTools(config, options.defineTool)
  const call = (name, args = {}) => {
    const tool = tools.find((item) => item.name === name)
    if (tool === undefined) throw new Error(`未知工具：${name}`)
    return tool.execute(args)
  }
  return {
    dataDir,
    config,
    record: (input = {}) => call('exp_record', input),
    recall: (input = {}) => call('exp_recall', input),
    feedback: (input = {}) => call('exp_feedback', input),
    consolidate: (input = {}) => call('exp_consolidate', input),
    types: (input = { action: 'list' }) => call('exp_type', input),
    tools: () => tools.map((tool) => tool.name),
    listSkills: () => listSkills(dataDir),
    readSkill: (slug) => readSkillBySlug(dataDir, slug),
    validate: () => validateAllSkills(dataDir),
    hint: (maxCharacters) => renderHint(config, maxCharacters),
    /** 待判定队列（只读）：verdict=pending 的最近几条（带 brief，控制台直接显示）。 */
    pending: (limit = 2) => pendingRows(readStore(dataDir, { cache: true }), limit).map((row) => ({
      id: row.id,
      intent: row.intent,
      action: row.action,
      verdict: row.verdict,
      registeredAt: row.registeredAt,
      dimensions: row.dimensions,
      brief: pendingBrief(row),
    })),
    /** 回填判定（模型给 outcome，插件只写回）。 */
    resolveVerdicts: (list = []) => withStoreLock(dataDir, () => {
      const store = readStore(dataDir)
      const out = resolveVerdicts(store, list)
      writeStore(dataDir, store)
      return out
    }),
    /** 把 pending 带出回执（会 +1 提醒次数并落盘；外壳与测试用）。 */
    drainPending: (limit = 2) => withStoreLock(dataDir, () => {
      const store = readStore(dataDir)
      const out = pendingTasks(store, limit, { pendingTtl: config.pendingTtl })
      writeStore(dataDir, store)
      return out
    }),
    /**
     * 轻量快照（P3-A）：只读 manifest + 存储用量，不加载全量经验。
     * 概览页（/state）与设置页用它；需要行的地方用 `readHot()`。
     */
    snapshot: () => {
      const usage = storageUsageOf(dataDir)
      const singleFile = path.join(dataDir, shardStore.LEGACY_SOURCE_FILE)
      const singleExists = statIsFile(singleFile)
      let manifest = null
      let corrupt = false
      let parseError = ''
      try {
        // readManifest 带自愈：缓存丢了/对不上会按分片重建（manifest 是可重建缓存，D1）。
        manifest = readManifest(dataDir)
      } catch (error) {
        corrupt = true
        parseError = String((error && error.message) || error)
      }
      // 老库（还没有分片）仍要像以前一样检查 exp-lib.json 是否可解析，坏库不能静默当空库。
      if (!corrupt && manifest === null && singleExists) {
        try {
          JSON.parse(fs.readFileSync(singleFile, 'utf8'))
        } catch (error) {
          corrupt = true
          parseError = String((error && error.message) || error)
        }
      }
      const exists = manifest !== null || usage.fileCount > 0 || singleExists
      return {
        dataDir,
        file: manifest !== null ? shardStore.manifestPath(dataDir) : singleFile,
        exists,
        bytes: usage.totalBytes,
        updatedAt: usage.updatedAt,
        corrupt,
        parseError,
        manifest,
        storage: usage,
      }
    },
    /**
     * 页面级热档读：全部分片 + 旧单文件（不读冷档，冷档按 §4.5 默认不参与）。
     * 给 /experiences 列表、/experience 详情、/graph 用；页面级操作，调用方自己决定缓存。
     *
     * task-7：传 `{ cache: true }` 启用存储层读缓存——**只给只读调用方**。
     * 引擎里的写路径（resolveVerdicts/drainPending）与 tools.js（exp_record/exp_feedback）
     * 一律走默认无缓存读，避免读-改-写拿到缓存旧对象丢更新。
     */
    readHot: () => readStore(dataDir, { cache: true }),
  }
}
