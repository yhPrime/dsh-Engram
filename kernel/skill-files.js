/**
 * 技能磁盘表示（从 skills.js 拆出，纯搬代码、行为不变）：SKILL.md / skill.json 的读写、
 * frontmatter 解析与渲染、账本归一化、单个技能读取、附件清单渲染。
 *
 * 不 import skills.js / skill-registry.js；依赖方向 skills.js → skill-registry.js → 本文件 → skill-paths.js。
 */

import fs from 'node:fs'
import path from 'node:path'

import {
  DEFAULT_SKILL_VOLATILITY,
  normalizeAppliesTo,
  normalizeIsoDate,
  normalizeVolatility,
} from './retrieval.js'

import {
  SCRIPTS_DIRNAME,
  SKILL_FILENAME,
  META_FILENAME,
  assertSafeRelPath,
  pathIsLink,
  skillDirOf,
} from './skill-paths.js'

export const RESOLVED_LIMIT = 20

/* -------------------------------------------------------------------------- */
/* 文件读写                                                                    */
/* -------------------------------------------------------------------------- */

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

export function writeFileAtomic(file, content) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    fs.writeFileSync(tmp, content, 'utf8')
    fs.renameSync(tmp, file)
  } catch (error) {
    try { fs.unlinkSync(tmp) } catch { /* 清理失败不掩盖原错误 */ }
    throw error
  }
}

