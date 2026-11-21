/**
 * exp-ui — 族 / 类型 / 标签相关路由。
 *
 * /tag-registry /tag-tree /families /families/backfill /families/manage
 * /types /type /classify /classify-diag /retrieval-policy。行为与拆分前逐字一致。
 */

import { codedError, typesOf } from './data-source.js'
import fs from 'node:fs'
import path from 'node:path'
import { readEngineConfig, resolveEngramDataDir } from '../kernel/settings.js'
import { ensureDefaultTypes, normalizeContext, readStore, tagCatalog, tagRegistryView, withStoreLock, writeStore } from '../kernel/store.js'
import { classifyExperienceWithSession, localClassifyExperience } from '../kernel/experience-classify.js'
import { ensureTagOverrides, validateTagSet } from '../kernel/tag-registry.js'
import { backfillFamilies, derivedFamilyOf, manageFamilies, readCreatedFamilies, representativesOf, syncCreatedFamilies, tagTree, visibleRowsOf } from '../kernel/family-tools.js'
import { json, fail, readBody, readOf, storeOf, typeListOf } from './api-core.js'

export function buildTypeOp(source, body = {}) {
  if (!source || typeof source.typeOp !== 'function') throw codedError('unsupported', '当前数据源不支持类型管理')
  return source.typeOp(body)
}

export function handleTagRegistry(ctx) {
  const { req, res, active, url, method, deps } = ctx
  if (method !== 'GET') return fail(res, 405, 'method-not-allowed', '只用 GET')
  // 标签词表视图（0.20.0 P0）：core + 已复用(≥2) 按面分组，UI 的标签选择器直接照这份渲染。
  // 示例数据没有真实数据目录，只回内建词（不入用户覆盖）。
  const read = readOf(active)
  const dataDir = active !== null && active.mode === 'live' ? String(read.dataDir || '').trim() : ''
  const store = storeOf(active)
  return json(res, 200, { ok: true, data: tagRegistryView(store, dataDir === '' ? {} : { dataDir }) })
}

export function handleTagTree(ctx) {
  const { req, res, active, url, method, deps } = ctx
  if (method !== 'GET') return fail(res, 405, 'method-not-allowed', '只用 GET')
  // 0.40：冷启动先按 live dataDir 加载词表，/tag-tree 与 /tag-registry 同口径。
  const read = readOf(active)
  const dataDir = active !== null && active.mode === 'live' ? String(read.dataDir || '').trim() : ''
  try { if (dataDir !== '') ensureTagOverrides(dataDir) } catch { /* 坏词表按内建词走 */ }
  const store = storeOf(active)
  return json(res, 200, { ok: true, data: tagTree(visibleRowsOf(store)) })
}

