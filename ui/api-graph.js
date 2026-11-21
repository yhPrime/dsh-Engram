/**
 * exp-ui — 关系图 / 影子报表 / 对象链 / 冷档相关路由。
 *
 * /graph /graph-perf /shadow-report /objects /cold。
 */

import { numberParam, rowOf, visibleOf } from './data-source.js'
import fs from 'node:fs'
import path from 'node:path'
import { settingsFile } from '../kernel/settings.js'
import { buildSkillTree } from '../kernel/skills.js'
import { shadowReport } from '../kernel/tag-rank.js'
import { derivedFamilyOf } from '../kernel/family-tools.js'
import { json, fail, readBody, readOf, storeReadOf, metaOf } from './api-core.js'

/** 关系图 summary 模式的默认/上限经验条数（0.19.0）。 */
export const GRAPH_SUMMARY_LIMIT = 300
export const GRAPH_SUMMARY_LIMIT_MAX = 1200

/**
 * 解析 `/graph` 的 `scope` / `limit`。
 *
 * 兼容性优先：不带 `scope=summary` 时一律全量（旧 client 只认全量，不能因为
 * 顺手加的 `limit` 参数就悄悄变少）。`limit` 只在 summary 下生效，非法值退回
 * 默认 300，越界夹到 1..1200（`limit=0` 也按 1 处理，避免返回 0 个经验节点）。
 */
function graphOptionsOf(params) {
  const get = (key) => (params && typeof params.get === 'function' ? params.get(key) : null)
  const summary = String(get('scope') || '').trim().toLowerCase() === 'summary'
  return { summary, limit: summary ? graphLimitOf(get('limit')) : Infinity }
}

function graphLimitOf(raw) {
  if (raw === null || raw === undefined || String(raw).trim() === '') return GRAPH_SUMMARY_LIMIT
  const parsed = Math.trunc(Number(raw))
  if (!Number.isFinite(parsed)) return GRAPH_SUMMARY_LIMIT
  return Math.min(GRAPH_SUMMARY_LIMIT_MAX, Math.max(1, parsed))
}

/** 经验节点排序：weight 降序，其次 recent，再按 lastSeenAt 降序（全量模式不动原顺序）。 */
function rankGraphExperiences(rows) {
  return rows
    .map((row) => {
      const lastSeen = Date.parse(String(row.lastSeenAt || row.ts || '')) || 0
      return {
        row,
        lastSeen,
        recent: lastSeen > 0 && Date.now() - lastSeen < 7 * 24 * 3600 * 1000,
        weight: Math.min(1, 0.3 + Math.abs(Number(row.G) || 0) * 0.35),
      }
    })
    .sort((left, right) => right.weight - left.weight
      || Number(right.recent) - Number(left.recent)
      || right.lastSeen - left.lastSeen)
}

/** 关系图性能样本：只收数字与短字符串，避免任意页面往日志里灌内容。 */
function sanitizeGraphPerf(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const number = (value) => (Number.isFinite(Number(value)) ? Math.round(Number(value) * 100) / 100 : 0)
  const record = (value, limit, keyLimit) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value).slice(0, limit).map(([key, item]) => [String(key).slice(0, keyLimit), number(item)]))
  }
  return {
    at: new Date().toISOString(),
    nodes: number(body.nodes),
    edges: number(body.edges),
    fps: number(body.fps),
    p50: number(body.p50),
    p95: number(body.p95),
    frame: number(body.frame),
    tier: String(body.tier || '').slice(0, 16),
    size: record(body.size, 4, 12),
    phases: record(body.phases, 8, 20),
    counts: record(body.counts, 20, 24),
  }
}

const UNFILED_FAMILY = '未分族'

/** 族名 → 图节点 id：只转义会与 `exp:`/`skill:` 前缀撞车的字符。 */
export function graphFamilyId(name) {
  return `family:${String(name || '')
    .replace(/%/g, '%25')
    .replace(/:/g, '%3A')
    .replace(/\//g, '%2F')}`
}

