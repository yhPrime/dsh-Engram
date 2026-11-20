/**
 * 0.28/0.29：标签分级与补族、族代表的纯函数。
 * 只读/纯计算，不写盘；写回由调用方（工具/API）走 store.writeStore 的单事务。
 */
import fs from 'node:fs'
import path from 'node:path'
import { canonicalRegisteredName, directionFamilyOf, facetOf, registrySnapshot } from './tag-registry.js'
import { FAMILY_INVISIBLE_RE, FAMILY_NAME_MAX_CHARS, isGenericFamilyName, normalizeFamilyName } from './family-name.js'

/**
 * 0.37：object 面已从词表物理删除（TAG_FACETS 只剩 action/topic/quality），
 * `facetOf` 认不出这些词了，族名校验改按字面表挡：纯对象词不能当族名，族名必须是「动词+对象」。
 * 只比整名（`写脚本`/`改代码` 这类动作族不受影响）。
 */
export const LEGACY_OBJECT_TAGS = new Set([
  '代码', 'ppt', 'pptx', '幻灯片', '演示文稿', 'word', 'docx', 'excel', 'xlsx', 'wps',
  '课件', '任务卡', '版式', '插页', 'dsh插件', '网页应用', 'agent', '智能体平台', '脚本',
  'dsh', '关系图', '经验库',
])

/**
 * 0.38：族名唯一校验入口（族 = 可复用动作模式，「动词+对象」）。
 * `exp_family` / `exp_object` / `exp_record` 三条建族路径共用，堵住「绕过校验自动建族」的口子。
 * 合法返回规范化族名；非法抛错。纯函数，不写盘。
 */
export function validateFamilyName(raw) {
  if (raw === undefined || raw === null) throw new Error('族名不能为空')
  // 0.38：非字符串族名（数组/对象/数字）明确拒，别 String() 强转成族名。
  if (typeof raw !== 'string') throw new Error('族名必须是字符串')
  // 0.38：可见/不可见判定要兼顾两类：NFKC 能合成的组合重音（cafe\u0301→café，合法放行）与
  // 「归一后仍留着」的隐形字符（U+FE0F、零宽、填充符，拒）。所以先归一，再按归一结果与原始串两路判。
  const name = normalizeFamilyName(raw)
  if (name === '') throw new Error('族名不能为空')
  if (!/[\p{L}\p{N}]/u.test(name)) throw new Error('族名不能为空')
  // 归一后仍带组合附着符（U+FE0F / 汉字+组合重音；被 NFKC 合成掉的拉丁重音不算）→ 拒。
  if (/\p{M}/u.test(name)) throw new Error('族名不能含组合/不可见字符')
  // 原始串里的格式/填充符：NFKC 会把 \ufeff 之类直接吃掉（归一后查不到），所以查 raw。
  if (FAMILY_INVISIBLE_RE.test(raw)) throw new Error('族名不能含零宽/不可见字符')
  if (name === '未分族') throw new Error('「未分族」是保留族名，不能创建/改名/指派')
  // 0.37：object 面已在词表里删除，facetOf 认不出对象词，改用字面表兜住——
  // 否则「代码」「课件」这类纯对象词会绕过校验变成族名（族名必须是「动词+对象」）。
  if (LEGACY_OBJECT_TAGS.has(name.toLowerCase())) {
    throw new Error('对象词不能当族名，请用「动词+对象」，例如 写脚本 / 改代码 / 跑测试')
  }
  if (isGenericFamilyName(name)) {
    throw new Error('族名太泛，请用「动词+对象」，例如 git 推送 / 跑 npm 测试')
  }
  if ([...name].length > FAMILY_NAME_MAX_CHARS) throw new Error(`族名最多 ${FAMILY_NAME_MAX_CHARS} 字`)
  if (/[\\/:*?"<>|]/.test(name) || /^v?\d+(?:\.\d+)*$/iu.test(name)) throw new Error('族名不能是路径/版本号')
  return name
}

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
  // 族键一律按规范化后的形态比较：旧行里可能留着 `GIT PUSH` / `git  push`，
  // 不归一就会和「git 推送」并存成两个只差大小写/空格的活跃族（0.34 唯一性拍板）。
  const familyOfRow = (row) => {
    const raw = row !== null && typeof row === 'object' && typeof row.family === 'string' ? row.family : ''
    return normalizeFamilyName(raw) || '未分族'
  }
  const checkName = validateFamilyName
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
    // 0.38：来源族名非字符串明确拒，别 String()/normalize 强转成族名。
    if (action === 'rename' && typeof args.family !== 'string') throw new Error('来源族名必须是字符串')
    if (action === 'merge' && Array.isArray(args.names) && args.names.some((name) => typeof name !== 'string')) throw new Error('来源族名必须是字符串')
    const target = checkName(action === 'rename' ? args.newName : (args.newName || args.family))
    const sources = action === 'rename'
      ? [normalizeFamilyName(args.family)]
      : (Array.isArray(args.names) ? args.names.map((name) => normalizeFamilyName(name)) : [])
    if (sources.length === 0 || sources.some((name) => name === '')) throw new Error('需要来源族名')
    // 改名到同一个规范化键 = 空操作：不写盘、不改行（否则每次都会「改」一遍）。
    if (action === 'rename' && sources.length === 1 && sources[0] === target) {
      return {
        changed: false,
        result: { action, target, sources, changed: 0, merged: false, note: '新旧族名规范化后相同，无需改名' },
      }
    }
    const sourceSet = new Set(sources.filter((name) => name !== target))
    // 撞名（目标族已有行）时不算错：按拍板语义自动合并，并在回执里显式标明 merged。
    const targetExisted = rows.some((row) => familyOfRow(row) === target && !sourceSet.has(familyOfRow(row)))
    let changed = 0
    for (const row of rows) {
      if (sourceSet.has(familyOfRow(row))) { row.family = target; row.actionFamily = target; changed += 1 }
    }
    return { changed: changed > 0, result: { action, target, sources, changed, merged: targetExisted } }
  }
  if (action === 'assign') {
    const target = checkName(args.family)
    const ids = new Set(Array.isArray(args.ids) ? args.ids.map(String) : [])
    const sourceId = String(args.sourceId || '')
    let changed = 0
    const droppedDirections = []
    for (const row of rows) {
      if ((ids.size > 0 && ids.has(String(row.id))) || (sourceId !== '' && String(row.sourceId || '') === sourceId)) {
        row.family = target
        row.actionFamily = target
        // 0.38：指派到新族时，方向标签若不属于新族就摘掉（族键按 normalizeFamilyName 归一后比较，同族/别名族不摘）。
        const tags = Array.isArray(row.context) ? row.context : []
        const kept = tags.filter((tag) => {
          const dirFamily = directionFamilyOf(tag)
          return dirFamily === null || dirFamily === '' || normalizeFamilyName(dirFamily) === normalizeFamilyName(target)
        })
        if (kept.length !== tags.length) {
          const keptLower = new Set(kept.map((tag) => String(tag).toLowerCase()))
          for (const tag of tags) {
            if (!keptLower.has(String(tag).toLowerCase())) droppedDirections.push(String(tag))
          }
          row.context = kept
        }
        changed += 1
      }
    }
    if (changed === 0) throw new Error('没有匹配的经验可指派')
    return { changed: true, result: { action, target, changed, droppedDirections: [...new Set(droppedDirections)] } }
  }
  if (action === 'delete') {
    // 0.38：来源族名非字符串明确拒。
    if (typeof args.family !== 'string') throw new Error('族名必须是字符串')
    // 删除是「清理旧宽族」的合法出口：来源族名允许是泛词（推送/校验…），只做空名与保留名校验；
    // 目标语义才是「必须具体」，所以 create/rename/assign 走 checkName。
    const family = normalizeFamilyName(args.family)
    if (family === '') throw new Error('族名不能为空')
    if (family === '未分族') throw new Error('「未分族」是保留族名，不能删除')
    if (rowsOf(family).length > 0) throw new Error('族里还有经验，先 exp_family assign 再删除')
    return { changed: false, result: { family, deleted: true, note: '空族无需落盘；未分族不可删除' } }
  }
  throw new Error('未知 action：' + action)
}


