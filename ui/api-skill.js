/**
 * exp-ui — 固化技能相关路由。
 *
 * /skills /skills/import /skill-feedback /skill-global /skill-node /skill-meta /skill-forget
 * + 技能列表与导入的 builder（buildSkills / buildImportSkill / buildSkillFeedback）。
 */

import { codedError } from './data-source.js'
import { resolveEngramDataDir } from '../kernel/settings.js'
import { importSkills } from '../kernel/import-skill.js'
import { applySkillNodeAction, bodyHashOf, buildSkillTree, forgetSkill, registerSkillGlobally, skillRuntimeOf, unregisterSkillFromDsh, updateSkillMeta } from '../kernel/skills.js'
import { json, fail, readBody, readOf, metaOf, safeSkills, skillSummaryOf, typeListOf, resetSourceCache } from './api-core.js'

function treeOrderOf(node) {
  if (node.skill) return Number(node.skill.order) || 0
  return node.children.reduce((max, child) => Math.max(max, treeOrderOf(child)), 0)
}

/** 把内核树节点转成给界面的轻量节点（不把整行 skill 对象塞进去）。 */
function publicTreeNode(node, rootName) {
  const root = rootName || node.path
  const skill = node.skill
  return {
    id: node.path,
    path: node.path,
    name: skill ? skill.name : node.name,
    kind: node.kind,
    depth: node.depth,
    rootName: root,
    parentPath: node.depth > 0 ? node.path.slice(0, node.path.lastIndexOf('/')) : '',
    skillCount: node.skillCount,
    registeredCount: node.registeredCount,
    childCount: Math.max(0, node.skillCount - (skill ? 1 : 0)),
    children: node.children.map((child) => publicTreeNode(child, root)),
  }
}

/** 技能行补上树上的位置信息（path/depth/rootName/childCount）。 */
function decorateSkillRows(tree, rows) {
  const info = new Map()
  const visit = (node, root) => {
    if (node.skill) {
      info.set(node.path, {
        path: node.path,
        depth: node.depth,
        rootName: root,
        parentPath: node.depth > 0 ? node.path.slice(0, node.path.lastIndexOf('/')) : '',
        childCount: Math.max(0, node.skillCount - 1),
      })
    }
    for (const child of node.children) visit(child, root)
  }
  for (const node of tree) visit(node, node.path)
  return rows.map((row) => ({ ...row, ...(info.get(row.id) || { path: row.id }) }))
}

/** `/skills` 的 data：固化技能列表 + 状态分布 + 目录树。 */
export function buildSkills(source) {
  const read = readOf(source)
  const rows = safeSkills(source)
  const tree = buildSkillTree(rows)
  tree.sort((left, right) => treeOrderOf(right) - treeOrderOf(left) || left.name.localeCompare(right.name, 'zh'))
  return {
    source: metaOf(source),
    notice: String(read.notice || ''),
    total: rows.length,
    summary: skillSummaryOf(rows),
    skills: decorateSkillRows(tree, rows).map((row) => ({
      ...row,
      // 0.21.2 P1：召回时交给模型的运行时清单（绝对路径 + 可执行命令），控制台详情直接展示。
      // cap 收小：控制台只用来核对，不需要把 24 个附件全列出来。
      runtime: skillRuntimeOf(row, { cap: 12 }),
      // 正文 hash：复用回执据此判断「上次给的是不是同一版」；空正文也给出稳定值。
      bodyHash: bodyHashOf(row.body || ''),
    })),
    tree: tree.map((node) => publicTreeNode(node)),
  }
}

/**
 * `/skills/import` 的 data：把一条外部技能文本导进来。
 *
 * 分类 / 标签 / 排序由 `deps.getLlm` / `deps.getRoute` 提供的临时模型会话算；
 * 宿主没有模型服务时 kernel 会退回本地关键词归类，并如实回 classifier='local'。
 * 所以前端必须把 classifier 与 note 原样展示，不能假装算过。
 */
export async function buildImportSkill(source, body = {}, deps = {}) {
  if (source.mode !== 'live') throw codedError('unsupported', '示例数据不支持导入技能')
  const read = readOf(source)
  const dataDir = String(read.dataDir || '')
  if (dataDir === '') throw codedError('no-data-dir', '没有数据目录，无法写入技能')
  const typeNames = typeListOf(source, read).map((type) => String(type.name || '')).filter((name) => name !== '')
  const filePath = String(body.path || '').trim()
  const content = typeof body.content === 'string' ? body.content : ''
  const categories = Array.isArray(body.categories) ? body.categories.map(String) : []
  const notes = Array.isArray(body.notes) ? body.notes.map(String) : []
  // 套件导入走 contents 数组（浏览器选文件夹/多选 SKILL.md）：字符串或 {text, suiteRoot, relPath} 都收。
  let contents = Array.isArray(body.contents)
    ? body.contents.filter((item) => {
      if (typeof item === 'string') return item.trim() !== ''
      if (item && typeof item === 'object') return String(item.text || item.content || '').trim() !== ''
      return false
    })
    : []
  // 兼容客户端另一种写法：顶层给 suiteRoot/relPath + 单条 content。
  const suiteRoot = String(body.suiteRoot || '').trim()
  const relPath = String(body.relPath || '').trim()
  if (contents.length === 0 && content.trim() !== '' && (suiteRoot !== '' || relPath !== '')) {
    contents = [{ text: content, suiteRoot, relPath }]
  }
  if (filePath === '' && content.trim() === '' && contents.length === 0) {
    throw codedError('source-required', '要么拖入/选择 SKILL.md，要么粘贴正文')
  }
  return importSkills({ dataDir, filePath, content, contents, typeNames, categories, notes, deps })
}

