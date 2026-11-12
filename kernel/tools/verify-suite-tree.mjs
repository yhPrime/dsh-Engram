#!/usr/bin/env node
/**
 * 套件树验收 / 修包摘要（开发工具，不进发布包）。
 *
 *   node kernel/tools/verify-suite-tree.mjs --root <skillsRoot>
 *        [--expect N] [--expect-roots N] [--fix-packages] [--json]
 *
 * 检查：
 *   - 每个技能的 id 与磁盘相对路径一致；
 *   - skill.json.id 已按新路径更新；
 *   - 可选断言技能总数 / 树根数；
 *   - 打印树（技能 ●、组节点 ▸）。
 * --fix-packages：按实际目录重算每个技能的 package.files/bytes/dirs/skipped，
 *   修掉迁移后「文件 N」偏旧的问题（根技能按物理子树计数）。
 */
import fs from 'node:fs'
import path from 'node:path'

import { buildSkillTree, listSkills, SKILLS_DIRNAME } from '../skills.js'

const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build'])
const SKIP_PACKAGE_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build'])

function usage() {
  console.error('用法：node kernel/tools/verify-suite-tree.mjs --root <skillsRoot> [--expect N] [--expect-roots N] [--fix-packages] [--json]')
}

function parseArgs(argv) {
  const out = { root: '', expect: undefined, expectRoots: undefined, fix: false, json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--root') out.root = String(argv[++index] || '')
    else if (arg === '--expect') out.expect = Number(argv[++index])
    else if (arg === '--expect-roots') out.expectRoots = Number(argv[++index])
    else if (arg === '--fix-packages') out.fix = true
    else if (arg === '--json') out.json = true
    else if (arg === '--help' || arg === '-h') { usage(); process.exit(0) }
    else { usage(); throw new Error(`不认识的参数：${arg}`) }
  }
  if (out.root === '') { usage(); throw new Error('缺少 --root') }
  return out
}

/** 物理目录摘要：文件数 / 字节 / 一级目录。跳过包缓存与隐藏目录。 */
function summarize(dir) {
  const dirs = new Set()
  let files = 0
  let bytes = 0
  let skipped = 0
  const walk = (current, rel) => {
    let entries = []
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      if (SKIP_PACKAGE_DIRS.has(entry.name)) continue
      // 账本自身不计入 package 摘要：否则每写一次 skill.json，字节数就变，永远不幂等。
      if (entry.isFile() && entry.name === 'skill.json') continue
      const target = path.join(current, entry.name)
      if (entry.isDirectory()) {
        dirs.add(rel === '' ? entry.name : rel.split('/')[0])
        walk(target, rel === '' ? entry.name : `${rel}/${entry.name}`)
        continue
      }
      if (!entry.isFile()) {
        skipped += 1
        continue
      }
      try {
        bytes += fs.statSync(target).size
        files += 1
      } catch {
        skipped += 1
      }
    }
  }
  walk(dir, '')
  return { files, bytes, dirs: [...dirs].sort(), skipped }
}

function treeLines(tree) {
  const lines = []
  const walk = (node, depth) => {
    const mark = node.kind === 'skill' ? '●' : '▸'
    lines.push(`${'  '.repeat(depth)}${mark} ${node.path}（${node.skillCount} 技能）`)
    for (const child of node.children) walk(child, depth + 1)
  }
  for (const node of tree) walk(node, 0)
  return lines
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const root = path.resolve(args.root)
  if (!fs.existsSync(root)) throw new Error(`技能根不存在：${root}`)
  // listSkills 收的是 dataDir（它自己拼 skills/）；--root 给的是 skills 目录本身。
  const dataDir = path.basename(root).toLowerCase() === SKILLS_DIRNAME ? path.dirname(root) : root
  const rows = listSkills(dataDir)
  const tree = buildSkillTree(rows)
  const problems = []
  let fixed = 0

  for (const row of rows) {
    const rel = path.relative(root, row.dir).split(path.sep).join('/')
    if (rel !== row.id) problems.push(`id 与磁盘不一致：${row.id} != ${rel}`)
    const metaPath = path.join(row.dir, 'skill.json')
    let meta = null
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
    } catch {
      problems.push(`skill.json 读不了：${row.id}`)
    }
    if (meta !== null && meta.id !== row.id) problems.push(`skill.json.id 未更新：${row.id}（账本 ${meta.id}）`)
    if (args.fix && meta !== null) {
      const summary = summarize(row.dir)
      const current = meta.package && typeof meta.package === 'object' ? meta.package : {}
      const same = current.files === summary.files && current.bytes === summary.bytes
        && Array.isArray(current.dirs) && current.dirs.join('/') === summary.dirs.join('/')
        && (current.skipped || 0) === summary.skipped
      if (!same) {
        meta.package = { ...current, ...summary, source: current.source || row.dir, copiedAt: new Date().toISOString() }
        fs.writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
        fixed += 1
      }
    }
  }

  if (Number.isFinite(args.expect) && rows.length !== args.expect) {
    problems.push(`技能总数 ${rows.length} != 预期 ${args.expect}`)
  }
  if (Number.isFinite(args.expectRoots) && tree.length !== args.expectRoots) {
    problems.push(`树根数 ${tree.length} != 预期 ${args.expectRoots}`)
  }

  if (args.json) {
    console.log(JSON.stringify({ root, total: rows.length, roots: tree.length, fixed, problems }, null, 2))
  } else {
    console.log(`根：${root}`)
    console.log(`技能 ${rows.length} 个｜树根 ${tree.length} 个｜包摘要修正 ${fixed} 个\n`)
    for (const line of treeLines(tree)) console.log(line)
    if (problems.length > 0) {
      console.log('\n问题：')
      for (const problem of problems) console.log(`  - ${problem}`)
    } else {
      console.log('\n验收通过：id、账本、数量都对得上。')
    }
  }
  if (problems.length > 0) process.exit(1)
}

try {
  main()
} catch (error) {
  console.error(error && error.message ? error.message : String(error))
  process.exit(2)
}
