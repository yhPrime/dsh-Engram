#!/usr/bin/env node
/**
 * 历史数据迁移：把摊平的技能套件目录收成树（《计划书》v2 第 9 节）。
 *
 *   node kernel/tools/migrate-suite-tree.mjs [--dry-run|--apply] --root <skillsRoot>
 *        [--animation-source <dir>]
 *
 * 参数
 *   --dry-run            只出一张「动作 / 源 / 目标 / 冲突」表，不落盘（默认）
 *   --apply              真正执行；必须显式给 --root（默认 .exp/skills 可能指向真实库，
 *                        不允许隐式落盘）
 *   --root <dir>         技能库根目录（其下直接是技能/组目录）
 *   --animation-source   动画套件来源目录，默认 C:\Users\yh\Documents\GitHub\动画\skills\skills；
 *                        显式传入但不存在 = 用法错误，默认值不存在 = 跳过 B 并告警
 *   --help               打印用法
 *
 * 行为（只做这三步，不碰 ppt-master / 插件市场收录申请）
 *   A. ai-base-tools：7 个已知子技能里，若 <root>/<child> 是顶层真身、而
 *      <root>/ai-base-tools/<child> 只是无 skill.json 的内容副本 → 删副本、把顶层移入、
 *      把子技能 skill.json 的 id 改成 ai-base-tools/<child>、package.source 改成新绝对路径；
 *      已是嵌套真身则跳过。
 *   B. 动画：<root>/动画 不存在则建；对 --animation-source 下每个含 SKILL.md 的子目录名，
 *      若 <root>/<name> 是顶层技能 → 移入 <root>/动画/<name>，skill.json.id 改成 动画/<name>；
 *      已在动画内则跳过。
 *   C. 冲突即中止：目标已存在且不是预期副本、源目录是链接（junction/symlink）、
 *      两边都是真身、skill.json 解析失败 → 打印冲突并退出码 1，**一个字节都不改**。
 *
 * 幂等：重复执行 --apply 零变更（按路径存在性 + skill.json 现值判断）。
 * 回滚：本工具只做 rename/删副本，回滚用 .exp 的 git tag（计划书 9.1/11）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const SUITE = 'ai-base-tools'
export const ANIMATION_GROUP = '动画'

/** ai-base-tools 的 7 个已知子技能（计划书 9.2 A）。 */
export const SUITE_CHILDREN = [
  'aelos-action-mirror',
  'changguike-ppt-maker',
  'pptx-existing-deck-edit',
  'pptx-page-number',
  'programming-board',
  'task-card-builder',
  'yanxue-base-ppt-maker',
]

export const DEFAULT_ANIMATION_SOURCE = 'C:\\Users\\yh\\Documents\\GitHub\\动画\\skills\\skills'
const DEFAULT_ROOT = path.resolve(process.cwd(), '.exp', 'skills')

/* ------------------------------------------------------------------ 小工具 */

function isDir(target) {
  try {
    return fs.statSync(target).isDirectory()
  } catch {
    return false
  }
}

function isFile(target) {
  try {
    return fs.statSync(target).isFile()
  } catch {
    return false
  }
}

/** lstat 判定：符号链接与 Windows junction 都算「链接」（stat 会跟进去，这里不能跟）。 */
function isLink(target) {
  try {
    return fs.lstatSync(target).isSymbolicLink()
  } catch {
    return false
  }
}

function hasSkillMd(dir) {
  return isFile(path.join(dir, 'SKILL.md'))
}

function hasSkillJson(dir) {
  return isFile(path.join(dir, 'skill.json'))
}

/** 相对路径（POSIX 分隔符）——表格里显示用。 */
function relOf(root, target) {
  const rel = path.relative(root, target)
  return rel === '' ? '.' : rel.split(path.sep).join('/')
}

/** 越界检查：所有被处理的路径都必须落在 root 内。 */
function assertInside(root, target) {
  const rel = path.relative(root, target)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`路径越界：${target} 不在 ${root} 内`)
  }
}

