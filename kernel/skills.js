/**
 * 技能沉淀（0.29.0）：`.exp/skills/` 下每技能一个文件夹。
 *
 * - `SKILL.md`：标准技能模板（name/description + 正文），可直接注册；
 * - `skill.json`：引擎账本（confidence/obstacles/resolved/derivedFrom/pendingCommit）；
 * - 仓库根在 `.exp`（`.exp/.git`），引擎只提交 `skills/` 路径；
 * - 事件按「障碍签名」独立记录：干净成功给每个活跃签名各记 clean；
 *   同一签名连续 3 次 → 覆盖技能并归档，之后复发从 1 重新累计。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'

import { abstractState, stateSimilarity } from './kernel.js'

export const SKILLS_DIRNAME = 'skills'
export const SCRIPTS_DIRNAME = 'scripts'
const MAX_ATTACH_FILE_BYTES = 2 * 1024 * 1024
const MAX_ATTACH_TOTAL_BYTES = 8 * 1024 * 1024
export const SKILL_FILENAME = 'SKILL.md'
export const META_FILENAME = 'skill.json'
export const EXCEPTION_LIMIT = 5
export const RESOLVED_LIMIT = 20
export const EVENTS_LIMIT = 10
export const MATCH_MIN_SIMILARITY = 0.12
export const MATCH_AMBIGUITY_MARGIN = 0.15
export const CONFIDENT_MIN_USES = 3
export const CONFIDENT_MIN_RATIO = 0.8

const GIT_IDENTITY = ['-c', 'user.name=dsh-exp-lib', '-c', 'user.email=exp-lib@local']

export function skillsRootOf(dataDir) {
  return path.join(String(dataDir || ''), SKILLS_DIRNAME)
}

const RESERVED_SLUG = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/** slug 只允许字母/数字/中文/短横；拒绝穿越、保留名、尾点尾空格。 */
export function assertSafeSlug(value) {
  const slug = String(value || '')
  if (slug === '' || slug.length > 64) throw new Error('技能 slug 为空或超过 64 字符')
  if (!/^[a-z0-9\u4e00-\u9fa5][a-z0-9\u4e00-\u9fa5-]*$/i.test(slug)) throw new Error(`技能 slug 非法：${slug}`)
  if (slug.includes('..')) throw new Error(`技能 slug 不能包含 ..：${slug}`)
  if (RESERVED_SLUG.test(slug)) throw new Error(`技能 slug 不能是 Windows 保留名：${slug}`)
  if (/[. ]$/.test(slug)) throw new Error(`技能 slug 不能以点或空格结尾：${slug}`)
  return slug
}

