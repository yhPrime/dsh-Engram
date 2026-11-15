#!/usr/bin/env node
/**
 * 标签迁移 v2（0.20 P1 · 标签分类与召回治理）
 *
 * 把历史数据里的「实例名/旧别名」标签归一成规范词，**只改 context，不改 intent / action / note / 正文**。
 *
 * 规则来自 `kernel/tag-registry.js`（与运行时同一份）：
 *   DSH-Engram / dsh 插件 / 经验库插件 → DSH插件
 *   EigenFlux（eigenflux）              → 智能体平台
 *   交友 → 社交；生意 → 交易；研学/研学活动 → 研学课；ppt → PPT …
 *   非法标签（>12 字、含标点、像句子、版本号、路径…）：默认**保留原文并计数**（--unknown=keep），
 *   显式 `--unknown=drop` 才丢弃。默认不丢数据。
 *
 * 用法：
 *   node tools/migrate-tags-v2.mjs                          # dry-run（默认，只读）
 *   node tools/migrate-tags-v2.mjs --data D:/x/.exp          # 指定数据根
 *   node tools/migrate-tags-v2.mjs --apply                   # 先备份整个 .exp，再写盘
 *   node tools/migrate-tags-v2.mjs --json                    # 机器可读报告（stdout）
 *   node tools/migrate-tags-v2.mjs --unknown=drop            # 非法标签丢弃（默认 keep）
 *   node tools/migrate-tags-v2.mjs --limit=50                # 报告里逐条明细的上限（默认 20）
 *
 * 安全：
 *   - dry-run 纯只读：直接读 manifest + 分片，**不走 readStore**（readStore 在条数不符时会自愈回写）。
 *   - --apply 先整包备份到同级 `<.exp>.bak-tags-<时间戳>/`（跳过 .locks / .cache / *.tmp）。
 *   - --apply 写后自动复算一遍：若仍有变更就报错退出（说明规则不幂等）。
 *   - 分片条数与 manifest 声明不符、或没有 manifest（旧单文件库）时**拒绝写入**，只报告。
 *
 * 退出码：0 正常（含「无需变更」）；1 环境/数据错误；2 参数错误。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { canonicalTag, writeStore } from '../kernel/store.js'
import { TAG_MAX_COUNT, facetOf } from '../kernel/tag-registry.js'
import { readManifestFile, readShardRecords } from '../kernel/shard-store.js'
import { resolveEngramDataDir } from '../kernel/settings.js'

/** 备份目录后缀（同一父目录下，带时间戳）。 */
export const BACKUP_PREFIX = '.bak-tags-'

/** 备份时跳过的临时目录/文件：锁与读缓存不属于数据，还原它们反而会卡住活着的进程。 */
const BACKUP_SKIP = new Set(['.locks', '.cache'])
const BACKUP_SKIP_SUFFIX = ['.tmp']

/** 命令行帮助。 */
export const USAGE = `标签迁移 v2（dry-run 默认）

  node tools/migrate-tags-v2.mjs [选项]

  --data <dir>       数据根（默认取 settings.currentRoot 或 $DSH_HOME/.exp）
  --apply            真写盘（先自动备份；不加就是只读 dry-run）
  --unknown=keep|drop  非法标签怎么处理（默认 keep：保留原文，只计数）
  --limit=<n>        报告里逐条明细条数上限（默认 20）
  --json             输出 JSON 报告
  --quiet            只打印最终结论行
`

/**
 * 单个标签的迁移去向。
 * @returns {{kind: 'kept'|'renamed'|'invalid'|'dropped', from: string, to: string, reason: string}}
 */
export function planTagOf(raw) {
  const from = String(raw === undefined || raw === null ? '' : raw).replace(/\s+/g, ' ').trim()
  if (from === '') return { kind: 'dropped', from, to: '', reason: '空标签' }
  const canonical = canonicalTag(from)
  if (canonical === null) return { kind: 'invalid', from, to: from, reason: '不合规（会被丢弃或保留原文）' }
  if (canonical !== from) return { kind: 'renamed', from, to: canonical, reason: '别名/大小写归一' }
  return { kind: 'kept', from, to: canonical, reason: '' }
}