const RESERVED_SEGMENT = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/** 路径段校验（计划书 5.1）：空段、./..、保留名、首尾点或空格、超长段一律拒绝。 */
export function validSegment(name) {
  if (typeof name !== 'string' || name === '') return '空段'
  if (name === '.' || name === '..') return '不允许 . 或 ..'
  if (/[\\/]/.test(name)) return '含路径分隔符'
  if (/[\u0000-\u001f]/.test(name)) return '含控制字符'
  if (/[<>:"|?*]/.test(name)) return '含 Windows 非法字符'
  if (RESERVED_SEGMENT.test(name)) return 'Windows 保留名'
  if (/^[. ]|[. ]$/.test(name)) return '首尾有点或空格'
  if (name.length > 64) return '超过 64 字符'
  return ''
}

/** 显示宽度（中日韩字符算 2 列），让表格对齐。 */
function displayWidth(text) {
  let width = 0
  for (const ch of String(text)) {
    const code = ch.codePointAt(0)
    const wide = (code >= 0x1100 && code <= 0x115f)
      || (code >= 0x2e80 && code <= 0xa4cf)
      || (code >= 0xac00 && code <= 0xd7a3)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xfe30 && code <= 0xfe6f)
      || (code >= 0xff00 && code <= 0xff60)
      || (code >= 0xffe0 && code <= 0xffe6)
      || (code >= 0x1f300 && code <= 0x1faff)
      || (code >= 0x20000 && code <= 0x3fffd)
    width += wide ? 2 : 1
  }
  return width
}

function padCell(text, width) {
  const value = String(text)
  return value + ' '.repeat(Math.max(0, width - displayWidth(value)))
}

/** 打印「动作 / 源 / 目标 / 冲突」表。 */
function printTable(title, rows) {
  console.log(`\n[${title}]`)
  if (rows.length === 0) {
    console.log('  （无）')
    return
  }
  const header = ['动作', '源', '目标', '冲突']
  const cells = rows.map((row) => [row.action, row.from || '-', row.to || '-', row.conflict || ''])
  const widths = header.map((head, index) => Math.max(
    displayWidth(head),
    ...cells.map((line) => displayWidth(line[index])),
  ))
  console.log(`  ${header.map((head, index) => padCell(head, widths[index])).join('  ')}`)
  console.log(`  ${widths.map((width) => '-'.repeat(width)).join('  ')}`)
  for (const line of cells) {
    console.log(`  ${line.map((cell, index) => padCell(cell, widths[index])).join('  ')}`.trimEnd())
  }
}

/* -------------------------------------------------------------- skill.json */

function readMeta(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    return { data: JSON.parse(raw), trailingNewline: raw.endsWith('\n') }
  } catch (error) {
    return { error: error.message }
  }
}

/**
 * 计算 skill.json 需要改的字段（不落盘）。
 * @returns {{changes: Array<{field:string, from:any, to:string, note?:string}>, problem?:string}}
 */
function metaChanges(data, wanted) {
  const changes = []
  if (wanted.id !== undefined && data.id !== wanted.id) {
    changes.push({ field: 'id', from: data.id, to: wanted.id })
  }
  if (wanted.source !== undefined) {
    if (!data.package || typeof data.package !== 'object' || Array.isArray(data.package)) {
      // 没有 package 字段就不硬造一个，只提示。
      if (data.package === undefined) changes.push({ field: 'package.source', from: '(无)', to: wanted.source, note: '无 package 字段，未写' , skipWrite: true })
      else changes.push({ field: 'package.source', from: String(data.package), to: wanted.source, note: 'package 不是对象，未写', skipWrite: true })
    } else if (data.package.source !== wanted.source) {
      changes.push({ field: 'package.source', from: data.package.source, to: wanted.source })
    }
  }
  return { changes }
}

/** 只改 id / package.source，保留其余字段与 2 空格缩进、末尾换行习惯。 */
function writeMeta(file, changes) {
  const meta = readMeta(file)
  if (meta.error) throw new Error(`skill.json 解析失败：${file}（${meta.error}）`)
  const data = meta.data
  for (const change of changes) {
    if (change.skipWrite) continue
    if (change.field === 'id') data.id = change.to
    else if (change.field === 'package.source') data.package.source = change.to
  }
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + (meta.trailingNewline ? '\n' : ''), 'utf8')
}

/* -------------------------------------------------------------- 统计/概况 */

const SCAN_SKIP = new Set(['.git', 'node_modules', '.venv', '__pycache__', 'dist', 'build'])

