/**
 * 0.28/0.29：标签分级与补族、族代表的纯函数。
 * 只读/纯计算，不写盘；写回由调用方（工具/API）走 store.writeStore 的单事务。
 */
import { canonicalRegisteredName, facetOf, registrySnapshot } from './tag-registry.js'

/** 动作面标签 → 父级（UI 分组用；不影响召回）。 */
export const TAG_PARENT_MAP = Object.freeze({
  提交: '交付',
  推送: '交付',
  注册: '交付',
  沉淀: '沉淀',
  技能沉淀: '沉淀',
  校验: '校验',
  验收: '校验',
  恢复: '维护',
  分类: '整理',
  编写: '产出',
})

export const TAG_PARENT_OTHER = '其它'

/** 标签的父级：动作面按语义分组，其它面以面名作父级；未登记词归「其它」。 */
export function parentOfTag(value) {
  const name = canonicalRegisteredName(value) || String(value === undefined || value === null ? '' : value).trim()
  if (name === '') return TAG_PARENT_OTHER
  const facet = facetOf(name)
  if (facet === 'action') return TAG_PARENT_MAP[name] || '其它动作'
  if (facet === null) return TAG_PARENT_OTHER
  return facet
}

/**
 * 标签分级树 + 覆盖率（分母=传入行数）。
 * @param {Array<object>} rows 可见经验行
 * @returns {{facets: Record<string, Array<{parent: string, children: Array<{name: string, count: number, coverage: number, core: boolean}>}>>, total: number}}
 */
export function tagTree(rows) {
  const list = Array.isArray(rows) ? rows.filter((row) => row !== null && typeof row === 'object') : []
  const counts = new Map()
  for (const row of list) {
    const seen = new Set()
    for (const value of Array.isArray(row.context) ? row.context : []) {
      const name = canonicalRegisteredName(value)
      if (name === null || seen.has(name)) continue
      seen.add(name)
      counts.set(name, (counts.get(name) || 0) + 1)
    }
  }
  const snapshot = registrySnapshot()
  const groups = snapshot && snapshot.groups ? snapshot.groups : snapshot
  const facets = {}
  for (const [facet, entries] of Object.entries(groups)) {
    // 0.32：对象面退出标签体系，树里也不再给 object 分区。
    if (facet === 'object') continue
    const parents = new Map()
    const add = (name) => {
      const parent = parentOfTag(name)
      if (!parents.has(parent)) parents.set(parent, [])
      const coreEntry = entries.find((entry) => entry.name === name)
      parents.get(parent).push({
        name,
        count: counts.get(name) || 0,
        coverage: list.length === 0 ? 0 : Math.round(((counts.get(name) || 0) / list.length) * 1e4) / 1e4,
        core: coreEntry !== undefined ? coreEntry.core === true : false,
      })
    }
    for (const entry of entries) add(entry.name)
    // 行里出现、词表未登记的自由标签也进树（父级「其它」），否则 UI 看不到真实使用。
    for (const name of counts.keys()) {
      if (facetOf(name) !== facet) continue
      if (entries.some((entry) => entry.name === name)) continue
      add(name)
    }
    facets[facet] = [...parents.entries()]
      .map(([parent, children]) => ({
        parent,
        children: children.sort((left, right) => (right.count - left.count) || (left.name < right.name ? -1 : 1)),
      }))
      .sort((left, right) => (left.parent < right.parent ? -1 : 1))
  }
  return { facets, total: list.length }
}

/** 行的族键（纯推导）：显式 family > 第一个动作面标签；都没有返回 ''。 */
export function derivedFamilyOf(row) {
  if (row === null || row === undefined || typeof row !== 'object') return ''
  if (typeof row.family === 'string' && row.family.trim() !== '') return row.family.trim()
  for (const value of Array.isArray(row.context) ? row.context : []) {
    if (facetOf(value) === 'action') {
      const name = canonicalRegisteredName(value)
      if (name !== null) return name
    }
  }
  return ''
}

/** 可见行（召回口径）：未删除、未取代、未退休。 */
export function visibleRowsOf(store) {
  return (Array.isArray(store && store.experiences) ? store.experiences : [])
    .filter((row) => row !== null && typeof row === 'object' && !row.deleted_at && !row.superseded_by && !row.retired_at)
}

/**
 * 0.28 补族：对可见的「未分族」行按规则补族；resolver 为预留接口（返回字符串则采用）。
 * @returns {{scanned: number, filled: number, changes: Array<{id: string, from: string, to: string}>, skipped: number}}
 */
export function backfillFamilies(store, options = {}) {
  const rows = visibleRowsOf(store)
  const resolver = typeof options.resolver === 'function' ? options.resolver : null
  const changes = []
  let skipped = 0
  for (const row of rows) {
    // 只补「没有显式族」的行；能按动作族推导的落成显式族（规则），推不出再交给 resolver。
    const explicit = typeof row.family === 'string' && row.family.trim() !== '' ? row.family.trim() : ''
    if (explicit !== '') continue
    let next = derivedFamilyOf(row)
    if (next === '' && resolver !== null) {
      try {
        const resolved = resolver({ row })
        if (typeof resolved === 'string' && resolved.trim() !== '') next = resolved.trim()
      } catch { next = '' }
    }
    if (next === '') skipped += 1
    else changes.push({ id: String(row.id || ''), from: row.family || '', to: next })
  }
  return { scanned: rows.length, filled: changes.length, changes, skipped }
}