/**
 * 一行记录的标签计划（纯函数，不写盘）。
 * @param {object} row
 * @param {{unknown?: 'keep'|'drop'}} options
 */
export function planRowOf(row, options = {}) {
  const unknown = options.unknown === 'drop' ? 'drop' : 'keep'
  const raw = row === null || row === undefined ? undefined : row.context
  if (raw === undefined || raw === null) return null // 没有标签字段：不碰
  // 结构化 context（对象/数字/布尔）不能被 String() 成 "[object Object]"。
  // 迁移只处理字符串或字符串数组；遇到其它形状直接隔离并拒绝写盘。
  if (!Array.isArray(raw) && typeof raw !== 'string') {
    return { before: [], after: [], changed: false, shapeUnsupported: true, shapeFixed: false, renames: [], invalid: [], dropped: [], keptInvalid: [], deduped: 0, overflow: 0 }
  }
  const before = Array.isArray(raw) ? raw.slice() : [raw]
  const shapeFixed = !Array.isArray(raw)
  const tags = []
  const renames = []
  const invalid = []
  const dropped = []
  const keptInvalid = []
  let deduped = 0
  let overflow = 0
  for (const item of before) {
    const planned = planTagOf(item)
    if (planned.kind === 'invalid') {
      if (unknown === 'drop') {
        dropped.push({ value: planned.from, reason: planned.reason })
        continue
      }
      // keep：原文保留（不因迁移丢数据），但计入 invalid 让报告能看见
      invalid.push({ value: planned.from })
      if (!tags.some((existing) => existing.toLowerCase() === planned.from.toLowerCase())) tags.push(planned.from)
      else deduped += 1
      continue
    }
    if (planned.kind === 'dropped') {
      dropped.push({ value: planned.from, reason: planned.reason })
      continue
    }
    if (planned.kind === 'renamed') renames.push({ from: planned.from, to: planned.to })
    if (tags.some((existing) => existing.toLowerCase() === planned.to.toLowerCase())) {
      deduped += 1
      continue
    }
    tags.push(planned.to)
  }
  if (tags.length > TAG_MAX_COUNT) {
    overflow = tags.length - TAG_MAX_COUNT
    tags.length = TAG_MAX_COUNT
  }
  const changed = shapeFixed || tags.length !== before.length || tags.some((tag, index) => tag !== before[index])
  return { before, after: tags, changed, shapeFixed, renames, invalid, dropped, keptInvalid, deduped, overflow }
}

/**
 * 读分片库（**纯读**：不走 readStore，避免条数不符时自愈回写）。
 * @returns {{manifest: object|null, rows: object[]|null, declaredCount: number, mismatch: boolean, legacy: boolean}}
 */
export function readShardsReadOnly(dataDir) {
  const manifest = readManifestFile(dataDir)
  if (manifest === null || manifest === undefined) {
    const legacyExists = fs.existsSync(path.join(dataDir, 'exp-lib.json'))
    return { manifest: null, rows: null, declaredCount: 0, mismatch: false, legacy: legacyExists }
  }
  const rows = readShardRecords(dataDir, manifest)
  const declaredCount = (Array.isArray(manifest.buckets) ? manifest.buckets : []).reduce((sum, bucket) => sum + (Number(bucket && bucket.count) || 0), 0)
  return { manifest, rows, declaredCount, mismatch: declaredCount !== rows.length, legacy: false }
}

