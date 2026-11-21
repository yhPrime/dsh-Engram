/**
 * 工具层纯辅助函数：自动类型兜底、分类目录对账、查询标签摊平、回执渲染/截断、
 * 方向摘除、族登记判定、时间校验、宿主会话推断、按类型分组、manifest 类型目录、
 * taskIndex 可信度。全部从 tools.js 原样搬出（0.45.0-D4b），只被 tools.js 引用。
 */
import fs from 'node:fs'
import path from 'node:path'

import { SYSTEM_TYPE } from './store.js'
import { hasFamilyLayout, markFamilyTypeCreated, removeFamilyTypeDir, syncFamilyTypeName, taskIndexOf } from './shard-store.js'
import { normalizeFamilyName } from './family-name.js'
import { readFamilyRegistry } from './family-registry.js'
import { TAG_MAX_COUNT, directionFamilyOf } from './tag-registry.js'
import { normalizeIsoDate } from './retrieval.js'
import { sessionIdOfAgent } from './skills.js'

/**
 * 自动记录的类型兜底（0.24.x）：标签字面 → 预设主分类名。
 *
 * 自动记录没有模型参与，只能靠引擎。簇路由命中就用簇；没命中时如果标签里已经出现
 * 「DSH插件 / 课件 / 代码……」，档案柜不该还挂在「未分类」上。
 * 0.37 起 object 面已删除，这些词不再是登记标签，但模型/旧数据仍可能原样传进来，
 * 所以这里按**字面**匹配（不查 facetOf），映射不到就保持原样——宁可未分类，也不凭空造分类。
 */
const AUTO_TYPE_BY_OBJECT_TAG = {
  DSH插件: '开发', 代码: '开发', 脚本: '开发', 网页应用: '开发', Agent: '开发', 智能体平台: '开发',
  PPT: '办公', Word: '办公', Excel: '办公', WPS: '办公', 课件: '办公', 任务卡: '办公', 版式: '办公', 插页: '办公',
}

/** 用标签里的对象面挑一个已存在的类型名；挑不到返回 ''。 */
function autoTypeFromTags(tags, types) {
  const list = Array.isArray(types) ? types : []
  for (const tag of Array.isArray(tags) ? tags : []) {
    const wanted = AUTO_TYPE_BY_OBJECT_TAG[tag]
    if (wanted === undefined) continue
    const hit = list.find((type) => type && String(type.name).toLowerCase() === wanted.toLowerCase())
    if (hit !== undefined) return String(hit.name)
  }
  return ''
}

/**
 * 查询标签：把 `extractQueryTags` 的分面结果摊平成数组。
 * 0.25.0 P1 复用点：抽词只跑一次，结果直接喂给既有 `contextMatch`，不新增排序代码。
 * 面内顺序按排序权重（动作 0.55 > 主题 0.30 > 对象 0.15 > 质量）：截到 8 个时先保动作/主题，
 * 否则「对象面词多」的意图会把动作信号整体挤掉。
 */
/**
 * 分类目录对账（0.27.0 分族布局）：exp_type 的 create/rename/delete/merge 之后调用。
 * - 不在 store.types 里的目录删掉；在 types 里的同步 _type.json 名字；
 * - 没有行的业务分类标 created:true（重建时保留），系统类型不建目录。
 */
function reconcileFamilyTypeDirs(dataDir, store) {
  if (!hasFamilyLayout(dataDir)) return
  const known = new Map((Array.isArray(store.types) ? store.types : []).map((type) => [String(type.id), String(type.name || '')]))
  const root = path.join(String(dataDir), 'library')
  let dirs = []
  try { dirs = fs.readdirSync(root) } catch { dirs = [] }
  for (const typeId of dirs) {
    if (known.has(typeId)) continue
    // R9 缺陷：只清「像分类目录」的项（有 _type/_index 或 ty_* 名）；用户自建目录/文件不删。
    if (typeId.startsWith('.')) continue
    let isClassDir = false
    try { isClassDir = fs.statSync(path.join(root, typeId)).isDirectory() } catch { isClassDir = false }
    if (!isClassDir) continue
    let hasMeta = false
    try { hasMeta = fs.existsSync(path.join(root, typeId, '_index.json')) || fs.existsSync(path.join(root, typeId, '_type.json')) } catch { hasMeta = false }
    if (!hasMeta && !/^ty_/i.test(typeId)) continue
    removeFamilyTypeDir(dataDir, typeId)
  }
  const withRows = new Set((Array.isArray(store.experiences) ? store.experiences : []).map((row) => String((row && row.typeId) || 'ty_other')))
  for (const [typeId, name] of known) {
    if (typeId === 'ty_other') continue
    if (!withRows.has(typeId)) markFamilyTypeCreated(dataDir, typeId, name)
    else syncFamilyTypeName(dataDir, typeId, name)
  }
}
function flattenQueryTags(queryTags) {
  if (queryTags === null || typeof queryTags !== 'object') return []
  const out = []
  for (const facet of ['action', 'topic', 'quality']) {
    for (const name of Array.isArray(queryTags[facet]) ? queryTags[facet] : []) {
      if (typeof name === 'string' && name !== '' && !out.includes(name)) out.push(name)
    }
  }
  return out.slice(0, TAG_MAX_COUNT)
}

