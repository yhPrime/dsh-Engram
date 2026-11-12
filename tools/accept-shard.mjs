#!/usr/bin/env node
/**
 * P4 验收台架：0.14.0「存储分片」。
 *
 * 目标（计划书 §8 / §9）：
 *  - 今天就能在**当前单文件存储**上跑出 1x / 4x / 10x 合成库的耗时基线；
 *  - 把 9 条验收判据做成可重复执行的脚本：尚未落地的判据标 SKIP 并写明原因，
 *    P1/P2 落地后同一脚本自动改跑真判据（不需要改脚本）；
 *  - 生成真实库的 golden fixture（只读复制）+ 逐字段哈希，供 P1 迁移比对；
 *  - 回滚演练：在 `_tmp` 副本里造「已迁移」形态，跑恢复 legacy / 归档分片 / 校验读库，
 *    并验证「legacy 不存在时中止」分支。
 *
 * 硬约束：
 *  - 真实库 `C:\Users\yh\WorkDeepSeek\.exp\exp-lib.json` 只读：只复制，绝不写入/迁移/压缩；
 *  - 所有破坏性动作都在 `_tmp/` 下（已 gitignore），不碰真实 .exp；
 *  - 不 import 任何分片内部 API：只观察 readStore/writeStore 的对外行为与磁盘布局，
 *    这样 P1 换实现不用改台架。
 *
 * 用法：
 *   node tools/accept-shard.mjs
 *   node tools/accept-shard.mjs --out=tools/accept-baseline-2026-11-12.md
 *   node tools/accept-shard.mjs --regression=all          # 跑全部测试文件
 *   node tools/accept-shard.mjs --bounds=quick            # 上界判据用 10x（默认 3×N_MAX）
 *   node tools/accept-shard.mjs --baseline=_tmp/accept-shard/baseline.json
 *
 * 退出码：有 FAIL → 1；否则 0（SKIP 不算失败）。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

import {
  readStore,
  writeStore,
  rankExperiences,
  renderHintSlim,
  renderHintFull,
  visibleExperiences,
} from '../kernel/store.js'
import * as storeApi from '../kernel/store.js'
import * as shardApi from '../kernel/shard-store.js'
import { createEngine } from '../kernel/engine.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const TMP_ROOT = path.join(REPO, '_tmp')
const FIXTURE_DIR = path.join(TMP_ROOT, 'fixtures')
const DEFAULT_FIXTURE = path.join(FIXTURE_DIR, 'exp-lib-snapshot.json')
const ACCEPT_ROOT = path.join(TMP_ROOT, 'accept-shard')
const DEFAULT_BASELINE = path.join(ACCEPT_ROOT, 'baseline.json')
const DEFAULT_REAL_LIB = 'C:\\Users\\yh\\WorkDeepSeek\\.exp\\exp-lib.json'

/** fixture 旁的哈希清单 / 提示段 golden（换 --fixture 时跟着换目录，不写死）。 */
function sidecarPath(fixturePath, suffix) {
  return fixturePath.replace(/\.json$/u, `.${suffix}.json`)
}

/**
 * 计划书 §5 参数：优先读实现导出的常量（storage-core 调参后台架自动跟随），
 * 读不到才退回当前默认值（2026-11-12 定稿：桶 2 MiB / 热 32 MiB / N_MAX 20000）。
 */
const SHARD_K = shardApi.SHARD_K ?? 2
const MAX_BUCKET_BYTES = shardApi.MAX_BUCKET_BYTES ?? 2 * 1024 * 1024
const COLD_MAX_BYTES = shardApi.COLD_MAX_BYTES ?? 8 * 1024 * 1024
const HOT_MAX_BYTES = shardApi.HOT_MAX_BYTES ?? 32 * 1024 * 1024
const N_MAX = shardApi.N_MAX ?? 20000
const AVG_RECORD_BYTES = 2138
// 数据文件上限：热档 2 片/类型（按 24 类型上限）+ 3×N_MAX 全部下沉需要的冷档片数 + manifest/legacy 余量。
const FILE_COUNT_MAX = 2 * 24 + Math.ceil((3 * N_MAX * AVG_RECORD_BYTES) / COLD_MAX_BYTES) + 3
const TOMBSTONE_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000

/** 召回测速用的固定意图（写「对象+任务」，与提示段口径一致）。 */
const BENCH_INTENT = '给研学课 PPT 插一页（深蓝色调）'

const CORE_TESTS = [
  'kernel/tests/store-safety.test.mjs',
  'kernel/tests/store.test.mjs',
  'kernel/tests/recall.test.mjs',
  'kernel/tests/cluster.test.mjs',
  'kernel/tests/hint-cache.test.mjs',
  'kernel/tests/tools.test.mjs',
  'kernel/tests/pending.test.mjs',
  'kernel/tests/verdicts.test.mjs',
  'kernel/tests/engine-headless.test.mjs',
  'kernel/tests/plugin.test.mjs',
]

/** golden fixture 的逐字段哈希清单（计划书 §8.1 点名的字段都在里面）。 */
const HASH_FIELDS = [
  'id', 'ts', 'lastSeenAt', 'hits', 'intent', 'action', 'state', 'step_rewards',
  'G', 'GOutcome', 'outcome', 'note', 'origin', 'typeId', 'typeName', 'typeSource',
  'deleted_at', 'superseded_by', 'retired_at', 'supersedes', 'feedback_log',
  'feedback', 'lastFeedbackAt', 'context', 'verdict', 'verdictAt', 'decidedBy',
  'pendingReminders', 'dimensions', 'taskId', 'kind', 'stepIndex', 'stepTotal',
  'failedStep', 'expectedG', 'predictionError', 'history',
]

const STATUS_ICON = { PASS: '✅', FAIL: '❌', SKIP: '⏭', PARTIAL: '⚠️' }

// ---------------------------------------------------------------- 通用工具

function parseArgs(argv) {
  const opts = {
    out: null,
    jsonPath: null,
    baseline: null,
    regression: 'core',
    bounds: '3x',
    samples: 5,
    realLib: DEFAULT_REAL_LIB,
    fixture: DEFAULT_FIXTURE,
    git: true,
    keepRuns: 2,
  }
  const valueFlags = new Set([
    '--out', '--json', '--baseline', '--regression', '--bounds', '--samples',
    '--real-lib', '--fixture', '--keep-runs',
  ])
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      opts.help = true
      continue
    }
    if (arg === '--no-git') {
      opts.git = false
      continue
    }
    let name = arg
    let value = null
    const eq = arg.indexOf('=')
    if (eq > 0) {
      name = arg.slice(0, eq)
      value = arg.slice(eq + 1)
    }
    if (!valueFlags.has(name)) throw new Error(`未知参数：${arg}`)
    if (value === null) {
      i += 1
      if (i >= argv.length) throw new Error(`参数缺少值：${name}`)
      value = argv[i]
    }
    switch (name) {
      case '--out': opts.out = value; break
      case '--json': opts.jsonPath = value; break
      case '--baseline': opts.baseline = value; break
      case '--regression': opts.regression = value; break
      case '--bounds': opts.bounds = value; break
      case '--samples': opts.samples = Number(value); break
      case '--real-lib': opts.realLib = value; break
      case '--fixture': opts.fixture = value; break
      case '--keep-runs': opts.keepRuns = Math.max(0, Number(value) || 0); break
      default: throw new Error(`未知参数：${arg}`)
    }
  }
  if (!['core', 'all', 'off'].includes(opts.regression)) throw new Error('--regression 只能是 core / all / off')
  if (!['3x', 'quick'].includes(opts.bounds)) throw new Error('--bounds 只能是 3x / quick')
  if (!Number.isFinite(opts.samples) || opts.samples < 1) opts.samples = 5
  return opts
}

const USAGE = `P4 验收台架（存储分片 0.14.0）
  node tools/accept-shard.mjs [选项]
    --out=<路径>         把 markdown 报告写到该路径（基线入档用）
    --json=<路径>        额外写一份机器可读结果（供 P1 前后自动对比）
    --baseline=<路径>    P1 后对比用的基线 JSON（默认 _tmp/accept-shard/baseline.json）
    --regression=core|all|off   回归判据范围（默认 core：10 个关键文件）
    --bounds=3x|quick    上界判据的数据规模（默认 3x = 3×N_MAX；quick = 10x 快跑）
    --samples=5          每个耗时项取样次数（默认 5，取中位数）
    --real-lib=<路径>    真实库路径（只读；默认 C:\\Users\\yh\\WorkDeepSeek\\.exp\\exp-lib.json）
    --fixture=<路径>     golden fixture 路径（默认 _tmp/fixtures/exp-lib-snapshot.json）
    --keep-runs=2        保留最近几次运行目录（默认 2，旧的自动删）
    --no-git             跳过需 git 的判据（J7）
`

function sha256(data) {
  return createHash('sha256').update(data).digest('hex')
}

/** 稳定序列化：对象键排序，数组保持顺序。 */
function canon(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canon(item)).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canon(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value === undefined ? null : value)
}

function shaCanon(value) {
  return sha256(Buffer.from(canon(value)))
}

function sortById(list) {
  return [...(Array.isArray(list) ? list : [])].sort((left, right) => String(left && left.id).localeCompare(String(right && right.id)))
}

function sortedTypes(types) {
  return [...(Array.isArray(types) ? types : [])].sort((left, right) => String(left && left.id).localeCompare(String(right && right.id)))
}

function visibleOf(records) {
  return (Array.isArray(records) ? records : []).filter((item) => item && !item.deleted_at && !item.superseded_by && !item.retired_at)
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

/** 同步基准：先预热一次，再取 samples 次，返回中位数/最小值（毫秒）。 */
function bench(fn, samples) {
  fn()
  const values = []
  for (let i = 0; i < samples; i += 1) {
    const started = performance.now()
    fn()
    values.push(performance.now() - started)
  }
  const med = median(values)
  return {
    median: Number(med.toFixed(2)),
    min: Number(Math.min(...values).toFixed(2)),
    max: Number(Math.max(...values).toFixed(2)),
    samples: values.length,
    values: values.map((value) => Number(value.toFixed(2))),
  }
}

/** 文件签名（mtime 纳秒 + 大小 + inode）：判断「是否被写过」比 mtimeMs 稳。 */
function fileSig(file) {
  const stat = fs.statSync(file, { bigint: true })
  return `${stat.size}:${stat.mtimeNs}:${stat.ino}`
}

/** 目录内所有文件相对路径 → 签名（跳过锁目录/临时文件）。 */
function treeSig(dir) {
  const out = {}
  const walk = (current) => {
    let entries = []
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      const rel = path.relative(dir, full).split(path.sep).join('/')
      if (rel.startsWith('.locks') || rel === 'exp-lib.json.lock' || entry.name.endsWith('.tmp')) continue
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      try {
        out[rel] = fileSig(full)
      } catch {
        // 文件在遍历时被删（别的进程）：忽略
      }
    }
  }
  walk(dir)
  return out
}

function diffSig(before, after) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  const changed = []
  for (const key of keys) {
    if (before[key] !== after[key]) changed.push(key)
  }
  return changed.sort()
}

function countLines(file) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    let lines = 0
    for (const line of text.split('\n')) if (line.trim() !== '') lines += 1
    return lines
  } catch {
    return 0
  }
}

/** 解析 JSONL；坏行记到 errors（迁移/压缩坏了要能看见，不能静默丢）。 */
function readJsonl(file) {
  const records = []
  const errors = []
  let index = 0
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    index += 1
    if (line.trim() === '') continue
    try {
      records.push(JSON.parse(line))
    } catch (error) {
      errors.push(`${path.basename(file)}:${index} ${error && error.message ? error.message : error}`)
    }
  }
  return { records, errors }
}