function writeJsonFile(file, value) {
  writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`)
}

/**
 * corrupt/metaError 是 readSkill 给「本次读取」挂的诊断标记，不属于账本字段。
 * 写回前剥离：否则引擎修好 skill.json 后，标记会随 existing.meta 一起写进新账本，
 * 之后 metaRaw 已能解析却仍显示「账本损坏」，validateAllSkills 永久报警（R8 D2）。
 * 成功写回即视为修复，内存对象里的标记也一并清掉（后续 pendingCommit 重写不再带病）。
 */
function stripMetaReadFlags(meta) {
  if (meta === null || typeof meta !== 'object') return meta
  delete meta.corrupt
  delete meta.metaError
  return meta
}

function parseFrontmatter(text) {
  const lines = String(text || '').split(/\r?\n/)
  if (lines[0] !== '---') return { fields: {}, body: lines.join('\n') }
  const fields = {}
  let idx = 1
  for (; idx < lines.length; idx += 1) {
    const line = lines[idx]
    if (line === '---') break
    const match = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (!match) continue
    let value = match[2].trim()
    // YAML 块标量：`description: |` / `>` 的值在缩进块里。
    // 不认它会把描述读成「|」或「>」，技能的 name/description 就废了。
    if (/^[|>][+-]?$/.test(value)) {
      const block = []
      let cursor = idx + 1
      for (; cursor < lines.length; cursor += 1) {
        const inner = lines[cursor]
        if (inner === '---') break
        if (inner.trim() !== '' && !/^\s/.test(inner)) break
        block.push(inner)
      }
      const nonEmpty = block.filter((inner) => inner.trim() !== '')
      const indent = nonEmpty.length === 0 ? 0 : Math.min(...nonEmpty.map((inner) => (inner.match(/^\s*/) || [''])[0].length))
      const dedented = block.map((inner) => inner.slice(indent)).join('\n').trim()
      value = value.startsWith('>') ? dedented.replace(/\n(?=\S)/gu, ' ') : dedented
      idx = cursor - 1
    }
    fields[match[1]] = value
  }
  return { fields, body: lines.slice(idx + 1).join('\n').replace(/^\n+/, '') }
}

function oneLine(value) {
  return String(value || '').replace(/[\r\n]+/g, ' ').trim()
}

function renderSkillMd(name, description, body) {
  return `---\nname: ${oneLine(name)}\ndescription: ${oneLine(description)}\n---\n\n${String(body || '').trim()}\n`
}

export function defaultMeta(id) {
  return {
    id,
    typeName: '',
    // 一个技能可以挂多个分类（技能套件常见：一个套件覆盖多类任务），便签是给人看的备注
    typeNames: [],
    notes: [],
    context: [],
    triggers: [],
    confidence: { uses: 0, helped: 0, hurt: 0, lastUsedAt: null },
    revisions: 0,
    obstacles: {},
    resolved: [],
    derivedFrom: [],
    // 新技能一开始排到最前：刚加进来的技能先让用户看见、能被触发，
    // 之后靠实际使用（feedback/uses）把顺序调回正常。
    order: 90,
    files: [],
    pendingCommit: false,
    // 时效治理（0.20 P0）：技能比经验更易腐，旧技能缺字段时按 perishable 解释（计划书 §7.1）。
    volatility: 'perishable',
    lastVerifiedAt: null,
    reviewAfter: null,
    verifiedBy: null,
    appliesTo: null,
    stale_at: null,
    stale_reason: null,
    review_note: '',
    retired_at: null,
    retired_reason: null,
  }
}

function normalizeMeta(raw, id) {
  const meta = { ...defaultMeta(id), ...(raw && typeof raw === 'object' ? raw : {}) }
  meta.confidence = { uses: 0, helped: 0, hurt: 0, lastUsedAt: null, ...(raw && raw.confidence) }
  meta.obstacles = raw && raw.obstacles && typeof raw.obstacles === 'object' ? raw.obstacles : {}
  meta.resolved = Array.isArray(raw && raw.resolved) ? raw.resolved.slice(-RESOLVED_LIMIT) : []
  meta.derivedFrom = Array.isArray(raw && raw.derivedFrom) ? raw.derivedFrom : []
  meta.typeNames = Array.isArray(raw && raw.typeNames) ? raw.typeNames.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim()).slice(0, 12) : []
  meta.notes = Array.isArray(raw && raw.notes) ? raw.notes.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim()).slice(0, 50) : []
  meta.triggers = Array.isArray(raw && raw.triggers) ? raw.triggers : []
  meta.context = Array.isArray(raw && raw.context) ? raw.context : []
  // 附件登记不在读取时截断：截断会让第 41 个附件「文件在、登记表里没有」，下次 attach 就丢。
  // 数量上限放在 attach 时明确拒绝（见 MAX_ATTACH_COUNT），而不是静默丢弃。
  meta.files = Array.isArray(raw && raw.files)
    ? raw.files.filter((item) => item && typeof item.path === 'string')
    : []
  // 时效字段（0.20 P0）：旧技能缺字段按 perishable 解释，读时不写回；只有真正改技能时才落盘。
  meta.volatility = normalizeVolatility(raw && raw.volatility) || DEFAULT_SKILL_VOLATILITY
  meta.lastVerifiedAt = normalizeIsoDate(raw && raw.lastVerifiedAt)
  meta.reviewAfter = normalizeIsoDate(raw && raw.reviewAfter)
  meta.verifiedBy = raw && raw.verifiedBy ? String(raw.verifiedBy).slice(0, 80) : null
  meta.appliesTo = normalizeAppliesTo(raw && raw.appliesTo)
  meta.stale_at = normalizeIsoDate(raw && raw.stale_at)
  meta.stale_reason = raw && raw.stale_reason ? String(raw.stale_reason).slice(0, 60) : null
  meta.review_note = raw && raw.review_note ? String(raw.review_note).slice(0, 240) : ''
  meta.retired_at = normalizeIsoDate(raw && raw.retired_at)
  meta.retired_reason = raw && raw.retired_reason ? String(raw.retired_reason).slice(0, 120) : null
  // corrupt/metaError 是 readSkill 的「本次读取」诊断标记，不是账本字段：旧数据若把标记写进磁盘，
  // 不能再原样展开（否则账本已修复、健康检查仍永久报损坏）。是否损坏只由本次 metaRaw 能否解析决定。
  delete meta.corrupt
  delete meta.metaError
  return meta
}

/**
 * 读一个技能目录；缺 SKILL.md 返回 null，损坏的 skill.json 用默认值兜底。
 * id 是相对 skillsRoot 的 POSIX 路径（顶层技能 = 目录名）；不传时退回目录名。
 */
export function readSkill(dir, id = path.basename(dir)) {
  try {
    if (pathIsLink(dir)) return null
  } catch {
    return null
  }
  const skillFile = path.join(dir, SKILL_FILENAME)
  let raw
  try {
    // 缺失（ENOENT）/ 是目录（EISDIR）/ 权限不足（EACCES）/ 读的瞬间被删都按「读不出」处理。
    // 这里不能抛：listSkills 逐目录读，单个坏技能项会拖垮整库列表与普通召回（D1）。
    raw = fs.readFileSync(skillFile, 'utf8')
  } catch {
    return null
  }
  const { fields, body } = parseFrontmatter(raw)
  let rel = String(id || path.basename(dir)).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (rel === '') rel = path.basename(dir)
  const metaPath = path.join(dir, META_FILENAME)
  const metaRaw = readJsonFile(metaPath)
  const meta = normalizeMeta(metaRaw, rel)
  // skill.json 存在但读不出来：不能静默当默认账本（confidence/obstacles/files 会像丢了一样）。
  // 读路径仍然返回技能（正文可用），但打上标记，validateAllSkills / 界面能看到「账本损坏」。
  // 形状也要判：`[]` / `"x"` / `123` / `true` 都是合法 JSON，但不是账本对象，同样不能被静默当默认账本。
  const metaNotObject = metaRaw !== null && (typeof metaRaw !== 'object' || Array.isArray(metaRaw))
  if (fs.existsSync(metaPath) && (metaRaw === null || metaNotObject)) {
    meta.corrupt = true
    meta.metaError = metaRaw === null
      ? `技能账本损坏：${META_FILENAME}（无法解析，已按默认值显示；修复后可恢复计数）`
      : `技能账本损坏：${META_FILENAME}（不是账本对象，已按默认值显示；修复后可恢复计数）`
  }
  // 磁盘路径是唯一事实源：账本里的旧 id 不拦路，读出来按当前位置纠正（写回发生在下次落盘）。
  meta.id = rel
  const parts = rel.split('/')
  return {
    id: rel,
    slug: rel,
    path: rel,
    parentPath: parts.length > 1 ? parts.slice(0, -1).join('/') : '',
    depth: parts.length - 1,
    dir,
    name: fields.name && fields.name !== '' ? fields.name : parts[parts.length - 1],
    description: fields.description || '',
    body,
    meta,
  }
}

export function readSkillBySlug(dataDir, slug) {
  try {
    const id = assertSafeRelPath(slug)
    return readSkill(skillDirOf(dataDir, id), id)
  } catch {
    return null
  }
}

/* -------------------------------------------------------------------------- */
/* 技能运行时（0.24.1）：召回后直接用技能里准备好的文件，而不是让模型重写       */
/* -------------------------------------------------------------------------- */

const SCRIPT_RUNNERS = new Map([
  ['.py', 'python'],
  ['.js', 'node'],
  ['.mjs', 'node'],
  ['.cjs', 'node'],
  ['.ps1', 'powershell -NoProfile -File'],
  ['.sh', 'bash'],
  ['.bat', 'cmd /c'],
  ['.cmd', 'cmd /c'],
])

/** .py → `python "<abs>"`；认不出的扩展名返回 null。 */
export function runnerForScript(file) {
  const runner = SCRIPT_RUNNERS.get(path.extname(String(file || '')).toLowerCase())
  return runner === undefined ? null : `${runner} "${file}"`
}

/** 技能包内这些目录不扫（构建产物/缓存），避免拖慢召回。 */
const PACKAGE_SKIP_DIRS = new Set(['node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', '.git', '.idea', '.vscode'])

function collectPackageFiles(dir, sub, out, depth, cap) {
  if (depth > 2 || out.length >= cap) return
  let entries = []
  try {
    entries = fs.readdirSync(path.join(dir, sub), { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (out.length >= cap) return
    if (entry.name.startsWith('.')) continue
    const rel = sub === '' ? entry.name : `${sub}/${entry.name}`
    const abs = path.join(dir, rel)
    if (entry.isDirectory()) {
      if (PACKAGE_SKIP_DIRS.has(entry.name)) continue
      collectPackageFiles(dir, rel, out, depth + 1, cap)
      continue
    }
    if (!entry.isFile()) continue
    let bytes = 0
    try {
      bytes = fs.statSync(abs).size
    } catch {
      bytes = 0
    }
    out.push({ path: rel, abs, bytes })
  }
}

/**
 * 技能运行时清单：把「召回后怎么直接用它」一次性给全。
 *
 * 为什么需要：模型拿到技能正文后，以前只有 `files: ['scripts/x.py']` 这种相对路径，
 * 不知道技能根在哪、该用什么解释器跑，于是常常自己重写一个等价脚本——技能就白沉淀了。
 * 这里给出绝对路径 + 可直接执行的命令，模型照 run 跑即可，省 token 也省一次试错。
 */
export function skillRuntimeOf(skill, options = {}) {
  const dir = String((skill && skill.dir) || '')
  if (dir === '') return null
  const cap = Number(options.cap) > 0 ? Number(options.cap) : 24
  const scripts = []
  collectPackageFiles(dir, SCRIPTS_DIRNAME, scripts, 0, cap)
  const references = []
  for (const sub of ['references', 'templates', 'assets', 'data', 'examples']) {
    collectPackageFiles(dir, sub, references, 0, cap)
  }
  const scriptRows = scripts.map((item) => ({
    path: item.path,
    abs: item.abs,
    bytes: item.bytes,
    run: runnerForScript(item.abs),
  }))
  const runnable = scriptRows.filter((item) => item.run !== null)
  return {
    dir,
    skillFile: path.join(dir, SKILL_FILENAME),
    scripts: scriptRows,
    references: references.slice(0, cap).map((item) => ({ path: item.path, abs: item.abs, bytes: item.bytes })),
    usage: runnable.length > 0
      ? '自带脚本优先：先按 scripts[].run 直接执行，不要重写等价脚本；只有脚本识别不了（锚点漂移、复制页同号等边界）才自己写。'
      : (scriptRows.length > 0
        ? '有脚本但认不出解释器：先看脚本头部（shebang/注释）再决定怎么执行，别重写等价脚本。'
        : '没有自带脚本：按正文步骤做。'),
  }
}

/**
 * 召回时的正文裁剪（0.24.1）：长正文以前直接切前 6000 字，末尾的「## Resources / ## 脚本」
 * 正好被切掉——而那里才是脚本用法。现在保留开头 + 最后一节，中间省略。
 * 两处切口（保留尾节的头部窗口、纯头部截断）都按字符边界收口，见 safeSliceEnd：
 * 不把 emoji 等代理对字符切成孤立码元（否则落盘/传输时 UTF-8 会变成 U+FFFD）。
 */
export function clipSkillBody(body, limit = 6000) {
  const raw = String(body || '')
  const cap = Number(limit) > 0 ? Number(limit) : 6000
  if (raw.length <= cap) return { text: raw, truncated: false }
  const headings = [...raw.matchAll(/^##\s+[^\n]*$/gmu)]
  const tailStart = headings.length > 0 ? headings[headings.length - 1].index : -1
  const tail = tailStart >= 0 ? raw.slice(tailStart) : ''
  if (tail !== '' && tail.length <= Math.floor(cap * 0.6)) {
    // 头部窗口的收尾点也要收在字符边界：emoji 等非 BMP 字符占 2 码元，按码元直切会切出孤立代理。
    const head = raw.slice(0, safeSliceEnd(raw, Math.max(0, cap - tail.length - 30)))
    return { text: `${head}\n…（中间省略）…\n${tail}`, truncated: true }
  }
  return { text: raw.slice(0, safeSliceEnd(raw, cap)), truncated: true }
}

/** 写技能目录（SKILL.md + skill.json）。 */
export function writeSkill(dir, draft, meta) {
  fs.mkdirSync(dir, { recursive: true })
  writeFileAtomic(path.join(dir, SKILL_FILENAME), renderSkillMd(draft.name, draft.description, draft.body))
  writeJsonFile(path.join(dir, META_FILENAME), stripMetaReadFlags(meta))
}

/* -------------------------------------------------------------------------- */
/* 附件（scripts/ + SKILL.md 的「## 脚本」节）                                  */
/* -------------------------------------------------------------------------- */

function safeAttachName(name) {
  const base = String(name || '').split(/[\\/]/).pop() || ''
  const cleaned = base.replace(/[^\w.\-]+/gu, '_').replace(/^\.+/u, '').slice(0, 80)
  if (cleaned === '' || cleaned === '.' || cleaned === '..') throw new Error(`附件文件名不可用：${base}`)
  return cleaned
}

function formatBytes(bytes) {
  const size = Number(bytes) || 0
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

/** 把附件写进 SKILL.md 的 `## 脚本` 节（保留原有其它节）。 */
function appendScriptsSection(dir, files) {
  const skillFile = path.join(dir, SKILL_FILENAME)
  const { fields, body } = parseFrontmatter(fs.readFileSync(skillFile, 'utf8'))
  const lines = String(body || '').split(/\r?\n/)
  const section = [
    '## 脚本',
    ...(files.length === 0 ? ['- （暂无附件）'] : files.map((item) => `- \`${item.path}\`（${formatBytes(item.bytes)}）`)),
    '',
    '> 运行前先确认解释器与依赖；命令示例可以补在对应条目下面。',
  ]
  const index = headingIndex(lines, '脚本')
  let next
  if (index >= 0) {
    const { to } = sectionBounds(lines, index)
    next = [...lines.slice(0, index), ...section, ...lines.slice(to)]
  } else {
    next = [...lines, '', ...section]
  }
  writeFileAtomic(skillFile, renderSkillMd(fields.name || path.basename(dir), fields.description || '', next.join('\n')))
}

function headingIndex(lines, title) {
  const pattern = new RegExp(`^##\\s+${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`)
  return lines.findIndex((line) => pattern.test(line))
}

function sectionBounds(lines, index) {
  let end = lines.length
  for (let i = index + 1; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i])) { end = i; break }
  }
  return { from: index + 1, to: end }
}

/**
 * 把「切到这里为止」的码元下标收到字符边界：`end` 落在代理对中间时退一位。
 * 只在 UTF-16 码元层面切片时用（emoji 等非 BMP 字符占 2 个码元）。
 */
function safeSliceEnd(value, end) {
  if (end <= 0) return 0
  if (end >= value.length) return value.length
  const before = value.charCodeAt(end - 1)
  if (before < 0xd800 || before > 0xdbff) return end
  const after = value.charCodeAt(end)
  return after >= 0xdc00 && after <= 0xdfff ? end - 1 : end
}

export {
  readJsonFile,
  writeJsonFile,
  stripMetaReadFlags,
  normalizeMeta,
  safeAttachName,
  formatBytes,
  appendScriptsSection,
  safeSliceEnd,
  headingIndex,
  sectionBounds,
}
