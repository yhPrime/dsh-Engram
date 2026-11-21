/**
 * 技能注册与管理（从 skills.js 拆出，纯搬代码、行为不变）：技能列表与提示段缓存、全局注册
 * （DSH skills/ 下的链接）、套件树动作、附件挂载与 git 提交。
 *
 * 不 import skills.js；依赖方向 skills.js → 本文件 → skill-files.js → skill-paths.js。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'

import {
  HALF_LIFE_DAYS,
  lifecycleMetaOf,
  normalizeAppliesTo,
  normalizeIsoDate,
  normalizeVolatility,
} from './retrieval.js'

import {
  SKILLS_DIRNAME,
  SCRIPTS_DIRNAME,
  META_FILENAME,
  SKILL_SCAN_SKIP_DIRS,
  skillsRootOf,
  skillDirOf,
  assertSafeRelPath,
  pathIsLink,
} from './skill-paths.js'

import {
  readSkill,
  readSkillBySlug,
  readJsonFile,
  writeJsonFile,
  stripMetaReadFlags,
  safeAttachName,
  formatBytes,
  appendScriptsSection,
} from './skill-files.js'

const MAX_ATTACH_FILE_BYTES = 2 * 1024 * 1024
const MAX_ATTACH_TOTAL_BYTES = 8 * 1024 * 1024
const MAX_ATTACH_COUNT = 200

const GIT_IDENTITY = ['-c', 'user.name=dsh-exp-lib', '-c', 'user.email=exp-lib@local']

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

/**
 * 提示段专用技能目录缓存（0.14.0）：listSkills 要递归走 `skills/` 并逐份读 `SKILL.md` + `skill.json`，
 * 22 个技能实测约 60 ms，而提示段只列前几个名字。提示段容得下 2 秒陈旧；记录/召回/控制台仍走
 * `listSkills`，不吃这份缓存（避免测试与实时性受影响）。
 */
const HINT_SKILLS_TTL_MS = 10000
const hintSkillsCache = new Map()

/**
 * skills 树签名（0.37 P0）：根目录 mtime + 每个顶层子目录 mtime。
 * 增删技能（含套件里加子技能）会改目录 mtime，所以签名一变就重扫；
 * 只改 SKILL.md 正文不会改目录 mtime，这类陈旧由 TTL 兜底（内容侧的实时读取走 readSkillBySlug）。
 */
function skillsRootSignature(dataDir) {
  try {
    const root = skillsRootOf(dataDir)
    const rootStat = fs.statSync(root)
    let signature = `${Math.trunc(rootStat.mtimeMs)}`
    let entries = []
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      entries = []
    }
    for (const entry of entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))) {
      if (!entry.isDirectory()) continue
      try {
        const stat = fs.statSync(path.join(root, entry.name))
        signature += `|${entry.name}:${Math.trunc(stat.mtimeMs)}`
      } catch {
        signature += `|${entry.name}:?`
      }
    }
    return signature
  } catch {
    return null
  }
}

export function listSkillsCached(dataDir, options = {}) {
  const key = `${path.resolve(String(dataDir || ''))}|${options.onlyLocal === true ? 'local' : 'all'}`
  const hit = hintSkillsCache.get(key)
  const now = Date.now()
  const signature = skillsRootSignature(dataDir)
  // 目录签名一致 → 命中（0.37 P0：导入新技能当次可见，不再等 10 秒）。
  if (hit !== undefined && signature !== null && hit.signature === signature) return hit.skills
  // 签名拿不到（目录不存在/读失败）时退回计时缓存，避免每次调用都重扫失败路径。
  if (hit !== undefined && signature === null && now - hit.at < HINT_SKILLS_TTL_MS) return hit.skills
  const skills = listSkills(dataDir, options)
  hintSkillsCache.set(key, { at: now, skills, signature })
  return skills
}