const RESERVED_SEGMENT = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i
const ILLEGAL_SEGMENT = /[<>:"/\\|?*\u0000-\u001f]/

/**
 * 套件树里的一个路径段。
 *
 * 新建技能仍走 `assertSafeSlug`（严格小写短横线）；套件里的子目录要保住来源原名，
 * 所以这里放宽到「文件系统安全」：允许中文、空格、点、下划线，但拒绝穿越、
 * 非法字符、尾点/尾空格与 Windows 保留名。名字只在 skillsRoot 内解析，不拼绝对路径。
 */
export function assertSafePathSegment(value) {
  const name = String(value || '')
  if (name === '' || name === '.' || name === '..') throw new Error(`技能路径段非法：${name}`)
  if (name.length > 100) throw new Error(`技能路径段超过 100 字符：${name}`)
  if (ILLEGAL_SEGMENT.test(name)) throw new Error(`技能路径段含非法字符：${name}`)
  if (/[. ]$/.test(name)) throw new Error(`技能路径段不能以点或空格结尾：${name}`)
  if (RESERVED_SEGMENT.test(name)) throw new Error(`技能路径段不能是 Windows 保留名：${name}`)
  return name
}

/** 技能 id：相对 skillsRoot 的 POSIX 路径（`套件/子技能`），逐段校验。 */
export function assertSafeRelPath(value) {
  const raw = String(value || '')
  if (raw === '' || raw.length > 512) throw new Error('技能 id 为空或过长')
  if (raw.startsWith('/') || raw.endsWith('/') || raw.includes('\\')) throw new Error(`技能 id 非法：${raw}`)
  const parts = raw.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..')) throw new Error(`技能 id 含空段或穿越：${raw}`)
  for (const part of parts) assertSafePathSegment(part)
  return parts.join('/')
}

/** 目录是不是链接（symlink 或 Windows junction）。junction 的 lstat 不报 symlink，要读 readlink。 */
export function pathIsLink(target) {
  try {
    if (fs.lstatSync(target).isSymbolicLink()) return true
    return fs.readlinkSync(target) !== ''
  } catch {
    return false
  }
}

/** 在 skillsRoot 内解析技能目录；越界或链接直接拒绝。 */
export function skillDirOf(dataDir, id) {
  const safe = assertSafeRelPath(id)
  const root = path.resolve(skillsRootOf(dataDir))
  const dir = path.resolve(root, ...safe.split('/'))
  const rel = path.relative(root, dir)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`技能路径越界：${safe}`)
  try {
    if (pathIsLink(dir)) throw new Error(`技能目录不能是链接：${safe}`)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  // Windows junction 的 lstat 不是 symlink：用 realpath 再确认没有跳出 skillsRoot。
  try {
    const realpath = fs.realpathSync.native || fs.realpathSync
    const rootReal = realpath(root)
    const dirReal = realpath(dir)
    const realRel = path.relative(rootReal, dirReal)
    if (realRel === '' || realRel.startsWith('..') || path.isAbsolute(realRel)) {
      throw new Error(`技能目录越界（realpath）：${safe}`)
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  return dir
}

export function slugify(text) {
  const slug = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return slug === '' ? `skill-${Date.now().toString(36)}` : slug
}

/** 错误文本归一化：去路径/时间戳/行号，保留错误码与关键 token。 */
export function normalizeSignature(text) {
  let out = String(text || '').split(/\r?\n/)[0]
  out = out.toLowerCase()
  out = out.replace(/[a-z]:\\[^\s]+/g, ' ')
  out = out.replace(/\\\\[^\s]+/g, ' ')
  out = out.replace(/\d{4}-\d{2}-\d{2}[t ][\d:.]+z?/g, ' ')
  // 只去掉「行号」类数字，保留错误码/版本号（err-1、PS 5.1）。
  out = out.replace(/(?:line|行|第)\s*\d+(?:\s*行)?/gi, ' ')
  out = out.replace(/:\d+:\d+/g, ' ')
  out = out.replace(/\s+/g, ' ').trim()
  return out === '' ? 'obstacle' : out.slice(0, 80)
}

export function summarizeSignature(text) {
  const line = String(text || '').split(/\r?\n/)[0].replace(/\s+/g, ' ').trim()
  return line === '' ? '未命名障碍' : line.slice(0, 60)
}

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
  meta.files = Array.isArray(raw && raw.files)
    ? raw.files.filter((item) => item && typeof item.path === 'string').slice(0, 40)
    : []
  return meta
}

/** 从同族经验归纳出技能草稿：≥minSamples 条、≥2 正 ≥1 负、抽共同词与反例。 */
export function deriveSkillDraft(candidates, options = {}) {
  const intent = String(options.intent || '').trim()
  const minSamples = Math.max(2, Math.trunc(Number(options.minSamples) || 3))
  const rows = []
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    for (const evidence of candidate.evidence || []) {
      if (!rows.some((row) => row.id === evidence.id)) rows.push(evidence)
    }
  }
  const groups = new Map()
  for (const row of rows) {
    const key = String(row.typeName || '未分类')
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(row)
  }
  let best = null
  for (const [typeName, list] of groups) {
    if (best === null || list.length > best.list.length) best = { typeName, list }
  }
  if (best === null || best.list.length < minSamples) return null
  const positives = best.list.filter((row) => (Number(row.G) || 0) > 0)
  const negatives = best.list.filter((row) => (Number(row.G) || 0) < 0)
  if (positives.length < 2 || negatives.length === 0) return null
  const tokenFreq = (subset) => {
    const freq = new Map()
    for (const row of subset) {
      // 动作词优先：意图里通常只有「PPT/插页」这类主题词，抽进「做法」会把规则写空。
      let state = abstractState(String(row.action || ''))
      let tokens = new Set([...(state.tokens || []).filter((token) => String(token).length >= 2), ...(state.cgrams || [])])
      if (tokens.size === 0) {
        state = abstractState(`${row.intent || ''} ${row.action || ''}`)
        tokens = new Set([...(state.tokens || []).filter((token) => String(token).length >= 2), ...(state.cgrams || [])])
      }
      for (const token of tokens) if (String(token).length >= 2) freq.set(token, (freq.get(token) || 0) + 1)
    }
    return freq
  }
  const posFreq = tokenFreq(positives)
  const negFreq = tokenFreq(negatives)
  const need = Math.max(2, Math.ceil(positives.length * 0.6))
  const shared = [...posFreq.entries()].filter(([, count]) => count >= need).map(([token]) => token)
  const avoid = [...negFreq.keys()].filter((token) => !shared.includes(token))
  if (shared.length === 0 && avoid.length === 0) return null
  const label = options.name || `${best.typeName}：${shared[0] || avoid[0] || '经验'}`
  const positiveActions = [...new Set(positives.map((row) => String(row.action || '').trim()).filter(Boolean))].slice(0, 3)
  const negativeActions = [...new Set(negatives.map((row) => String(row.action || '').trim()).filter(Boolean))].slice(0, 3)
  const procedure = positiveActions.length > 0
    ? positiveActions.map((action) => `- 优先：${action.slice(0, 80)}`).join('\n')
    : '- （按经验做法执行）'
  const avoidLines = negativeActions.length > 0
    ? negativeActions.map((action) => `- 避免：${action.slice(0, 80)}`).join('\n')
    : '- （暂无明确反例）'
  return {
    slug: slugify(label),
    name: label.slice(0, 48),
    description: (intent || label).slice(0, 120),
    typeName: best.typeName,
    context: Array.isArray(options.context) ? options.context : [],
    triggers: [...shared, ...avoid].slice(0, 8),
    derivedFrom: best.list.map((row) => row.id),
    body: `# 何时用\n${intent || label}\n\n## 做法\n${procedure}\n\n## 避免\n${avoidLines}\n\n## 常见例外\n`,
  }
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
  if (!fs.existsSync(skillFile)) return null
  const { fields, body } = parseFrontmatter(fs.readFileSync(skillFile, 'utf8'))
  let rel = String(id || path.basename(dir)).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (rel === '') rel = path.basename(dir)
  const meta = normalizeMeta(readJsonFile(path.join(dir, META_FILENAME)), rel)
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

// 技能包里的这些目录不会放技能；跳过可避免为了找子技能去遍历上万个附件文件。
export const SKILL_SCAN_SKIP_DIRS = new Set([
  'node_modules', '.venv', 'venv', '__pycache__', '.idea', '.vscode', 'dist', 'build',
  'scripts', 'references', 'templates', 'assets', 'images', 'image', 'data', 'examples',
])

/**
 * 列出技能（递归）。
 *
 * 技能套件在磁盘上就是目录树：任何含 SKILL.md 的目录都是技能，中间目录只是收纳。
 * 所以这里递归扫描，子技能 id 是相对 skillsRoot 的路径（`套件/子技能`）。
 * options.onlyLocal=true 时不返回「已全局注册」的技能——它们已经交给 DSH 当真实技能用，
 * 经验库不再参与排序/召回，避免两个引擎同时抢着用它。
 */
export function listSkills(dataDir, options = {}) {
  const onlyLocal = options.onlyLocal === true
  const root = skillsRootOf(dataDir)
  if (!fs.existsSync(root)) return []
  const skills = []
  const visited = new Set()
  const walk = (dir, rel, depth) => {
    if (depth > 12) return
    let real = ''
    try {
      real = fs.realpathSync(dir)
    } catch {
      return
    }
    if (visited.has(real)) return
    visited.add(real)
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith('.')) continue
      if (SKILL_SCAN_SKIP_DIRS.has(entry.name)) continue
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
      let childDir
      try {
        childDir = skillDirOf(dataDir, childRel)
      } catch {
        continue
      }
      const skill = readSkill(childDir, childRel)
      if (skill !== null && (!onlyLocal || globalRegistrationOf(skill) === null)) skills.push(skill)
      walk(childDir, childRel, depth + 1)
    }
  }
  walk(path.resolve(root), '', 0)
  return skills.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
}