/** 备份整个数据根（跳过锁/缓存/临时文件），返回备份路径。 */
export function backupDataDir(dataDir) {
  const resolved = path.resolve(String(dataDir || ''))
  const parent = path.dirname(resolved)
  const base = path.basename(resolved)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = path.join(parent, `${base}${BACKUP_PREFIX}${stamp}`)
  let index = 1
  let finalTarget = target
  while (fs.existsSync(finalTarget)) {
    finalTarget = `${target}-${index}`
    index += 1
  }
  fs.cpSync(resolved, finalTarget, {
    recursive: true,
    filter: (source) => {
      const name = path.basename(source)
      if (BACKUP_SKIP.has(name)) return false
      if (BACKUP_SKIP_SUFFIX.some((suffix) => name.endsWith(suffix))) return false
      return true
    },
  })
  return finalTarget
}

/** 写前预检：数据根和每个分片都可写，避免写到一半才 EPERM 留下部分迁移。 */
function assertWritableLayout(dataDir, manifest) {
  fs.accessSync(dataDir, fs.constants.W_OK)
  const manifestFile = path.join(dataDir, 'manifest.json')
  if (fs.existsSync(manifestFile)) fs.accessSync(manifestFile, fs.constants.W_OK)
  for (const bucket of Array.isArray(manifest.buckets) ? manifest.buckets : []) {
    const file = path.join(dataDir, String(bucket.file || ''))
    if (fs.existsSync(file)) fs.accessSync(file, fs.constants.W_OK)
  }
}

/** 汇总一个计划的统计（纯函数）。 */
function summarizePlans(plans, options = {}) {
  const renames = new Map()
  const invalid = new Map()
  const dropped = new Map()
  let changedRows = 0
  let unchangedRows = 0
  let tagsBefore = 0
  let tagsAfter = 0
  let deduped = 0
  let overflow = 0
  let shapeFixed = 0
  let shapeUnsupported = 0
  const shapeUnsupportedRows = []
  let missingObject = 0
  let missingAction = 0
  const changes = []
  for (const { row, plan } of plans) {
    if (plan === null) continue
    if (plan.shapeUnsupported) {
      shapeUnsupported += 1
      shapeUnsupportedRows.push({ id: String(row && row.id || ''), reason: 'context 不是字符串数组' })
      continue
    }
    tagsBefore += plan.before.length
    tagsAfter += plan.after.length
    deduped += plan.deduped
    overflow += plan.overflow
    if (plan.shapeFixed) shapeFixed += 1
    for (const item of plan.renames) renames.set(`${item.from} → ${item.to}`, (renames.get(`${item.from} → ${item.to}`) || 0) + 1)
    for (const item of plan.invalid) invalid.set(item.value, (invalid.get(item.value) || 0) + 1)
    for (const item of plan.dropped) dropped.set(item.value, (dropped.get(item.value) || 0) + 1)
    if (plan.changed) {
      changedRows += 1
      // 面缺口：改完仍然没有对象/动作（只提示，不补标签——迁移不造词）
      const facets = new Set(plan.after.map((tag) => (facetOf(tag) === null ? '' : facetOf(tag))))
      if (!facets.has('object')) missingObject += 1
      if (!facets.has('action')) missingAction += 1
      changes.push({ id: String(row && row.id || ''), intent: String(row && row.intent || '').slice(0, 60), before: plan.before, after: plan.after })
    } else {
      unchangedRows += 1
    }
  }
  const limit = Math.max(0, Math.trunc(Number(options.limit) || 20))
  return {
    changedRows,
    unchangedRows,
    tagsBefore,
    tagsAfter,
    deduped,
    overflow,
    shapeFixed,
    shapeUnsupported,
    shapeUnsupportedRows,
    facetGaps: { missingObject, missingAction },
    renames: [...renames.entries()].map(([pair, count]) => {
      const [from, to] = pair.split(' → ')
      return { from, to, count }
    }).sort((left, right) => right.count - left.count || left.from.localeCompare(right.from, 'zh')),
    invalid: [...invalid.entries()].map(([value, count]) => ({ value, count })).sort((left, right) => right.count - left.count),
    dropped: [...dropped.entries()].map(([value, count]) => ({ value, count })).sort((left, right) => right.count - left.count),
    changes: changes.slice(0, limit),
    changesTotal: changes.length,
  }
}