/** 技能目录变了就地清缓存（导入/注册/取消注册后由调用方决定要不要清；不调也只是多陈旧 2 秒）。 */
export function clearSkillsHintCache(dataDir) {
  const prefix = `${path.resolve(String(dataDir || ''))}|`
  for (const key of [...hintSkillsCache.keys()]) {
    if (key.startsWith(prefix)) hintSkillsCache.delete(key)
  }
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
  // 先整体校验、再逐项落盘：中途拒绝（同名/超限）时不会留下未登记的孤儿文件。
  const planned = []
  let budget = total
  const sourcesList = (Array.isArray(sources) ? sources : [])
    .map((item) => String(item || '').trim())
    .filter((item) => item !== '')
  for (const raw of sourcesList) {
    const resolved = path.resolve(raw)
    let stat
    try {
      stat = fs.statSync(resolved)
    } catch {
      throw new Error(`附件不存在：${raw}`)
    }
    if (!stat.isFile()) throw new Error(`附件不是文件：${raw}`)
    if (stat.size > MAX_ATTACH_FILE_BYTES) throw new Error(`单个附件不能超过 2MB：${raw}`)
    const name = safeAttachName(resolved)
    const rel = `${SCRIPTS_DIRNAME}/${name}`
    // 同一次 attach 里同名文件会互相覆盖（只留最后一份），明确拒绝；跨调用替换是允许的。
    if (planned.some((item) => item.rel === rel)) throw new Error(`同一次 attach 里有同名附件：${rel}（改名或分两次调用）`)
    const index = files.findIndex((item) => item.path === rel)
    const oldBytes = index >= 0 ? Number(files[index].bytes) || 0 : 0
    // 同名附件是替换不是新增：预算要减去旧的一份，否则 3×1.5MB 同名文件会误撞 8MB 上限。
    if (budget - oldBytes + stat.size > MAX_ATTACH_TOTAL_BYTES) throw new Error(`附件总量不能超过 8MB（当前 ${formatBytes(budget - oldBytes)}）`)
    const pendingNew = planned.filter((item) => item.index < 0).length
    if (index < 0 && files.length + pendingNew >= MAX_ATTACH_COUNT) throw new Error(`附件数量不能超过 ${MAX_ATTACH_COUNT} 个（当前 ${files.length + pendingNew}）`)
    budget = budget - oldBytes + stat.size
    planned.push({ resolved, stat, name, rel, index, oldBytes })
  }
  for (const item of planned) {
    fs.mkdirSync(scriptsDir, { recursive: true })
    const target = path.join(scriptsDir, item.name)
    fs.copyFileSync(item.resolved, target)
    const entry = {
      path: item.rel,
      bytes: item.stat.size,
      sha256: createHash('sha256').update(fs.readFileSync(target)).digest('hex'),
      addedAt: new Date().toISOString(),
    }
    if (item.index >= 0) files[item.index] = entry
    else files.push(entry)
    total += item.stat.size - item.oldBytes
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
 * 只删链接本体，绝不递归：Windows 上 rm(recursive) 会顺着 junction 进去，
 * 把经验库里的源目录一起删光（实测过）。junction 只能 rmdir，symlink 用 unlink。
 */
function removeLinkOnly(target) {
  for (const attempt of [() => fs.rmdirSync(target), () => fs.unlinkSync(target)]) {
    try {
      attempt()
      return true
    } catch {
      // 换下一种
    }
  }
  return false
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
  // 幂等：账本记着就是这个目标、文件也还在 → 直接返回成功（别因 readlink 判不出 junction 就报占用）。
  const registered = globalRegistrationOf(skill)
  if (registered !== null && path.resolve(registered.path) === path.resolve(target) && fs.existsSync(target)) {
    return { slug: id, id, leaf, targetDir: target, mode: registered.mode || 'junction', registered: true }
  }
  if (fs.existsSync(target)) {
    // 已存在但账本没记（或记的是别处）：只有 realpath 指向同一技能才认领，否则绝不覆盖。
    let same = false
    try {
      same = path.resolve(fs.realpathSync.native(target)) === path.resolve(fs.realpathSync.native(skill.dir))
    } catch {
      same = false
    }
    if (!same) throw new Error(`目标已被占用：${target}（不是经验库的链接，删掉或改名后再试）`)
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
  clearSkillsHintCache(dataDir)
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
  // 没登记过 = 幂等成功；但绝不猜默认路径、不动任何文件。
  if (registered === null) {
    return { slug: id, id, leaf, targetDir: path.join(dshGlobalSkillsRoot(), leaf), removed: false, registered: false }
  }
  const target = registered.path
  let removed = false
  if (!fs.existsSync(target)) {
    removed = true
  } else if (registered.mode === 'copy') {
    // 只有确认是我们自己复制的那份才删，避免误删用户手放的技能。
    fs.rmSync(target, { recursive: true, force: true })
    removed = true
  } else {
    // 链接/junction：只删本体（递归会顺着 junction 删掉经验库源目录）。删不掉就报错并保留登记。
    // 目标若已被替换成普通文件/目录，绝不能当链接删掉（那是用户的东西）。
    if (!pathIsLink(target)) {
      throw new Error(`目标已不是链接：${target}（登记已保留，确认后手动处理再重试）`)
    }
    removed = removeLinkOnly(target)
    if (!removed) {
      throw new Error(`无法删除全局链接：${target}（登记已保留，可稍后重试或手动删除）`)
    }
  }
  delete skill.meta.globalRegistered
  commitMeta(dataDir, path.join(skill.dir, META_FILENAME), skill.meta, `skill(${id}): unregister globally`)
  clearSkillsHintCache(dataDir)
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
  // 时效字段（0.20 P0）：只写显式给的；改易腐层没给复核时间时按新半衰期重排。
  if (patch.volatility !== undefined) {
    const next = normalizeVolatility(patch.volatility)
    if (next !== '') meta.volatility = next
    if (patch.reviewAfter === undefined && meta.lastVerifiedAt) {
      meta.reviewAfter = new Date(Date.parse(meta.lastVerifiedAt) + (HALF_LIFE_DAYS[meta.volatility] || HALF_LIFE_DAYS.semi) * 86400000).toISOString()
    }
  }
  if (patch.lastVerifiedAt !== undefined) meta.lastVerifiedAt = normalizeIsoDate(patch.lastVerifiedAt)
  if (patch.reviewAfter !== undefined) meta.reviewAfter = normalizeIsoDate(patch.reviewAfter)
  if (patch.verifiedBy !== undefined) meta.verifiedBy = patch.verifiedBy === null ? null : String(patch.verifiedBy || '').slice(0, 80)
  if (patch.appliesTo !== undefined) meta.appliesTo = normalizeAppliesTo(patch.appliesTo)
  if (patch.stale_at !== undefined) meta.stale_at = normalizeIsoDate(patch.stale_at)
  if (patch.stale_reason !== undefined) meta.stale_reason = patch.stale_reason === null ? null : String(patch.stale_reason || '').slice(0, 60)
  if (patch.review_note !== undefined) meta.review_note = String(patch.review_note || '').slice(0, 240)
  if (patch.retired_at !== undefined) meta.retired_at = normalizeIsoDate(patch.retired_at)
  if (patch.retired_reason !== undefined) meta.retired_reason = patch.retired_reason === null ? null : String(patch.retired_reason || '').slice(0, 120)
  const committed = commitMeta(dataDir, path.join(skill.dir, META_FILENAME), meta, `skill(${slug}): meta`)
  clearSkillsHintCache(dataDir)
  return {
    slug,
    typeName: meta.typeName,
    typeNames: meta.typeNames,
    notes: meta.notes,
    commit: committed,
    lifecycle: lifecycleMetaOf(meta),
  }
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
  clearSkillsHintCache(dataDir)
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
  clearSkillsHintCache(dataDir)
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
    writeJsonFile(metaPath, stripMetaReadFlags(raw))
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
  writeJsonFile(metaFile, stripMetaReadFlags(meta))
  const committed = commitSkills(dataDir, message)
  if (!committed) {
    meta.pendingCommit = true
    writeJsonFile(metaFile, stripMetaReadFlags(meta))
  }
  return committed
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

export { sleepSync }
