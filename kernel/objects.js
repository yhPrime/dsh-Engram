/**
 * 0.35：对象链存储与校验。
 *
 * 一条「对象」记录的是**一件具体工作的实际过程**：对象名 + 1..n 条链（每条链 1..n 步，
 * 每步是一个动作族）；某步失败可在该步下挂分支（换一组动作继续），分支可再嵌套。
 *
 * 与经验库彻底解耦：
 * - 文件在库根 `objects.jsonl`，**不放 `library/`**（那里 `*.jsonl` 会被当族分片扫描并被
 *   `_index.json` 计数校验，多一个文件即判损坏）；
 * - 不进 manifest、不进 `_index.json`、不进召回与排序；
 * - 文件不存在 = 没有对象，读操作不建文件。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

import { FAMILY_INVISIBLE_RE, normalizeFamilyName } from './family-name.js'
import { validateFamilyName } from './family-tools.js'
import { resolveFamilyRef } from './family-registry.js'

export const OBJECTS_FILE = 'objects.jsonl'
/** 分支嵌套深度上限（从主干算起，主干步=0）。 */
export const MAX_BRANCH_DEPTH = 3
/** 「常用分支」只看最近多少条链。 */
export const PROMOTE_WINDOW = 5
/** 窗口内出现多少次算常用。 */
export const PROMOTE_MIN = 3
export const OUTCOMES = Object.freeze(['ok', 'failed', 'skipped'])
export const BRANCH_RESULTS = Object.freeze(['recovered', 'aborted'])
const NOTE_MAX = 200
const OBJECT_NAME_MAX = 40
const GENERIC_WHEN = /^(失败|出错|出问题|有异常|异常|报错|错误|error|fail|failed|失败。|出错了)[。.!！]?$/iu

export function objectsFile(dataDir) {
  return path.join(String(dataDir || ''), OBJECTS_FILE)
}

function newObjectId() {
  return `ob_${createHash('sha1').update(`${Date.now()}|${Math.random()}|${process.pid}`).digest('hex').slice(0, 8)}`
}

function clipNote(raw) {
  const text = String(raw === undefined || raw === null ? '' : raw).replace(/\s+/gu, ' ').trim()
  if (text === '') return ''
  return [...text].slice(0, NOTE_MAX).join('')
}

function isoAt(value) {
  const date = value === undefined || value === null ? new Date() : new Date(value)
  if (Number.isNaN(date.getTime())) return new Date().toISOString()
  return date.toISOString()
}

/** 读对象库：缺文件返回 []（**不建文件**）；坏行带行号报错，不静默少读。 */
export function readObjects(dataDir) {
  let text = ''
  try {
    text = fs.readFileSync(objectsFile(dataDir), 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return []
    throw error
  }
  const out = []
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (line === '') continue
    let row = null
    try { row = JSON.parse(line) } catch { row = null }
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error(`对象库损坏：${OBJECTS_FILE} 第 ${index + 1} 行不是合法对象`)
    }
    out.push({
      id: String(row.id || ''),
      object: String(row.object || ''),
      at: String(row.at || ''),
      chains: Array.isArray(row.chains) ? row.chains.filter((chain) => chain !== null && typeof chain === 'object' && !Array.isArray(chain)) : [],
    })
  }
  return out
}

export function writeObjects(dataDir, list) {
  const dir = String(dataDir || '')
  fs.mkdirSync(dir, { recursive: true })
  const file = objectsFile(dir)
  if (!Array.isArray(list) || list.length === 0) {
    try { fs.unlinkSync(file) } catch (error) { if (!error || error.code !== 'ENOENT') throw error }
    return 0
  }
  const text = `${list.map((row) => JSON.stringify(row)).join('\n')}\n`
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, text, 'utf8')
  try {
    fs.renameSync(tmp, file)
  } catch (error) {
    try { fs.unlinkSync(tmp) } catch { /* ignore */ }
    throw error
  }
  return list.length
}

