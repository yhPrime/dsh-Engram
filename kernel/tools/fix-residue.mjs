#!/usr/bin/env node
/**
 * 残渣修复工具（2026-11-07）：把 intent / action / note 里混进的工具调用残渣剥掉。
 *
 *   node tools/fix-residue.mjs [dataDir] [--write]
 *
 * 默认 **dry-run**，只打印将要改什么；加 `--write` 才落盘，且先备份：
 *  - 单文件布局：`<dataDir>/exp-lib.json.bak-<时间戳>`（旧行为）；
 *  - 分片布局（0.14.0+）：`<dataDir>/.locks/fix-residue-<时间戳>.bak/`（manifest + buckets，不复制冷档）。
 * 写盘统一走 `writeStore`（分片布局由存储层决定落哪些文件），**不自己拼 exp-lib.json 路径**。
 * 注意：未迁移的老库在 `--write` 时会顺带迁移到分片布局（与 exp_record 同一条写路径）；
 * 备份仍是迁移前的 exp-lib.json.bak，回滚用得上。
 *
 * 只做两件事：剥 `</note>` 这类标签、在 `<parameter …>` 处截断；**不改** outcome / G / 类型 /
 * hits，也不删条目。清洗规则与 exp_record 写入时用的是同一个 `sanitizeField`，不会引入第二套口径。
 */
import fs from 'node:fs'
import path from 'node:path'

import {
  readManifest,
  readStore,
  resolveToolDataDir,
  sanitizeField,
  storeFile,
  visibleExperiences,
  writeStore,
} from '../store.js'
import { bucketsPath, manifestPath } from '../shard-store.js'

/** 与 audit.mjs 同一口径：note 标签或工具参数残渣。 */
export const RESIDUE_RE = /<\/?\s*note\s*>|<\s*parameter\b/i

const hasResidue = (item) => RESIDUE_RE.test(`${item.intent || ''}\n${item.action || ''}\n${item.note || ''}`)

/**
 * 就地清洗所有可见经验里的残渣（纯函数式：只改传入的 store 对象，落盘由调用方决定）。
 * 清洗后 intent / action 为空说明原来只有残渣——保留原值并报告，不把条目弄成非法。
 * @returns {{changed: Array<{id: string, fields: string[]}>, skipped: Array<{id: string, reason: string}>}}
 */
export function fixResidue(store) {
  const changed = []
  const skipped = []
  for (const item of visibleExperiences(store)) {
    if (!hasResidue(item)) continue
    const next = {
      intent: sanitizeField(item.intent).text,
      action: sanitizeField(item.action).text,
      note: sanitizeField(item.note).text,
    }
    if (next.intent === '' || next.action === '') {
      skipped.push({ id: item.id, reason: '清洗后 intent/action 为空（原值只剩残渣）' })
      continue
    }
    const fields = []
    for (const key of ['intent', 'action', 'note']) {
      if (key === 'note' && (item.note || '') === next.note) continue
      if (key !== 'note' && item[key] === next[key]) continue
      item[key] = next[key]
      fields.push(key)
    }
    if (fields.length > 0) changed.push({ id: item.id, fields })
  }
  return { changed, skipped }
}

/**
 * 备份「热档」：单文件布局复制 exp-lib.json；分片布局复制 manifest + buckets。
 * 冷档不参与残渣修复，不需要备份（也不该在这一步放大磁盘）。
 * @returns {{mode: string, path: string}}
 */
function backupHotStorage(dataDir) {
  const singleFile = storeFile(dataDir)
  let manifest = null
  try {
    manifest = readManifest(dataDir)
  } catch {
    manifest = null
  }
  if (manifest === null && fs.existsSync(singleFile)) {
    const backup = `${singleFile}.bak-${Date.now()}`
    fs.copyFileSync(singleFile, backup)
    return { mode: '单文件', path: backup }
  }
  if (manifest !== null) {
    const backupDir = path.join(dataDir, '.locks', `fix-residue-${Date.now()}.bak`)
    fs.mkdirSync(backupDir, { recursive: true })
    fs.copyFileSync(manifestPath(dataDir), path.join(backupDir, 'manifest.json'))
    const buckets = bucketsPath(dataDir)
    if (fs.existsSync(buckets)) fs.cpSync(buckets, path.join(backupDir, 'buckets'), { recursive: true })
    return { mode: '分片', path: backupDir }
  }
  return { mode: '空库', path: '' }
}

function main() {
  const argv = process.argv.slice(2)
  const write = argv.includes('--write')
  const dataDir = path.resolve(argv.find((item) => !item.startsWith('--')) || resolveToolDataDir({}))
  const store = readStore(dataDir)
  const targets = visibleExperiences(store).filter(hasResidue)

  console.log(`残渣体检：${dataDir}`)
  console.log(`可见经验 ${visibleExperiences(store).length} 条｜含残渣 ${targets.length} 条`)
  if (targets.length === 0) {
    console.log('结论：没有残渣条目。')
    return
  }
  const { changed, skipped } = fixResidue(store)
  for (const item of changed) console.log(`  · ${item.id}：清洗 ${item.fields.join(' / ')}`)
  for (const item of skipped) console.log(`  ! ${item.id}：${item.reason}（跳过）`)

  if (!write) {
    console.log('\n这是 dry-run；确认无误后加 --write 落盘（单文件库会先备份到 exp-lib.json.bak-<时间戳>，并在写回时迁到分片；分片库备份到 .locks/fix-residue-<时间戳>.bak/）。')
    return
  }

  const backup = backupHotStorage(dataDir)
  writeStore(dataDir, store)
  const left = visibleExperiences(readStore(dataDir)).filter(hasResidue)
  const backupText = backup.path === '' ? '（无，空库）' : `${backup.path}（${backup.mode}）`
  console.log(`\n已写回：${changed.length} 条；备份 ${backupText}；复查剩余残渣 ${left.length} 条。`)
  if (left.length > 0) process.exitCode = 1
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('tools/fix-residue.mjs')) main()