function renderJson(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

/** 0.38：回执/报错里回显用户输入要截断，别把 10 万字符原样撑爆回执。按码元截但在代理对边界退一格，不劈 emoji。 */
function clipText(value, max = 60) {
  const text = String(value === undefined || value === null ? '' : value)
  if (text.length <= max) return text
  let cut = max
  if (cut > 0) {
    const code = text.charCodeAt(cut - 1)
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1
  }
  return `${text.slice(0, cut)}…`
}

/**
 * 0.38：合并/重记后若行里出现「不属于该族」的方向标签，摘掉并返回被摘清单（交给回执告警，不静默串族）。
 * 只按行当前族校验；行没有族则不动。
 */
function pruneRowForeignDirections(row) {
  if (!row || !Array.isArray(row.context)) return []
  const family = normalizeFamilyName(row.family)
  if (family === '') return []
  const dropped = []
  const kept = row.context.filter((tag) => {
    const dirFamily = directionFamilyOf(tag)
    if (dirFamily !== null && dirFamily !== '' && normalizeFamilyName(dirFamily) !== family) {
      dropped.push(tag)
      return false
    }
    return true
  })
  if (dropped.length > 0) row.context = kept
  return dropped
}

/**
 * 0.38：族是否已登记——有经验行挂在该族下，或 families.json 里有该名。
 * 方向登记时用它挡「挂到从未登记的族」。
 */
function familyIsKnown(store, dataDir, rawFamily) {
  const name = normalizeFamilyName(rawFamily)
  if (name === '') return false
  const rows = Array.isArray(store && store.experiences) ? store.experiences : []
  if (rows.some((row) => normalizeFamilyName(row && row.family) === name)) return true
  return readFamilyRegistry(dataDir).some((entry) => normalizeFamilyName(entry && entry.name) === name)
}

/** 可选时间字段：未给=null；给了但解析不了就明确报错，不能静默改走推算。 */
function checkedIsoDate(value, field) {
  if (value === undefined || value === null || String(value).trim() === '') return undefined
  if (normalizeIsoDate(value) === null) throw new Error(`${field} 不是合法时间（请用 ISO，例如 2026-12-31T00:00:00.000Z）`)
  return value
}

/**
 * 宿主真实执行上下文（task-7 B7）：dsh-tools 以 `tool.execute(args, exec)` 调用工具，
 * `exec.agent` 是发起调用的 Agent——`agent.id` 就是 session id，工作区在
 * `agent.session.header.cwd`（真实 v4 会话首事件同源）。这样不依赖 config.cwd 注入，
 * 也不靠文件 mtime 猜身份。拿不到（headless/脚本直调）返回空，调用方退回扫描会话文件。
 */
function hostSessionOf(exec) {
  try {
    const agent = exec && exec.agent
    if (!agent) return { sessionId: '', cwd: '' }
    const session = agent.session || null
    // 会话键解析统一走 skills.js 的 sessionIdOfAgent（pre-step 目录钩子用同一个函数），
    // 避免「工具记进 session.id 桶、钩子取空键」两处漂移。
    const sessionId = sessionIdOfAgent(agent)
    const cwd = session && session.header && typeof session.header.cwd === 'string' ? session.header.cwd : ''
    return { sessionId, cwd }
  } catch {
    return { sessionId: '', cwd: '' }
  }
}

/** 宿主会话对象（含 surface/events）：拿不到返回 null，三态判定会因此降级为每次全文。 */
function hostSessionObjectOf(exec) {
  try {
    return (exec && exec.agent && exec.agent.session) || null
  } catch {
    return null
  }
}

/** 会话可见面（`session.surface.nodes`）→ Set<seq>；宿主没暴露返回 null（方向安全：宁可重给全文）。 */
function visibleSeqsOf(exec) {
  try {
    const session = hostSessionObjectOf(exec)
    const nodes = session && session.surface && session.surface.nodes
    if (!Array.isArray(nodes)) return null
    return new Set(nodes)
  } catch {
    return null
  }
}

/** 把记录按 typeId 分组（写回 touched 类型时 rowsByType 必须是该类型的全部行，含 tombstone）。 */
function groupRowsByType(rows) {
  const out = {}
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) continue
    const typeId = String(row.typeId || SYSTEM_TYPE.id)
    if (out[typeId] === undefined) out[typeId] = []
    out[typeId].push(row)
  }
  return out
}

/**
 * 只读 manifest 的类型目录（T4）：count 用 `stats.tasksByType` 的唯一 taskId 数，与 `listTypes` 同口径。
 * 返回 null 表示 manifest 还没有统计（G6 缺失）→ 调用方回退全量读，不要在这里现算。
 */