function listJsonlFiles(dir) {
  const out = []
  const walk = (current) => {
    let entries = []
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.jsonl')) out.push(full)
    }
  }
  walk(dir)
  return out.sort()
}

function relFrom(dir, file) {
  return path.relative(dir, file).split(path.sep).join('/')
}

function copySnapshot(sourcePath, targetPath) {
  // 真实库可能正被插件写：rename 写盘是原子的，copy 不会读到半截；仍校验一次 JSON。
  fs.mkdirSync(path.dirname(targetPath), { recursive: true })
  const temp = `${targetPath}.copying`
  let lastError = null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      fs.copyFileSync(sourcePath, temp)
      JSON.parse(fs.readFileSync(temp, 'utf8'))
      fs.renameSync(temp, targetPath)
      return
    } catch (error) {
      lastError = error
      try { fs.unlinkSync(temp) } catch { /* 忽略 */ }
      sleepSync(80)
    }
  }
  throw new Error(`复制真实库失败：${lastError && lastError.message ? lastError.message : lastError}`)
}

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    const until = Date.now() + ms
    while (Date.now() < until) { /* 退化忙等 */ }
  }
}

function gitRun(cwd, args, { allowFailure = false } = {}) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })
  if (!allowFailure && result.status !== 0) {
    throw new Error(`git ${args.join(' ')} 失败（${result.status}）：${(result.stderr || result.stdout || '').trim()}`)
  }
  return result
}

function gitOut(cwd, args) {
  const result = gitRun(cwd, args, { allowFailure: true })
  return result.status === 0 ? String(result.stdout || '').trim() : null
}

/** 分桶：sha1(id) % K 的稳定替代（同一条记录永远同一个桶；实现细节无关，只用于造合成布局）。 */
function shardOf(id, k = SHARD_K) {
  const hex = sha256(Buffer.from(String(id))).slice(0, 8)
  return Number.parseInt(hex, 16) % k
}

// ---------------------------------------------------------------- 环境与 fixture

function collectEnv() {
  const storeFile = path.join(REPO, 'kernel', 'store.js')
  const storeBytes = fs.readFileSync(storeFile)
  const env = {
    at: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    cpus: os.cpus().length,
    repo: REPO,
    head: gitOut(REPO, ['rev-parse', '--short', 'HEAD']),
    headFull: gitOut(REPO, ['rev-parse', 'HEAD']),
    branch: gitOut(REPO, ['rev-parse', '--abbrev-ref', 'HEAD']),
    dirty: gitOut(REPO, ['status', '--porcelain', '--', 'kernel', 'ui', 'tools']) || '',
    storeSha256: sha256(storeBytes),
    pin: null,
    mainRepo: null,
  }
  // 只读 pin：工作树被别的会话占用时，用 `git archive <commit>` 复制一份到这里跑基线，
  // 并在副本根放 .accept-pin.json 说明来源（脚本不读 .git）。
  try {
    const pin = JSON.parse(fs.readFileSync(path.join(REPO, '.accept-pin.json'), 'utf8'))
    env.pin = pin.note || `git archive ${pin.head} 的只读副本`
    env.mainRepo = pin.mainRepo || null
    if (pin.head) env.head = pin.head
    if (pin.headFull) env.headFull = pin.headFull
    if (pin.branch) env.branch = pin.branch
    if (typeof pin.dirty === 'string') env.dirty = pin.dirty
  } catch {
    // 没有 pin 文件：正常在原地跑
  }
  return env
}

function computeFixtureHashes(data, bytes, sourcePath) {
  const records = Array.isArray(data.experiences) ? data.experiences : []
  const visible = visibleOf(records)
  const fields = {}
  for (const field of HASH_FIELDS) {
    fields[field] = shaCanon(sortById(records).map((item) => [item.id, item[field] === undefined ? null : item[field]]))
  }
  let sourceStat = null
  try {
    const stat = fs.statSync(sourcePath)
    sourceStat = { path: sourcePath, bytes: stat.size, mtime: stat.mtime.toISOString() }
  } catch {
    sourceStat = { path: sourcePath, bytes: null, mtime: null }
  }
  return {
    schema: 1,
    createdAt: new Date().toISOString(),
    source: sourceStat,
    copy: { bytes: bytes.length, sha256: sha256(bytes) },
    counts: {
      records: records.length,
      visible: visible.length,
      types: Array.isArray(data.types) ? data.types.length : 0,
      pending: records.filter((item) => item && item.verdict === 'pending').length,
    },
    allRecordsSha256: shaCanon(sortById(records)),
    visibleRecordsSha256: shaCanon(sortById(visible)),
    typesSha256: shaCanon(sortedTypes(data.types)),
    fields,
  }
}

function ensureFixture(opts) {
  const fixturePath = path.resolve(opts.fixture)
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true })
  const hashesPath = sidecarPath(fixturePath, 'hashes')
  const sourcePath = path.resolve(opts.realLib)
  if (!fs.existsSync(sourcePath)) throw new Error(`真实库不存在（只读源）：${sourcePath}`)
  let regenerated = false
  if (!fs.existsSync(fixturePath)) {
    copySnapshot(sourcePath, fixturePath)
    regenerated = true
  }
  const bytes = fs.readFileSync(fixturePath)
  const data = JSON.parse(bytes.toString('utf8'))
  if (!Array.isArray(data.experiences)) throw new Error('golden fixture 非法：experiences 不是数组')
  const hashes = computeFixtureHashes(data, bytes, sourcePath)
  let hashFile = null
  if (fs.existsSync(hashesPath)) {
    try {
      hashFile = JSON.parse(fs.readFileSync(hashesPath, 'utf8'))
    } catch {
      hashFile = null
    }
  }
  const hashMatch = hashFile !== null && hashFile.copy && hashFile.copy.sha256 === hashes.copy.sha256
  if (!hashMatch) {
    // fixture 被换过 / 首次生成：重写哈希清单（保留首次来源信息）。
    if (hashFile !== null && hashFile.source) hashes.source = hashFile.source
    fs.writeFileSync(hashesPath, `${JSON.stringify(hashes, null, 2)}\n`, 'utf8')
  }
  return {
    path: fixturePath,
    hashesPath,
    bytes,
    data,
    sha256: hashes.copy.sha256,
    bytesLength: bytes.length,
    hashes,
    regenerated,
    hashMatch: hashFile === null ? null : hashMatch,
    source: hashes.source,
  }
}

/**
 * 提示段 golden（J6 用）：在当前（旧版）实现下把「同一数据集」的提示段逐字符录下来。
 * P1 之后分片库渲染出来的提示段必须与它逐字符相等。
 */
function ensureExpectedHints(fixture, runDir) {
  const expectedPath = sidecarPath(fixture.path, 'expected')
  let expected = null
  if (fs.existsSync(expectedPath)) {
    try {
      expected = JSON.parse(fs.readFileSync(expectedPath, 'utf8'))
    } catch {
      expected = null
    }
  }
  if (expected !== null && expected.dataSha256 === fixture.sha256) return { expected, created: false, path: expectedPath }
  const dir = path.join(runDir, 'fixtures', 'expected-hint')
  fs.mkdirSync(dir, { recursive: true })
  fs.copyFileSync(fixture.path, path.join(dir, 'exp-lib.json'))
  const slim = renderHintSlim({ dataDir: dir }, 1400)
  const full = renderHintFull({ dataDir: dir }, 4000)
  if (typeof slim !== 'string' || slim === '' || typeof full !== 'string' || full === '') {
    throw new Error('录制提示段 golden 失败：renderHintSlim/Full 返回空')
  }
  expected = {
    schema: 1,
    createdAt: new Date().toISOString(),
    dataSha256: fixture.sha256,
    slim1400: slim,
    full4000: full,
    slimSha256: sha256(Buffer.from(slim, 'utf8')),
    fullSha256: sha256(Buffer.from(full, 'utf8')),
  }
  fs.writeFileSync(expectedPath, `${JSON.stringify(expected, null, 2)}\n`, 'utf8')
  return { expected, created: true, path: expectedPath }
}

// ---------------------------------------------------------------- 合成库与基线

/** 把快照记录平铺 scale 倍：字段原样，只给 id/taskId/supersedes 加后缀保证唯一。 */
function tileRecords(records, scale) {
  if (scale === 1) return records.map((record) => JSON.parse(JSON.stringify(record)))
  const out = []
  for (let tile = 0; tile < scale; tile += 1) {
    for (const record of records) {
      const copy = JSON.parse(JSON.stringify(record))
      if (tile > 0) {
        if (typeof copy.id === 'string') copy.id = `${copy.id}__t${tile}`
        if (typeof copy.taskId === 'string') copy.taskId = `${copy.taskId}__t${tile}`
        for (const key of ['supersedes', 'superseded_by']) {
          if (typeof copy[key] === 'string') copy[key] = `${copy[key]}__t${tile}`
        }
      }
      out.push(copy)
    }
  }
  return out
}

function writeSyntheticLib(dir, types, experiences) {
  fs.mkdirSync(dir, { recursive: true })
  const payload = {
    version: 1,
    updated_at: new Date().toISOString(),
    types,
    experiences,
  }
  const file = path.join(dir, 'exp-lib.json')
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  return { file, bytes: fs.statSync(file).size }
}

/**
 * 把「单文件库」按 P1 的方式迁移成分片布局。
 * P1 的 readStore 在 manifest 缺失时**只读不迁移**（迁移发生在第一次写盘 / migrateStore），
 * 所以台架要显式触发；没有 migrateStore 导出时保持原样（老版本/未落地即 SKIP）。
 * @returns {{migrated: boolean, error: Error|null}}
 */
function migrateIfPossible(dir) {
  const manifestFile = path.join(dir, 'manifest.json')
  if (fs.existsSync(manifestFile)) return { migrated: true, error: null }
  if (typeof storeApi.migrateStore !== 'function') return { migrated: false, error: null }
  try {
    storeApi.migrateStore(dir)
  } catch (error) {
    return { migrated: false, error }
  }
  return { migrated: fs.existsSync(manifestFile), error: null }
}