/**
 * 跑一次迁移（默认 dry-run）。返回报告对象；写盘只在 apply=true 时发生。
 * @param {{dataDir?: string, apply?: boolean, unknown?: 'keep'|'drop', limit?: number, now?: Date}} options
 */
export function runMigration(options = {}) {
  const dataDir = path.resolve(String(options.dataDir || resolveEngramDataDir()))
  const apply = options.apply === true
  const unknown = options.unknown === 'drop' ? 'drop' : 'keep'
  const report = {
    tool: 'migrate-tags-v2',
    version: 1,
    mode: apply ? 'apply' : 'dry-run',
    generatedAt: (options.now instanceof Date ? options.now : new Date()).toISOString(),
    dataDir,
    unknown,
    ok: true,
    error: '',
    totals: { rows: 0, rowsWithContext: 0, declaredCount: 0 },
    backup: '',
    counts: null,
    changes: [],
    changesTotal: 0,
    reapplied: null,
    skipped: { cold: '未读取（归档只读，迁移不碰）', legacy: '' },
  }
  if (!fs.existsSync(dataDir)) {
    return { ...report, ok: false, error: `数据目录不存在：${dataDir}` }
  }
  let loaded
  try {
    loaded = readShardsReadOnly(dataDir)
  } catch (error) {
    // 分片坏/缺失/条数不符都在 readShardRecords 里抛：dry-run 要报告，不能崩。
    return { ...report, ok: false, error: `读分片失败（原样报告，不写盘）：${error && error.message ? error.message : String(error)}` }
  }
  if (loaded.legacy === true) {
    return { ...report, ok: false, error: `这是旧单文件库（exp-lib.json，无 manifest）：先用 0.14+ 启动一次让它迁移成分片布局，再跑标签迁移` }
  }
  if (loaded.manifest === null) {
    return { ...report, ok: false, error: `没有 manifest.json，也不是旧单文件库：${dataDir}` }
  }
  if (loaded.mismatch) {
    return {
      ...report,
      ok: false,
      error: `分片条数（${loaded.rows.length}）与 manifest 声明（${loaded.declaredCount}）不一致，拒绝迁移（避免写回时丢数据）`,
    }
  }
  const rows = loaded.rows
  const plans = rows.map((row) => ({ row, plan: planRowOf(row, { unknown }) }))
  const summary = summarizePlans(plans, { limit: options.limit })
  const totals = {
    rows: rows.length,
    rowsWithContext: plans.filter((item) => item.plan !== null).length,
    declaredCount: loaded.declaredCount,
  }
  const base = { ...report, ok: true, totals, counts: summary, changes: summary.changes, changesTotal: summary.changesTotal }
  if (summary.shapeUnsupported > 0) {
    const ids = summary.shapeUnsupportedRows.slice(0, 5).map((item) => item.id).filter(Boolean).join(', ')
    return { ...base, ok: false, applied: false, error: `发现 ${summary.shapeUnsupported} 条 context 不是字符串数组；为避免把结构化数据写成 "[object Object]"，拒绝写盘${ids === '' ? '' : `（前几条：${ids}）`}` }
  }
  if (summary.changedRows === 0) {
    // 幂等：没有可改的就什么都不写（连备份也不需要）。
    return { ...base, applied: false, note: '没有需要变更的标签（幂等）' }
  }
  if (!apply) {
    return { ...base, applied: false, note: 'dry-run：没有写盘（加 --apply 才会写）' }
  }
  // ---- 以下只在 --apply 时执行 ----
  const backup = backupDataDir(dataDir)
  report.backup = backup
  if (!fs.existsSync(backup)) {
    return { ...report, ok: false, applied: false, error: `备份失败（目录不存在）：${backup}` }
  }
  // 备份后重新读一遍：避免「读到旧的、写到新的」覆盖期间别人的写入。
  let fresh
  try {
    fresh = readShardsReadOnly(dataDir)
  } catch (error) {
    return { ...report, ok: false, applied: false, backup, error: `备份后重读失败，已中止（未写盘）：${error && error.message ? error.message : String(error)}` }
  }
  if (fresh.manifest === null || fresh.mismatch) {
    return { ...report, ok: false, applied: false, backup, error: '备份后重读发现分片不一致，已中止（未写盘）' }
  }
  const freshPlans = fresh.rows.map((row) => ({ row, plan: planRowOf(row, { unknown }) }))
  const freshSummary = summarizePlans(freshPlans, { limit: options.limit })
  if (freshSummary.changedRows === 0) {
    return { ...base, applied: false, backup, note: '备份后复算已无变更（别人先一步迁移过），未写盘' }
  }
  const nextRows = fresh.rows.map((row, index) => {
    const plan = freshPlans[index].plan
    if (plan === null || !plan.changed) return row
    // 只改 context，其余字段原样带过去（浅拷贝 + 只覆盖 context）。
    return { ...row, context: plan.after }
  })
  try {
    assertWritableLayout(dataDir, fresh.manifest)
  } catch (error) {
    return { ...base, ok: false, applied: false, backup, partial: false, error: `写盘前检查失败（未写盘）：${error && error.message ? error.message : String(error)}；备份：${backup}` }
  }
  try {
    writeStore(dataDir, { version: fresh.manifest.version, types: fresh.manifest.types, experiences: nextRows })
  } catch (error) {
    return { ...base, ok: false, applied: false, backup, partial: true, error: `写盘中途失败（可能部分写入）：${error && error.message ? error.message : String(error)}；备份：${backup}` }
  }
  // 写后复算：仍然有变更 = 规则不幂等，必须报错（不能装作成功）。
  const after = summarizePlans(readShardsReadOnly(dataDir).rows.map((row) => ({ row, plan: planRowOf(row, { unknown }) })), { limit: 0 })
  return {
    ...base,
    applied: true,
    backup,
    reapplied: { changedRows: after.changedRows, tagsBefore: after.tagsBefore, tagsAfter: after.tagsAfter },
    ok: after.changedRows === 0,
    error: after.changedRows === 0 ? '' : `写后复算仍有 ${after.changedRows} 条变更（规则不幂等，请检查词表）`,
  }
}

