#!/usr/bin/env node
/**
 * 0.32 迁移：把现有经验拆成「纯动作」记录（一条经验按每个动作一条）。
 *
 * 用法：
 *   node tools/split-actions.mjs --data-dir <dir> [--dry-run]
 *   node tools/split-actions.mjs --data-dir <dir> --apply
 *
 * 安全：
 *  - 默认 dry-run，只统计不写盘；
 *  - --apply 前自动整库备份到 <父目录>/备份/<日期>/exp-before-split-<时间>；
 *  - 迁移后校验：新库行数 = 报告 actionRows+negativeRows，且原行全部可解析（unparsed 不得静默丢）。
 */
import fs from 'node:fs'
import path from 'node:path'

import { readStore, writeStore } from '../kernel/store.js'
import { splitStore } from '../kernel/action-split.js'

const args = process.argv.slice(2)
const dataDirIndex = args.indexOf('--data-dir')
const dataDir = dataDirIndex >= 0 ? String(args[dataDirIndex + 1] || '').trim() : ''
const apply = args.includes('--apply')
const dryRun = !apply

if (dataDir === '') {
  console.error('用法：node tools/split-actions.mjs --data-dir <dir> [--dry-run|--apply]')
  process.exit(2)
}
if (!fs.existsSync(path.join(dataDir, 'manifest.json'))) {
  console.error(`不是经验库目录（缺 manifest.json）：${dataDir}`)
  process.exit(2)
}

const store = readStore(dataDir)
const { store: nextStore, report } = splitStore(store)

const summary = {
  sourceRows: report.sourceRows,
  actionRows: report.actionRows,
  negativeRows: report.negativeRows,
  negativeSources: report.negativeSources,
  unparsed: report.unparsed.length,
  dryRun,
}
console.log(JSON.stringify(summary, null, 2))
if (report.unparsed.length > 0) {
  console.error(`有 ${report.unparsed.length} 行无法拆分（不会静默丢）：${report.unparsed.slice(0, 10).join(', ')}`)
}

if (dryRun) {
  console.log('[split-actions] dry-run：只统计，不写盘')
  process.exit(report.unparsed.length > 0 ? 2 : 0)
}

// 备份整库
const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
const backupRoot = path.join(path.dirname(dataDir), '备份', new Date().toISOString().slice(0, 10))
const backupDir = path.join(backupRoot, `exp-before-split-${stamp}`)
fs.mkdirSync(backupDir, { recursive: true })
fs.cpSync(dataDir, backupDir, { recursive: true })
console.log(`[split-actions] 备份：${backupDir}`)

writeStore(dataDir, nextStore, { layout: 'family' })
const verify = readStore(dataDir)
const expected = report.actionRows + report.negativeRows
const problems = []
if (verify.experiences.length !== expected) problems.push(`行数不符：期望 ${expected}，实际 ${verify.experiences.length}`)
const kinds = verify.experiences.reduce((map, row) => { map[row.kind || '(none)'] = (map[row.kind || '(none)'] || 0) + 1; return map }, {})
if ((kinds.action || 0) !== report.actionRows) problems.push(`正向动作数不符：${kinds.action || 0}`)
if ((kinds['action-negative'] || 0) !== report.negativeRows) problems.push(`负面动作数不符：${kinds['action-negative'] || 0}`)
if (verify.experiences.some((row) => Array.isArray(row.context) && row.context.some((tag) => ['代码', 'DSH插件', 'PPT', 'Word', '课件', 'Agent', '智能体平台', '脚本', '网页应用', '任务卡', '版式', '插页', 'Excel', 'WPS', 'DSH'].includes(String(tag))))) {
  problems.push('仍有对象面标签残留')
}
if (problems.length > 0) {
  console.error('[split-actions] 迁移后校验失败：')
  for (const problem of problems) console.error(` - ${problem}`)
  process.exit(1)
}
console.log(JSON.stringify({ ...summary, dryRun: false, kinds, backupDir }, null, 2))
console.log('[split-actions] 迁移完成，校验通过')