function runBaseline(fixture, runDir, opts) {
  const scales = [1, 4, 10]
  const rows = []
  for (const scale of scales) {
    const dir = path.join(runDir, 'bench', `${scale}x`)
    const experiences = tileRecords(fixture.data.experiences, scale)
    const { file, bytes } = writeSyntheticLib(dir, fixture.data.types, experiences)
    // 预读一次：P1 之后首次写会触发一次性迁移；台架显式迁移，不把迁移成本算进 steady-state。
    let store = readStore(dir)
    const migration = migrateIfPossible(dir)
    if (migration.error !== null) throw new Error(`${scale}x 迁移失败：${migration.error.message}`)
    if (migration.migrated) store = readStore(dir)
    const sharded = migration.migrated
    const visibleCount = visibleExperiences(store).length
    const read = bench(() => { readStore(dir) }, opts.samples)
    // task-7：控制台只读路径会传 {cache:true}；实现未落地时该参数被忽略（数字相同）。
    const readCached = bench(() => { readStore(dir, { cache: true }) }, opts.samples)
    const storeForRank = store
    const rank = bench(() => { rankExperiences(storeForRank, BENCH_INTENT, 8) }, opts.samples)

    // 写：复制一份已就绪的库再写，避免污染读测量；每次先改一条（模拟 exp_record 的一次写）。
    const writeDir = path.join(runDir, 'bench', `${scale}x-write`)
    fs.cpSync(dir, writeDir, { recursive: true })
    const writeStoreObj = readStore(writeDir)
    const write = bench(() => {
      const target = writeStoreObj.experiences.find((item) => item && !item.deleted_at && !item.superseded_by && !item.retired_at)
        || writeStoreObj.experiences[0]
      if (target) target.hits = (Number(target.hits) || 0) + 1
      writeStore(writeDir, writeStoreObj)
    }, opts.samples)

    // P3-B 定向写：exp_record/exp_recall 在 partial 路径用 writeTypeShards（只重写 touched 类型 + 就地 stats/recent）。
    // 这里量「改一条 → 只写它所属类型」的稳态成本，和上面的全 store writeStore 对照。
    let writeDirect = null
    let directTypeId = ''
    let directRows = []
    if (sharded && typeof shardApi.writeTypeShards === 'function' && typeof storeApi.readManifest === 'function') {
      const manifest = storeApi.readManifest(writeDir)
      const buckets = Array.isArray(manifest && manifest.buckets) ? manifest.buckets : []
      const largest = [...buckets].sort((left, right) => (Number(right.count) || 0) - (Number(left.count) || 0))[0]
      directTypeId = String((largest && largest.typeId) || '')
      directRows = writeStoreObj.experiences.filter((row) => row && String(row.typeId || '') === directTypeId)
      if (directTypeId !== '' && directRows.length > 0) {
        let currentManifest = manifest
        writeDirect = bench(() => {
          const target = directRows.find((row) => row && !row.deleted_at && !row.superseded_by && !row.retired_at) || directRows[0]
          if (target) target.hits = (Number(target.hits) || 0) + 1
          currentManifest = shardApi.writeTypeShards(writeDir, currentManifest, {
            touchedTypeIds: [directTypeId],
            rowsByType: { [directTypeId]: directRows },
          })
        }, opts.samples)
      }
    }

    // task-9：exp_record 快路径（manifest 定位类型 → partial 读目标类型 → recordShardWrite 定向写+压缩）。
    // 用 autoBind:false 跳过会话绑定，量的就是「读目标类型 + upsert + 定向写」的存储成本。
    let recordFast = null
    if (sharded && typeof shardApi.recordShardWrite === 'function') {
      const recordDir = path.join(runDir, 'bench', `${scale}x-record`)
      fs.cpSync(dir, recordDir, { recursive: true })
      const engine = createEngine({ dataDir: recordDir, config: { autoBind: false, routing: 'on' } })
      const targetType = (store.types.find((type) => type && type.system !== true && type.id !== 'ty_other') || store.types[0] || {}).name
      let seq = 0
      recordFast = bench(() => {
        seq += 1
        engine.record({
          intent: `基准记录第 ${seq} 条：给${targetType || '记录'}补一条`,
          action: `基准动作 ${seq}`,
          outcome: 'success',
          ...(targetType ? { type: targetType } : {}),
        })
      }, opts.samples)
    }

    // 提示段：新目录首调 = 冷（模块内缓存 miss），随后 = 暖。
    const hintDir = path.join(runDir, 'bench', `${scale}x-hint`)
    fs.cpSync(dir, hintDir, { recursive: true })
    const hintStarted = performance.now()
    const hintText = renderHintSlim({ dataDir: hintDir }, 1400)
    const hintCold = { median: Number((performance.now() - hintStarted).toFixed(2)), min: null, max: null, samples: 1 }
    const hintWarm = bench(() => { renderHintSlim({ dataDir: hintDir }, 1400) }, opts.samples)

    rows.push({
      scale,
      label: `${scale}x`,
      records: experiences.length,
      visible: visibleCount,
      fileBytes: bytes,
      file,
      sharded,
      read,
      readCached,
      rank,
      write,
      writeDirect,
      directTypeId,
      recordFast,
      hintCold,
      hintWarm,
      hintLength: hintText.length,
    })
  }
  return rows
}

// ---------------------------------------------------------------- 判据上下文

function prepareJudges(fixture, runDir) {
  const root = path.join(runDir, 'judges')
  const shardDir = path.join(root, 'sharded')
  fs.mkdirSync(shardDir, { recursive: true })
  fs.copyFileSync(fixture.path, path.join(shardDir, 'exp-lib.json'))
  // 真实库的原始记录快照（已验证 == 当前 readStore 归一化后的记录）。
  const rawRecords = JSON.parse(JSON.stringify(fixture.data.experiences || []))
  let migrated = null
  let migrateError = null
  try {
    migrated = readStore(shardDir)
  } catch (error) {
    migrateError = error
  }
  if (!fs.existsSync(path.join(shardDir, 'manifest.json')) && migrateError === null) {
    // P1 的 readStore 只读不迁移：显式触发一次性迁移（没有 migrateStore 导出 = P1 未落地）。
    const migration = migrateIfPossible(shardDir)
    if (migration.error !== null) migrateError = migration.error
    else if (migration.migrated) {
      try {
        migrated = readStore(shardDir)
      } catch (error) {
        migrateError = error
      }
    }
  }
  const manifestPath = path.join(shardDir, 'manifest.json')
  const sharded = fs.existsSync(manifestPath)
  return { root, shardDir, rawRecords, rawTypes: fixture.data.types, migrated, migrateError, sharded, manifestPath }
}

function makeJudge(id, name, status, detail, extra = {}) {
  return { id, name, status, detail, ...extra }
}

function runJudge(fn) {
  try {
    return fn()
  } catch (error) {
    return makeJudge('?', '未捕获错误', 'FAIL', `判据执行抛错：${error && error.message ? error.message : error}`)
  }
}

// ---------------------------------------------------------------- J1 迁移等价

function judgeMigration(ctx) {
  if (ctx.migrateError) {
    return makeJudge('J1', '迁移等价', 'FAIL', `readStore 迁移抛错：${ctx.migrateError.message}`)
  }
  if (!ctx.sharded) {
    return makeJudge('J1', '迁移等价', 'SKIP', '当前 commit 仍是单文件存储：readStore 读真实库副本后未生成 manifest.json，没有「迁移后」可比。P1 落地后同一判据自动生效；golden 逐字段哈希已入档（J-哈希）。')
  }
  const migrated = ctx.migrated
  const rawById = new Map(ctx.rawRecords.map((item) => [item.id, item]))
  const problems = []
  const fieldDiffs = {}
  const extraFields = new Set()
  let compared = 0
  for (const record of sortById(migrated.experiences)) {
    const raw = rawById.get(record.id)
    if (raw === undefined) {
      problems.push(`迁移后多出记录：${record.id}`)
      continue
    }
    compared += 1
    // 迁移是「换存储形态」：原字段逐字段必须相等；迁移后新增的字段只记录、不判红。
    for (const key of Object.keys(raw)) {
      const left = raw[key] === undefined ? null : raw[key]
      const right = record[key] === undefined ? null : record[key]
      if (canon(left) !== canon(right)) fieldDiffs[key] = (fieldDiffs[key] || 0) + 1
    }
    for (const key of Object.keys(record)) if (!(key in raw)) extraFields.add(key)
  }
  if (migrated.experiences.length !== ctx.rawRecords.length) {
    problems.push(`记录数不一致：迁移前 ${ctx.rawRecords.length} / 迁移后 ${migrated.experiences.length}`)
  }
  const missing = ctx.rawRecords.filter((item) => !migrated.experiences.some((row) => row.id === item.id)).map((item) => item.id)
  if (missing.length > 0) problems.push(`迁移后缺少 ${missing.length} 条：${missing.slice(0, 5).join(', ')}`)
  if (canon(sortedTypes(migrated.types)) !== canon(sortedTypes(ctx.rawTypes))) problems.push('types 不一致（id/name/description/system 任一字段）')
  const fields = Object.keys(fieldDiffs)
  if (fields.length > 0) problems.push(`字段差异：${fields.map((key) => `${key}×${fieldDiffs[key]}`).join(', ')}`)
  const visibleIds = new Set(visibleOf(ctx.rawRecords).map((item) => item.id))
  const migratedVisibleIds = new Set(visibleOf(migrated.experiences).map((item) => item.id))
  if (visibleIds.size !== migratedVisibleIds.size) problems.push(`可见条数不一致：${visibleIds.size} / ${migratedVisibleIds.size}`)
  const extra = [...extraFields]
  const detail = problems.length === 0
    ? `逐字段相等：${compared} 条记录原有字段全部一致，types 一致，可见 ${migratedVisibleIds.size} 条一致${extra.length > 0 ? `（迁移后新增字段：${extra.join(', ')}，非失败）` : ''}`
    : problems.slice(0, 6).join('；')
  return makeJudge('J1', '迁移等价', problems.length === 0 ? 'PASS' : 'FAIL', detail, { fieldDiffs, extraFields: extra })
}

// ---------------------------------------------------------------- J2 幂等

function judgeIdempotent(ctx) {
  if (!ctx.sharded) {
    return makeJudge('J2', '迁移幂等', 'SKIP', '当前是单文件存储，没有「第二次迁移」可测；P1 落地后自动生效。')
  }
  const before = treeSig(ctx.shardDir)
  try {
    readStore(ctx.shardDir)
  } catch (error) {
    return makeJudge('J2', '迁移幂等', 'FAIL', `第二次 readStore 抛错：${error && error.message ? error.message : error}`)
  }
  const changed = diffSig(before, treeSig(ctx.shardDir))
  return makeJudge(
    'J2',
    '迁移幂等',
    changed.length === 0 ? 'PASS' : 'FAIL',
    changed.length === 0
      ? `第二次 readStore 未写文件（${Object.keys(before).length} 个文件的 mtime/size 均不变）`
      : `第二次 readStore 改动了 ${changed.length} 个文件：${changed.slice(0, 6).join(', ')}`,
  )
}

// ---------------------------------------------------------------- J3/J4 上界与守恒（3×N_MAX）

function prepareHeavy(ctx, opts, runDir) {
  if (!ctx.sharded) return null
  const base = ctx.rawRecords.length || 1
  const target = opts.bounds === 'quick' ? base * 10 : N_MAX * 3
  const scale = Math.max(1, Math.ceil(target / base))
  const dir = path.join(runDir, 'judges', 'heavy')
  const experiences = tileRecords(ctx.rawRecords, scale)
  writeSyntheticLib(dir, ctx.rawTypes, experiences)
  const store = readStore(dir)
  // 让每个类型的指纹都变一次：否则 P2 的增量写可能整轮跳过，压缩永远不触发。
  const touched = new Set()
  for (const record of store.experiences) {
    const typeId = String(record.typeId || '')
    if (!touched.has(typeId)) {
      record.hits = (Number(record.hits) || 0) + 1
      record.lastSeenAt = new Date().toISOString()
      touched.add(typeId)
    }
  }
  // 写入前的前置快照（含每条完整记录）：压缩守恒/冷档逐字段比对都用它。
  const preById = new Map(store.experiences.map((item) => [item.id, JSON.parse(JSON.stringify(item))]))
  writeStore(dir, store)
  // P2 的 compactStore 每次写只压缩「当前最大的那个分片」（D4 的语义）；真实使用是一条一条写，
  // 会自然收敛。台架是批量写，所以要重复触发直到上界全部满足（最多 200 轮，无进展即停）。
  let compactionRounds = 0
  for (let round = 0; round < 200; round += 1) {
    const probe = scanLayout(dir)
    const hotBytes = probe.buckets.reduce((sum, bucket) => sum + bucket.bytes, 0)
    const overBucket = probe.buckets.some((bucket) => bucket.bytes > MAX_BUCKET_BYTES)
    const overHot = hotBytes > HOT_MAX_BYTES
    const visible = Number(probe.manifest && probe.manifest.stats && probe.manifest.stats.visible)
    const overCount = Number.isFinite(visible) && visible > N_MAX
    if (!overBucket && !overHot && !overCount) break
    const before = probe.buckets.map((bucket) => bucket.bytes).join(',')
    writeStore(dir, readStore(dir))
    compactionRounds = round + 1
    const after = scanLayout(dir).buckets.map((bucket) => bucket.bytes).join(',')
    if (after === before) break
  }
  const scan = scanLayout(dir)
  return { dir, scale, records: experiences.length, hotTypes: touched.size, preById, scan, compactionRounds }
}

