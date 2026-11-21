/**
 * 技能路径与安全校验（从 skills.js 拆出，纯搬代码、行为不变）：skills/ 下的路径常量、
 * slug/路径段/相对路径校验、链接判定与技能目录解析。
 *
 * 不 import skills.js，避免循环依赖；依赖方向 skills.js → 本文件。
 */

import fs from 'node:fs'
import path from 'node:path'

export const SKILLS_DIRNAME = 'skills'
export const SCRIPTS_DIRNAME = 'scripts'

export const SKILL_FILENAME = 'SKILL.md'
export const META_FILENAME = 'skill.json'

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

/** 同一路径比较（Windows 大小写不敏感；两边都先 path.resolve）。 */
function samePath(left, right) {
  const a = path.resolve(String(left))
  const b = path.resolve(String(right))
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/**
 * 目录**本身**是不是链接（symlink 或 Windows junction），不看祖先目录。
 *
 * 不能拿 `realpath(target) !== resolve(target)` 判：dataDir 本身可能是指向同步目录的 junction，
 * 此时 `link/skills/x` 的 realpath 与自身必然不同，正常技能会被全判成链接——写入报成功、
 * 读回/列表却全是空（静默不可见）。这里只比「自身 realpath」与「父目录 realpath + 自身名」：
 * 相等说明这一层不是链接；祖先是不是链接不影响判定。祖先越界由 skillDirOf 的 skillsRoot
 * 包含性检查负责。
 */
export function pathIsLink(target) {
  const abs = path.resolve(String(target))
  try {
    if (fs.lstatSync(abs).isSymbolicLink()) return true
  } catch {
    return false
  }
  // Windows junction 可能不报 symlink（不同 Node 版本行为不一），用父级 realpath 比对兜底。
  try {
    const real = fs.realpathSync.native(abs)
    const parentReal = fs.realpathSync.native(path.dirname(abs))
    return !samePath(real, path.join(parentReal, path.basename(abs)))
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

// 技能包里的这些目录不会放技能；跳过可避免为了找子技能去遍历上万个附件文件。
export const SKILL_SCAN_SKIP_DIRS = new Set([
  'node_modules', '.venv', 'venv', '__pycache__', '.idea', '.vscode', 'dist', 'build',
  'scripts', 'references', 'templates', 'assets', 'images', 'image', 'data', 'examples',
])