/** 人读报告。 */
export function formatReport(report) {
  const lines = []
  lines.push(`标签迁移 v2 · ${report.mode === 'apply' ? '写盘（apply）' : '只读（dry-run）'}`)
  lines.push(`数据目录：${report.dataDir}`)
  if (!report.ok) {
    lines.push(`失败：${report.error}`)
    if (report.counts) {
      lines.push(`变更 ${report.counts.changedRows} 条；结构不支持 ${report.counts.shapeUnsupported || 0} 条`)
      for (const item of (report.counts.shapeUnsupportedRows || []).slice(0, 5)) lines.push(`  ${item.id}  ${item.reason}`)
    }
    return lines.join('\n')
  }
  const totals = report.totals || {}
  const counts = report.counts || {}
  lines.push(`记录：${totals.rows} 条（manifest 声明 ${totals.declaredCount}），带标签字段 ${totals.rowsWithContext} 条`)
  lines.push(`变更：${counts.changedRows} 条 / 未变更 ${counts.unchangedRows} 条；标签数 ${counts.tagsBefore} → ${counts.tagsAfter}`)
  if (counts.renames.length > 0) {
    lines.push('别名归一：')
    for (const item of counts.renames) lines.push(`  ${item.from} → ${item.to}  ×${item.count}`)
  }
  if (counts.invalid.length > 0) {
    lines.push(`非法标签（${report.unknown === 'drop' ? '已丢弃' : '保留原文'}）：`)
    for (const item of counts.invalid) lines.push(`  ${item.value}  ×${item.count}`)
  }
  if (counts.dropped.length > 0) {
    lines.push('被丢弃（空/超限/非法）：')
    for (const item of counts.dropped) lines.push(`  ${item.value || '(空)'}  ×${item.count}`)
  }
  if (counts.deduped > 0) lines.push(`去重：${counts.deduped} 个重复标签`)
  if (counts.overflow > 0) lines.push(`超上限（>${TAG_MAX_COUNT}）被截：${counts.overflow} 个`)
  if (counts.shapeFixed > 0) lines.push(`结构修正（context 不是数组）：${counts.shapeFixed} 条`)
  if (counts.shapeUnsupported > 0) lines.push(`结构不支持（context 不是字符串数组，拒绝写盘）：${counts.shapeUnsupported} 条`)
  lines.push(`面缺口（迁移不补标签）：缺对象 ${counts.facetGaps.missingObject} 条 / 缺动作 ${counts.facetGaps.missingAction} 条`)
  if (report.changesTotal > 0) {
    lines.push(`明细（前 ${report.changes.length} / 共 ${report.changesTotal} 条）：`)
    for (const item of report.changes) lines.push(`  ${item.id}  [${item.before.join('、')}] → [${item.after.join('、')}]  ${item.intent}`)
  }
  if (report.backup !== '') lines.push(`备份：${report.backup}`)
  if (report.applied === true) {
    lines.push(`写后复算：剩 ${report.reapplied ? report.reapplied.changedRows : '?'} 条变更（0 = 幂等）`)
  }
  if (report.note) lines.push(report.note)
  lines.push(report.skipped.legacy ? `旧单文件库：${report.skipped.legacy}` : `冷档：${report.skipped.cold}`)
  return lines.join('\n')
}