function scanLayout(dir) {
  const manifestPath = path.join(dir, 'manifest.json')
  let manifest = null
  if (fs.existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    } catch {
      manifest = 'BAD_JSON'
    }
  }
  const buckets = []
  for (const file of listJsonlFiles(path.join(dir, 'buckets'))) {
    buckets.push({ file: relFrom(dir, file), bytes: fs.statSync(file).size, lines: countLines(file) })
  }
  const cold = []
  for (const file of listJsonlFiles(path.join(dir, 'cold'))) {
    cold.push({ file: relFrom(dir, file), bytes: fs.statSync(file).size, lines: countLines(file) })
  }
  const legacy = fs.existsSync(path.join(dir, 'exp-lib.legacy.json'))
  const single = fs.existsSync(path.join(dir, 'exp-lib.json'))
  const dataFiles = (manifest !== null ? 1 : 0) + buckets.length + cold.length + (legacy ? 1 : 0) + (single ? 1 : 0)
  return { manifest, manifestBytes: manifest !== null ? fs.statSync(manifestPath).size : 0, buckets, cold, legacy, single, dataFiles }
}

/** manifest.cold 的登记：兼容 P2 的 `years[].files[]` 与旧的 `years[].file` 两种形状。 */
function manifestColdEntries(manifest) {
  const years = manifest && manifest.cold && Array.isArray(manifest.cold.years) ? manifest.cold.years : []
  const out = []
  for (const year of years) {
    if (year === null || typeof year !== 'object') continue
    if (Array.isArray(year.files)) {
      for (const entry of year.files) {
        if (entry === null || typeof entry !== 'object') continue
        out.push({ file: String(entry.file || '').split('\\').join('/'), count: Number(entry.count) || 0, bytes: Number(entry.bytes) || 0 })
      }
      continue
    }
    if (typeof year.file === 'string' && year.file !== '') {
      out.push({ file: year.file.split('\\').join('/'), count: Number(year.count) || 0, bytes: Number(year.bytes) || 0 })
    }
  }
  return out
}

function judgeBounds(ctx, heavy) {
  if (!ctx.sharded) {
    return makeJudge('J3', '单文件上界', 'SKIP', `当前是单文件存储（exp-lib.json），没有分片/冷档可断言；P1/P2 落地后自动按 3×N_MAX 数据检查「桶 ≤${Math.round(MAX_BUCKET_BYTES / 1024 / 1024)} MiB、热档 ≤${Math.round(HOT_MAX_BYTES / 1024 / 1024)} MiB、冷档片 ≤${Math.round(COLD_MAX_BYTES / 1024 / 1024)} MB、数据文件 ≤${FILE_COUNT_MAX}」。`)
  }
  if (heavy === null) return makeJudge('J3', '单文件上界', 'SKIP', 'heavy 数据集未生成（--bounds 关闭）')
  const scan = heavy.scan
  if (scan.manifest === 'BAD_JSON') return makeJudge('J3', '单文件上界', 'FAIL', 'manifest.json 不是合法 JSON')
  if (scan.buckets.length === 0) return makeJudge('J3', '单文件上界', 'FAIL', '没有 buckets/*.jsonl，分片布局不成立')
  const overBuckets = scan.buckets.filter((item) => item.bytes > MAX_BUCKET_BYTES)
  const overCold = scan.cold.filter((item) => item.bytes > COLD_MAX_BYTES)
  const tooManyFiles = scan.dataFiles > FILE_COUNT_MAX
  const maxBucket = Math.max(...scan.buckets.map((item) => item.bytes))
  const maxCold = scan.cold.length > 0 ? Math.max(...scan.cold.map((item) => item.bytes)) : 0
  const hotBytes = scan.buckets.reduce((sum, bucket) => sum + bucket.bytes, 0)
  const coldBytes = scan.cold.reduce((sum, bucket) => sum + bucket.bytes, 0)
  const overHot = hotBytes > HOT_MAX_BYTES
  const problems = []
  if (overBuckets.length > 0) problems.push(`${overBuckets.length}/${scan.buckets.length} 个桶超 1 MB（最大 ${fmtBytes(maxBucket)}）`)
  if (overHot) problems.push(`热档合计 ${fmtBytes(hotBytes)} > 12 MiB（D4 闸）`)
  if (overCold.length > 0) problems.push(`${overCold.length} 个冷档超 8 MB（最大 ${fmtBytes(maxCold)}）`)
  if (tooManyFiles) problems.push(`数据文件 ${scan.dataFiles} 个 > ${FILE_COUNT_MAX}`)
  const detail = `桶 ${scan.buckets.length} 个（最大 ${fmtBytes(maxBucket)}，热档 ${fmtBytes(hotBytes)}）· 冷档 ${scan.cold.length} 档（最大 ${fmtBytes(maxCold)}，合计 ${fmtBytes(coldBytes)}）· 数据文件 ${scan.dataFiles} 个 · 合成 ${heavy.records} 条（scale ${heavy.scale}x）· 压 ${heavy.compactionRounds} 轮收敛`
  return makeJudge('J3', '单文件上界', problems.length === 0 ? 'PASS' : 'FAIL', problems.length === 0 ? detail : `${problems.join('；')}｜${detail}`, { scan: summarizeScan(scan), hotBytes, coldBytes, compactionRounds: heavy.compactionRounds })
}

function summarizeScan(scan) {
  return {
    buckets: scan.buckets.length,
    maxBucketBytes: scan.buckets.length > 0 ? Math.max(...scan.buckets.map((item) => item.bytes)) : 0,
    hotBytes: scan.buckets.reduce((sum, bucket) => sum + bucket.bytes, 0),
    cold: scan.cold.length,
    maxColdBytes: scan.cold.length > 0 ? Math.max(...scan.cold.map((item) => item.bytes)) : 0,
    coldBytes: scan.cold.reduce((sum, bucket) => sum + bucket.bytes, 0),
    dataFiles: scan.dataFiles,
    legacy: scan.legacy,
  }
}

function judgeConservation(ctx, heavy) {
  if (!ctx.sharded) {
    return makeJudge('J4', '压缩守恒', 'SKIP', '当前是单文件存储，压缩未实现；P1/P2 落地后检查 manifest 计数与分片实际行数一致、热+冷不丢「不应丢」的记录。')
  }
  if (heavy === null) return makeJudge('J4', '压缩守恒', 'SKIP', 'heavy 数据集未生成（--bounds 关闭）')
  const scan = heavy.scan
  if (scan.manifest === null || scan.manifest === 'BAD_JSON') {
    return makeJudge('J4', '压缩守恒', 'FAIL', 'manifest.json 缺失或非法，无法核对计数')
  }
  const problems = []
  const bucketByFile = new Map(scan.buckets.map((item) => [item.file, item]))
  const listed = new Map()
  for (const entry of Array.isArray(scan.manifest.buckets) ? scan.manifest.buckets : []) {
    const file = String(entry && entry.file ? entry.file : '').split('\\').join('/')
    if (file === '') {
      problems.push('manifest.buckets 有一条缺 file')
      continue
    }
    const real = bucketByFile.get(file)
    if (real === undefined) {
      problems.push(`manifest 登记的 ${file} 不存在`)
      continue
    }
    listed.set(file, real)
    const declared = Number(entry.count)
    if (declared !== real.lines) problems.push(`${file}: manifest 记 ${declared} 行，实际 ${real.lines} 行`)
  }
  const unlisted = scan.buckets.filter((item) => !listed.has(item.file))
  if (unlisted.length > 0) problems.push(`${unlisted.length} 个桶未登记进 manifest（如 ${unlisted[0].file}）`)

  // 冷档计数（兼容 years[].files[] 与 years[].file）
  const coldByFile = new Map(scan.cold.map((item) => [item.file, item]))
  for (const entry of manifestColdEntries(scan.manifest)) {
    const file = entry.file
    if (file === '') {
      problems.push('manifest.cold 有一条缺 file')
      continue
    }
    const real = coldByFile.get(file)
    if (real === undefined) problems.push(`manifest.cold 登记的 ${file} 不存在`)
    else if (Number(entry.count) !== real.lines) problems.push(`${file}: 冷档 manifest 记 ${entry.count} 行，实际 ${real.lines} 行`)
  }

  // 热+冷 记录集合：不丢「不应被清理」的记录、不凭空多出、不重复。
  const hotIds = new Map()
  const badLines = []
  for (const item of scan.buckets) {
    const parsed = readJsonl(path.join(heavy.dir, item.file))
    badLines.push(...parsed.errors)
    for (const record of parsed.records) hotIds.set(String(record.id || ''), record)
  }
  const coldIds = new Map()
  for (const item of scan.cold) {
    const parsed = readJsonl(path.join(heavy.dir, item.file))
    badLines.push(...parsed.errors)
    for (const record of parsed.records) coldIds.set(String(record.id || ''), record)
  }
  if (badLines.length > 0) problems.push(`有 ${badLines.length} 行不是合法 JSON：${badLines.slice(0, 2).join(' / ')}`)
  const union = new Set([...hotIds.keys(), ...coldIds.keys()])
  const invented = [...union].filter((id) => !heavy.preById.has(id))
  if (invented.length > 0) problems.push(`出现 ${invented.length} 条库里原本没有的记录：${invented.slice(0, 3).join(', ')}`)
  const duplicated = [...hotIds.keys()].filter((id) => coldIds.has(id))
  if (duplicated.length > 0) problems.push(`${duplicated.length} 条记录同时出现在热档与冷档：${duplicated.slice(0, 3).join(', ')}`)
  const now = Date.now()
  const purgeEligible = new Set()
  for (const [id, record] of heavy.preById) {
    const deletedAt = Date.parse(record.deleted_at)
    const expiredTombstone = Boolean(record.deleted_at) && (!Number.isFinite(deletedAt) || now - deletedAt >= TOMBSTONE_DAYS * DAY_MS)
    if (expiredTombstone || record.superseded_by || record.retired_at) purgeEligible.add(id)
  }
  const lost = [...heavy.preById.keys()].filter((id) => !purgeEligible.has(id) && !union.has(id))
  if (lost.length > 0) problems.push(`丢了 ${lost.length} 条本不该清理的记录：${lost.slice(0, 3).join(', ')}`)

  const detail = `热 ${hotIds.size} 条 + 冷 ${coldIds.size} 条 = ${union.size} 条；压缩前 ${heavy.preById.size} 条（可按规则物理清理 ${purgeEligible.size} 条）`
  return makeJudge('J4', '压缩守恒', problems.length === 0 ? 'PASS' : 'FAIL', problems.length === 0 ? detail : `${problems.slice(0, 5).join('；')}｜${detail}`, { scan: summarizeScan(scan) })
}

// ---------------------------------------------------------------- J5 写入局部性