/** 递归数「含某个标记文件」的目录（skill.json = 技能账本条目），跳过 .git 等与链接，避免环。 */
function countDirsWith(dir, marker) {
  let count = 0
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  if (entries.some((entry) => entry.isFile() && entry.name === marker)) count += 1
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (SCAN_SKIP.has(entry.name)) continue
    count += countDirsWith(path.join(dir, entry.name), marker)
  }
  return count
}

function statsOf(root) {
  return {
    skills: countDirsWith(root, 'skill.json'),
    skillMdDirs: countDirsWith(root, 'SKILL.md'),
    tops: topLevelEntries(root).length,
  }
}

function formatStats(stats) {
  return `技能 ${stats.skills} 个（skill.json）｜含 SKILL.md 的目录 ${stats.skillMdDirs} 个｜顶层条目 ${stats.tops} 个`
}

function topLevelEntries(root) {
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

/* ------------------------------------------------------------------- 计划 */

/**
 * 只读地算出整个迁移计划。
 * @returns {{a:object[], b:object[], errors:object[], warnings:string[], statsBefore:object}}
 */
export function buildPlan({ root, animationSource, animationSourceExplicit }) {
  const rowsA = []
  const rowsB = []
  const errors = []
  const warnings = []

  const statsBefore = statsOf(root)

  /* ---- 前置：root 与 ai-base-tools 目录本身不能是链接 ---- */
  if (isLink(root)) {
    errors.push({ step: '前置', action: '检查', from: relOf(path.dirname(root), root), to: '-', conflict: '技能库根目录是链接，拒绝操作' })
    return { a: rowsA, b: rowsB, errors, warnings, statsBefore }
  }

  const suiteDir = path.join(root, SUITE)

  /* ---- A：ai-base-tools 子技能 ---- */
  if (!isDir(suiteDir)) {
    warnings.push(`未找到 ${SUITE}/ 目录，跳过 A`)
  } else if (isLink(suiteDir)) {
    errors.push({ step: 'A', action: '检查', from: `${SUITE}/`, to: '-', conflict: `${SUITE}/ 是链接，拒绝操作` })
  } else if (!hasSkillMd(suiteDir) && !hasSkillJson(suiteDir)) {
    warnings.push(`${SUITE}/ 既无 SKILL.md 也无 skill.json，仍按套件目录处理`)
  }

  if (isDir(suiteDir) && !isLink(suiteDir)) {
    for (const child of SUITE_CHILDREN) {
      const top = path.join(root, child)
      const nested = path.join(suiteDir, child)
      const topExists = isDir(top)
      const nestedExists = isDir(nested)
      const topLink = isLink(top)
      const nestedLink = isLink(nested)
      const nestedIsSkill = hasSkillJson(nested)
      const topIsSkill = hasSkillMd(top) || hasSkillJson(top)

      if (nestedExists && nestedIsSkill && !topExists) {
        rowsA.push({ action: '跳过', from: `${child}`, to: `${SUITE}/${child}`, conflict: '已是嵌套真身', skip: true, notes: [] })
        continue
      }
      if (nestedExists && nestedIsSkill && topExists) {
        errors.push({ step: 'A', action: '移动子技能', from: child, to: `${SUITE}/${child}`, conflict: '顶层与嵌套都有 skill.json（两边都是真身），人工确认' })
        continue
      }
      if (nestedLink) {
        errors.push({ step: 'A', action: '移动子技能', from: child, to: `${SUITE}/${child}`, conflict: `目标 ${SUITE}/${child} 是链接，拒绝删除` })
        continue
      }
      if (topLink) {
        errors.push({ step: 'A', action: '移动子技能', from: child, to: `${SUITE}/${child}`, conflict: `源 ${child}/ 是链接，拒绝移动` })
        continue
      }
      if (!topExists && !nestedExists) {
        rowsA.push({ action: '跳过', from: child, to: `${SUITE}/${child}`, conflict: '两边都不存在', skip: true, notes: [] })
        continue
      }
      if (!topExists) {
        // 只剩无 skill.json 的副本：孤儿副本，不删数据，只提示。
        rowsA.push({ action: '跳过', from: child, to: `${SUITE}/${child}`, conflict: '只有副本、无顶层真身', skip: true, notes: [] })
        warnings.push(`${SUITE}/${child} 是没有真身的内容副本（孤儿），未删除，请人工确认`)
        continue
      }
      if (!topIsSkill) {
        errors.push({ step: 'A', action: '移动子技能', from: child, to: `${SUITE}/${child}`, conflict: `顶层 ${child}/ 不是技能（无 SKILL.md），拒绝移动` })
        continue
      }

      // 正路：顶层真身 → 嵌套位置；若目标存在，必须是无 skill.json 的副本。
      const metaFile = path.join(top, 'skill.json')
      const meta = hasSkillJson(top) ? readMeta(metaFile) : { missing: true }
      if (meta.error) {
        errors.push({ step: 'A', action: '移动子技能', from: child, to: `${SUITE}/${child}`, conflict: `skill.json 解析失败：${meta.error}` })
        continue
      }
      const wanted = { id: `${SUITE}/${child}`, source: nested }
      const changes = meta.missing ? [] : metaChanges(meta.data, wanted).changes
      const notes = []
      if (nestedExists) notes.push('删除无 skill.json 的内容副本')
      else notes.push('目标副本不存在，直接移入')
      if (meta.missing) notes.push('顶层无 skill.json，跳过 id 改写')
      for (const change of changes) {
        notes.push(`${change.field} ${JSON.stringify(change.from)} → ${JSON.stringify(change.to)}${change.note ? `（${change.note}）` : ''}`)
      }

      rowsA.push({
        action: '移动子技能',
        from: `${child}/`,
        to: `${SUITE}/${child}/`,
        conflict: '',
        skip: false,
        notes,
        exec() {
          assertInside(root, top)
          assertInside(root, nested)
          if (hasSkillJson(nested)) throw new Error(`目标 ${relOf(root, nested)} 突然出现 skill.json，拒绝删除`)
          if (isLink(nested)) throw new Error(`目标 ${relOf(root, nested)} 是链接，拒绝删除`)
          if (nestedExists) fs.rmSync(nested, { recursive: true, force: false })
          fs.renameSync(top, nested)
          const writable = changes.filter((change) => !change.skipWrite)
          if (!meta.missing && writable.length > 0) writeMeta(path.join(nested, 'skill.json'), writable)
          return changes
        },
      })
    }
  }

  /* ---- B：动画（组节点，无根技能） ---- */
  const groupDir = path.join(root, ANIMATION_GROUP)
  const groupExists = isDir(groupDir)
  if (isLink(groupDir)) {
    errors.push({ step: 'B', action: '检查', from: `${ANIMATION_GROUP}/`, to: '-', conflict: `${ANIMATION_GROUP}/ 是链接，拒绝操作` })
  } else if (fs.existsSync(groupDir) && !groupExists) {
    errors.push({ step: 'B', action: '检查', from: `${ANIMATION_GROUP}`, to: '-', conflict: `同名的 ${ANIMATION_GROUP} 是文件，不是目录` })
  }

  if (!fs.existsSync(groupDir)) {
    rowsB.push({
      action: '新建组目录',
      from: '-',
      to: `${ANIMATION_GROUP}/`,
      conflict: '',
      skip: false,
      notes: ['组节点（无根 SKILL.md），只用于收纳与整套操作'],
      exec() {
        fs.mkdirSync(groupDir)
        return []
      },
    })
  }

  if (!isDir(animationSource)) {
    if (animationSourceExplicit) {
      errors.push({ step: 'B', action: '读取来源', from: animationSource, to: '-', conflict: '--animation-source 不存在或不是目录' })
    } else {
      warnings.push(`默认动画来源不存在（${animationSource}），跳过 B`)
    }
  } else {
    const names = fs.readdirSync(animationSource, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => hasSkillMd(path.join(animationSource, name)))
      .sort()
    if (names.length === 0) warnings.push(`动画来源 ${animationSource} 下没有含 SKILL.md 的子目录，B 无事可做`)
    for (const name of names) {
      const top = path.join(root, name)
      const inside = path.join(groupDir, name)
      const bad = validSegment(name)
      if (bad) {
        errors.push({ step: 'B', action: '移入动画', from: name, to: `${ANIMATION_GROUP}/${name}`, conflict: `目录名非法：${bad}` })
        continue
      }
      if (isDir(inside)) {
        rowsB.push({ action: '跳过', from: `${name}/`, to: `${ANIMATION_GROUP}/${name}/`, conflict: '已在动画内', skip: true, notes: [] })
        continue
      }
      if (isLink(inside)) {
        errors.push({ step: 'B', action: '移入动画', from: name, to: `${ANIMATION_GROUP}/${name}`, conflict: `目标 ${ANIMATION_GROUP}/${name} 是链接` })
        continue
      }
      if (!isDir(top)) {
        rowsB.push({ action: '跳过', from: `${name}/`, to: `${ANIMATION_GROUP}/${name}/`, conflict: '顶层不存在', skip: true, notes: [] })
        continue
      }
      if (isLink(top)) {
        errors.push({ step: 'B', action: '移入动画', from: name, to: `${ANIMATION_GROUP}/${name}`, conflict: `源 ${name}/ 是链接，拒绝移动` })
        continue
      }
      if (!hasSkillMd(top)) {
        errors.push({ step: 'B', action: '移入动画', from: name, to: `${ANIMATION_GROUP}/${name}`, conflict: `顶层 ${name}/ 无 SKILL.md，不是技能` })
        continue
      }

      const metaFile = path.join(top, 'skill.json')
      const meta = hasSkillJson(top) ? readMeta(metaFile) : { missing: true }
      if (meta.error) {
        errors.push({ step: 'B', action: '移入动画', from: name, to: `${ANIMATION_GROUP}/${name}`, conflict: `skill.json 解析失败：${meta.error}` })
        continue
      }
      const wanted = { id: `${ANIMATION_GROUP}/${name}` }
      const changes = meta.missing ? [] : metaChanges(meta.data, wanted).changes
      const notes = []
      if (meta.missing) notes.push('无 skill.json，只移动不改 id')
      for (const change of changes) notes.push(`${change.field} ${JSON.stringify(change.from)} → ${JSON.stringify(change.to)}`)

      rowsB.push({
        action: '移入动画',
        from: `${name}/`,
        to: `${ANIMATION_GROUP}/${name}/`,
        conflict: '',
        skip: false,
        notes,
        exec() {
          assertInside(root, top)
          assertInside(root, inside)
          if (!isDir(groupDir)) fs.mkdirSync(groupDir)
          if (isLink(top)) throw new Error(`源 ${relOf(root, top)} 是链接，拒绝移动`)
          if (fs.existsSync(inside)) throw new Error(`目标 ${relOf(root, inside)} 已存在，拒绝覆盖`)
          fs.renameSync(top, inside)
          const writable = changes.filter((change) => !change.skipWrite)
          if (!meta.missing && writable.length > 0) writeMeta(path.join(inside, 'skill.json'), writable)
          return changes
        },
      })
    }
  }

  return { a: rowsA, b: rowsB, errors, warnings, statsBefore }
}

/* ------------------------------------------------------------------- 主流程 */

function parseArgs(argv) {
  const options = {
    mode: 'dry-run',
    root: DEFAULT_ROOT,
    rootExplicit: false,
    animationSource: DEFAULT_ANIMATION_SOURCE,
    animationSourceExplicit: false,
    help: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--dry-run') options.mode = 'dry-run'
    else if (arg === '--apply') options.mode = 'apply'
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--root' || arg.startsWith('--root=')) {
      const value = arg === '--root' ? argv[index += 1] : arg.slice('--root='.length)
      if (!value) throw new Error('--root 需要目录参数')
      options.root = path.resolve(value)
      options.rootExplicit = true
    } else if (arg === '--animation-source' || arg.startsWith('--animation-source=')) {
      const value = arg === '--animation-source' ? argv[index += 1] : arg.slice('--animation-source='.length)
      if (!value) throw new Error('--animation-source 需要目录参数')
      options.animationSource = path.resolve(value)
      options.animationSourceExplicit = true
    } else {
      throw new Error(`未知参数：${arg}`)
    }
  }
  return options
}