const CREATED_FAMILIES_FILE = '_created-families.json'

/** 0.33：模型显式创建、尚无行的空族（可见但 0 条）。读时同样做族键归一 + 去重。 */
export function readCreatedFamilies(dataDir) {
  const file = path.join(String(dataDir || ''), 'library', CREATED_FAMILIES_FILE)
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!Array.isArray(parsed.created)) return []
    const out = []
    for (const item of parsed.created) {
      const name = normalizeFamilyName(item)
      if (name === '' || out.includes(name)) continue
      out.push(name)
    }
    return out
  } catch { return [] }
}

export function writeCreatedFamilies(dataDir, names) {
  const dir = path.join(String(dataDir || ''), 'library')
  if (!fs.existsSync(dir)) return
  const list = []
  for (const item of Array.isArray(names) ? names : []) {
    const name = normalizeFamilyName(item)
    if (name === '' || list.includes(name)) continue
    list.push(name)
  }
  const file = path.join(dir, CREATED_FAMILIES_FILE)
  if (list.length === 0) { try { fs.rmSync(file, { force: true }) } catch { /* ignore */ } return }
  fs.writeFileSync(file, JSON.stringify({ created: list }, null, 2) + '\n', 'utf8')
}

/**
 * create/rename/merge/delete/assign 后同步空族登记表（只处理没有行的族）。
 *
 * create 的「已存在」判定要连空族登记一起看：manageFamilies 是纯函数、看不到登记表，
 * 这里补上最后一环——第二次 create 同一个（规范化后的）空族返回 created:false，不重复登记。
 */
export function syncCreatedFamilies(dataDir, action, args, result) {
  const current = readCreatedFamilies(dataDir)
  let next = current.slice()
  const add = (name) => { if (name && !next.includes(name)) next.push(name) }
  const drop = (name) => { next = next.filter((item) => item !== name) }
  if (action === 'create') {
    const family = normalizeFamilyName(result.family || args.family || '')
    if (family !== '' && current.includes(family)) {
      result.created = false
      result.note = '族已存在（空族已登记）'
    } else if (result.created !== false) {
      // 已有行的族不是「空族」：不写登记表（删光后再 create 才需要）。
      add(family)
    }
  } else if (action === 'rename') {
    drop(normalizeFamilyName(args.family))
    const target = normalizeFamilyName(result.target || args.newName || '')
    if (current.includes(target) && normalizeFamilyName(args.family) !== target) result.merged = true
    add(target)
  } else if (action === 'merge') {
    for (const name of Array.isArray(args.names) ? args.names : []) drop(normalizeFamilyName(name))
    add(normalizeFamilyName(result.target || args.newName || ''))
  } else if (action === 'delete') {
    drop(normalizeFamilyName(args.family || result.family || ''))
  } else if (action === 'assign') {
    add(normalizeFamilyName(result.target || args.family || ''))
  }
  writeCreatedFamilies(dataDir, next)
  return next
}