function judgeWriteLocality(ctx, runDir) {
  if (!ctx.sharded) {
    return makeJudge('J5', '写入局部性', 'SKIP', '当前是单文件存储：写一条必然整文件重写（这正是要修的），判据不适用；P1/P2 落地后自动检查「只有该类型分片变化」。')
  }
  const dir = path.join(runDir, 'judges', 'locality')
  fs.mkdirSync(dir, { recursive: true })
  const legacySource = path.join(ctx.shardDir, 'exp-lib.legacy.json')
  if (fs.existsSync(legacySource)) fs.copyFileSync(legacySource, path.join(dir, 'exp-lib.legacy.json'))
  fs.cpSync(path.join(ctx.shardDir, 'buckets'), path.join(dir, 'buckets'), { recursive: true })
  fs.copyFileSync(path.join(ctx.shardDir, 'manifest.json'), path.join(dir, 'manifest.json'))
  if (fs.existsSync(path.join(ctx.shardDir, 'cold'))) fs.cpSync(path.join(ctx.shardDir, 'cold'), path.join(dir, 'cold'), { recursive: true })

  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
  const store = readStore(dir)
  const target = store.experiences.find((item) => item && !item.deleted_at && !item.superseded_by && !item.retired_at)
  if (target === undefined) return makeJudge('J5', '写入局部性', 'FAIL', '没有可见记录可改')
  const marker = `[locality-${Date.now()}]`
  target.note = `${target.note === undefined ? '' : target.note} ${marker}`.trim()
  target.hits = (Number(target.hits) || 0) + 1

  const before = treeSig(dir)
  writeStore(dir, store)
  const changed = diffSig(before, treeSig(dir))
  const typeFiles = new Set((Array.isArray(manifest.buckets) ? manifest.buckets : [])
    .filter((entry) => String(entry.typeId) === String(target.typeId))
    .map((entry) => String(entry.file).split('\\').join('/')))
  const touchedType = changed.filter((file) => typeFiles.has(file))
  const unexpected = changed.filter((file) => file !== 'manifest.json' && !typeFiles.has(file))
  const reread = readStore(dir).experiences.find((item) => item.id === target.id)
  const readBack = reread !== undefined && String(reread.note || '').includes(marker)
  const problems = []
  if (typeFiles.size === 0) problems.push('manifest 里找不到目标类型的分片登记')
  if (touchedType.length === 0) problems.push(`目标类型（${target.typeName || target.typeId}）的分片一个都没变`)
  if (unexpected.length > 0) problems.push(`其它文件被顺带重写：${unexpected.slice(0, 6).join(', ')}`)
  if (!readBack) problems.push('改完再读回来找不到标记（写入未生效）')
  const detail = touchedType.length === 0
    ? problems.join('；')
    : `只动 ${touchedType.length} 个分片（${touchedType.join(', ')}），其它 ${Math.max(0, changed.length - touchedType.length)} 个变化文件${unexpected.length > 0 ? `：${unexpected.slice(0, 4).join(', ')}` : '均不属于该类型'}`
  return makeJudge('J5', '写入局部性', problems.length === 0 ? 'PASS' : 'FAIL', problems.length === 0 ? detail : `${problems.join('；')}｜${detail}`)
}

// ---------------------------------------------------------------- J6 提示段等价

function judgeHintEquivalence(ctx, expected) {
  const data = expected.expected
  // 先自检 golden 是否与「当前数据集」一致（防止 fixture/期望文件错配）。
  if (data === null || data.dataSha256 !== ctx.rawSha) {
    return makeJudge('J6', '提示段等价', 'FAIL', 'golden 提示段与当前 fixture 哈希不一致（期望文件需重录）')
  }
  if (!ctx.sharded) {
    return makeJudge('J6', '提示段等价', 'SKIP', `单文件存储下新旧同源；golden 已录制（slim ${data.slimSha256.slice(0, 12)}… / full ${data.fullSha256.slice(0, 12)}…），P1 落地后与分片库渲染结果逐字符比对。`)
  }
  const problems = []
  const slim = renderHintSlim({ dataDir: ctx.shardDir }, 1400)
  const full = renderHintFull({ dataDir: ctx.shardDir }, 4000)
  if (slim !== data.slim1400) problems.push(`slim 不一致（长度 ${slim.length} vs ${data.slim1400.length}）${firstDiff(slim, data.slim1400)}`)
  if (full !== data.full4000) problems.push(`full 不一致（长度 ${full.length} vs ${data.full4000.length}）${firstDiff(full, data.full4000)}`)
  return makeJudge('J6', '提示段等价', problems.length === 0 ? 'PASS' : 'FAIL', problems.length === 0
    ? `slim ${slim.length} 字符 / full ${full.length} 字符，与 golden 逐字符相等`
    : problems.join('；'), { slimSha256: sha256(Buffer.from(slim, 'utf8')), fullSha256: sha256(Buffer.from(full, 'utf8')) })
}

function firstDiff(left, right) {
  const limit = Math.min(left.length, right.length)
  let index = 0
  while (index < limit && left[index] === right[index]) index += 1
  const from = Math.max(0, index - 20)
  const show = (text) => JSON.stringify(text.slice(from, index + 40))
  return `，首个差异 @${index}：分片=${show(left)} golden=${show(right)}`
}

// ---------------------------------------------------------------- J7 Git 合并