/** 关系图数据：根 → 族 → 经验；技能树与 derivedFrom 单独一环。 */
export function buildGraph(source, params) {
  const read = readOf(source)
  const storeRead = storeReadOf(source)
  const store = storeRead.store
  const rows = visibleOf(store).map(rowOf)
  const options = graphOptionsOf(params)
  // summary 只裁经验：root/族/技能/套件全留，保证图骨架不塌。
  const keptRows = options.summary ? rankGraphExperiences(rows).slice(0, options.limit).map((entry) => entry.row) : rows
  const skills = source && typeof source.skills === 'function' ? (source.skills() || []) : []
  const nodes = [{ id: 'root', kind: 'root', label: '经验库' }]
  const edges = []
  const families = new Map()
  const familyNameOf = (row) => {
    const name = String(derivedFamilyOf(row) || '').trim()
    return name === '' ? UNFILED_FAMILY : name
  }
  const ensureFamily = (name) => {
    const id = graphFamilyId(name)
    let node = families.get(id)
    if (node === undefined) {
      node = { id, kind: 'family', label: name, count: 0, weight: 0.35, system: name === UNFILED_FAMILY }
      nodes.push(node)
      families.set(id, node)
    }
    return node
  }
  // 族骨架按全量行建：summary 只裁经验，族节点与它的计数不裁。
  for (const row of rows) ensureFamily(familyNameOf(row)).count += 1
  for (const node of families.values()) {
    node.weight = Math.min(1, 0.35 + node.count / 12)
    edges.push({ source: 'root', target: node.id, kind: 'root', strength: 0.3 + Math.min(0.4, node.count / 30) })
  }
  const expIds = new Set()
  for (const row of keptRows) {
    const family = familyNameOf(row)
    const familyNode = families.get(graphFamilyId(family))
    const lastSeen = Date.parse(String(row.lastSeenAt || row.ts || '')) || 0
    nodes.push({
      id: `exp:${row.id}`,
      kind: 'experience',
      label: row.intent || row.action || row.id,
      action: row.action || '',
      outcome: row.outcome,
      G: row.G,
      family,
      typeId: row.typeId || '',
      typeName: row.typeName || '',
      lastSeenAt: row.lastSeenAt || row.ts || '',
      weight: Math.min(1, 0.3 + Math.abs(Number(row.G) || 0) * 0.35),
      recent: lastSeen > 0 && Date.now() - lastSeen < 7 * 24 * 3600 * 1000,
    })
    edges.push({ source: familyNode.id, target: `exp:${row.id}`, kind: 'family', strength: 0.25 + Math.min(0.5, Math.abs(Number(row.G) || 0) * 0.25) })
    expIds.add(row.id)
  }
  // 次级分类关系：同标签的经验连一条虚线，不新增节点；标签复用后图上能看出它们的关系。
  // 与族同名的标签跳过——族边已经表达这层关系，再画就是双重语义。
  const labelMembers = new Map()
  for (const row of keptRows) {
    const familyKey = familyNameOf(row).toLowerCase()
    for (const tag of Array.isArray(row.context) ? row.context : []) {
      const name = String(tag || '').trim()
      if (name === '' || name.toLowerCase() === familyKey) continue
      const list = labelMembers.get(name) || []
      list.push(row.id)
      labelMembers.set(name, list)
    }
  }
  let labelEdges = 0
  for (const [name, ids] of labelMembers) {
    if (ids.length < 2 || ids.length > 6 || labelEdges >= 120) continue
    for (let index = 1; index < ids.length; index += 1) {
      edges.push({ source: `exp:${ids[0]}`, target: `exp:${ids[index]}`, kind: 'label', label: name, strength: 0.18 })
      labelEdges += 1
      if (labelEdges >= 120) break
    }
  }
  const skillTree = buildSkillTree(skills)
  const skillNodes = new Map()
  const rootLinked = new Set()
  const walkSkill = (node, parentId) => {
    const id = node.kind === 'group' ? `suite:${node.path}` : `skill:${node.path}`
    if (node.kind === 'group') {
      nodes.push({
        id,
        kind: 'suite',
        label: node.name,
        path: node.path,
        parent: parentId || '',
        depth: node.depth,
        count: node.skillCount,
        weight: Math.min(1, 0.5 + node.skillCount / 20),
      })
    } else {
      const skill = node.skill
      const skillNode = {
        id,
        kind: 'skill',
        label: skill.name,
        path: node.path,
        parent: parentId || '',
        depth: node.depth,
        childCount: node.childCount,
        status: skill.status,
        uses: skill.uses || 0,
        helped: skill.helped || 0,
        hurt: skill.hurt || 0,
        weight: Math.min(1, 0.45 + (skill.uses || 0) / 12),
      }
      nodes.push(skillNode)
      skillNodes.set(node.path, skillNode)
    }
    // 顶层挂根；套件内部挂父节点（总技能或组节点），这样图上能看出母子关系。
    if (parentId === '') rootLinked.add(id)
    edges.push({
      source: parentId || 'root',
      target: id,
      kind: parentId === '' ? 'root' : 'suite',
      strength: parentId === '' ? 0.55 : 0.9,
    })
    for (const child of node.children) walkSkill(child, id)
  }
  for (const rootNode of skillTree) walkSkill(rootNode, '')
  for (const skill of skills) {
    const id = String(skill.id || '')
    const node = skillNodes.get(id)
    if (!node) continue
    const derived = Array.isArray(skill.derivedFrom) ? skill.derivedFrom : []
    const linked = derived.filter((experienceId) => expIds.has(String(experienceId)))
    for (const experienceId of linked) edges.push({ source: `exp:${experienceId}`, target: `skill:${id}`, kind: 'derived', strength: 0.5 + Math.min(0.45, (skill.uses || 0) / 12) })
    // 独立技能没有经验来源时仍然挂根；套件子技能已有父边、技能树根节点已挂根，都不再重复挂根。
    if (linked.length === 0 && !String(id).includes('/') && !rootLinked.has(`skill:${id}`)) edges.push({ source: 'root', target: `skill:${id}`, kind: 'derived', strength: 0.55 })
  }
  const suiteRoots = skillTree.filter((node) => node.kind === 'group' || node.skillCount > 1).length
  // degree 用一遍边表累加（O(N+E)）：前端画图不用再自己数邻居。
  const degree = new Map()
  for (const edge of edges) {
    degree.set(edge.source, (degree.get(edge.source) || 0) + 1)
    degree.set(edge.target, (degree.get(edge.target) || 0) + 1)
  }
  const byKind = {}
  for (const node of nodes) {
    node.degree = degree.get(node.id) || 0
    byKind[node.kind] = (byKind[node.kind] || 0) + 1
  }
  return {
    notice: String(read.notice || ''),
    storeError: storeRead.error,
    nodes,
    edges,
    // total/truncated 只描述「经验」：summary 裁的就是经验，骨架节点不裁。
    total: rows.length,
    truncated: keptRows.length < rows.length,
    byKind,
    summary: { families: families.size, experiences: rows.length, skills: skills.length, suites: suiteRoots },
    updatedAt: String(read.updatedAt || ''),
  }
}