/** 对象名归一：折叠空白、限长；不硬拦实例名（定稿 §10-4）。 */
export function normalizeObjectName(raw) {
  const text = String(raw === undefined || raw === null ? '' : raw).replace(/\s+/gu, ' ').trim().normalize('NFKC')
  if (text === '') throw new Error('object 必填：写清这是什么对象/这件事')
  if ([...text].length > OBJECT_NAME_MAX) throw new Error(`对象名最多 ${OBJECT_NAME_MAX} 字`)
  return [...text].slice(0, OBJECT_NAME_MAX).join('')
}

/** 对象名比较键：只做 NFKC / 折叠空白 / 小写，不套族名同义表。 */
function objectKey(raw) {
  return String(raw === undefined || raw === null ? '' : raw).normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase()
}

/** 按 id 或名字找对象。 */
export function findObject(list, key) {
  const text = String(key === undefined || key === null ? '' : key).trim()
  if (text === '') return null
  const byId = list.find((row) => row.id === text)
  if (byId !== undefined) return byId
  const normalized = objectKey(text)
  return list.find((row) => objectKey(row.object) === normalized) || null
}

export function assertNoDuplicate(list, name) {
  const normalized = objectKey(name)
  const hit = list.find((row) => objectKey(row.object) === normalized)
  if (hit !== undefined) throw new Error(`对象已存在：${hit.object}（${hit.id}）。要继续记一件事请 append，换一件事请换对象名`)
}

/** 工具入参 steps → 存储步骤；resolveFamily(name) 返回族 id。 */
/**
 * @param {Array} rawList 步骤数组 [{family, direction?, note?, outcome?}]
 * @param {(familyName:string)=>string} resolveFamily 族名 → 族 id
 * @param {{resolveDirection?: (familyName:string, direction:string)=>string, requireDirection?: boolean}} [options]
 *   resolveDirection：返回规范化方向名，非法则 throws（0.38 由调用方接 validateDirectionForFamily）。
 *   requireDirection：true 时每一步必须带 direction（exp_object 工具走 true）。
 */
export function buildSteps(rawList, resolveFamily, options = {}) {
  const list = Array.isArray(rawList) ? rawList : []
  if (list.length === 0) throw new Error('steps 至少要有 1 步（[{family, direction, note}]）')
  const { resolveDirection = null, requireDirection = false } = options
  return list.map((item) => {
    const source = item !== null && typeof item === 'object' && !Array.isArray(item) ? item : { family: item }
    if (source.family !== undefined && source.family !== null && typeof source.family !== 'string') throw new Error('每一步的族名必须是字符串（[{ family, direction, note }]）')
    // 0.38：非空字符串族名先过 validateFamilyName（含不可见/泛词/长度），与其它入口同文案；
    // 纯空白（无不可见符）留给下面报「每一步都要有族名」；纯不可见符（如 U+FEFF）走校验器的「族名不能为空」。
    if (typeof source.family === 'string' && source.family !== '') {
      const plainBlank = source.family.trim() === '' && !FAMILY_INVISIBLE_RE.test(source.family)
      if (!plainBlank) validateFamilyName(source.family)
    }
    const familyName = normalizeFamilyName(source.family)
    if (familyName === '') throw new Error('每一步都要有族名：steps: [{ family, direction, note }]')
    // 0.38：方向先解析（旧族名+旧方向时优先报「方向不属于该族」，而不是先报族名退休）。
    const rawDirection = String(source.direction === undefined || source.direction === null ? '' : source.direction).trim()
    let directionValue
    if (rawDirection === '') {
      if (requireDirection) throw new Error('每一步都要有方向标签：steps: [{ family, direction, note }]；方向用 exp_type label 登记（facet=direction + family）')
    } else {
      if (typeof resolveDirection !== 'function') throw new Error('这一步带了 direction，但没有提供方向解析器')
      directionValue = resolveDirection(familyName, rawDirection)
    }
    const step = { familyId: resolveFamily(familyName) }
    if (directionValue !== undefined) step.direction = directionValue
    const note = clipNote(source.note)
    if (note !== '') step.note = note
    if (source.outcome !== undefined && source.outcome !== null) {
      if (typeof source.outcome !== 'string') throw new Error(`对象步的 outcome 只能是 ${OUTCOMES.join(' / ')}（收到非字符串）`)
      const outcome = source.outcome.trim()
      if (outcome !== '') {
        if (!OUTCOMES.includes(outcome)) throw new Error(`outcome 只能是 ${OUTCOMES.join(' / ')}`)
        if (outcome !== 'ok') step.outcome = outcome
      }
    }
    return step
  })
}