export function handleFamilies(ctx) {
  const { req, res, active, url, method, deps } = ctx
  if (method !== 'GET') return fail(res, 405, 'method-not-allowed', '只用 GET')
  const store = storeOf(active)
  const rows = visibleRowsOf(store)
  const reps = representativesOf(store)
  const types = new Map()
  let unfiled = 0
  for (const row of rows) {
    const family = derivedFamilyOf(row)
    if (family === '') { unfiled += 1; continue }
    const typeId = String(row.typeId || 'ty_other')
    if (!types.has(typeId)) types.set(typeId, { typeId, name: String(row.typeName || '未分类'), count: 0, families: new Map() })
    const type = types.get(typeId)
    type.count += 1
    if (!type.families.has(family)) {
      const rep = reps.get(`${typeId}\u0000${family}`) || null
      type.families.set(family, { family, count: 0, representative: rep })
    }
    type.families.get(family).count += 1
  }
  const data = [...types.values()].map((type) => ({
    typeId: type.typeId,
    name: type.name,
    count: type.count,
    families: [...type.families.values()].sort((left, right) => (right.count - left.count) || (left.family < right.family ? -1 : 1)),
  })).sort((left, right) => (left.typeId < right.typeId ? -1 : 1))
  const unfiledRows = rows.filter((row) => derivedFamilyOf(row) === '').slice(0, 50).map((row) => ({ id: String(row.id || ''), typeId: String(row.typeId || 'ty_other'), typeName: String(row.typeName || ''), intent: String(row.intent || '') }))
  // 0.33：单层族布局，families 是扁平事实族表；types 保留一版做兼容。
  const flatFamilies = new Map()
  for (const type of data) {
    for (const item of type.families) {
      if (!flatFamilies.has(item.family)) flatFamilies.set(item.family, { family: item.family, count: 0, representative: item.representative || null })
      const entry = flatFamilies.get(item.family)
      entry.count += item.count
      if (entry.representative === null && item.representative !== null) entry.representative = item.representative
    }
  }
  // 显式创建、尚无行的空族也要可见（0 条）。
  try {
    const dataDir = String((readOf(active) || {}).dataDir || '').trim()
    if (dataDir !== '') {
      for (const family of readCreatedFamilies(dataDir)) {
        if (!flatFamilies.has(family)) flatFamilies.set(family, { family, count: 0, representative: null })
      }
    }
  } catch { /* 空族登记读不到不影响 */ }
  const families = [...flatFamilies.values()].sort((left, right) => (right.count - left.count) || (left.family < right.family ? -1 : 1))
  return json(res, 200, { ok: true, data: { types: data, families, unfiled, unfiledRows } })
}

export async function handleFamiliesBackfill(ctx) {
  const { req, res, active, url, method, deps } = ctx
  if (method !== 'POST') return fail(res, 405, 'method-not-allowed', '只用 POST')
  const body = await readBody(req)
  const dryRun = body === null || body.dryRun === undefined ? true : body.dryRun !== false
  if (dryRun || active.mode !== 'live') {
    // 只读路径（预览 / 示例数据）：继续用页面级热档快照，不写盘。
    const preview = backfillFamilies(storeOf(active))
    return json(res, 200, { ok: true, data: { dryRun: true, ...preview } })
  }
  const dataDir = String((readOf(active) || {}).dataDir || '').trim() || resolveEngramDataDir()
  // 0.44.1 P0-A（A1）：写路径整段在锁内，锁内只读无缓存快照。storeOf(active) 是深冻结的读缓存，
  // 改它会抛只读错误；即使可改，用旧快照写回也会覆盖并发写入。回执与落盘基于同一快照。
  const preview = withStoreLock(dataDir, () => {
    const store = readStore(dataDir)
    const plan = backfillFamilies(store)
    const byId = new Map((Array.isArray(store.experiences) ? store.experiences : []).map((row) => [String(row.id), row]))
    for (const change of plan.changes) {
      const row = byId.get(change.id)
      if (row !== undefined) row.family = change.to
    }
    writeStore(dataDir, store)
    return plan
  })
  return json(res, 200, { ok: true, data: { dryRun: false, ...preview } })
}

export async function handleFamiliesManage(ctx) {
  const { req, res, active, url, method, deps } = ctx
  if (method !== 'POST') return fail(res, 405, 'method-not-allowed', '只用 POST')
  const body = await readBody(req)
  if (body === null || typeof body !== 'object' || String(body.action || '').trim() === '') {
    return fail(res, 400, 'bad-request', '需要 action（list/create/rename/merge/assign/delete）')
  }
  const action = String(body.action || '').trim()
  if (active.mode !== 'live') {
    // 示例数据：只在内存里演一遍，不落盘；回执语义与旧版一致（有改动标 dryRun）。
    const outcome = manageFamilies(storeOf(active), action, body)
    if (outcome.changed) return json(res, 200, { ok: true, data: { ...outcome.result, dryRun: true } })
    const dataDir = String((readOf(active) || {}).dataDir || '').trim()
    if (dataDir !== '') syncCreatedFamilies(dataDir, action, body, outcome.result)
    return json(res, 200, { ok: true, data: { ...outcome.result, dryRun: false } })
  }
  const dataDir = String((readOf(active) || {}).dataDir || '').trim() || resolveEngramDataDir()
  // 0.44.1 P0-A（A2）：写路径在锁内无缓存重读后再执行 manageFamilies；
  // 空族登记表同步与族操作放进同一个外层锁，避免与 exp_family 对登记表交错写。
  const outcome = withStoreLock(dataDir, () => {
    const store = readStore(dataDir)
    const result = manageFamilies(store, action, body)
    if (result.changed) writeStore(dataDir, store)
    syncCreatedFamilies(dataDir, action, body, result.result)
    return result
  })
  return json(res, 200, { ok: true, data: { ...outcome.result, dryRun: false } })
}