function printHelp() {
  console.log(`用法：node kernel/tools/migrate-suite-tree.mjs [--dry-run|--apply] --root <skillsRoot> [--animation-source <dir>]

  --dry-run             只出「动作 / 源 / 目标 / 冲突」表，不落盘（默认）
  --apply               真正执行；必须显式 --root
  --root <dir>          技能库根目录（默认 ${DEFAULT_ROOT}，仅供 dry-run 使用）
  --animation-source    动画来源目录（默认 ${DEFAULT_ANIMATION_SOURCE}）

只做两件事：A 把 ai-base-tools 的 7 个子技能收进套件目录；B 把动画 18 个技能收进 动画/。
ppt-master、插件市场收录申请不动。冲突时退出码 1 且不做任何改动。`)
}

function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`参数错误：${error.message}`)
    printHelp()
    process.exitCode = 2
    return
  }
  if (options.help) {
    printHelp()
    return
  }
  if (options.mode === 'apply' && !options.rootExplicit) {
    console.error('拒绝隐式落盘：--apply 必须显式传 --root <skillsRoot>（默认值可能是真实库）。')
    process.exitCode = 2
    return
  }
  if (!isDir(options.root)) {
    console.error(`技能库根目录不存在或不是目录：${options.root}`)
    process.exitCode = 2
    return
  }

  const root = options.root
  const plan = buildPlan({
    root,
    animationSource: options.animationSource,
    animationSourceExplicit: options.animationSourceExplicit,
  })

  console.log(`技能树迁移（${options.mode === 'apply' ? 'APPLY 落盘' : 'DRY-RUN 只读'}）`)
  console.log(`  技能库：${root}`)
  console.log(`  动画来源：${options.animationSource}`)
  console.log(`  迁移前：${formatStats(plan.statsBefore)}`)

  printTable('A · ai-base-tools 子技能', plan.a)
  printTable(`B · ${ANIMATION_GROUP} 套件`, plan.b)

  const actionRows = [...plan.a, ...plan.b].filter((row) => !row.skip)
  for (const row of actionRows) {
    for (const note of row.notes || []) console.log(`  · ${row.from} → ${row.to}｜${note}`)
  }

  if (plan.warnings.length > 0) {
    console.log(`\nWARN ${plan.warnings.length} 条：`)
    for (const message of plan.warnings) console.log(`  - ${message}`)
  }

  if (plan.errors.length > 0) {
    console.log(`\n冲突 ${plan.errors.length} 条（未做任何改动）：`)
    for (const error of plan.errors) console.log(`  × [${error.step}] ${error.action}｜${error.from} → ${error.to}｜${error.conflict}`)
    process.exitCode = 1
    return
  }

  if (plan.a.some((row) => row.skip) || plan.b.some((row) => row.skip)) {
    const skips = [...plan.a, ...plan.b].filter((row) => row.skip)
    console.log(`\n跳过 ${skips.length} 条：${skips.map((row) => `${row.from}（${row.conflict}）`).join('；')}`)
  }

  if (options.mode !== 'apply') {
    console.log(`\nDRY-RUN：待变更 ${actionRows.length} 条，未落盘。确认后加 --apply 执行。`)
    if (actionRows.length === 0) console.log('零变更：库已经是树状结构，无需迁移。')
    return
  }

  /* ---- 执行：先 A 后 B，逐条打印；任何一条抛错就停下并报错（保留已完成的移动，用 git 回滚） ---- */
  let done = 0
  let failed = null
  const executed = []
  for (const row of [...plan.a, ...plan.b]) {
    if (row.skip) continue
    try {
      const changes = row.exec() || []
      done += 1
      executed.push(row)
      console.log(`  ok ${row.action}：${row.from} → ${row.to}`)
      for (const change of changes) {
        if (change.skipWrite) continue
        console.log(`     skill.json ${change.field}：${JSON.stringify(change.from)} → ${JSON.stringify(change.to)}`)
      }
    } catch (error) {
      failed = { row, message: error.message }
      break
    }
  }

  console.log(`\n已执行 ${done} 条${failed ? '（中途失败）' : ''}｜迁移后：${formatStats(statsOf(root))}`)

  if (failed) {
    console.error(`失败：${failed.row.action} ${failed.row.from} → ${failed.row.to}｜${failed.message}`)
    console.error('已完成的移动不回滚；如需回滚请用 .exp 的 git tag pre-suite-tree-2026-11-11。')
    process.exitCode = 1
    return
  }
  if (done === 0) console.log('零变更：库已经是树状结构，无需迁移。')
  else console.log('完成。再跑一次 dry-run 应显示零变更。')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
