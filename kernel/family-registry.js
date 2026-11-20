/**
 * 0.35：族稳定 id 注册表（对象链存 id，不存族名）。
 *
 * 文件：`<dataDir>/families.json` —— `{ families: [{ id, name, aliases: [id...] }] }`
 * - `id` 一旦生成就跟着族走：rename 只改 name，id 不变；
 * - merge 把来源族 id（连同它自己的别名）记进目标族的 aliases，链里的旧 id 读取时沿别名解析；
 * - 与经验库布局解耦：不写 manifest（每次写盘都会重建）、不写 `library/_index.json`（同样会重建），
 *   所以单独一个文件、单独一次原子写，坏掉也只影响「链能不能解析出名字」。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

import { FAMILY_INVISIBLE_RE, FAMILY_NAME_MAX_CHARS, normalizeFamilyName } from './family-name.js'

export const FAMILIES_FILE = 'families.json'

/** 0.38：retired 只收干净旧名——规范化后非空、≤12 码点、无不可见字符；不干净的丢弃。 */
function cleanRetiredName(raw) {
  if (typeof raw !== 'string') return ''
  const name = normalizeFamilyName(raw)
  if (name === '' || [...name].length > FAMILY_NAME_MAX_CHARS) return ''
  if (FAMILY_INVISIBLE_RE.test(raw) || /\p{M}/u.test(name)) return ''
  return name
}

export function familiesFile(dataDir) {
  return path.join(String(dataDir || ''), FAMILIES_FILE)
}

function newFamilyId() {
  return `fm_${createHash('sha1').update(`${Date.now()}|${Math.random()}|${process.pid}`).digest('hex').slice(0, 8)}`
}

function unique(list) {
  const out = []
  for (const item of Array.isArray(list) ? list : []) {
    const value = String(item === undefined || item === null ? '' : item)
    if (value === '' || out.includes(value)) continue
    out.push(value)
  }
  return out
}

/** 读注册表：文件不存在/坏掉都返回空表（缺表只是「还没有 id」，不影响经验库读写）。 */
export function readFamilyRegistry(dataDir) {
  let parsed = null
  try { parsed = JSON.parse(fs.readFileSync(familiesFile(dataDir), 'utf8')) } catch { return [] }
  return normalizeRegistry(parsed)
}

function normalizeRegistry(parsed) {
  const raw = parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.families) ? parsed.families : []
  const seen = new Set()
  const out = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const id = String(item.id || '')
    const name = normalizeFamilyName(item.name)
    if (!/^fm_[A-Za-z0-9_-]{4,32}$/u.test(id) || name === '' || seen.has(id)) continue
    seen.add(id)
    const aliases = unique(item.aliases).filter((alias) => alias !== id && /^fm_[A-Za-z0-9_-]{4,32}$/u.test(alias))
    // 0.38：改名/合并后旧名进 retired，旧名仍能解析到这个族（不再复活成幽灵旧族）。
    // retired 必须是干净集合：只收字符串、归一后去重、≤12 码点、无不可见/组合符、且不等于当前名。
    const retired = []
    for (const raw of Array.isArray(item.retired) ? item.retired : []) {
      if (typeof raw !== 'string') continue
      const oldName = cleanRetiredName(raw)
      if (oldName === '' || oldName === name || retired.includes(oldName)) continue
      retired.push(oldName)
    }
    out.push({ id, name, aliases, ...(retired.length > 0 ? { retired } : {}) })
  }
  return out
}

export function writeFamilyRegistry(dataDir, families) {
  const dir = String(dataDir || '')
  fs.mkdirSync(dir, { recursive: true })
  const text = `${JSON.stringify({ families: normalizeRegistry({ families }) }, null, 2)}\n`
  const file = familiesFile(dir)
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, text, 'utf8')
  try {
    fs.renameSync(tmp, file)
  } catch (error) {
    try { fs.unlinkSync(tmp) } catch { /* ignore */ }
    throw error
  }
  return families.length
}

/** 按名查 id（不做任何写）。当前名命中优先于其他族的 retired 旧名命中。 */
export function familyIdByName(registry, rawName) {
  const name = normalizeFamilyName(rawName)
  if (name === '') return ''
  const list = Array.isArray(registry) ? registry : []
  const direct = list.find((entry) => entry.name === name)
  if (direct !== undefined) return direct.id
  const retiredHit = list.find((entry) => Array.isArray(entry.retired) && entry.retired.includes(name))
  return retiredHit === undefined ? '' : retiredHit.id
}

/** 0.38：把旧名（改名/合并前的名）归一到当前族名；认不出就返回规范化后的原名。当前名命中优先。 */
export function canonicalFamilyName(registry, rawName) {
  const name = normalizeFamilyName(rawName)
  if (name === '') return ''
  const list = Array.isArray(registry) ? registry : []
  const direct = list.find((entry) => entry.name === name)
  if (direct !== undefined) return direct.name
  const retiredHit = list.find((entry) => Array.isArray(entry.retired) && entry.retired.includes(name))
  return retiredHit === undefined ? name : retiredHit.name
}

/** 0.38：如果给的是「已退休的旧族名」，返回它现在对应的族名；否则 null。 */
export function retiredFamilyTarget(registry, rawName) {
  const name = normalizeFamilyName(rawName)
  if (name === '') return null
  const list = Array.isArray(registry) ? registry : []
  for (const entry of list) {
    if (entry.name === name) return null
    if (Array.isArray(entry.retired) && entry.retired.includes(name)) return entry.name
  }
  return null
}