/** 写技能目录（SKILL.md + skill.json）。 */
export function writeSkill(dir, draft, meta) {
  fs.mkdirSync(dir, { recursive: true })
  writeFileAtomic(path.join(dir, SKILL_FILENAME), renderSkillMd(draft.name, draft.description, draft.body))
  writeJsonFile(path.join(dir, META_FILENAME), meta)
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

/**
 * 给技能挂脚本附件：复制到 `<skill>/scripts/`，登记进 skill.json 的 files，
 * 并在 SKILL.md 里维护「## 脚本」清单。这样技能才是可执行的完整包。
 */
export function attachSkillFiles(dataDir, slug, sources, options = {}) {
  const skill = readSkillBySlug(dataDir, slug)
  if (skill === null) throw new Error(`没有这个技能：${slug}`)
  const scriptsDir = path.join(skill.dir, SCRIPTS_DIRNAME)
  const files = Array.isArray(skill.meta.files) ? [...skill.meta.files] : []
  let total = files.reduce((sum, item) => sum + (Number(item.bytes) || 0), 0)
  const added = []
  for (const source of Array.isArray(sources) ? sources : []) {
    const raw = String(source || '').trim()
    if (raw === '') continue
    const resolved = path.resolve(raw)
    let stat
    try {
      stat = fs.statSync(resolved)
    } catch {
      throw new Error(`附件不存在：${raw}`)
    }
    if (!stat.isFile()) throw new Error(`附件不是文件：${raw}`)
    if (stat.size > MAX_ATTACH_FILE_BYTES) throw new Error(`单个附件不能超过 2MB：${raw}`)
    if (total + stat.size > MAX_ATTACH_TOTAL_BYTES) throw new Error(`附件总量不能超过 8MB（当前 ${formatBytes(total)}）`)
    fs.mkdirSync(scriptsDir, { recursive: true })
    const name = safeAttachName(resolved)
    const target = path.join(scriptsDir, name)
    fs.copyFileSync(resolved, target)
    const rel = `${SCRIPTS_DIRNAME}/${name}`
    const entry = {
      path: rel,
      bytes: stat.size,
      sha256: createHash('sha256').update(fs.readFileSync(target)).digest('hex'),
      addedAt: new Date().toISOString(),
    }
    const index = files.findIndex((item) => item.path === rel)
    if (index >= 0) files[index] = entry
    else files.push(entry)
    total += stat.size
    added.push(entry)
  }
  skill.meta.files = files
  appendScriptsSection(skill.dir, files)
  const committed = commitMeta(dataDir, path.join(skill.dir, META_FILENAME), skill.meta, `skill(${slug}): attach ${added.length} file(s)`)
  return { slug, files, added, commit: committed }
}


/** DSH 扫描「已安装技能」的目录（全局注册的落点）。 */
export function dshGlobalSkillsRoot(env = process.env) {
  const home = String((env && env.DSH_HOME) || '').trim()
  const base = home === '' ? path.join(os.homedir(), '.dsh') : path.resolve(home.replace(/^~(?=$|[\\/])/u, os.homedir()))
  return path.join(base, 'skills')
}

/** 这个技能是否已经在全局注册（被 DSH 当真实技能加载）。 */
export function globalRegistrationOf(skill) {
  const meta = skill && skill.meta ? skill.meta : {}
  const registered = meta.globalRegistered
  return registered && typeof registered.path === 'string' && registered.path !== '' ? registered : null
}

/**
 * 把一个技能链接进 DSH 的 skills 目录（用户手动点的动作，不是自动行为）。
 *
 * - 优先建 junction（Windows 上不需要管理员权限，且两边是同一份文件，改一处同步）；
 * - 链接建不出来才退回复制，并在 meta 里记 mode='copy'，取消注册时按记录删。
 * - 目标已被别人占用（不是指向本技能）时直接报错，绝不覆盖。
 */
export function registerSkillGlobally(dataDir, slug, options = {}) {
  const skill = readSkillBySlug(dataDir, slug)
  if (skill === null) throw new Error(`没有这个技能：${slug}`)
  const id = skill.id
  // 链接目标用叶子名：套件里的子技能也要能在 DSH 的 skills/ 下被单独加载。
  const leaf = id.split('/').pop()
  const root = path.resolve(options.root || dshGlobalSkillsRoot())
  fs.mkdirSync(root, { recursive: true })
  const target = path.join(root, leaf)
  let mode = 'junction'
  let link = null
  try {
    link = fs.readlinkSync(target)
  } catch {
    link = null
  }
  if (link !== null) {
    const resolved = path.resolve(root, link)
    if (resolved !== path.resolve(skill.dir)) throw new Error(`目标已被占用：${target}（指向 ${resolved}）`)
  } else if (fs.existsSync(target)) {
    throw new Error(`目标已被占用：${target}（不是经验库的链接，删掉或改名后再试）`)
  } else {
    try {
      fs.symlinkSync(skill.dir, target, 'junction')
    } catch {
      copyTree(skill.dir, target)
      mode = 'copy'
    }
  }
  skill.meta.globalRegistered = { path: target, at: new Date().toISOString(), mode }
  commitMeta(dataDir, path.join(skill.dir, META_FILENAME), skill.meta, `skill(${id}): register globally`)
  return { slug: id, id, leaf, targetDir: target, mode, registered: true }
}

/**
 * 取消全局注册：只删我们记下的那条链接/副本，别的一概不动。
 * 没注册过也不报错（幂等），返回 removed=false。
 */
export function unregisterSkillFromDsh(dataDir, slug) {
  const skill = readSkillBySlug(dataDir, slug)
  if (skill === null) throw new Error(`没有这个技能：${slug}`)
  const id = skill.id
  const leaf = id.split('/').pop()
  const registered = globalRegistrationOf(skill)
  const target = registered !== null ? registered.path : path.join(dshGlobalSkillsRoot(), leaf)
  const expected = path.join(path.dirname(target), leaf)
  let removed = false
  if (path.resolve(target) === path.resolve(expected)) {
    let isLink = false
    try {
      // Windows 的 junction 在 lstat 里被报成「目录 + 重解析点」，isSymbolicLink() 是 false，
      // 只认它就会永远删不掉链接——表现就是点了「取消注册」毫无反应。
      // readlinkSync 对 symlink 和 junction 都能读出目标，用它判更可靠。
      isLink = fs.lstatSync(target).isSymbolicLink() || fs.readlinkSync(target) !== ''
    } catch {
      isLink = false
    }
    if (isLink) {
      // 关键：**绝不能**对链接用递归删除。Windows 上 fs.rm(recursive) 会先顺着 junction
      // 进去把目标目录（也就是经验库里的技能）里的文件删光，再删掉链接本身——
      // 实测这一下直接把 `.exp/skills/<slug>/SKILL.md` 和 scripts/ 删了。
      // 删链接只能用 unlink（symlink）或 rmdir（junction），两者都不跟进去。
      try {
        try {
          fs.unlinkSync(target)
        } catch {
          fs.rmdirSync(target)
        }
        removed = true
      } catch {
        removed = false
      }
    } else if (fs.existsSync(target) && registered !== null && registered.mode === 'copy') {
      // 只有确认是我们自己复制的那份才删，避免误删用户手放的技能
      fs.rmSync(target, { recursive: true, force: true })
      removed = true
    }
  }
  delete skill.meta.globalRegistered
  commitMeta(dataDir, path.join(skill.dir, META_FILENAME), skill.meta, `skill(${id}): unregister globally`)
  return { slug: id, id, leaf, targetDir: target, removed, registered: false }
}

/**
 * 改技能的「分类 + 便签」这类元数据。
 * 技能套件常用：一个技能挂多个分类、加几条给人看的便签；这些不参与排序打分，只做标识。
 */
export function updateSkillMeta(dataDir, slug, patch = {}) {
  const skill = readSkillBySlug(dataDir, slug)
  if (skill === null) throw new Error(`没有这个技能：${slug}`)
  const meta = skill.meta
  if (patch.typeName !== undefined) meta.typeName = String(patch.typeName || '').trim()
  if (Array.isArray(patch.typeNames)) {
    meta.typeNames = patch.typeNames.map(String).map((item) => item.trim()).filter((item) => item !== '').slice(0, 12)
  }
  if (Array.isArray(patch.notes)) {
    meta.notes = patch.notes.map(String).map((item) => item.trim()).filter((item) => item !== '').slice(0, 50)
  }
  // 排序：新建默认高（90），用户可手动调；范围 0~100。
  if (patch.order !== undefined && Number.isFinite(Number(patch.order))) {
    meta.order = Math.max(0, Math.min(100, Math.round(Number(patch.order))))
  }
  const committed = commitMeta(dataDir, path.join(skill.dir, META_FILENAME), meta, `skill(${slug}): meta`)
  return { slug, typeName: meta.typeName, typeNames: meta.typeNames, notes: meta.notes, commit: committed }
}

/** 忘记技能 = 删除这个技能目录（注册着的先取消注册，免得留悬空链接）。 */
export function forgetSkill(dataDir, slug) {
  const skill = readSkillBySlug(dataDir, slug)
  if (skill === null) throw new Error(`没有这个技能：${slug}`)
  let unregistered = false
  if (globalRegistrationOf(skill) !== null) {
    try {
      unregistered = unregisterSkillFromDsh(dataDir, slug).removed
    } catch {
      unregistered = false
    }
  }
  if (pathIsLink(skill.dir)) throw new Error(`拒绝删除链接：${slug}`)
  fs.rmSync(skill.dir, { recursive: true, force: true })
  const committed = commitSkills(dataDir, `skill(${skill.id}): forget`)
  return { slug: skill.id, id: skill.id, deleted: true, unregistered, commit: committed }
}

/* -------------------------------------------------------------------------- */
/* 套件树（磁盘即结构）                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 由技能列表构建目录树。
 * 含 SKILL.md 的目录是技能节点（kind=skill）；只为收纳存在的中间目录是组节点（kind=group）。
 * skillCount / registeredCount 按子树累计。
 */
export function buildSkillTree(skills) {
  const input = Array.isArray(skills) ? skills : []
  const nodes = new Map()
  const roots = []
  const ensure = (id) => {
    const existing = nodes.get(id)
    if (existing) return existing
    const parts = id.split('/')
    const node = {
      path: id,
      name: parts[parts.length - 1],
      kind: 'group',
      depth: parts.length - 1,
      skillCount: 0,
      registeredCount: 0,
      skill: null,
      children: [],
    }
    nodes.set(id, node)
    if (parts.length === 1) roots.push(node)
    else ensure(parts.slice(0, -1).join('/')).children.push(node)
    return node
  }
  for (const skill of input) {
    if (!skill || typeof skill.id !== 'string' || skill.id === '') continue
    const node = ensure(skill.id)
    node.kind = 'skill'
    node.name = skill.name || node.name
    node.skill = skill
  }
  const count = (node) => {
    let total = node.kind === 'skill' ? 1 : 0
    // 内核技能对象带 meta.globalRegistered 记录；界面行只有 globalRegistered 布尔，两种都认。
    let registered = node.skill
      ? (node.skill.globalRegistered === true || globalRegistrationOf(node.skill) !== null ? 1 : 0)
      : 0
    for (const child of node.children) {
      const sub = count(child)
      total += sub.total
      registered += sub.registered
    }
    node.skillCount = total
    node.registeredCount = registered
    node.childCount = Math.max(0, total - (node.kind === 'skill' ? 1 : 0))
    node.children.sort((left, right) => left.name.localeCompare(right.name, 'zh'))
    return { total, registered }
  }
  for (const root of roots) count(root)
  roots.sort((left, right) => left.name.localeCompare(right.name, 'zh'))
  return roots
}

/** 某个节点下的所有技能（含自身）。组节点就是整棵子树。 */
export function subtreeSkills(skills, nodePath) {
  const id = assertSafeRelPath(nodePath)
  const list = Array.isArray(skills) ? skills : []
  return list.filter((skill) => skill.id === id || skill.id.startsWith(`${id}/`))
}

/** 在树里按路径找节点；找不到返回 null。 */
export function findSkillTreeNode(tree, nodePath) {
  const id = assertSafeRelPath(nodePath)
  const stack = Array.isArray(tree) ? [...tree] : []
  while (stack.length > 0) {
    const node = stack.pop()
    if (node.path === id) return node
    if (Array.isArray(node.children) && node.children.length > 0) stack.push(...node.children)
  }
  return null
}

function assertNodeExists(dataDir, nodePath) {
  const id = assertSafeRelPath(nodePath)
  const skills = listSkills(dataDir)
  const members = subtreeSkills(skills, id)
  if (members.length === 0) throw new Error(`没有这个节点：${id}`)
  return { id, skills, members }
}

/** 子树注册到全局：逐项执行，单项失败不中断。 */
export function registerSkillTree(dataDir, nodePath, options = {}) {
  const { id, members } = assertNodeExists(dataDir, nodePath)
  const results = []
  const failed = []
  for (const skill of members) {
    try {
      results.push(registerSkillGlobally(dataDir, skill.id, options))
    } catch (error) {
      failed.push({ path: skill.id, message: error && error.message ? error.message : String(error) })
    }
  }
  return { action: 'register', path: id, total: members.length, ok: results.length, failed, results }
}

/** 子树取消注册：逐项执行，单项失败不中断。 */
export function unregisterSkillTree(dataDir, nodePath) {
  const { id, members } = assertNodeExists(dataDir, nodePath)
  const results = []
  const failed = []
  for (const skill of members) {
    if (globalRegistrationOf(skill) === null) continue
    try {
      results.push(unregisterSkillFromDsh(dataDir, skill.id))
    } catch (error) {
      failed.push({ path: skill.id, message: error && error.message ? error.message : String(error) })
    }
  }
  return { action: 'unregister', path: id, total: members.length, ok: results.length, failed, results }
}

/**
 * 子树删除：先按 expect 校验数量（防 UI 过期），再逐个取消注册，最后删节点目录。
 * 节点目录必须是普通目录；链接一律拒绝（删链接会连带删目标，11-10 踩过）。
 */
export function forgetSkillTree(dataDir, nodePath, options = {}) {
  const { id, members } = assertNodeExists(dataDir, nodePath)
  const expect = Number(options.expect)
  if (!Number.isFinite(expect)) throw new Error('删除节点必须带 expect（子树技能数）')
  if (expect !== members.length) throw new Error(`数量不匹配：预期 ${expect}，实际 ${members.length}（列表可能已过期，刷新后再试）`)
  const unregistered = []
  const failed = []
  for (const skill of members) {
    if (globalRegistrationOf(skill) === null) continue
    try {
      if (unregisterSkillFromDsh(dataDir, skill.id).removed) unregistered.push(skill.id)
    } catch (error) {
      failed.push({ path: skill.id, message: error && error.message ? error.message : String(error) })
    }
  }
  if (failed.length > 0) {
    // 还有注册没摘干净就删目录会留悬空链接：整单拒绝，让用户重试。
    throw new Error(`有 ${failed.length} 个技能取消注册失败，已停止删除：${failed.map((item) => item.path).join('、')}`)
  }
  const dir = skillDirOf(dataDir, id)
  if (!fs.existsSync(dir)) throw new Error(`没有这个节点目录：${id}`)
  if (pathIsLink(dir)) throw new Error(`拒绝删除链接：${id}`)
  fs.rmSync(dir, { recursive: true, force: true })
  const committed = commitSkills(dataDir, `skill(${id}): forget subtree (${members.length})`)
  return { action: 'forget', path: id, deleted: true, total: members.length, unregistered, failed, commit: committed }
}

/** 按磁盘现状重写所有技能的 skill.json.id（移动目录后调用）。 */
export function rewriteSkillIds(dataDir) {
  let changed = 0
  for (const skill of listSkills(dataDir)) {
    const metaPath = path.join(skill.dir, META_FILENAME)
    if (!fs.existsSync(metaPath)) continue
    const raw = readJsonFile(metaPath)
    if (raw === null || typeof raw !== 'object') continue
    if (raw.id === skill.id) continue
    raw.id = skill.id
    writeJsonFile(metaPath, raw)
    changed += 1
  }
  return changed
}

/** 把子技能移出套件（移到顶层）。顶层重名直接拒绝，不覆盖。 */
export function moveSkillToTop(dataDir, nodePath) {
  const id = assertSafeRelPath(nodePath)
  const skill = readSkillBySlug(dataDir, id)
  if (skill === null) throw new Error(`没有这个技能：${id}（组节点不能移出）`)
  const parts = id.split('/')
  if (parts.length < 2) return { action: 'detach', path: id, moved: false, to: id }
  const leaf = parts[parts.length - 1]
  const target = skillDirOf(dataDir, leaf)
  if (fs.existsSync(target)) throw new Error(`顶层已有同名技能：${leaf}（先改名或移走）`)
  fs.renameSync(skill.dir, target)
  rewriteSkillIds(dataDir)
  const committed = commitSkills(dataDir, `skill(${id}): detach to top`)
  return { action: 'detach', path: id, moved: true, to: leaf, commit: committed }
}

/** 通用节点动作入口（shell 只调这一个）。 */
export function applySkillNodeAction(dataDir, action, nodePath, options = {}) {
  const name = String(action || '').trim().toLowerCase()
  if (name === 'register') return registerSkillTree(dataDir, nodePath, options)
  if (name === 'unregister') return unregisterSkillTree(dataDir, nodePath)
  if (name === 'forget') return forgetSkillTree(dataDir, nodePath, options)
  if (name === 'detach') return moveSkillToTop(dataDir, nodePath)
  throw new Error(`不认识的节点动作：${action}`)
}

function copyTree(fromDir, toDir) {
  fs.mkdirSync(toDir, { recursive: true })
  for (const entry of fs.readdirSync(fromDir, { withFileTypes: true })) {
    const from = path.join(fromDir, entry.name)
    const to = path.join(toDir, entry.name)
    if (entry.isDirectory()) copyTree(from, to)
    else fs.copyFileSync(from, to)
  }
}

/* -------------------------------------------------------------------------- */
/* git                                                                        */
/* -------------------------------------------------------------------------- */
/* -------------------------------------------------------------------------- */
/* git                                                                        */
/* -------------------------------------------------------------------------- */

function gitRun(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: 'ignore',
    // 技能树可以上万文件：git add/commit 会超过 15s，超时被杀会留下 index.lock 并让后续提交永久失败。
    timeout: 300000,
    windowsHide: true,
  })
}