function buildSyntheticShardLayout(dir, data) {
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(path.join(dir, 'buckets'), { recursive: true })
  const records = Array.isArray(data.experiences) ? data.experiences : []
  const byType = new Map()
  for (const record of records) {
    const typeId = String(record.typeId || 'ty_other')
    if (!byType.has(typeId)) byType.set(typeId, [])
    byType.get(typeId).push(record)
  }
  const buckets = []
  for (const [typeId, list] of byType) {
    const shards = new Map()
    for (const record of list) {
      const index = shardOf(record.id)
      if (!shards.has(index)) shards.set(index, [])
      shards.get(index).push(record)
    }
    for (const index of [...shards.keys()].sort((left, right) => left - right)) {
      const file = `buckets/${typeId}.${index}.jsonl`
      const lines = shards.get(index).map((record) => JSON.stringify(record)).join('\n')
      fs.writeFileSync(path.join(dir, file), `${lines}\n`, 'utf8')
      buckets.push({ file, typeId, count: shards.get(index).length, bytes: fs.statSync(path.join(dir, file)).size })
    }
  }
  const manifest = {
    schema: 2,
    version: 1,
    types: Array.isArray(data.types) ? data.types : [],
    buckets,
    pending: [],
    cold: { years: [] },
    migratedFrom: 'exp-lib.json',
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  fs.writeFileSync(path.join(dir, 'exp-lib.legacy.json'), `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  return { byType, buckets, manifest }
}

function editJsonlLine(file, lineIndex, mutate) {
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  const record = JSON.parse(lines[lineIndex])
  mutate(record)
  lines[lineIndex] = JSON.stringify(record)
  fs.writeFileSync(file, lines.join('\n'), 'utf8')
}

function judgeGitMerge(ctx, runDir, opts) {
  if (!opts.git) return makeJudge('J7', 'Git 合并', 'SKIP', '按 --no-git 跳过')
  const dir = path.join(runDir, 'judges', 'git-merge')
  try {
    const layout = buildSyntheticShardLayout(dir, ctx.fixture.data)
    const types = layout.manifest.buckets
    if (types.length < 2) return makeJudge('J7', 'Git 合并', 'SKIP', 'fixture 类型不足 2 个，无法构造「不同记录」合并场景')
    const filesA = [...new Set(types.map((entry) => entry.file))]
    const typeAFile = filesA[0]
    const typeBFile = filesA.find((file) => file !== typeAFile) || filesA[0]

    gitRun(dir, ['init', '-q', '-b', 'main'])
    gitRun(dir, ['config', 'user.email', 'accept-harness@leadvm.local'])
    gitRun(dir, ['config', 'user.name', 'accept-harness'])
    gitRun(dir, ['config', 'core.autocrlf', 'false'])
    gitRun(dir, ['add', '-A'])
    gitRun(dir, ['commit', '-q', '-m', 'base'])

    // A：两台设备各改**不同分片文件**里的一条记录。
    gitRun(dir, ['checkout', '-q', '-b', 'device-a'])
    editJsonlLine(path.join(dir, typeAFile), 0, (record) => { record.note = `${record.note || ''} [device-a]`.trim() })
    gitRun(dir, ['commit', '-q', '-am', 'device-a: one record'])
    gitRun(dir, ['checkout', '-q', 'main'])
    gitRun(dir, ['checkout', '-q', '-b', 'device-b'])
    editJsonlLine(path.join(dir, typeBFile), 0, (record) => { record.note = `${record.note || ''} [device-b]`.trim() })
    gitRun(dir, ['commit', '-q', '-am', 'device-b: one record'])
    gitRun(dir, ['checkout', '-q', 'device-a'])
    const mergeA = gitRun(dir, ['merge', '--no-edit', 'device-b'], { allowFailure: true })
    const bucketClean = mergeA.status === 0
    let mergedText = ''
    if (bucketClean) {
      mergedText = fs.readFileSync(path.join(dir, typeAFile), 'utf8') + fs.readFileSync(path.join(dir, typeBFile), 'utf8')
    } else {
      gitRun(dir, ['merge', '--abort'], { allowFailure: true })
    }
    const bothPresent = mergedText.includes('[device-a]') && mergedText.includes('[device-b]')

    // B：同一分片文件、不同行（同一类型两条记录并发）→ 应能自动合并。
    gitRun(dir, ['checkout', '-q', 'main'])
    const multiLine = [...new Set(layout.buckets.map((entry) => entry.file))]
      .map((file) => ({ file, lines: countLines(path.join(dir, file)) }))
      .filter((entry) => entry.file !== typeAFile || entry.lines >= 2)
      .sort((left, right) => right.lines - left.lines)[0]
    let sameFileClean = null
    let sameFileDetail = ''
    if (multiLine !== undefined && multiLine.lines >= 3) {
      const file = multiLine.file
      const firstLine = 0
      const secondLine = Math.min(4, multiLine.lines - 1)
      gitRun(dir, ['checkout', '-q', '-b', 'device-c'])
      editJsonlLine(path.join(dir, file), firstLine, (record) => { record.note = `${record.note || ''} [device-c]`.trim() })
      gitRun(dir, ['commit', '-q', '-am', 'device-c'])
      gitRun(dir, ['checkout', '-q', 'main'])
      gitRun(dir, ['checkout', '-q', '-b', 'device-d'])
      editJsonlLine(path.join(dir, file), secondLine, (record) => { record.note = `${record.note || ''} [device-d]`.trim() })
      gitRun(dir, ['commit', '-q', '-am', 'device-d'])
      gitRun(dir, ['checkout', '-q', 'device-c'])
      const mergeB = gitRun(dir, ['merge', '--no-edit', 'device-d'], { allowFailure: true })
      sameFileClean = mergeB.status === 0
      sameFileDetail = `${path.basename(file)} 第 ${firstLine + 1}/${secondLine + 1} 行`
      if (!sameFileClean) gitRun(dir, ['merge', '--abort'], { allowFailure: true })
      gitRun(dir, ['checkout', '-q', 'main'])
    }

    const problems = []
    if (!bucketClean) problems.push('不同分片文件各改一条 → 合并冲突')
    if (!bothPresent) problems.push('合并后两台设备的改动没有同时保留')
    if (sameFileClean === false) problems.push('同一分片文件不同行并发改 → 合并冲突')
    const notes = []
    notes.push(`不同文件各改一条：${bucketClean && bothPresent ? '无冲突' : '有冲突'}`)
    notes.push(sameFileClean === null ? '同文件不同行：样本不足，未测' : `同文件不同行（${sameFileDetail}）：${sameFileClean ? '无冲突' : '有冲突'}`)
    notes.push('manifest 是可重建缓存（D1，不含 updated_at）：即使合并冲突，取任一边后下一次读会按分片重建，不影响数据')
    return makeJudge('J7', 'Git 合并', problems.length === 0 ? 'PASS' : 'FAIL',
      problems.length === 0 ? notes.join('；') : `${problems.join('；')}｜${notes.join('；')}`,
      { sameFileClean })
  } catch (error) {
    return makeJudge('J7', 'Git 合并', 'FAIL', `git 演练失败：${error && error.message ? error.message : error}`)
  }
}

// ---------------------------------------------------------------- J8 回归

function parsePackageTests(repo) {
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'))
  const script = String((pkg.scripts && pkg.scripts.test) || '')
  return script.split('&&')
    .map((part) => part.trim().replace(/^node\s+/u, ''))
    .filter((part) => part.endsWith('.mjs'))
}

function judgeRegression(repo, mode) {
  if (mode === 'off') return makeJudge('J8', '回归', 'SKIP', '按 --regression=off 跳过')
  const files = mode === 'all' ? parsePackageTests(repo) : CORE_TESTS
  const failures = []
  const started = Date.now()
  for (const file of files) {
    const result = spawnSync(process.execPath, [file], {
      cwd: repo,
      encoding: 'utf8',
      timeout: 180000,
      env: { ...process.env, NO_COLOR: '1' },
    })
    if (result.status !== 0) {
      const tail = `${result.stdout || ''}\n${result.stderr || ''}`.trim().split('\n').slice(-6).join(' ⏎ ')
      failures.push(`${file}（exit ${result.status}${result.error ? `, ${result.error.code}` : ''}）：${tail}`)
    }
  }
  const elapsed = ((Date.now() - started) / 1000).toFixed(1)
  return makeJudge('J8', '回归', failures.length === 0 ? 'PASS' : 'FAIL',
    failures.length === 0
      ? `${files.length} 个测试文件逐文件全绿（${elapsed}s，范围 ${mode}）`
      : `${failures.length}/${files.length} 失败（${elapsed}s）：${failures.slice(0, 4).join('；')}`,
    { failures, count: files.length, elapsedSeconds: Number(elapsed) })
}

// ---------------------------------------------------------------- J9 冷档可查

function judgeCold(ctx, heavy) {
  if (!ctx.sharded) return makeJudge('J9', '冷档可查', 'SKIP', '当前是单文件存储，没有冷档；P2 落地并触发一次下沉后自动检查「字段完整 / 默认召回取不到 / 提示段不计入」。')
  if (heavy === null) return makeJudge('J9', '冷档可查', 'SKIP', 'heavy 数据集未生成，无法触发下沉')
  const coldFiles = listJsonlFiles(path.join(heavy.dir, 'cold'))
  if (coldFiles.length === 0) return makeJudge('J9', '冷档可查', 'SKIP', '本次数据未触发下沉（没有 cold/*.jsonl）；到 3×N_MAX 仍不下沉说明压缩未生效，需在 P2 复核')
  const problems = []
  const coldRecords = []
  const badLines = []
  for (const file of coldFiles) {
    const parsed = readJsonl(file)
    coldRecords.push(...parsed.records)
    badLines.push(...parsed.errors)
  }
  if (badLines.length > 0) problems.push(`冷档有 ${badLines.length} 行坏 JSON`)
  let fieldBroken = 0
  for (const record of coldRecords) {
    const before = heavy.preById.get(String(record.id))
    if (before === undefined) {
      fieldBroken += 1
      continue
    }
    if (canon(record) !== canon(before)) fieldBroken += 1
  }
  if (fieldBroken > 0) problems.push(`${fieldBroken}/${coldRecords.length} 条下沉记录与下沉前快照字段不一致`)
  const hotStore = readStore(heavy.dir)
  const hotIds = new Set(hotStore.experiences.map((item) => String(item.id)))
  const stillHot = coldRecords.filter((record) => hotIds.has(String(record.id)))
  if (stillHot.length > 0) problems.push(`${stillHot.length} 条下沉记录仍出现在默认读库结果里`)
  const hint = renderHintSlim({ dataDir: heavy.dir }, 1400)
  const match = /共\s*(\d+)\s*条/u.exec(hint)
  const declared = match === null ? null : Number(match[1])
  const hotVisible = visibleExperiences(hotStore).length
  if (declared !== null && declared !== hotVisible) problems.push(`提示段「共 ${declared} 条」与热档可见条数 ${hotVisible} 不一致（冷档不应计入）`)
  return makeJudge('J9', '冷档可查', problems.length === 0 ? 'PASS' : 'FAIL',
    problems.length === 0
      ? `下沉 ${coldRecords.length} 条：字段与下沉前逐字段一致；默认召回不含它们；提示段「共 ${declared} 条」不计冷档`
      : problems.join('；'),
    { coldCount: coldRecords.length })
}

// ---------------------------------------------------------------- 回滚演练

function runRollbackRehearsal(ctx, runDir) {
  const root = path.join(runDir, 'rollback')
  const dir = path.join(root, 'sharded')
  // 1) 造一个「已迁移」形态的副本：legacy + manifest + buckets + cold（全部是副本，真实库不参与）。
  const layout = buildSyntheticShardLayout(dir, ctx.fixture.data)
  fs.mkdirSync(path.join(dir, 'cold'), { recursive: true })
  const coldSample = visibleOf(ctx.fixture.data.experiences).slice(0, 2)
  fs.writeFileSync(path.join(dir, 'cold', '2026.jsonl'), `${coldSample.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8')

  // 2) 跑真实回滚步骤（与 tools/rollback-shard.md 一一对应）。
  const started = performance.now()
  const archiveName = 'rollback-archive-20261112'
  let result = null
  try {
    result = rollbackProcedure(dir, archiveName)
  } catch (error) {
    result = { aborted: true, reason: error && error.message ? error.message : String(error), steps: [] }
  }
  const elapsed = Number((performance.now() - started).toFixed(2))

  const problems = []
  if (result.aborted) {
    problems.push(`回滚中止（不应中止）：${result.reason}`)
  } else {
    const restored = path.join(dir, 'exp-lib.json')
    if (!fs.existsSync(restored)) problems.push('回滚后没有 exp-lib.json')
    else {
      const restoredSha = sha256(fs.readFileSync(restored))
      if (restoredSha !== ctx.fixture.sha256 && restoredSha !== sha256(Buffer.from(`${JSON.stringify(ctx.fixture.data, null, 2)}\n`, 'utf8'))) {
        problems.push('exp-lib.json 与 legacy 快照字节不一致')
      }
    }
    for (const leftover of ['manifest.json', 'buckets', 'cold']) {
      if (fs.existsSync(path.join(dir, leftover))) problems.push(`回滚后 ${leftover} 仍在原位`)
    }
    const archiveDir = path.join(dir, archiveName)
    for (const archived of ['manifest.json', 'buckets', 'cold']) {
      if (!fs.existsSync(path.join(archiveDir, archived))) problems.push(`归档里缺少 ${archived}`)
    }
    try {
      const store = readStore(dir)
      const visible = visibleExperiences(store).length
      const expected = visibleOf(ctx.fixture.data.experiences).length
      if (visible !== expected) problems.push(`恢复后可见 ${visible} 条，期望 ${expected} 条`)
    } catch (error) {
      problems.push(`恢复后 readStore 失败：${error && error.message ? error.message : error}`)
    }
  }

  // 3) 中止分支：没有 legacy 时必须拒绝回滚、且不动任何文件。
  const abortDir = path.join(root, 'legacy-missing')
  fs.rmSync(abortDir, { recursive: true, force: true })
  fs.mkdirSync(path.join(abortDir, 'buckets'), { recursive: true })
  fs.copyFileSync(path.join(dir, archiveName, 'manifest.json'), path.join(abortDir, 'manifest.json'))
  fs.writeFileSync(path.join(abortDir, 'buckets', 'ty_other.0.jsonl'), `${JSON.stringify({ id: 'ex_probe' })}\n`, 'utf8')
  const abortBefore = treeSig(abortDir)
  const abortResult = rollbackProcedure(abortDir, 'rollback-archive-abort')
  const abortAfter = treeSig(abortDir)
  const abortUntouched = diffSig(abortBefore, abortAfter).length === 0
  if (!abortResult.aborted) problems.push('legacy 缺失时回滚没有中止')
  if (!abortUntouched) problems.push('legacy 缺失时回滚改动了文件')

  return makeJudge('R1', '回滚演练', problems.length === 0 ? 'PASS' : 'FAIL',
    problems.length === 0
      ? `恢复 legacy → 归档分片 → 校验读库 全通过（${elapsed} ms，${(result.steps || []).length} 步）；legacy 缺失分支正确中止且未改文件`
      : problems.join('；'),
    {
      elapsedMs: elapsed,
      steps: result.steps || [],
      archive: archiveName,
      fixtures: { syntheticShardFiles: layout.buckets.length },
    })
}

/**
 * 回滚步骤（与 tools/rollback-shard.md 对应）：
 *   1. 确认 exp-lib.legacy.json 存在，否则中止（当前不是分片形态）。
 *   2. 建归档目录，把 buckets/、cold/、manifest.json 移进去（不直接删，便于事后核对/找回）。
 *   3. exp-lib.legacy.json → exp-lib.json。
 * 失败/中止时不移动任何文件。
 */
function rollbackProcedure(dir, archiveName) {
  const legacy = path.join(dir, 'exp-lib.legacy.json')
  if (!fs.existsSync(legacy)) {
    return { aborted: true, reason: 'exp-lib.legacy.json 不存在：当前不是分片形态，无需回滚', steps: [] }
  }
  const archiveDir = path.join(dir, archiveName)
  fs.mkdirSync(archiveDir, { recursive: true })
  const steps = []
  for (const name of ['buckets', 'cold']) {
    const source = path.join(dir, name)
    if (fs.existsSync(source)) {
      fs.renameSync(source, path.join(archiveDir, name))
      steps.push(`归档 ${name}/`)
    }
  }
  const manifest = path.join(dir, 'manifest.json')
  if (fs.existsSync(manifest)) {
    fs.renameSync(manifest, path.join(archiveDir, 'manifest.json'))
    steps.push('归档 manifest.json')
  }
  fs.renameSync(legacy, path.join(dir, 'exp-lib.json'))
  steps.push('exp-lib.legacy.json → exp-lib.json')
  return { aborted: false, steps, archiveDir }
}

// ---------------------------------------------------------------- 基线对比与报告

function loadBaseline(opts) {
  const file = opts.baseline ? path.resolve(opts.baseline) : DEFAULT_BASELINE
  if (!fs.existsSync(file)) return null
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    return { file, data }
  } catch {
    return null
  }
}

function saveBaseline(benchRows, env, fixture) {
  fs.mkdirSync(ACCEPT_ROOT, { recursive: true })
  const rows = benchRows.map((row) => ({
    scale: row.scale,
    records: row.records,
    visible: row.visible,
    fileBytes: row.fileBytes,
    readMinMs: row.read.min,
    readMedMs: row.read.median,
    readCachedMinMs: row.readCached.min,
    readCachedMedMs: row.readCached.median,
    rankMinMs: row.rank.min,
    rankMedMs: row.rank.median,
    writeMinMs: row.write.min,
    writeMedMs: row.write.median,
    writeDirectMinMs: row.writeDirect === null ? null : row.writeDirect.min,
    writeDirectMedMs: row.writeDirect === null ? null : row.writeDirect.median,
    recordFastMinMs: row.recordFast === null ? null : row.recordFast.min,
    recordFastMedMs: row.recordFast === null ? null : row.recordFast.median,
    hintColdMs: row.hintCold.median,
    hintWarmMinMs: row.hintWarm.min,
    hintWarmMedMs: row.hintWarm.median,
  }))
  // 同一 fixture 多次跑基线时保留**历史最优**：并发会话/杀软会把单次中位数抬高 2×，
  // 取多次观测的最小值才是「实现本身」的近似。
  let previous = null
  try {
    previous = JSON.parse(fs.readFileSync(DEFAULT_BASELINE, 'utf8'))
  } catch {
    previous = null
  }
  let runs = 1
  let merged = false
  if (previous && previous.fixture && previous.fixture.sha256 === fixture.sha256 && Array.isArray(previous.bench)) {
    runs = (Number(previous.runs) || 1) + 1
    merged = true
    const best = (current, old) => {
      const value = Number(old)
      return Number.isFinite(value) ? Math.min(current, value) : current
    }
    const byScale = new Map(previous.bench.map((row) => [row.scale, row]))
    for (const row of rows) {
      const old = byScale.get(row.scale)
      if (old === undefined) continue
      row.readMinMs = best(row.readMinMs, old.readMinMs ?? old.readMs)
      row.readMedMs = best(row.readMedMs, old.readMedMs ?? old.readMs)
      row.rankMinMs = best(row.rankMinMs, old.rankMinMs ?? old.rankMs)
      row.rankMedMs = best(row.rankMedMs, old.rankMedMs ?? old.rankMs)
      row.writeMinMs = best(row.writeMinMs, old.writeMinMs ?? old.writeMs)
      row.writeMedMs = best(row.writeMedMs, old.writeMedMs ?? old.writeMs)
      row.hintColdMs = best(row.hintColdMs, old.hintColdMs)
      row.hintWarmMinMs = best(row.hintWarmMinMs, old.hintWarmMinMs ?? old.hintWarmMs)
      row.hintWarmMedMs = best(row.hintWarmMedMs, old.hintWarmMedMs ?? old.hintWarmMs)
    }
  }
  const payload = {
    schema: 2,
    kind: 'single-file-baseline',
    savedAt: new Date().toISOString(),
    runs,
    note: '本机有并发会话/杀软，绝对毫秒会漂移；表内为多次基线运行的历史最优（最小值）。P1 前后对比请用「最小值」的比值。',
    env: { node: env.node, platform: env.platform, cpus: env.cpus, head: env.head, storeSha256: env.storeSha256 },
    fixture: { sha256: fixture.sha256, counts: fixture.hashes.counts },
    bench: rows,
  }
  fs.writeFileSync(DEFAULT_BASELINE, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  return { path: DEFAULT_BASELINE, merged }
}

function compareWithBaseline(benchRows, baseline) {
  if (baseline === null) return null
  const byScale = new Map((baseline.data.bench || []).map((row) => [row.scale, row]))
  return benchRows.map((row) => {
    const base = byScale.get(row.scale)
    if (base === undefined) return { scale: row.scale, missing: true }
    return {
      scale: row.scale,
      // 用最小值比较：并发会话/杀软会让中位数翻倍，最小值更接近实现本身的开销。
      read: { base: base.readMinMs, now: row.read.min, ratio: ratio(row.read.min, base.readMinMs) },
      rank: { base: base.rankMinMs, now: row.rank.min, ratio: ratio(row.rank.min, base.rankMinMs) },
      write: { base: base.writeMinMs, now: row.write.min, ratio: ratio(row.write.min, base.writeMinMs) },
      hintWarm: { base: base.hintWarmMinMs, now: row.hintWarm.min, ratio: ratio(row.hintWarm.min, base.hintWarmMinMs) },
      baselineSavedAt: baseline.data.savedAt,
    }
  })
}

function ratio(now, base) {
  const value = Number(base)
  if (!Number.isFinite(value) || value <= 0) return null
  return Number((Number(now) / value).toFixed(2))
}

function fmtBytes(bytes) {
  const value = Number(bytes) || 0
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(2)} MB`
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${value} B`
}

function mdTable(headers, rows) {
  const escape = (value) => String(value === undefined || value === null ? '' : value).replace(/\|/gu, '\\|').replace(/\r?\n/gu, ' ')
  return [
    `| ${headers.map(escape).join(' | ')} |`,
    `|${headers.map(() => '---').join('|')}|`,
    ...rows.map((row) => `| ${row.map(escape).join(' | ')} |`),
  ].join('\n')
}

function renderMarkdown(result) {
  const { env, fixture, benchRows, judges, rollback, expected, baselineCompare, opts } = result
  const lines = []
  const pass = judges.filter((judge) => judge.status === 'PASS').length
  const fail = judges.filter((judge) => judge.status === 'FAIL').length
  const skip = judges.filter((judge) => judge.status === 'SKIP').length
  const sharded = judges.some((judge) => judge.id === 'J1' && judge.status !== 'SKIP') || result.sharded

  lines.push('# P4 验收台架 · 基线（0.14.0 存储分片）')
  lines.push('')
  lines.push(`- 生成时间：${env.at}`)
  lines.push(`- 仓库：\`${env.mainRepo || env.repo}\` · 分支 \`${env.branch}\` · HEAD \`${env.head}\``)
  if (env.pin) lines.push(`- 运行位置：**只读 pin** \`${env.repo}\`（${env.pin}）`)
  lines.push(`- 工作树（kernel/ui/tools）：${env.dirty ? `**不干净**\n\n\`\`\`\n${env.dirty}\n\`\`\`` : '干净'}`)
  lines.push(`- \`kernel/store.js\` sha256：\`${env.storeSha256}\``)
  lines.push(`- 运行环境：${env.node} · ${env.platform} · ${env.cpus} CPU`)
  lines.push(`- 数据形态：${sharded ? '**分片存储**（manifest.json 已生成）' : '**单文件存储**（exp-lib.json；分片层尚未落地）'}`)
  lines.push('')
  lines.push('## 1 结论')
  lines.push('')
  lines.push('**通过 ' + pass + ' · 跳过 ' + skip + ' · 失败 ' + fail + `**（共 ${judges.length} 条，含回滚演练 R1）`)
  lines.push('')
  lines.push(sharded
    ? '当前阶段是**分片存储**：迁移/幂等/提示段判据已在跑；上界/压缩/写入局部性要等 P2（压缩 + 增量写），冷档要等 P2 的下沉触发。'
    : '当前阶段未落地分片：迁移/上界/守恒/局部性/冷档判据按计划标 SKIP；基线数字用于 P1/P2 后同一脚本自动对比。')
  lines.push('')
  lines.push('## 2 基线耗时（真实库快照 + 平铺放大）')
  lines.push('')
  lines.push('合成方法：1x = 真实库快照原样（`_tmp/fixtures/exp-lib-snapshot.json`）；4x/10x = 同分布平铺，字段原样、id/taskId 加后缀。每项 1 次预热 + ' + String(opts.samples) + ' 次取样，表中为「中位数 / 最小值」（毫秒，含 OS 文件缓存；不是冷启动）。')
  lines.push('')
  lines.push('> 本机同时有另一会话/杀软在跑，绝对毫秒会漂移（同一脚本两次运行可差 2×）。判断性能回退看**最小值**的比值：中位数会放大外部干扰。')
  lines.push('')
  const benchHeaders = ['规模', '记录数', '可见', 'exp-lib.json', 'readStore 中位/最小', 'readStore缓存 中位/最小', 'rankExperiences 中位/最小', 'writeStore(改1条) 中位/最小', '定向写 writeTypeShards 中位/最小', 'exp_record 快路径 中位/最小', '提示段冷', '提示段暖 中位/最小']
  if (baselineCompare !== null) benchHeaders.push('readStore 最小 vs 基线', 'writeStore 最小 vs 基线')
  lines.push(mdTable(benchHeaders, benchRows.map((row) => {
    const values = [
      row.label,
      row.records,
      row.visible,
      fmtBytes(row.fileBytes),
      `${row.read.median} / ${row.read.min} ms`,
      `${row.readCached.median} / ${row.readCached.min} ms`,
      `${row.rank.median} / ${row.rank.min} ms`,
      `${row.write.median} / ${row.write.min} ms`,
      row.writeDirect === null ? '—' : `${row.writeDirect.median} / ${row.writeDirect.min} ms`,
      row.recordFast === null ? '—' : `${row.recordFast.median} / ${row.recordFast.min} ms`,
      `${row.hintCold.median} ms`,
      `${row.hintWarm.median} / ${row.hintWarm.min} ms`,
    ]
    if (baselineCompare !== null) {
      const cmp = baselineCompare.find((item) => item.scale === row.scale)
      if (cmp === undefined || cmp.missing) values.push('无基线', '无基线')
      else {
        values.push(`${cmp.read.base} → ${cmp.read.now} ms（×${cmp.read.ratio}${cmp.read.ratio !== null && cmp.read.ratio > 2 ? ' ⚠ 超 2×' : ''}）`)
        values.push(`${cmp.write.base} → ${cmp.write.now} ms（×${cmp.write.ratio}${cmp.write.ratio !== null && cmp.write.ratio > 2 ? ' ⚠ 超 2×（P2 增量写前预期如此）' : ''}）`)
      }
    }
    return values
  })))
  lines.push('')
  if (baselineCompare !== null) {
    const cmp = baselineCompare[0]
    lines.push(`基线来自 \`${DEFAULT_BASELINE}\`（${cmp.baselineSavedAt || '时间未知'}）。§9 风险处置：\`readStore\` 最小值超基线 2× 即考虑回退。`)
    lines.push('')
  }
  lines.push('`readStore缓存` = 控制台只读路径的 `readStore(dataDir, { cache: true })`（task-7；实现未落地时该参数被忽略，数值与普通 readStore 相同）。写路径（tools.js / exp_record / exp_feedback）**禁止**传 cache。')
  lines.push('')
  lines.push('`定向写 writeTypeShards` = `exp_recall` 写回路径；`exp_record` 快路径是 `recordShardWrite`（定向写 + 压缩触发）。**`writeStore` / `writeTypeShards` / `exp_record 快路径` 三列要并排看相对关系**，不要把任一列单独当记录成本；记录路径绝对值以 task-9 复验为准，报告不写死目标值。')
  lines.push('提示段冷/暖：冷 = 新目录首次渲染（模块缓存 miss，含一次 readStore）；暖 = 同目录再渲染（P0 缓存命中）。基目录不含 \`skills/\`，故不含技能目录扫描成本（P0 已单独缓存，与分片无关）。')
  lines.push('')
  lines.push('## 3 验收判据（§8 的 9 条 + 回滚演练）')
  lines.push('')
  lines.push(mdTable(['#', '判据', '状态', '证据 / 说明'], judges.map((judge) => [
    judge.id,
    judge.name,
    `${STATUS_ICON[judge.status] || ''} ${judge.status}`,
    judge.detail,
  ])))
  lines.push('')
  if (fail > 0) {
    lines.push('> 有失败项。若分片层刚落地，J3/J5 失败通常意味着 P2（压缩 / 增量写）还没做；先看每一行的「证据」再决定是否回退。')
    lines.push('')
  }

  lines.push('## 4 库规模与类型分布（golden fixture）')
  lines.push('')
  lines.push(`- fixture：\`${fixture.path}\`（${fmtBytes(fixture.bytesLength)}，sha256 \`${fixture.sha256}\`${fixture.regenerated ? '，本次首次生成' : '，沿用已有副本'}）`)
  lines.push(`- 记录 ${fixture.hashes.counts.records} 条 / 可见 ${fixture.hashes.counts.visible} 条 / 类型 ${fixture.hashes.counts.types} 个 / pending ${fixture.hashes.counts.pending} 条`)
  lines.push(`- 下表按**全部 ${fixture.hashes.counts.records} 条**统计（含墓碑/被取代，分片要落盘的正是这些），单行 JSON 字节 ≈ 分片里的实际行宽`)
  lines.push('')
  const byType = new Map()
  for (const record of fixture.data.experiences || []) {
    const typeId = String(record.typeId || 'ty_other')
    if (!byType.has(typeId)) byType.set(typeId, { count: 0, bytes: 0 })
    const bucket = byType.get(typeId)
    bucket.count += 1
    bucket.bytes += Buffer.byteLength(JSON.stringify(record), 'utf8')
  }
  const typeNames = new Map((fixture.data.types || []).map((type) => [String(type.id), String(type.name)]))
  const total = fixture.hashes.counts.records || 1
  const typeRows = [...byType.entries()]
    .sort((left, right) => right[1].count - left[1].count)
    .map(([typeId, bucket]) => [typeNames.get(typeId) || typeId, typeId, bucket.count, `${((bucket.count / total) * 100).toFixed(1)}%`, fmtBytes(bucket.bytes)])
  lines.push(mdTable(['类型', 'typeId', '条数', '占比', '单行 JSON 字节'], typeRows))
  lines.push('')

  lines.push('## 5 golden fixture 与逐字段哈希')
  lines.push('')
  lines.push(`- 哈希清单：\`${fixture.hashesPath}\`（sha256 与 fixture 字节一致${fixture.hashMatch === false ? '；**本次已重写**' : ''}）`)
  lines.push(`- 全量记录哈希：\`${fixture.hashes.allRecordsSha256}\``)
  lines.push(`- 可见记录哈希：\`${fixture.hashes.visibleRecordsSha256}\``)
  lines.push(`- 类型哈希：\`${fixture.hashes.typesSha256}\``)
  lines.push('')
  lines.push(mdTable(['字段', 'sha256'], Object.entries(fixture.hashes.fields).map(([field, hash]) => [`\`${field}\``, `\`${hash}\``])))
  lines.push('')
  lines.push('P1 迁移后，同一份数据的 `visibleExperiences` 逐字段哈希必须与上表一致（`kernel/tests/shard-accept.test.mjs` / 本脚本 J1 会断言）。')
  lines.push('')

  lines.push('## 6 提示段 golden（J6）')
  lines.push('')
  lines.push(`- 期望文件：\`${expected.path}\`（${expected.created ? '本次录制' : '沿用已有'}；数据集 sha256 \`${expected.expected.dataSha256}\`）`)
  lines.push(`- slim(1400) sha256：\`${expected.expected.slimSha256}\``)
  lines.push(`- full(4000) sha256：\`${expected.expected.fullSha256}\``)
  lines.push('')
  lines.push('P1 之后，分片库渲染的提示段必须与 golden 逐字符相等（J6 自动比对）。')
  lines.push('')

  lines.push('## 7 回滚演练')
  lines.push('')
  lines.push(`步骤与命令见 [tools/rollback-shard.md](./rollback-shard.md)。本次演练在 \`_tmp\` 副本上实际执行了：`)
  lines.push('')
  lines.push(`1. 造「已迁移」形态（legacy + manifest + ${(rollback.fixtures && rollback.fixtures.syntheticShardFiles) || '若干'} 个合成分片 + cold）；`)
  lines.push(`2. 归档 \`buckets/\`、\`cold/\`、\`manifest.json\` → \`${rollback.archive || 'rollback-archive-*'}/\`；`)
  lines.push(`3. \`exp-lib.legacy.json\` → \`exp-lib.json\`；`)
  lines.push(`4. 校验恢复后的库可读、条数正确；`)
  lines.push(`5. 另造一个没有 legacy 的目录，确认回滚会中止且不改任何文件。`)
  lines.push('')
  lines.push(`结果：**${rollback.status}** · ${rollback.detail}`)
  lines.push('')
  lines.push('注意：回滚 = **回到迁移时刻**。迁移之后新写/改的记录只在 `buckets/` 里，归档后不会自动并回旧库；要保留这部分数据，先导出（P2 后提供）或人工合并。`cold/` 里的下沉记录同理。')
  lines.push('')

  lines.push('## 8 复现')
  lines.push('')
  lines.push('```powershell')
  lines.push('# 基线（单文件存储，今天就能跑）')
  lines.push('node tools/accept-shard.mjs --out=tools/accept-baseline-2026-11-12.md')
  lines.push('')
  lines.push('# P1/P2 落地后：同一脚本自动改跑真判据，并与本次基线对比')
  lines.push('node tools/accept-shard.mjs --out=_tmp/accept-shard/p1-report.md')
  lines.push('')
  lines.push('# 全量回归（逐文件，约 1-2 分钟）')
  lines.push('node tools/accept-shard.mjs --regression=all --out=_tmp/accept-shard/regression.md')
  lines.push('```')
  lines.push('')
  lines.push('## 9 未验项 / 风险')
  lines.push('')
  lines.push('- **单文件上界/压缩未实测**：当前单文件存储只证明基线；3×N_MAX 的桶/冷档上界要 P2 压缩落地后由 J3/J4 检验（本脚本已备好 heavy 数据路径）。')
  lines.push('- **真机双设备并发**：J7 只在 `_tmp` 里造了合成分片布局验证「不同文件/不同行可自动合并」；真实 `.exp` 双设备冲突率仍未测。manifest 已按 D1 定位为可重建缓存（不含 updated_at），冲突取任一边即可，不入手工解冲突流程。')
  lines.push('- **回归结论受并发会话影响**：若另一会话正在改 `kernel/store.js`，J8 在运行时刻可能读到中间态；报告头部的「工作树」与 store.js sha256 是判定依据。')
  lines.push('- **提示段耗时未设硬阈值**：§8.6 只记录不判红，避免环境抖动假红。')
  lines.push('')
  return `${lines.join('\n')}\n`
}

// ---------------------------------------------------------------- 入口

function pruneRuns(keep, current) {
  const root = path.join(ACCEPT_ROOT, 'runs')
  let entries = []
  try {
    entries = fs.readdirSync(root).sort()
  } catch {
    return
  }
  const stale = entries.filter((name) => path.join(root, name) !== current).slice(0, Math.max(0, entries.length - keep))
  for (const name of stale) {
    try {
      fs.rmSync(path.join(root, name), { recursive: true, force: true })
    } catch {
      // 目录被占用就留到下次；不影响结论
    }
  }
}

function printSummary(result) {
  const { judges, benchRows, env } = result
  const pass = judges.filter((judge) => judge.status === 'PASS').length
  const fail = judges.filter((judge) => judge.status === 'FAIL').length
  const skip = judges.filter((judge) => judge.status === 'SKIP').length
  console.log('')
  console.log(`P4 验收台架 @ ${env.head || '?'}（${env.node} / ${env.platform}）`)
  console.log('判据：' + judges.map((judge) => `${judge.id} ${STATUS_ICON[judge.status] || judge.status}`).join('  '))
  console.log(`合计：通过 ${pass} · 跳过 ${skip} · 失败 ${fail}`)
  console.log('')
  console.log('规模   记录   可见   文件       readStore中位/最小  read缓存中位/最小  rank中位/最小     writeStore中位/最小  writeTypeShards中位/最小  exp_record快路径中位/最小  提示冷    提示暖')
  for (const row of benchRows) {
    const pad = (value, width) => String(value).padEnd(width)
    console.log([
      pad(row.label, 5), pad(row.records, 6), pad(row.visible, 5), pad(fmtBytes(row.fileBytes), 9),
      pad(`${row.read.median}/${row.read.min}ms`, 19), pad(`${row.readCached.median}/${row.readCached.min}ms`, 19),
      pad(`${row.rank.median}/${row.rank.min}ms`, 17), pad(`${row.write.median}/${row.write.min}ms`, 17),
      pad(row.writeDirect === null ? '—' : `${row.writeDirect.median}/${row.writeDirect.min}ms`, 17),
      pad(row.recordFast === null ? '—' : `${row.recordFast.median}/${row.recordFast.min}ms`, 17),
      pad(`${row.hintCold.median}ms`, 9), pad(`${row.hintWarm.median}/${row.hintWarm.min}ms`, 8),
    ].join(' '))
  }
  for (const judge of judges) {
    if (judge.status !== 'PASS') console.log(`${STATUS_ICON[judge.status] || ''} ${judge.id} ${judge.name}：${judge.detail}`)
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    console.log(USAGE)
    return
  }
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
  const runDir = path.join(ACCEPT_ROOT, 'runs', stamp)
  fs.mkdirSync(runDir, { recursive: true })
  const startedAt = Date.now()

  const env = collectEnv()
  const fixture = ensureFixture(opts)
  const expected = ensureExpectedHints(fixture, runDir)
  const benchRows = runBaseline(fixture, runDir, opts)

  const ctx = prepareJudges(fixture, runDir)
  ctx.fixture = fixture
  ctx.rawSha = fixture.sha256

  const judges = []
  judges.push(runJudge(() => judgeMigration(ctx)))
  judges.push(runJudge(() => judgeIdempotent(ctx)))
  const heavy = ctx.sharded ? prepareHeavy(ctx, opts, runDir) : null
  judges.push(runJudge(() => judgeBounds(ctx, heavy)))
  judges.push(runJudge(() => judgeConservation(ctx, heavy)))
  judges.push(runJudge(() => judgeWriteLocality(ctx, runDir)))
  judges.push(runJudge(() => judgeHintEquivalence(ctx, expected)))
  judges.push(runJudge(() => judgeGitMerge(ctx, runDir, opts)))
  judges.push(runJudge(() => judgeRegression(REPO, opts.regression)))
  judges.push(runJudge(() => judgeCold(ctx, heavy)))
  let rollback = null
  try {
    rollback = runRollbackRehearsal(ctx, runDir)
  } catch (error) {
    rollback = makeJudge('R1', '回滚演练', 'FAIL', `演练抛错：${error && error.message ? error.message : error}`)
  }
  judges.push(rollback)

  // 基线对比：单文件模式保存基线；分片模式读取基线。
  const baseline = ctx.sharded ? loadBaseline(opts) : null
  const baselineCompare = ctx.sharded ? compareWithBaseline(benchRows, baseline) : null
  if (!ctx.sharded) saveBaseline(benchRows, env, fixture)

  const result = {
    schema: 1,
    kind: ctx.sharded ? 'sharded' : 'single-file',
    sharded: ctx.sharded,
    runDir,
    env,
    fixture,
    expected,
    benchRows,
    judges,
    rollback,
    baselineCompare,
    elapsedSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
    opts,
  }

  const report = renderMarkdown(result)
  const outPath = opts.out ? path.resolve(process.cwd(), opts.out) : null
  if (outPath !== null) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    fs.writeFileSync(outPath, report, 'utf8')
  }
  if (opts.jsonPath) {
    const jsonPath = path.resolve(process.cwd(), opts.jsonPath)
    fs.mkdirSync(path.dirname(jsonPath), { recursive: true })
    // 只写机器可读部分：不把 462 KB 的 fixture 正文或 golden 提示段全文塞进 JSON。
    const slim = {
      ...result,
      fixture: {
        path: result.fixture.path,
        sha256: result.fixture.sha256,
        bytesLength: result.fixture.bytesLength,
        regenerated: result.fixture.regenerated,
        hashMatch: result.fixture.hashMatch,
        source: result.fixture.source,
        hashes: result.fixture.hashes,
      },
      expected: {
        created: result.expected.created,
        dataSha256: result.expected.expected.dataSha256,
        slimSha256: result.expected.expected.slimSha256,
        fullSha256: result.expected.expected.fullSha256,
      },
      opts: undefined,
    }
    fs.writeFileSync(jsonPath, `${JSON.stringify(slim, null, 2)}\n`, 'utf8')
  }
  pruneRuns(opts.keepRuns, runDir)
  printSummary(result)
  if (outPath !== null) console.log(`\n报告：${outPath}`)
  if (opts.jsonPath) console.log(`JSON：${path.resolve(process.cwd(), opts.jsonPath)}`)

  const failed = judges.filter((judge) => judge.status === 'FAIL').length
  process.exitCode = failed > 0 ? 1 : 0
}

main().catch((error) => {
  console.error(`验收台架失败：${error && error.stack ? error.stack : error}`)
  process.exitCode = 2
})