export function buildSkillFeedback(source, body = {}) {
  const slug = String(body.slug || '').trim()
  const result = String(body.result || '').trim().toLowerCase()
  if (slug === '') throw codedError('slug-required', '缺少技能 slug')
  if (!['helped', 'hurt', 'neutral'].includes(result)) throw codedError('bad-result', 'result 只能是 helped / hurt / neutral')
  if (typeof source.skillFeedback !== 'function') throw codedError('unsupported', '当前数据源不支持技能反馈')
  return source.skillFeedback(slug, result)
}

export function handleSkills(ctx) {
  const { req, res, active, url, method, deps } = ctx
  if (method !== 'GET') return fail(res, 405, 'method-not-allowed', '只用 GET')
  return json(res, 200, { ok: true, data: buildSkills(active) })
}

export async function handleSkillsImport(ctx) {
  const { req, res, active, url, method, deps } = ctx
  if (method !== 'POST') return fail(res, 405, 'method-not-allowed', '只用 POST')
  return json(res, 200, { ok: true, data: await buildImportSkill(active, await readBody(req), deps) })
}

export async function handleSkillFeedback(ctx) {
  const { req, res, active, url, method, deps } = ctx
  if (method !== 'POST') return fail(res, 405, 'method-not-allowed', '只用 POST')
  return json(res, 200, { ok: true, data: buildSkillFeedback(active, await readBody(req)) })
}

export async function handleSkillGlobal(ctx) {
  const { req, res, active, url, method, deps } = ctx
  if (method !== 'POST') return fail(res, 405, 'method-not-allowed', '只用 POST')
  const body = await readBody(req)
  const slug = String((body && body.slug) || '').trim()
  if (slug === '') return fail(res, 400, 'slug-required', '缺少技能 slug')
  const action = String((body && body.action) || 'register').trim().toLowerCase()
  if (!['register', 'unregister'].includes(action)) return fail(res, 400, 'bad-action', 'action 只能是 register / unregister')
  if (active.mode !== 'live') return fail(res, 400, 'unsupported', '示例数据不支持全局注册')
  const dataDir = String((active.read && active.read().dataDir) || '').trim() || resolveEngramDataDir()
  try {
    const result = action === 'register'
      ? registerSkillGlobally(dataDir, slug)
      : unregisterSkillFromDsh(dataDir, slug)
    resetSourceCache()
    return json(res, 200, { ok: true, data: { ...result, action } })
  } catch (error) {
    return fail(res, 400, 'skill-global-failed', error && error.message ? error.message : String(error))
  }
}

export async function handleSkillNode(ctx) {
  const { req, res, active, url, method, deps } = ctx
  if (method !== 'POST') return fail(res, 405, 'method-not-allowed', '只用 POST')
  const body = await readBody(req)
  const nodePath = String((body && (body.path || body.slug)) || '').trim()
  if (nodePath === '') return fail(res, 400, 'node-required', '缺少节点 path')
  const action = String((body && body.action) || '').trim().toLowerCase()
  if (!['register', 'unregister', 'forget', 'detach'].includes(action)) {
    return fail(res, 400, 'bad-action', 'action 只能是 register / unregister / forget / detach')
  }
  if (active.mode !== 'live') return fail(res, 400, 'unsupported', '示例数据不支持节点操作')
  const dataDir = String((active.read && active.read().dataDir) || '').trim() || resolveEngramDataDir()
  try {
    const result = applySkillNodeAction(dataDir, action, nodePath, { expect: body && body.expect })
    resetSourceCache()
    return json(res, 200, { ok: true, data: result })
  } catch (error) {
    return fail(res, 400, 'skill-node-failed', error && error.message ? error.message : String(error))
  }
}

export async function handleSkillMeta(ctx) {
  const { req, res, active, url, method, deps } = ctx
  if (method !== 'POST') return fail(res, 405, 'method-not-allowed', '只用 POST')
  const body = await readBody(req)
  const slug = String((body && body.slug) || '').trim()
  if (slug === '') return fail(res, 400, 'slug-required', '缺少技能 slug')
  if (active.mode !== 'live') return fail(res, 400, 'unsupported', '示例数据不支持改技能元数据')
  const dataDir = String((active.read && active.read().dataDir) || '').trim() || resolveEngramDataDir()
  try {
    const result = updateSkillMeta(dataDir, slug, body)
    resetSourceCache()
    return json(res, 200, { ok: true, data: result })
  } catch (error) {
    return fail(res, 400, 'skill-meta-failed', error && error.message ? error.message : String(error))
  }
}

export async function handleSkillForget(ctx) {
  const { req, res, active, url, method, deps } = ctx
  if (method !== 'POST') return fail(res, 405, 'method-not-allowed', '只用 POST')
  const body = await readBody(req)
  const slug = String((body && body.slug) || '').trim()
  if (slug === '') return fail(res, 400, 'slug-required', '缺少技能 slug')
  if (active.mode !== 'live') return fail(res, 400, 'unsupported', '示例数据不支持删除技能')
  const dataDir = String((active.read && active.read().dataDir) || '').trim() || resolveEngramDataDir()
  try {
    const result = forgetSkill(dataDir, slug)
    resetSourceCache()
    return json(res, 200, { ok: true, data: result })
  } catch (error) {
    return fail(res, 400, 'skill-forget-failed', error && error.message ? error.message : String(error))
  }
}