/**
 * 按 [步骤, 分支, 步骤, …]（1 起、奇数长度）定位某一步。
 * @returns {{chain: object, steps: Array<object>, step: object, level: number}}
 */
export function locateStep(obj, chainIndex, stepPath) {
  const chains = Array.isArray(obj.chains) ? obj.chains : []
  const index = Number(chainIndex)
  if (!Number.isInteger(index) || index < 1 || index > chains.length) {
    throw new Error(`chainIndex 越界：这个对象只有 ${chains.length} 条链`)
  }
  const path = Array.isArray(stepPath) ? stepPath.map((item) => Number(item)) : []
  if (path.length === 0 || path.length % 2 === 0) {
    throw new Error('stepPath 必须是从 1 起的奇数长度数组：[步骤] / [步骤, 分支, 步骤] …')
  }
  const chain = chains[index - 1]
  let steps = Array.isArray(chain.steps) ? chain.steps : []
  for (let level = 0; level * 2 < path.length; level += 1) {
    const stepIndex = path[level * 2]
    if (!Number.isInteger(stepIndex) || stepIndex < 1 || stepIndex > steps.length) {
      throw new Error(`stepPath 第 ${level * 2 + 1} 段越界：这一层只有 ${steps.length} 步`)
    }
    const step = steps[stepIndex - 1]
    if (level * 2 + 1 >= path.length) return { chain, steps, step, level }
    const branchIndex = path[level * 2 + 1]
    const branches = Array.isArray(step.branches) ? step.branches : []
    if (!Number.isInteger(branchIndex) || branchIndex < 1 || branchIndex > branches.length) {
      throw new Error(`stepPath 第 ${level * 2 + 2} 段越界：这一步只有 ${branches.length} 条分支`)
    }
    steps = Array.isArray(branches[branchIndex - 1].steps) ? branches[branchIndex - 1].steps : []
  }
  throw new Error('stepPath 定位失败')
}

/** 定位「一条分支的 steps 容器」或「整条链」：偶数长度 stepPath，空 = 主干。 */
export function locateContainer(obj, chainIndex, stepPath) {
  const path = Array.isArray(stepPath) ? stepPath.map((item) => Number(item)) : []
  if (path.length === 0) {
    const index = Number(chainIndex)
    const chains = Array.isArray(obj.chains) ? obj.chains : []
    if (!Number.isInteger(index) || index < 1 || index > chains.length) throw new Error(`chainIndex 越界：这个对象只有 ${chains.length} 条链`)
    return { steps: (chains[index - 1].steps = Array.isArray(chains[index - 1].steps) ? chains[index - 1].steps : []) }
  }
  if (path.length % 2 !== 0) throw new Error('补到分支里时 stepPath 要指向分支本身（偶数长度，如 [2, 1]）')
  // 偶数路径：最后两段是「所属步骤, 分支」。
  const ownerPath = path.slice(0, -1)
  const located = locateStep(obj, chainIndex, ownerPath)
  const branchIndex = path[path.length - 1]
  const branches = Array.isArray(located.step.branches) ? located.step.branches : []
  if (!Number.isInteger(branchIndex) || branchIndex < 1 || branchIndex > branches.length) {
    throw new Error(`分支越界：这一步只有 ${branches.length} 条分支`)
  }
  const branch = branches[branchIndex - 1]
  branch.steps = Array.isArray(branch.steps) ? branch.steps : []
  return { steps: branch.steps }
}

/** create：建对象 + 首条链。 */
export function createObject(list, rawName, steps, { note = '', at } = {}) {
  const name = normalizeObjectName(rawName)
  assertNoDuplicate(list, name)
  const chain = { at: isoAt(at), steps }
  const chainNote = clipNote(note)
  if (chainNote !== '') chain.note = chainNote
  const row = { id: newObjectId(), object: name, at: isoAt(at), chains: [chain] }
  list.push(row)
  return row
}