export function handleCold(ctx) {
  const { req, res, active, url, method, deps } = ctx
  if (method !== 'GET') return fail(res, 405, 'method-not-allowed', '只用 GET')
  const offset = numberParam(url.searchParams.get('offset'), 0, Number.MAX_SAFE_INTEGER)
  const limit = numberParam(url.searchParams.get('limit'), 50, 500)
  const query = String(url.searchParams.get('query') || '')
  const yearRaw = url.searchParams.get('year')
  const year = yearRaw === null || String(yearRaw).trim() === '' || !Number.isFinite(Number(yearRaw))
    ? null
    : Math.trunc(Number(yearRaw))
  let result = { years: [], total: 0, rows: [] }
  try {
    if (active && typeof active.coldRows === 'function') result = active.coldRows({ offset, limit, query, year })
  } catch (error) {
    // 冷档文件缺失/坏行：明确 500，不把「丢了」显示成「没有」。
    return fail(res, 500, 'cold-unreadable', String((error && error.message) || error))
  }
  const years = Array.isArray(result.years) ? result.years : []
  return json(res, 200, {
    ok: true,
    data: {
      source: metaOf(active),
      notice: '',
      exists: years.length > 0,
      total: Number(result.total) || 0,
      offset,
      limit,
      years,
      rows: Array.isArray(result.rows) ? result.rows : [],
      error: null,
    },
  })
}