/** 解析 argv（保持极简，坏参数返回 error）。 */
export function parseArgs(argv = []) {
  const options = { dataDir: '', apply: false, unknown: 'keep', limit: 20, json: false, quiet: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--apply') { options.apply = true; continue }
    if (arg === '--json') { options.json = true; continue }
    if (arg === '--quiet') { options.quiet = true; continue }
    if (arg === '--help' || arg === '-h') return { help: true, options }
    if (arg.startsWith('--data=')) { options.dataDir = arg.slice('--data='.length); continue }
    if (arg === '--data') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) return { error: '--data 需要目录参数（--data <dir> 或 --data=<dir>）', options }
      options.dataDir = value
      index += 1
      continue
    }
    if (arg.startsWith('--unknown=')) {
      const value = arg.slice('--unknown='.length)
      if (value !== 'keep' && value !== 'drop') return { error: `--unknown 只能是 keep 或 drop，收到 ${value}`, options }
      options.unknown = value
      continue
    }
    if (arg.startsWith('--limit=')) {
      const value = Math.trunc(Number(arg.slice('--limit='.length)))
      if (!Number.isFinite(value) || value < 0) return { error: `--limit 需要非负整数`, options }
      options.limit = value
      continue
    }
    return { error: `不认识的参数：${arg}`, options }
  }
  return { options }
}

/** CLI 入口。 */
export function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv)
  if (parsed.help === true) {
    process.stdout.write(USAGE)
    return 0
  }
  if (parsed.error) {
    process.stderr.write(`${parsed.error}\n\n${USAGE}`)
    return 2
  }
  const report = runMigration(parsed.options)
  if (parsed.options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  else if (parsed.options.quiet) process.stdout.write(`${report.ok ? (report.mode === 'apply' ? 'apply' : 'dry-run') : 'FAILED'}：变更 ${report.counts ? report.counts.changedRows : 0} 条${report.backup ? ` · 备份 ${report.backup}` : ''}${report.ok ? '' : ` · ${report.error}`}\n`)
  else process.stdout.write(`${formatReport(report)}\n`)
  return report.ok ? 0 : 1
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (invokedDirectly) process.exitCode = main()