function typesFromManifest(manifest) {
  if (manifest === null || manifest === undefined) return null
  const stats = manifest.stats !== null && typeof manifest.stats === 'object' ? manifest.stats : null
  const taskCounts = stats !== null && stats.tasksByType !== null && typeof stats.tasksByType === 'object' ? stats.tasksByType : null
  if (taskCounts === null) return null
  const types = Array.isArray(manifest.types) ? manifest.types : []
  // 类型声明漂移（R6 缺陷 D3）：`stats.tasksByType` 还引用 `manifest.types` 里没有的 typeId，
  // 说明 manifest 只取到了一边 / 类型声明被手删而分片旧行仍在。逐项取数会把那些行整条算丢
  // （实测「未分类:0」而可见 2 行）——与「stats 缺失」同属「计数不可信」，返回 null 让调用方
  // 回退全量读 + listTypes；发生一次写盘后 manifest 就自愈了。
  const knownTypeIds = new Set(types.map((type) => String((type && type.id) || '')))
  if (Object.keys(taskCounts).some((typeId) => !knownTypeIds.has(String(typeId)))) return null
  return types
    .map((type) => ({
      id: type.id,
      name: type.name,
      description: type.description || '',
      system: type.system === true || type.id === SYSTEM_TYPE.id,
      source: type.source || 'preset',
      createdAt: type.createdAt || '',
      count: Number(taskCounts[type.id]) || 0,
    }))
    .sort((left, right) => Number(left.system) - Number(right.system) || right.count - left.count || left.name.localeCompare(right.name, 'zh'))
}

/**
 * `manifest.taskIndex` 是否能用来回答「这个键下有没有别的类型的旧条」（R6 缺陷 D1 / R7 缺陷 D1）。
 *
 * 三种情况：
 *  - 键在索引里、值全是 typeId：可信（但键在 `taskIndexDropped` 名单里时，它的行被截断甩过、
 *    类型覆盖可能不全 → 不可信）；
 *  - 键不在索引、也不在 `taskIndexDropped` 名单、且名单**精确存在**：确实是新键 → 可信；
 *  - 键不在索引、名单缺失（truncated 但没有 dropped 名单，记不清了）→ 不可信。
 *
 * 值被手改/冲突写成 `[]` / `null` / `''` / 数字 / 布尔 / 对象 / 数字数组 / 超长垃圾串时一律不可信：
 * 解析不出**全部**是 typeId 就退回慢路径（与「缺索引 / 空键」同一收口），由写盘的
 * `mergeTaskIndex` 重建索引。R7 缺陷 R7-D1：原来只判「有非空片段」，于是 `0` / `true` /
 * `[1,2]` / 5000 字符垃圾都被当成可信，快路径照旧把同一条重开。typeId 口径是本仓库统一的
 * `ty_[A-Za-z0-9_-]{1,64}`（预设 `ty_dev`、新建 `ty_<8hex>`、分片名同口径清洗）。
 * 键不存在仍视为可信（确实没有别的类型挂这个键）；值里是旧 typeId 也照旧用——那个类型的分片
 * 还在盘上就仍能定位到旧条（R5 ④a 的既有契约：类型声明漂移不牵连分片读取）。
 */
const TASK_INDEX_TYPE_ID_RE = /^ty_[A-Za-z0-9_-]{1,64}$/
function isTypeIdList(raw) {
  if (typeof raw !== 'string') return false
  const candidates = raw.split(',').map((typeId) => typeId.trim())
  return candidates.length > 0 && candidates.every((typeId) => TASK_INDEX_TYPE_ID_RE.test(typeId))
}

function fastIndexTrusted(manifest, taskKey) {
  if (manifest === null || manifest === undefined || taskKey === '') return true
  const taskIndex = taskIndexOf(manifest)
  if (taskIndex === null) return true
  const raw = taskIndex[taskKey]
  const dropped = Array.isArray(manifest.taskIndexDropped) ? manifest.taskIndexDropped : null
  // 这个键有行被 600 键上限甩掉过：索引里即使还留着它，typeId 覆盖也可能不全 → 退慢。
  if (dropped !== null && dropped.includes(taskKey)) return false
  if (raw === undefined) {
    // 有精确 dropped 名单 → 不在名单里就是新键，可放心走快路径；
    // 只有 truncated 标记、没有名单（超预算记不清）→ 缺键一律不可信。
    return manifest.taskIndexTruncated !== true || dropped !== null
  }
  return isTypeIdList(raw)
}

export {
  autoTypeFromTags,
  reconcileFamilyTypeDirs,
  flattenQueryTags,
  renderJson,
  clipText,
  pruneRowForeignDirections,
  familyIsKnown,
  checkedIsoDate,
  hostSessionOf,
  hostSessionObjectOf,
  visibleSeqsOf,
  groupRowsByType,
  typesFromManifest,
  isTypeIdList,
  fastIndexTrusted
}
