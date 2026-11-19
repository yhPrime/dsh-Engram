#!/usr/bin/env node
/**
 * 0.33 迁移：把旧分族布局 `library/<typeId>/<族>.jsonl` 压成单层 `library/<族>.jsonl`。
 *
 * 用法：
 *   node tools/flatten-types.mjs --data-dir <dir> [--dry-run]
 *   node tools/flatten-types.mjs --data-dir <dir> --apply
 *
 * 安全：默认 dry-run；--apply 前整库备份；迁移后校验行数不变、族数不变、再跑幂等。
 */
import fs from 'node:fs'
import path from 'node:path'

import { readStore, writeStore } from '../kernel/store.js'
import { readManifestFile, writeManifest } from '../kernel/shard-store.js'

const args = process.argv.slice(2)
const index = args.indexOf('--data-dir')
const dataDir = index >= 0 ? String(args[index + 1] || '').trim() : ''
const apply = args.includes('--apply')

if (dataDir === '') {
  console.error('用法：node tools/flatten-types.mjs --data-dir <dir> [--dry-run|--apply]')
  process.exit(2)
}
if (!fs.existsSync(path.join(dataDir, 'manifest.json'))) {
  console.error(`不是经验库目录（缺 manifest.json）：${dataDir}`)
  process.exit(2)
}

const manifest = readManifestFile(dataDir)
if (manifest === null || typeof manifest !== 'object') {
  console.error('manifest 不可读')
  process.exit(2)
}
if (manifest.layout === 'family-flat') {
  console.log(JSON.stringify({ layout: 'family-flat', changed: false }, null, 2))
  console.log('[flatten-types] 已经是单层族布局，无需迁移')
  process.exit(0)
}
if (manifest.layout !== 'family') {
  console.error(`只支持从 family 布局迁移，当前 layout=${String(manifest.layout || '(legacy)')}`)
  process.exit(2)
}

const before = readStore(dataDir)
const library = path.join(dataDir, 'library')
const summary = {
  layoutBefore: manifest.layout,
  layoutAfter: 'family-flat',
  rowsBefore: before.experiences.length,
  bucketsBefore: manifest.buckets.length,
  typeDirs: fs.readdirSync(library).filter((name) => {
    try { return fs.statSync(path.join(library, name)).isDirectory() && !name.startsWith('.') } catch { return false }
  }).length,
  dryRun: !apply,
}
console.log(JSON.stringify(summary, null, 2))
if (!apply) {
  console.log('[flatten-types] dry-run：只统计，不写盘')
  process.exit(0)
}

const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
const backupRoot = path.join(path.dirname(dataDir), '备份', new Date().toISOString().slice(0, 10))
const backupDir = path.join(backupRoot, `exp-before-flat-${stamp}`)
fs.mkdirSync(backupDir, { recursive: true })
fs.cpSync(dataDir, backupDir, { recursive: true })
console.log(`[flatten-types] 备份：${backupDir}`)

// 1) 把各分类目录的族文件移到 library 根；同名文件按行合并（去重 id）。
const rootFiles = new Map()
for (const name of fs.readdirSync(library)) {
  const dir = path.join(library, name)
  let isDir = false
  try { isDir = fs.statSync(dir).isDirectory() } catch { isDir = false }
  if (!isDir) continue
  for (const file of fs.readdirSync(dir)) {
    if (!file.toLowerCase().endsWith('.jsonl')) continue
    const source = path.join(dir, file)
    if (!rootFiles.has(file)) rootFiles.set(file, [])
    const rows = fs.readFileSync(source, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line))
    rootFiles.get(file).push(...rows)
    fs.rmSync(source)
  }
}
for (const [file, rows] of rootFiles) {
  const seen = new Set()
  const kept = []
  for (const row of rows) {
    const id = String((row && row.id) || '')
    if (id !== '' && seen.has(id)) continue
    if (id !== '') seen.add(id)
    kept.push(row)
  }
  fs.writeFileSync(path.join(library, file), kept.map((row) => JSON.stringify(row)).join('\n') + (kept.length > 0 ? '\n' : ''), 'utf8')
}
// 2) 删除分类目录与 _type.json（先删目录，族文件已移走）。
for (const name of fs.readdirSync(library)) {
  const dir = path.join(library, name)
  let isDir = false
  try { isDir = fs.statSync(dir).isDirectory() } catch { isDir = false }
  if (isDir) fs.rmSync(dir, { recursive: true, force: true })
}
// 3) 重写 manifest：buckets 路径去分类，layout/schema 升级。
const buckets = []
const seenFiles = new Set()
for (const bucket of manifest.buckets) {
  const file = String(bucket.file || '').replace(/^library\/[^/]+\//, 'library/')
  if (file === '' || seenFiles.has(file)) continue
  seenFiles.add(file)
  buckets.push({ ...bucket, file })
}
const nextManifest = { ...manifest, layout: 'family-flat', schema: 4, buckets }
writeManifest(dataDir, nextManifest)

// 4) 校验：行数不变、族数不变、读回一致。
const after = readStore(dataDir)
const problems = []
if (after.experiences.length !== summary.rowsBefore) problems.push(`行数不符：${summary.rowsBefore} → ${after.experiences.length}`)
if (buckets.length !== summary.bucketsBefore) problems.push(`族文件数变化：${summary.bucketsBefore} → ${buckets.length}`)
if (problems.length > 0) {
  console.error('[flatten-types] 迁移后校验失败：')
  for (const problem of problems) console.error(` - ${problem}`)
  process.exit(1)
}
// 5) 用 writeStore 收口一次，确保索引/统计与 flat 布局一致。
writeStore(dataDir, after, { layout: 'family-flat' })
console.log(JSON.stringify({ ...summary, dryRun: false, rowsAfter: after.experiences.length, bucketsAfter: buckets.length, backupDir }, null, 2))
console.log('[flatten-types] 迁移完成，校验通过')