/** 按名取 id，缺则登记一条（只改内存，落盘由调用方决定）。 */
export function ensureFamilyEntry(registry, rawName) {
  const name = normalizeFamilyName(rawName)
  if (name === '') throw new Error('族名不能为空')
  // 0.38：旧名（retired）命中当前族就复用，别新增一条 0 行同名幽灵族。
  const existing = registry.find((entry) => entry.name === name || (Array.isArray(entry.retired) && entry.retired.includes(name)))
  if (existing !== undefined) return existing.id
  const entry = { id: newFamilyId(), name, aliases: [] }
  registry.push(entry)
  return entry.id
}

/**
 * 把 id 解析回族：直查命中返回自身；命中别名返回目标族并标出 aliasOf。
 * 解析不到返回 null（族被删且没留别名）——由调用方显示「族已删除」。
 */
export function resolveFamilyRef(registry, rawId) {
  const id = String(rawId === undefined || rawId === null ? '' : rawId)
  if (id === '') return null
  const list = Array.isArray(registry) ? registry : []
  const direct = list.find((entry) => entry.id === id)
  if (direct !== undefined) return { id: direct.id, name: direct.name, aliasOf: null }
  const owner = list.find((entry) => Array.isArray(entry.aliases) && entry.aliases.includes(id))
  if (owner !== undefined) return { id: owner.id, name: owner.name, aliasOf: id }
  return null
}

/** rename：优先保 id；目标名已存在时按合并处理。 */
export function renameFamilyEntry(registry, rawOldName, rawNewName) {
  const from = normalizeFamilyName(rawOldName)
  const to = normalizeFamilyName(rawNewName)
  if (from === '' || to === '') throw new Error('族名不能为空')
  const source = registry.find((entry) => entry.name === from)
  if (source === undefined) {
    const retiredOwner = registry.find((entry) => Array.isArray(entry.retired) && entry.retired.includes(from))
    if (retiredOwner !== undefined) {
      // 幂等：旧名已经改到目标名（A→B 第二次），当空操作；改到别的名才是真错。
      if (retiredOwner.name === to) return { id: retiredOwner.id, renamed: false }
      throw new Error(`族名「${from}」已并入「${retiredOwner.name}」，请用当前族名`)
    }
    // 旧名从没登记过：只保证目标名有稳定 id；但旧名要退休到目标族，且只收干净名（别把 10 万字符写进 retired）。
    const id = ensureFamilyEntry(registry, to)
    const entry = registry.find((item) => item.id === id)
    const cleanFrom = cleanRetiredName(from)
    if (entry !== undefined && cleanFrom !== '' && cleanFrom !== to) entry.retired = unique([...(entry.retired || []), cleanFrom]).filter((oldName) => oldName !== to)
    return { id, renamed: false }
  }
  const target = registry.find((entry) => entry.name === to && entry.id !== source.id)
  if (target === undefined) {
    // 0.38：旧名退休——保留在 retired 里，旧名仍解析到本族（不复活成幽灵旧族）。
    const cleanFrom = cleanRetiredName(from)
    if (cleanFrom !== '' && cleanFrom !== to) source.retired = unique([...(source.retired || []), cleanFrom]).filter((oldName) => oldName !== to)
    source.name = to
    return { id: source.id, renamed: from !== to }
  }
  target.aliases = unique([...target.aliases, source.id, ...source.aliases])
  const cleanSource = cleanRetiredName(source.name)
  if (cleanSource !== '') target.retired = unique([...(target.retired || []), cleanSource, ...(source.retired || [])]).filter((oldName) => oldName !== target.name)
  registry.splice(registry.indexOf(source), 1)
  return { id: target.id, renamed: from !== to, merged: true }
}

/** merge：来源族的 id 与别名全部并进目标族，链里的旧 id 仍能解析到目标名。 */
export function mergeFamilyEntries(registry, rawNames, rawTargetName) {
  const targetId = ensureFamilyEntry(registry, rawTargetName)
  const target = registry.find((entry) => entry.id === targetId)
  let merged = 0
  for (const rawName of Array.isArray(rawNames) ? rawNames : []) {
    const name = normalizeFamilyName(rawName)
    if (name === '') continue
    const source = registry.find((entry) => entry.name === name && entry.id !== targetId)
    if (source === undefined) {
      // 来源族从没登记过：把它退休到目标族，但只收干净名（≤12 码点、无不可见符），别把 10 万字符写进 retired。
      const cleanName = cleanRetiredName(name)
      if (cleanName !== '' && cleanName !== target.name) target.retired = unique([...(target.retired || []), cleanName]).filter((oldName) => oldName !== target.name)
      continue
    }
    target.aliases = unique([...target.aliases, source.id, ...source.aliases])
    // 0.38：来源名也退休到目标族的 retired，旧名解析到目标族（不复活）。
    const cleanSource = cleanRetiredName(source.name)
    if (cleanSource !== '') target.retired = unique([...(target.retired || []), cleanSource, ...(source.retired || [])]).filter((oldName) => oldName !== target.name)
    registry.splice(registry.indexOf(source), 1)
    merged += 1
  }
  return { targetId, targetName: target.name, merged }
}

/** 删族时摘掉登记（链的引用检查由调用方先做）。返回被摘的 id 与别名。 */
export function dropFamilyEntry(registry, rawName) {
  const name = normalizeFamilyName(rawName)
  const index = registry.findIndex((entry) => entry.name === name)
  if (index < 0) return { removed: false, id: '', aliases: [] }
  const [entry] = registry.splice(index, 1)
  return { removed: true, id: entry.id, aliases: Array.isArray(entry.aliases) ? entry.aliases.slice() : [] }
}

/** 一个族的「全部身份」：自身 id + 合并进它的别名（删族前查引用用）。 */
export function familyIdSetOf(registry, rawName) {
  const name = normalizeFamilyName(rawName)
  const entry = registry.find((item) => item.name === name)
  if (entry === undefined) return new Set()
  return new Set([entry.id, ...entry.aliases])
}