export async function handleObjects(ctx) {
  const { req, res, active, url, method, deps } = ctx
  if (method !== 'GET') return fail(res, 405, 'method-not-allowed', '只用 GET')
  // 对象链（0.35）：只读视图。写入口仍是 exp_object 工具，控制台不做第二套写路径。
  const read = readOf(active)
  const dataDir = String(read.dataDir || '').trim()
  if (active.mode !== 'live' || dataDir === '') {
    return json(res, 200, { ok: true, data: { available: false, total: 0, objects: [] } })
  }
  try {
    const objectsModule = await import('../kernel/objects.js')
    const registryModule = await import('../kernel/family-registry.js')
    const list = objectsModule.readObjects(dataDir)
    const registry = registryModule.readFamilyRegistry(dataDir)
    return json(res, 200, {
      ok: true,
      data: {
        available: true,
        total: list.length,
        objects: list.map((obj) => ({
          ...objectsModule.objectView(obj, registry),
          hints: objectsModule.promotionHints(obj),
        })),
      },
    })
  } catch (error) {
    // 0.35 内核未就位时不要把整页打崩：给空视图 + 原因。
    return json(res, 200, {
      ok: true,
      data: { available: false, total: 0, objects: [], error: String((error && error.message) || error) },
    })
  }
}

export function handleGraph(ctx) {
  const { req, res, active, url, method, deps } = ctx
  if (method !== 'GET') return fail(res, 405, 'method-not-allowed', '只用 GET')
  return json(res, 200, { ok: true, data: buildGraph(active, url.searchParams) })
}

export function handleShadowReport(ctx) {
  const { req, res, active, url, method, deps } = ctx
// 0.25.0 P0：影子判据只读报表（数据全来自现成的 usage.shadow，不新增埋点）。
  if (method !== 'GET') return fail(res, 405, 'method-not-allowed', '只用 GET')
  if (!active || active.mode !== 'live') return fail(res, 400, 'unsupported', '示例数据不支持影子报表')
  try {
    return json(res, 200, { ok: true, data: shadowReport(String(readOf(active).dataDir || '')) })
  } catch (error) {
    return fail(res, 500, 'report-failed', String((error && error.message) || error))
  }
}

export async function handleGraphPerf(ctx) {
  const { req, res, active, url, method, deps } = ctx
  // 页面里开了 `?graphPerf=1` 才回传；只写本机 ~/.dsh/engram/graph-perf.jsonl，
  // 不进经验库仓、不暴露到 UI。单条 >256KB 的日志会保留最后 500 条。
  if (method !== 'POST') return fail(res, 405, 'method-not-allowed', '只用 POST')
  const sample = sanitizeGraphPerf(await readBody(req))
  if (sample === null) return fail(res, 400, 'bad-perf', '统计载荷不合法')
  try {
    const dir = path.dirname(settingsFile())
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'graph-perf.jsonl')
    fs.appendFileSync(file, `${JSON.stringify(sample)}\n`, 'utf8')
    if (fs.statSync(file).size > 256 * 1024) {
      const lines = fs.readFileSync(file, 'utf8').trim().split('\n').slice(-500)
      fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8')
    }
    return json(res, 200, { ok: true, data: { logged: true } })
  } catch (error) {
    return fail(res, 500, 'perf-log-failed', String((error && error.message) || error))
  }
}