/** append：追一条完整的新链。 */
export function appendChain(obj, steps, { note = '', at } = {}) {
  const chain = { at: isoAt(at), steps }
  const chainNote = clipNote(note)
  if (chainNote !== '') chain.note = chainNote
  obj.chains.push(chain)
  return { chainIndex: obj.chains.length, steps: steps.length }
}

/** append：不给 chainIndex → 追一条新链；给了 → 往那条链（或指定分支）末尾补一步。 */
export function appendToObject(obj, { chainIndex, stepPath, step, note = '', at } = {}) {
  if (chainIndex === undefined || chainIndex === null || String(chainIndex).trim() === '') {
    const chain = { at: isoAt(at), steps: [step] }
    const chainNote = clipNote(note)
    if (chainNote !== '') chain.note = chainNote
    obj.chains.push(chain)
    return { chainIndex: obj.chains.length, stepIndex: 1, newChain: true }
  }
  const container = locateContainer(obj, chainIndex, stepPath)
  container.steps.push(step)
  return { chainIndex: Number(chainIndex), stepIndex: container.steps.length, newChain: false }
}

/** branch：给 failed 步骤挂一条分支。 */
export function addBranch(obj, { chainIndex, stepPath, when, steps, result } = {}) {
  const located = locateStep(obj, chainIndex, stepPath)
  if (located.step.outcome !== 'failed') throw new Error('只能给 outcome=failed 的步骤挂分支（先把它标成 failed）')
  const depth = located.level + 1
  if (depth > MAX_BRANCH_DEPTH) throw new Error(`分支嵌套最多 ${MAX_BRANCH_DEPTH} 层，这一层已经是第 ${depth} 层`)
  const text = String(when === undefined || when === null ? '' : when).replace(/\s+/gu, ' ').trim()
  if (text === '') throw new Error('when 必填：写清撞上什么意外（报错信息 / 环境不对）')
  if (GENERIC_WHEN.test(text)) throw new Error('when 要写具体意外，不要只写「失败 / 报错」这类空话')
  if ([...text].length > 200) throw new Error('when 最多 200 字')
  const branch = { when: [...text].slice(0, 200).join(''), steps }
  if (result !== undefined && result !== null && String(result).trim() !== '') {
    const value = String(result).trim()
    if (!BRANCH_RESULTS.includes(value)) throw new Error(`result 只能是 ${BRANCH_RESULTS.join(' / ')}`)
    if (value === 'aborted') branch.result = 'aborted'
  }
  located.step.branches = Array.isArray(located.step.branches) ? located.step.branches : []
  located.step.branches.push(branch)
  return { chainIndex: Number(chainIndex), stepPath: Array.isArray(stepPath) ? stepPath.map(Number) : [], depth, branches: located.step.branches.length }
}

function walkBranches(steps, visit, where = []) {
  const list = Array.isArray(steps) ? steps : []
  for (let index = 0; index < list.length; index += 1) {
    const step = list[index]
    if (step === null || typeof step !== 'object') continue
    const here = [...where, index + 1]
    for (let branchIndex = 0; branchIndex < (Array.isArray(step.branches) ? step.branches.length : 0); branchIndex += 1) {
      const branch = step.branches[branchIndex]
      visit(branch, { stepPath: [...here, branchIndex + 1], step })
      walkBranches(branch.steps, visit, [...here, branchIndex + 1])
    }
  }
}

function stepsSignature(steps) {
  return (Array.isArray(steps) ? steps : []).map((step) => String(step && step.familyId || '')).join('>')
}

/**
 * 「常用分支」提示（定稿 §10-2）：最近 PROMOTE_WINDOW 条链里，同 steps 序列或同 when
 * 出现 ≥PROMOTE_MIN 次即提示并进主干。只提示，不改历史、不自动搬。
 */