function gitCapture(cwd, args) {
  // 沙箱里 git 输出接 pipe 会 EPERM（实测），和 artifact-diff 一样落临时文件再读。
  const tmp = path.join(os.tmpdir(), `engram-gitcap-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`)
  let fd = null
  try {
    fd = fs.openSync(tmp, 'w')
    execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', fd, 'ignore'],
      timeout: 300000,
      windowsHide: true,
    })
    fs.closeSync(fd)
    fd = null
    return fs.readFileSync(tmp, 'utf8')
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        // 已关闭
      }
    }
    try {
      fs.unlinkSync(tmp)
    } catch {
      // 临时文件不存在
    }
  }
}

export function ensureSkillsRepo(dataDir) {
  const root = skillsRootOf(dataDir)
  fs.mkdirSync(root, { recursive: true })
  const attributes = path.join(root, '.gitattributes')
  if (!fs.existsSync(attributes)) fs.writeFileSync(attributes, '* text=auto eol=lf\n', 'utf8')
  if (!fs.existsSync(path.join(dataDir, '.git'))) {
    gitRun(dataDir, ['init'])
  }
}

/**
 * 写 meta 并提交：提交前先把 pendingCommit 置 false（提交快照里就是 false），失败再置 true。
 * 只置 true 不复位会让 UI 永远显示「待补提交」（技能复验发现）。
 */