export function handleRetrievalPolicy(ctx) {
  const { req, res, active, url, method, deps } = ctx
  if (method !== 'GET') return fail(res, 405, 'method-not-allowed', '只用 GET')
  const store = storeOf(active)
  const rows = visibleRowsOf(store)
  const reps = representativesOf(store)
  const config = readEngineConfig()
  const dataDir = String((readOf(active) || {}).dataDir || '').trim() || resolveEngramDataDir()
  let ab = null
  try { ab = JSON.parse(fs.readFileSync(path.join(dataDir, '.cache', 'ab-report.json'), 'utf8')) } catch { ab = null }
  return json(res, 200, {
    ok: true,
    data: {
      tagRank: String(config.tagRank || 'shadow'),
      routing: String(config.routing || 'on'),
      visible: rows.length,
      families: reps.size,
      unfiled: rows.filter((row) => derivedFamilyOf(row) === '').length,
      ab,
    },
  })
}

export function handleTypes(ctx) {
  const { req, res, active, url, method, deps } = ctx
  if (method !== 'GET') return fail(res, 405, 'method-not-allowed', '只用 GET')
  const read = active.read() || {}
  let types = typeListOf(active, read)
  // 老安装可能先落了经验、后升级：启动时的种分类被 experiences>0 挡掉过。
  // 类型页自己再兜一次，保证空业务类型时一定补默认分类。
  if (!types.some((type) => type && type.system !== true)) {
    const dataDir = String(read.dataDir || '').trim() || resolveEngramDataDir()
    try {
      ensureDefaultTypes(dataDir)
      types = typesOf(readStore(dataDir))
    } catch {
      // 读不到/写不了就保持原样，页面仍显示「未分类」，错误由其它接口暴露。
    }
  }
  return json(res, 200, { ok: true, data: { types } })
}

export async function handleType(ctx) {
  const { req, res, active, url, method, deps } = ctx
  if (method !== 'POST') return fail(res, 405, 'method-not-allowed', '只用 POST')
  return json(res, 200, { ok: true, data: buildTypeOp(active, await readBody(req)) })
}

export function handleClassifyDiag(ctx) {
  const { req, res, active, url, method, deps } = ctx
  if (method !== 'GET') return fail(res, 405, 'method-not-allowed', '只用 GET')
  const llm = typeof deps.getLlm === 'function' ? deps.getLlm() : null
  const routeInfo = typeof deps.getRoute === 'function' ? deps.getRoute() : null
  return json(res, 200, { ok: true, data: { mode: active && active.mode ? active.mode : '', hasLlm: llm !== null && llm !== undefined, hasStream: llm !== null && llm !== undefined && typeof llm.stream === 'function', hasRoute: routeInfo !== null && routeInfo !== undefined, provider: routeInfo && routeInfo.provider ? String(routeInfo.provider) : '', model: routeInfo && routeInfo.model ? String(routeInfo.model) : '' } })
}