export function promotionHints(obj) {
  const chains = Array.isArray(obj.chains) ? obj.chains : []
  const from = Math.max(0, chains.length - PROMOTE_WINDOW)
  const bySteps = new Map()
  const byWhen = new Map()
  for (let index = from; index < chains.length; index += 1) {
    walkBranches(chains[index].steps, (branch, where) => {
      const signature = stepsSignature(branch.steps)
      const stepHit = bySteps.get(signature) || { signature, when: branch.when, count: 0, places: [] }
      stepHit.count += 1
      stepHit.places.push({ chainIndex: index + 1, stepPath: where.stepPath })
      bySteps.set(signature, stepHit)
      const whenKey = normalizeFamilyName(branch.when)
      const whenHit = byWhen.get(whenKey) || { when: branch.when, count: 0, places: [] }
      whenHit.count += 1
      whenHit.places.push({ chainIndex: index + 1, stepPath: where.stepPath })
      byWhen.set(whenKey, whenHit)
    })
  }
  const hints = []
  for (const hit of bySteps.values()) {
    if (hit.count >= PROMOTE_MIN) {
      hints.push({ reason: 'steps', when: hit.when, steps: hit.signature.split('>').filter((item) => item !== ''), count: hit.count, window: PROMOTE_WINDOW, places: hit.places })
    }
  }
  for (const hit of byWhen.values()) {
    if (hit.count < PROMOTE_MIN) continue
    if (hints.some((hint) => hint.reason === 'steps' && normalizeFamilyName(hint.when) === normalizeFamilyName(hit.when))) continue
    hints.push({ reason: 'when', when: hit.when, count: hit.count, window: PROMOTE_WINDOW, places: hit.places })
  }
  return hints
}

function stepView(step, registry) {
  const out = {}
  const ref = resolveFamilyRef(registry, step.familyId)
  if (ref === null) {
    out.family = '(族已删除)'
    out.familyId = String(step.familyId || '')
  } else {
    out.family = ref.name
    if (ref.aliasOf !== null) out.aliasOf = ref.aliasOf
  }
  if (step.direction !== undefined && step.direction !== '') out.direction = step.direction
  if (step.note !== undefined && step.note !== '') out.note = step.note
  if (step.outcome !== undefined && step.outcome !== '') out.outcome = step.outcome
  if (Array.isArray(step.branches) && step.branches.length > 0) {
    out.branches = step.branches.map((branch) => {
      const view = { when: branch.when }
      if (branch.result === 'aborted') view.result = 'aborted'
      view.steps = (Array.isArray(branch.steps) ? branch.steps : []).map((item) => stepView(item, registry))
      return view
    })
  }
  return out
}

/** 读视图：族 id 解析成当前名，命中别名标 aliasOf，解析不到标「族已删除」。 */
export function objectView(obj, registry) {
  return {
    id: obj.id,
    object: obj.object,
    at: obj.at,
    chains: (Array.isArray(obj.chains) ? obj.chains : []).map((chain) => {
      const view = { at: chain.at }
      if (chain.note) view.note = chain.note
      view.steps = (Array.isArray(chain.steps) ? chain.steps : []).map((step) => stepView(step, registry))
      return view
    }),
  }
}

/** 链里引用某个族（含别名）的位置；删族前用它拦。 */
export function chainReferences(objects, familyIds) {
  const ids = familyIds instanceof Set ? familyIds : new Set(familyIds)
  const hits = []
  for (const obj of Array.isArray(objects) ? objects : []) {
    (Array.isArray(obj.chains) ? obj.chains : []).forEach((chain, chainIndex) => {
      const scan = (steps, where) => {
        (Array.isArray(steps) ? steps : []).forEach((step, index) => {
          const here = [...where, index + 1]
          if (step !== null && typeof step === 'object' && ids.has(String(step.familyId || ''))) {
            hits.push({ object: obj.object, objectId: obj.id, chainIndex: chainIndex + 1, stepPath: here })
          }
          (Array.isArray(step && step.branches) ? step.branches : []).forEach((branch, branchIndex) => {
            scan(branch.steps, [...here, branchIndex + 1])
          })
        })
      }
      scan(chain.steps, [])
    })
  }
  return hits
}