function commitMeta(dataDir, metaFile, meta, message) {
  meta.pendingCommit = false
  writeJsonFile(metaFile, meta)
  const committed = commitSkills(dataDir, message)
  if (!committed) {
    meta.pendingCommit = true
    writeJsonFile(metaFile, meta)
  }
  return committed
}

/** 提交 skills/ 路径；失败返回 false（写入仍然保留，调用方记 pendingCommit）。 */
function skillWarningFor(skill, intent) {
  if (!skill) return null
  const text = [skill.name, skill.description, ...(skill.meta.triggers || []), ...(skill.meta.context || [])].join(' ')
  const similarity = stateSimilarity(abstractState(String(intent || '')), abstractState(text))
  // 中文短意图与技能描述的词面相似度天然很低（正确技能实测 0.035），阈值压到 0.01：
  // 只有几乎零重叠才提示「可能写错」，避免正常调用被误报。
  return similarity < 0.01
    ? `skillId 与 intent 的相似度只有 ${Math.round(similarity * 100) / 100}，确认没有写错技能（账本已按该 id 更新）。`
    : null
}

function withSkillLock(dataDir, slug, fn, options = {}) {
  const lockDir = path.join(String(dataDir || ''), '.locks')
  fs.mkdirSync(lockDir, { recursive: true })
  // 套件子技能的 id 带 `/`，不能直接当文件名：压成单段，避免把锁写到不存在的子目录。
  const lockName = String(slug || '').replace(/[^\w.\u4e00-\u9fa5-]+/gu, '_').slice(0, 120) || 'skill'
  const lockFile = path.join(lockDir, `${lockName}.lock`)
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : 2000
  const staleMs = Number.isFinite(Number(options.staleMs)) ? Number(options.staleMs) : 5000
  const deadline = Date.now() + timeoutMs
  let fd = null
  while (fd === null) {
    try {
      fd = fs.openSync(lockFile, 'wx')
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      try {
        const stat = fs.statSync(lockFile)
        if (Date.now() - stat.mtimeMs > staleMs) {
          fs.unlinkSync(lockFile)
          continue
        }
      } catch {
        // 锁刚被释放：重试
      }
      if (Date.now() > deadline) return { busy: true }
      sleepSync(20)
    }
  }
  try {
    fs.writeSync(fd, `${process.pid} ${Date.now()}`)
  } finally {
    try { fs.closeSync(fd) } catch { /* 忽略 */ }
  }
  try {
    return { value: fn() }
  } finally {
    try { fs.unlinkSync(lockFile) } catch { /* 锁已不存在也正常 */ }
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

export function commitSkills(dataDir, message) {
  // 上一次被超时杀掉的 git 会留下 index.lock：超过 10 分钟（> 300s git 超时）的视为残留，清掉再提交。
  // 阈值必须大于 git 超时，否则长提交（13k 文件实测 86–132s）会被后来者误删活锁。
  // 仓库根在 dataDir/.git（ensureSkillsRepo 在 dataDir 初始化），不是 dataDir/skills/.git。
  try {
    const lock = path.join(String(dataDir || ''), '.git', 'index.lock')
    if (fs.existsSync(lock) && Date.now() - fs.statSync(lock).mtimeMs > 600000) fs.unlinkSync(lock)
  } catch {
    // 清锁失败不阻断：让 git 自己报错
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      ensureSkillsRepo(dataDir)
      // 没有变更 = 已经在 git 里了（例如同一目录被上一次提交带上），不算失败。
      const dirty = gitCapture(dataDir, ['status', '--porcelain', '--', SKILLS_DIRNAME])
      if (dirty !== null && dirty.trim() === '') return true
      gitRun(dataDir, ['add', '--', SKILLS_DIRNAME])
      // 只提交 skills/ 路径：用户已 staged 的其它文件不能被顺带提交。
      gitRun(dataDir, [...GIT_IDENTITY, 'commit', '-m', message, '--', SKILLS_DIRNAME])
      return true
    } catch {
      if (attempt < 2) sleepSync(50 * (attempt + 1))
    }
  }
  return false
}

/* -------------------------------------------------------------------------- */
/* 创建                                                                       */
/* -------------------------------------------------------------------------- */

function defaultBody(draft) {
  return `# 何时用\n${draft.description || draft.name}\n\n## 做法\n${draft.procedure || '- （待补充）'}\n\n## 常见例外\n`
}

function mergeSkillBodies(existingBody, draftBody) {
  let merged = String(draftBody || '').trim()
  const existing = String(existingBody || '').split(/\r?\n/)
  for (const title of ['常见例外', '已内化']) {
    const index = headingIndex(existing, title)
    if (index < 0) continue
    const { from, to } = sectionBounds(existing, index)
    const content = existing.slice(from, to).filter((line) => line.trim() !== '')
    if (!content.some((line) => /^-\s/.test(line))) continue
    const draftLines = merged.split(/\r?\n/)
    const draftIndex = headingIndex(draftLines, title)
    if (draftIndex >= 0) {
      const bounds = sectionBounds(draftLines, draftIndex)
      draftLines.splice(draftIndex, bounds.to - draftIndex)
    }
    merged = draftLines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()
    merged += `\n\n## ${title}\n${content.join('\n')}`
  }
  return `${merged.trim()}\n`
}

/** 创建/更新技能（带锁）：同一 id 的读-改-写串行。id 可以是套件里的相对路径。 */
export function createSkill(dataDir, draft) {
  const id = assertSafeRelPath(draft.id || draft.slug || slugify(draft.name))
  const locked = withSkillLock(dataDir, id, () => createSkillUnlocked(dataDir, { ...draft, id }))
  if (locked.busy === true) throw new Error(`技能正在被另一个进程写入：${id}`)
  return locked.value
}

function persistSkill(dataDir, dir, draft, meta, message) {
  meta.pendingCommit = false
  writeSkill(dir, draft, meta)
  const committed = commitSkills(dataDir, message)
  if (!committed) {
    meta.pendingCommit = true
    writeJsonFile(path.join(dir, META_FILENAME), meta)
  }
  return committed
}

function createSkillUnlocked(dataDir, draft) {
  const id = assertSafeRelPath(draft.id || draft.slug || slugify(draft.name))
  const dir = skillDirOf(dataDir, id)
  const existing = readSkill(dir, id)
  const action = existing === null ? 'created' : 'updated'
  const meta = existing === null ? defaultMeta(id) : existing.meta
  meta.id = id
  meta.typeName = draft.typeName || meta.typeName || ''
  if (Array.isArray(draft.typeNames)) meta.typeNames = draft.typeNames.map(String).map((item) => item.trim()).filter((item) => item !== '').slice(0, 12)
  if (Array.isArray(draft.notes)) meta.notes = draft.notes.map(String).map((item) => item.trim()).filter((item) => item !== '').slice(0, 50)
  meta.context = Array.isArray(draft.context) ? draft.context : meta.context
  meta.triggers = Array.isArray(draft.triggers) ? draft.triggers : meta.triggers
  if (draft.order !== undefined && Number.isFinite(Number(draft.order))) {
    meta.order = Math.max(0, Math.min(100, Math.round(Number(draft.order))))
  }
  if (Array.isArray(draft.derivedFrom)) {
    meta.derivedFrom = [...new Set([...meta.derivedFrom, ...draft.derivedFrom.map(String)])].slice(0, 50)
  }
  const body = typeof draft.body === 'string' && draft.body.trim() !== ''
    ? (existing !== null ? mergeSkillBodies(existing.body, draft.body) : draft.body.trim())
    : (existing !== null ? existing.body : defaultBody(draft))
  const message = action === 'created'
    ? `skill: ${id} — 创建（源自 ${meta.derivedFrom.length} 条经验）`
    : `skill: ${id} — 更新定义`
  const committed = persistSkill(dataDir, dir, {
    name: draft.name || (existing !== null ? existing.name : id),
    description: draft.description || (existing !== null ? existing.description : ''),
    body,
  }, meta, message)
  return { action, slug: id, id, dir, commit: committed }
}

/* -------------------------------------------------------------------------- */
/* 计数与修订                                                                  */
/* -------------------------------------------------------------------------- */

export function highConfidence(meta) {
  const confidence = (meta && meta.confidence) || {}
  const helped = Number(confidence.helped) || 0
  const hurt = Number(confidence.hurt) || 0
  const uses = helped + hurt
  const ratio = uses === 0 ? 0 : helped / uses
  const open = Object.values((meta && meta.obstacles) || {}).some((entry) => (Number(entry.streak) || 0) >= 3)
  return uses >= CONFIDENT_MIN_USES && ratio >= CONFIDENT_MIN_RATIO && !open
}

/** 给模型看的置信说明：helped 比例 + 未解决连续障碍。 */
export function confidenceReason(meta) {
  const confidence = (meta && meta.confidence) || {}
  const helped = Number(confidence.helped) || 0
  const hurt = Number(confidence.hurt) || 0
  const uses = helped + hurt
  const ratio = uses === 0 ? 0 : Math.round((helped / uses) * 100) / 100
  const open = Object.entries((meta && meta.obstacles) || {})
    .filter(([, entry]) => (Number(entry.streak) || 0) >= 3)
    .map(([signature]) => signature)
  return `helped ${helped}/${uses}（比例 ${ratio}）${open.length > 0 ? `；未解决连续障碍：${open.join('、')}` : '；无未解决连续障碍'}`
}

/** 校验单个技能的账本/正文不变量；返回问题数组（空 = 健康）。 */
export function validateSkill(skill) {
  if (!skill) return ['技能为空']
  const problems = []
  if (!skill.name) problems.push('name 为空')
  if (!skill.description) problems.push('description 为空')
  const meta = skill.meta || {}
  const confidence = meta.confidence || {}
  const uses = Number(confidence.uses) || 0
  const helped = Number(confidence.helped) || 0
  const hurt = Number(confidence.hurt) || 0
  if (uses !== helped + hurt) problems.push('uses != helped + hurt')
  if (helped < 0 || hurt < 0 || uses < 0) problems.push('confidence 出现负数')
  if (typeof meta.pendingCommit !== 'boolean') problems.push('pendingCommit 不是布尔')
  for (const file of Array.isArray(meta.files) ? meta.files : []) {
    if (!file || typeof file.path !== 'string' || file.path.trim() === '') {
      problems.push('files 有条目缺少 path')
      continue
    }
    const abs = path.join(skill.dir || '', file.path)
    if (skill.dir === undefined || !fs.existsSync(abs)) problems.push(`附件缺失：${file.path}`)
  }
  const obstacles = meta.obstacles && typeof meta.obstacles === 'object' ? meta.obstacles : {}
  for (const [signature, entry] of Object.entries(obstacles)) {
    const total = Number(entry.total) || 0
    const streak = Number(entry.streak) || 0
    if (total < 0 || streak < 0) problems.push(`活跃签名 ${signature} 出现负数`)
    if (total < streak) problems.push(`活跃签名 ${signature}：total < streak`)
    if (Array.isArray(entry.events) && entry.events.length > EVENTS_LIMIT) problems.push(`活跃签名 ${signature}：events > ${EVENTS_LIMIT}`)
  }
  const resolved = Array.isArray(meta.resolved) ? meta.resolved : []
  if (resolved.length > RESOLVED_LIMIT) problems.push(`resolved > ${RESOLVED_LIMIT}`)
  const seen = new Set()
  for (const item of resolved) {
    const signature = String((item && item.signature) || '')
    if (seen.has(signature)) problems.push(`resolved 重复：${signature}`)
    seen.add(signature)
    if (obstacles[signature]) problems.push(`签名同时活跃与归档：${signature}`)
  }
  const headings = String(skill.body || '').split(/\r?\n/).filter((line) => /^##\s/.test(line)).map((line) => line.replace(/^##\s+/, '').trim())
  for (const title of ['常见例外', '已内化']) {
    if (headings.filter((heading) => heading === title).length > 1) problems.push(`正文重复段：${title}`)
  }
  return problems
}

/** 扫描全部技能并返回有问题的条目。 */
export function validateAllSkills(dataDir) {
  return listSkills(dataDir)
    .map((skill) => ({ slug: skill.slug, problems: validateSkill(skill) }))
    .filter((item) => item.problems.length > 0)
}

/** 查询拆成可比较的单元（英文 token + 中文字二元组），小写去重。 */
function queryUnits(query) {
  return [...new Set([...(query.tokens || []), ...(query.cgrams || [])]
    .map((unit) => String(unit || '').toLowerCase())
    .filter((unit) => unit.length > 1))]
}

/**
 * 查询单元的 IDF 权重：在越少技能里出现的词越值钱。
 * 「左右镜像」「编程板」「页码」这种专有短语权重高，「课件」「程序」这种到处都是的权重低——
 * 否则套件总入口那段超长描述会把所有意图都吸走。
 */
function unitIdf(units, corpusTexts) {
  const total = Math.max(1, corpusTexts.length)
  const idf = new Map()
  for (const unit of units) {
    let df = 0
    for (const text of corpusTexts) {
      if (text.includes(unit)) df += 1
    }
    idf.set(unit, Math.log(1 + total / (1 + df)))
  }
  return idf
}

/** 加权覆盖率：命中单元的权重和 / 查询总权重。 */
function weightedCoverage(units, idf, candidateText) {
  const text = String(candidateText || '')
  let total = 0
  let hit = 0
  for (const unit of units) {
    const weight = idf.get(unit) || 0
    total += weight
    if (text.includes(unit)) hit += weight
  }
  return total === 0 ? 0 : hit / total
}

export function matchSkill(skills, intent, options = {}) {
  const list = Array.isArray(skills) ? skills : []
  const query = abstractState(String(intent || ''))
  const queryContext = Array.isArray(options.context) ? options.context.map((tag) => String(tag).toLowerCase()) : []
  const units = queryUnits(query)
  const corpusTexts = list.map((skill) => [skill.name, skill.description, ...(skill.meta.triggers || []), ...(skill.meta.context || [])].join(' ').toLowerCase())
  const idf = unitIdf(units, corpusTexts)
  const candidates = []
  for (let index = 0; index < list.length; index += 1) {
    const skill = list[index]
    if (options.requireConfident !== false && !highConfidence(skill.meta)) continue
    const text = corpusTexts[index]
    const headText = [skill.name, String(skill.description || '').slice(0, 160)].join(' ').toLowerCase()
    const jaccardScore = stateSimilarity(query, abstractState(text))
    const coverage = weightedCoverage(units, idf, text)
    const headCoverage = weightedCoverage(units, idf, headText)
    // 三块拼起来：
    // ① jaccard 兜通用词面；② 加权覆盖率补「关键短语命中」；
    // ③ 名称/描述前 160 字的覆盖率再给一次加成——技能真正讲的主题通常在开头，
    //    这样「编程板」「研学」这类开头就点题的技能不会被长描述或套件入口挤掉。
    // 另按描述长度做 specificity：超长描述（套件总入口 600+ 字）命中一切，需要压一档。
    const specificity = Math.min(1, 500 / Math.max(200, text.length))
    const similarity = jaccardScore + coverage * (0.2 + jaccardScore) * specificity + 0.25 * headCoverage 
    if (similarity < (Number(options.minSimilarity) || MATCH_MIN_SIMILARITY)) continue
    let contextScore = 0
    if (queryContext.length > 0) {
      const tags = (skill.meta.context || []).map((tag) => String(tag).toLowerCase())
      if (tags.length > 0) {
        const hit = queryContext.filter((tag) => tags.includes(tag)).length
        // 情境不匹配 = 技能不适用于当前环境：直接跳过，而不是只少加一点分。
        if (hit === 0) continue
        contextScore = hit / queryContext.length
      }
    }
    // 刚加进来的技能（还没被用过）给一点「新鲜度」加成：先让它有机会被触发，
    // 一有反馈（uses>0）就回落，排序随实际使用回归正常。
    const freshBoost = (Number((skill.meta.confidence || {}).uses) || 0) === 0 ? 0.06 : 0
    const score = similarity + contextScore * 0.1 + freshBoost
    // 命中词：把「query 的哪些词在这个技能里找到了」一起带出去，
    // 让模型能自查相关性（命中词跟任务明显无关 = 错配，应该换 intent 重试）。
    const matchedTerms = units.filter((unit) => text.includes(unit)).slice(0, 8)
    candidates.push({ skill, score, size: text.length, matchedTerms })
  }
  if (candidates.length === 0) return null
  candidates.sort((left, right) => right.score - left.score)
  const top = candidates[0]
  if (candidates.length === 1) return top
  const second = candidates[1]
  // 分数接近时不再直接放弃（交回经验列表），而是选「更具体」的那个：
  // 套件总入口 / 合集类技能描述长、什么都沾一点，同一个主题下应该让给专门的子技能。
  // 只有两者长度也接近才放弃，避免「随机选一个」。
  if (second.score >= top.score * (1 - MATCH_AMBIGUITY_MARGIN)) {
    const tight = Math.min(top.score, second.score) / Math.max(top.score, second.score)
    if (tight >= 0.92) {
      const specific = top.size <= second.size ? top : second
      const other = specific === top ? second : top
      if (specific.size >= other.size * 0.9) return null
      return specific
    }
    return null
  }
  return top
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

function upsertBullet(lines, title, key, text) {
  let index = headingIndex(lines, title)
  if (index < 0) {
    lines.push('', `## ${title}`, text)
    return
  }
  const { from, to } = sectionBounds(lines, index)
  for (let i = from; i < to; i += 1) {
    if (lines[i].startsWith(`- ${key}`)) { lines[i] = text; return }
  }
  lines.splice(to, 0, text)
}

function removeBullet(lines, title, key) {
  const index = headingIndex(lines, title)
  if (index < 0) return
  const { from, to } = sectionBounds(lines, index)
  for (let i = from; i < to; i += 1) {
    if (lines[i].startsWith(`- ${key}`)) {
      lines.splice(i, 1)
      break
    }
  }
  // 删掉空标题，避免正文残留「## 已内化」空段。
  const freshIndex = headingIndex(lines, title)
  if (freshIndex < 0) return
  const fresh = sectionBounds(lines, freshIndex)
  if (lines.slice(fresh.from, fresh.to).some((line) => line.trim() !== '')) return
  let end = freshIndex + 1
  while (end < lines.length && lines[end].trim() === '') end += 1
  lines.splice(freshIndex, end - freshIndex)
  if (freshIndex > 0 && lines[freshIndex - 1].trim() === '' && (freshIndex >= lines.length || lines[freshIndex].trim() === '')) lines.splice(freshIndex - 1, 1)
}

function pruneBullets(lines, title, limit, mergeLabel) {
  const index = headingIndex(lines, title)
  if (index < 0) return
  const { from, to } = sectionBounds(lines, index)
  const bullets = []
  for (let i = from; i < to; i += 1) if (/^-\s/.test(lines[i])) bullets.push(i)
  if (bullets.length <= limit) return
  const dropCount = bullets.length - limit + 1
  const drop = bullets.slice(0, dropCount)
  for (const lineNumber of [...drop].reverse()) lines.splice(lineNumber, 1)
  const freshIndex = headingIndex(lines, title)
  const fresh = sectionBounds(lines, freshIndex)
  lines.splice(fresh.to, 0, `- ${mergeLabel}（合并 ${dropCount} 条）`)
}

function exceptionText(label, total, now) {
  return `- ${label}（出现 ${total} 次，最近 ${now.slice(0, 10)}）`
}

function normalizeBody(lines) {
  const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n\n(?=-\s)/g, '\n')
  return `${text.trimEnd()}\n`
}

function applyObstacle(skill, signature, label, now) {
  const meta = skill.meta
  const obstacles = meta.obstacles
  const lines = String(skill.body || '').split(/\r?\n/)
  const existing = obstacles[signature]
  if (existing === undefined) {
    const revived = meta.resolved.some((item) => item.signature === signature)
    obstacles[signature] = { total: 1, streak: 1, events: ['hit'], lastAt: now, label }
    if (revived) {
      removeBullet(lines, '已内化', label)
      meta.resolved = meta.resolved.filter((item) => item.signature !== signature)
    }
    upsertBullet(lines, '常见例外', label, exceptionText(label, 1, now))
    pruneBullets(lines, '常见例外', EXCEPTION_LIMIT, '其它历史例外')
    return { action: revived ? 'reopened' : 'appended', total: 1, streak: 1, body: normalizeBody(lines) }
  }
  existing.total += 1
  existing.streak = (Number(existing.streak) || 0) + 1
  existing.events = [...(existing.events || []), 'hit'].slice(-EVENTS_LIMIT)
  existing.lastAt = now
  if (existing.streak < 3) {
    upsertBullet(lines, '常见例外', existing.label, exceptionText(existing.label, existing.total, now))
    pruneBullets(lines, '常见例外', EXCEPTION_LIMIT, '其它历史例外')
    return { action: 'appended', total: existing.total, streak: existing.streak, body: normalizeBody(lines) }
  }
  // 连续第 3 次：覆盖并归档该签名。
  const finalTotal = existing.total
  removeBullet(lines, '常见例外', existing.label)
  upsertBullet(lines, '已内化', existing.label, `- ${existing.label}（${now.slice(0, 10)} 覆盖）`)
  pruneBullets(lines, '已内化', 10, '更早的内化记录')
  meta.resolved = [...meta.resolved, {
    signature,
    total: finalTotal,
    revisions: (Number(meta.revisions) || 0) + 1,
    archivedAt: now,
  }].slice(-RESOLVED_LIMIT)
  meta.revisions = (Number(meta.revisions) || 0) + 1
  delete obstacles[signature]
  return { action: 'replaced', total: finalTotal, streak: 0, body: normalizeBody(lines) }
}

function commitFor(action, slug, signature) {
  if (action === 'replaced') return `skill: ${slug} — 连续 3 次障碍，覆盖并归档（sig: ${signature}）`
  if (action === 'reopened') return `skill: ${slug} — 复发重新累计（sig: ${signature}）`
  return `skill: ${slug} — 追加例外（sig: ${signature}）`
}

/** 撞到障碍：按签名计数，追加/覆盖/复发。 */
function applySkillObstacleUnlocked(dataDir, slug, options = {}) {
  let dir
  try {
    dir = skillDirOf(dataDir, slug)
  } catch {
    return { action: 'invalid', slug }
  }
  const skill = readSkill(dir, slug)
  if (skill === null) return { action: 'missing', slug }
  const signature = normalizeSignature(options.signature || options.blockedBy || 'obstacle')
  const label = options.label || summarizeSignature(options.signature || options.blockedBy || signature)
  const now = new Date().toISOString()
  const result = applyObstacle(skill, signature, label, now)
  const committed = persistSkill(dataDir, dir, { name: skill.name, description: skill.description, body: result.body }, skill.meta, commitFor(result.action, slug, signature))
  const warning = skillWarningFor(skill, options.intent)
  return { ...result, slug, signature, commit: committed, ...(warning ? { warning } : {}) }
}

/** 撞到障碍（带锁）：同一技能串行，避免并发丢更新。 */
export function applySkillObstacle(dataDir, slug, options = {}) {
  let dir
  try {
    dir = skillDirOf(dataDir, slug)
  } catch {
    return { action: 'invalid', slug }
  }
  const locked = withSkillLock(dataDir, assertSafeRelPath(String(slug)), () => applySkillObstacleUnlocked(dataDir, slug, options), options)
  return locked.busy === true ? { action: 'busy', slug } : locked.value
}

/**
 * 把「裸 slug」解析成真实技能 id（0.13.0）：套件里的技能 id 是 `套件/子技能`，
 * 用户/模型常只写子技能名。精确匹配优先；唯一后缀匹配自动补全；歧义或不存在要报错，
 * 绝不静默成功（以前 feedback 裸 slug 返回成功但账本没写）。
 */
export function resolveSkillId(dataDir, raw) {
  const wanted = String(raw || '').trim().replace(/^skill:/, '').replace(/\\/g, '/')
  if (wanted === '') throw new Error('技能 id 不能为空（形如 skill:<套件/技能名>）')
  const skills = listSkills(dataDir, { onlyLocal: true })
  const wantedLower = wanted.toLowerCase()
  const exact = skills.find((item) => String(item.slug || '').toLowerCase() === wantedLower)
  if (exact !== undefined) return String(exact.slug)
  const suffix = skills.filter((item) => String(item.slug || '').toLowerCase().endsWith(`/${wantedLower}`))
  if (suffix.length === 1) return String(suffix[0].slug)
  if (suffix.length > 1) {
    throw new Error(`技能 id 有歧义：${wanted}；候选：${suffix.map((item) => item.slug).join('、')}`)
  }
  const available = skills.slice(0, 8).map((item) => item.slug)
  throw new Error(`没有这个技能：${wanted}${available.length > 0 ? `；可用 id：${available.join('、')}` : '（技能库为空）'}`)
}

/** 用后结果：成功 = helped + 每个活跃签名记 clean；失败 = hurt。 */
function applySkillOutcomeUnlocked(dataDir, slug, result, options = {}) {
  let dir
  try {
    dir = skillDirOf(dataDir, slug)
  } catch {
    return { action: 'invalid', slug }
  }
  const skill = readSkill(dir, slug)
  if (skill === null) return { action: 'missing', slug }
  const now = new Date().toISOString()
  const confidence = skill.meta.confidence
  confidence.uses = (Number(confidence.uses) || 0) + 1
  if (result === 'helped') confidence.helped = (Number(confidence.helped) || 0) + 1
  else if (result === 'hurt') confidence.hurt = (Number(confidence.hurt) || 0) + 1
  confidence.lastUsedAt = now
  if (result === 'helped') {
    for (const entry of Object.values(skill.meta.obstacles)) {
      entry.events = [...(entry.events || []), 'clean'].slice(-EVENTS_LIMIT)
      entry.streak = 0
    }
  }
  const committed = persistSkill(dataDir, dir, { name: skill.name, description: skill.description, body: skill.body }, skill.meta, `skill: ${slug} — 用后反馈 ${result}`)
  const warning = skillWarningFor(skill, options.intent)
  return { action: 'feedback', slug, result, confident: highConfidence(skill.meta), commit: committed, ...(warning ? { warning } : {}) }
}

/** 用后结果（带锁）。 */
export function applySkillOutcome(dataDir, slug, result, options = {}) {
  let dir
  try {
    dir = skillDirOf(dataDir, slug)
  } catch {
    return { action: 'invalid', slug }
  }
  const locked = withSkillLock(dataDir, assertSafeRelPath(String(slug)), () => applySkillOutcomeUnlocked(dataDir, slug, result, options), options)
  return locked.busy === true ? { action: 'busy', slug } : locked.value
}