export async function handleClassify(ctx) {
  const { req, res, active, url, method, deps } = ctx
  if (method !== 'POST') return fail(res, 405, 'method-not-allowed', '只用 POST')
  if (!active || active.mode !== 'live' || typeof active.hot !== 'function') return fail(res, 400, 'unsupported', '示例数据不支持自动分类')
  const body = await readBody(req)
  const dataDir = String(readOf(active).dataDir || '')
  const targetId = String((body && body.id) || '')
  let snapshot
  try { snapshot = readStore(dataDir) } catch (error) { return fail(res, 500, 'store-unreadable', String((error && error.message) || error)) }
  const snapshotRow = (snapshot.experiences || []).find((item) => item.id === targetId)
  if (snapshotRow === undefined) return fail(res, 404, 'not-found', '经验不存在')
  // 0.44.1 P0-A（A3）：模型调用前先记下冲突判据——目标行的 typeId 与规范化 context；
  // 模型（可能很慢）在锁外跑，返回后进锁无缓存重读，再决定是否应用。
  const snapshotTypeId = String(snapshotRow.typeId || '')
  const snapshotContext = normalizeContext(snapshotRow.context)
  const typeNames = (snapshot.types || []).filter((type) => type && type.system !== true).map((type) => String(type.name || '')).filter(Boolean)
  const tagNames = tagCatalog(snapshot, { limit: 60, dataDir }).map((item) => item.name)
  const text = [snapshotRow.intent, snapshotRow.action, snapshotRow.note].filter(Boolean).join('\n')
  let decided = null
  try {
    decided = await classifyExperienceWithSession({
      llm: typeof deps.getLlm === 'function' ? deps.getLlm() : null,
      route: typeof deps.getRoute === 'function' ? deps.getRoute() : null,
      text,
      typeNames,
      tagNames,
    })
  } catch { decided = null }
  // 本地兜底也只能从词表里选（core + 已复用），不许自己造实例标签。
  if (decided === null) decided = localClassifyExperience({ text, typeNames, tagNames, allowedTags: tagNames })
  return withStoreLock(dataDir, () => {
    const store = readStore(dataDir)
    const row = (store.experiences || []).find((item) => item.id === targetId)
    if (row === undefined) return fail(res, 404, 'not-found', '经验不存在')
    const nowContext = normalizeContext(row.context)
    if (String(row.typeId || '') !== snapshotTypeId || JSON.stringify(nowContext) !== JSON.stringify(snapshotContext)) {
      // 等待期间这条的 type/context 已被用户或其他写者改过：409 交回调用方，不覆盖新决定。
      return fail(res, 409, 'classify-conflict', '这条经验在自动分类期间被修改，已放弃本次分类结果（可重试）')
    }
    // 其余字段 / 其他记录的并发更新不判冲突：在最新库上应用，分类与标签合并都基于最新 context。
    const target = (store.types || []).find((type) => type && type.name === decided.category && type.system !== true)
      || (store.types || []).find((type) => type && type.system !== true)
    if (target === undefined) return fail(res, 400, 'no-type', '没有可用的主分类')
    row.typeId = target.id
    row.typeName = target.name
    const existingTags = nowContext
    const room = Math.max(0, 8 - existingTags.length)
    const addedTags = (Array.isArray(decided.tags) ? decided.tags : []).map(String).filter((tag) => tag !== '' && !existingTags.includes(tag)).slice(0, room)
    row.context = normalizeContext([...existingTags, ...addedTags])
    writeStore(dataDir, store)
    // 自动分类只补标签，不替用户凑面：补完仍缺对象/动作就回 tagWarning（UI 黄字提示）。
    const tagCheck = validateTagSet(row.context)
    return json(res, 200, { ok: true, data: { id: row.id, typeName: target.name, tags: row.context, addedTags, classifier: decided.classifier, note: decided.note, model: decided.model || '', tagWarning: tagCheck.warning === '' ? undefined : tagCheck.warning } })
  })
}