/**
 * 0.29 族代表：每个 (typeId, family) 的代表=G 最高；tie 取 lastSeenAt 新者，再 tie 按 id 稳定。
 * @returns {Map<string, object>} key=`${typeId}\u0000${family}` → {id,typeId,typeName,family,intent,G,hits,lastSeenAt}
 */
export function representativesOf(store) {
  const out = new Map()
  for (const row of visibleRowsOf(store)) {
    const family = derivedFamilyOf(row)
    if (family === '') continue
    const typeId = String(row.typeId || 'ty_other')
    const key = `${typeId}\u0000${family}`
    const candidate = {
      id: String(row.id || ''),
      typeId,
      typeName: String(row.typeName || ''),
      family,
      intent: String(row.intent || ''),
      G: Number(row.G) || 0,
      hits: Number(row.hits) || 0,
      lastSeenAt: String(row.lastSeenAt || row.lastUsedAt || ''),
    }
    const existing = out.get(key)
    if (existing === undefined) { out.set(key, candidate); continue }
    if (candidate.G > existing.G) { out.set(key, candidate); continue }
    if (candidate.G === existing.G && candidate.lastSeenAt > existing.lastSeenAt) out.set(key, candidate)
  }
  return out
}


/**
 * 0.33 族管理（纯逻辑，不写盘）：list/create/rename/merge/assign/delete。
 * 词表/对象面规则复用 tag-registry；写盘由调用方（exp_family / UI API）负责。
 * @returns {{result: object, changed: boolean}}
 */
export function manageFamilies(store, action, args = {}) {
  const rows = Array.isArray(store && store.experiences) ? store.experiences : []
  const familyOfRow = (row) => {
    const raw = row !== null && typeof row === 'object' && typeof row.family === 'string' ? row.family.trim() : ''
    return raw === '' ? '未分族' : raw
  }
  const checkName = (raw) => {
    const name = String(raw === undefined || raw === null ? '' : raw).trim()
    if (name === '') throw new Error('族名不能为空')
    if ([...name].length > 12) throw new Error('族名最多 12 字')
    if (facetOf(name) === 'object') throw new Error('对象面标签不能当族名（对象不参与标签/分族）')
    if (/[\\/:*?"<>|]/.test(name) || /^\d+\.\d+/.test(name)) throw new Error('族名不能是路径/版本号')
    return name
  }
  const rowsOf = (family) => rows.filter((row) => familyOfRow(row) === family)
  if (action === 'list' || action === '' || action === undefined) {
    const counts = new Map()
    for (const row of rows) {
      const family = familyOfRow(row)
      counts.set(family, (counts.get(family) || 0) + 1)
    }
    return {
      changed: false,
      result: { families: [...counts.entries()].map(([family, count]) => ({ family, count })).sort((a, b) => b.count - a.count) },
    }
  }
  if (action === 'create') {
    const family = checkName(args.family)
    const exists = rows.some((row) => familyOfRow(row) === family)
    return { changed: false, result: { family, created: !exists, materialized: false, note: exists ? '族已存在' : '已登记；首次 exp_record.family 写入时落盘' } }
  }
  if (action === 'rename' || action === 'merge') {
    const target = checkName(action === 'rename' ? args.newName : (args.newName || args.family))
    const sources = action === 'rename'
      ? [String(args.family || '').trim()]
      : (Array.isArray(args.names) ? args.names.map((name) => String(name).trim()) : [])
    if (sources.length === 0 || sources.some((name) => name === '')) throw new Error('需要来源族名')
    let changed = 0
    for (const row of rows) {
      if (sources.includes(familyOfRow(row))) { row.family = target; row.actionFamily = target; changed += 1 }
    }
    return { changed: changed > 0, result: { action, target, sources, changed } }
  }
  if (action === 'assign') {
    const target = checkName(args.family)
    const ids = new Set(Array.isArray(args.ids) ? args.ids.map(String) : [])
    const sourceId = String(args.sourceId || '')
    let changed = 0
    for (const row of rows) {
      if ((ids.size > 0 && ids.has(String(row.id))) || (sourceId !== '' && String(row.sourceId || '') === sourceId)) {
        row.family = target
        row.actionFamily = target
        changed += 1
      }
    }
    if (changed === 0) throw new Error('没有匹配的经验可指派')
    return { changed: true, result: { action, target, changed } }
  }
  if (action === 'delete') {
    const family = checkName(args.family)
    if (rowsOf(family).length > 0) throw new Error('族里还有经验，先 exp_family assign 再删除')
    return { changed: false, result: { family, deleted: true, note: '空族无需落盘；未分族不可删除' } }
  }
  throw new Error('未知 action：' + action)
}
