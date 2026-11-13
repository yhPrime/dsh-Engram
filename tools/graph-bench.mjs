#!/usr/bin/env node
/**
 * 关系图布局基准：`client.js` 里的纯函数 `layoutGraph`（不依赖 React / DOM）。
 *
 * 固定夹具按真实 `buildGraph` 的形状合成：root → 20 类型 → N 经验 + 80 技能/套件
 * （8 个套件各带 6 个子技能，另 24 个顶层技能挂根，其中若干挂 derived 经验边）。
 * 节点总数 = 1k / 3k / 5k；每档跑 3 次取中位数，并核对两次布局的坐标校验和一致。
 *
 * 阈值参考（Node 夹具，非浏览器帧率）：
 *   1,000 < 120ms / 3,000 < 300ms / 5,000 < 600ms
 *
 * 只读：加载 `client.js` 副本到 vm，不写任何库、不发请求。
 * 运行：node tools/graph-bench.mjs（仓库根目录）；失败时退出码 1。
 */

import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const CLIENT = path.join(REPO, 'client.js')

const TYPE_COUNT = 20
const SUITE_COUNT = 8
const SUITE_CHILDREN = 6
const TOP_SKILL_COUNT = 24
const HIERARCHY_COUNT = SUITE_COUNT * (1 + SUITE_CHILDREN) + TOP_SKILL_COUNT
const RUNS = 3

export const BENCH_THRESHOLDS = [
  { size: 1000, limitMs: 120 },
  { size: 3000, limitMs: 300 },
  { size: 5000, limitMs: 600 },
]

/** layoutGraph 只做布局，React 桩只需要让模块工厂能建起来。 */
const ReactStub = {
  createElement(type, props, ...children) {
    return { type, props: props || {}, children }
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useEffect() {},
  useCallback(fn) {
    return fn
  },
  useMemo(fn) {
    return fn()
  },
  useRef(value) {
    return { current: value }
  },
}

/**
 * 用 vm 截获 `window.__ModuleLoader__.load`，拿到 client 模块导出（与 ui/tests/client.test.mjs 同法）。
 * 只测纯函数，不 apply 插槽、不渲染组件。
 */
export function loadClientModule() {
  const source = fs.readFileSync(CLIENT, 'utf8')
  let moduleConfig = null
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(config) {
          moduleConfig = config
        },
      },
      addEventListener() {},
      removeEventListener() {},
    },
    document: { baseURI: 'http://127.0.0.1:1/' },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, data: {} }) }),
    URL,
    URLSearchParams,
    console,
    setTimeout,
    clearTimeout,
  }
  vm.createContext(sandbox)
  new vm.Script(source, { filename: 'client.js' }).runInContext(sandbox)
  if (moduleConfig === null) throw new Error('client.js 没有向 window.__ModuleLoader__.load 注册模块')
  const module = moduleConfig.factory((name) => {
    if (name === 'react') return ReactStub
    throw new Error(`unexpected require: ${name}`)
  })
  if (typeof module.layoutGraph !== 'function') throw new Error('client.js 没有导出 layoutGraph')
  return module
}

const expId = (index) => `exp:e${String(index).padStart(6, '0')}`

/**
 * 固定夹具：同一 size 每次生成完全相同的节点/边（不使用 Math.random / 当前时间）。
 * @param {number} size - 节点总数（含 root）。
 */
export function buildGraphFixture(size) {
  const total = Math.max(TYPE_COUNT + HIERARCHY_COUNT + 2, Math.trunc(Number(size)) || 0)
  const experienceCount = total - 1 - TYPE_COUNT - HIERARCHY_COUNT
  const nodes = [{ id: 'root', kind: 'root', label: '经验库' }]
  const edges = []

  for (let index = 0; index < TYPE_COUNT; index += 1) {
    const id = `type:t${String(index).padStart(2, '0')}`
    nodes.push({
      id,
      kind: 'type',
      label: `类型 ${index}`,
      weight: Number((0.35 + ((index % 7) / 7) * 0.6).toFixed(4)),
      count: experienceCount / TYPE_COUNT,
    })
    edges.push({ source: 'root', target: id, kind: 'root', strength: 0.3 + ((index % 5) / 5) * 0.4 })
  }

  const outcomes = ['success', 'accepted', 'partial', 'failed', 'corrected', 'unknown', 'success', 'partial']
  for (let index = 0; index < experienceCount; index += 1) {
    const id = expId(index)
    const typeId = `t${String(index % TYPE_COUNT).padStart(2, '0')}`
    nodes.push({
      id,
      kind: 'experience',
      label: `经验 ${index}`,
      typeId,
      weight: Number((0.3 + ((index % 9) / 9) * 0.7).toFixed(4)),
      outcome: outcomes[index % outcomes.length],
    })
    edges.push({ source: `type:${typeId}`, target: id, kind: 'type', strength: 0.25 + ((index % 6) / 6) * 0.5 })
  }

  // 套件（宫格里的组节点）挂根，套件子技能用 suite 边；对应 buildGraph 的 walkSkill。
  for (let suite = 0; suite < SUITE_COUNT; suite += 1) {
    const suiteId = `suite:套件${suite}`
    nodes.push({ id: suiteId, kind: 'suite', label: `套件 ${suite}`, parent: '', depth: 0, weight: 0.5 + (suite / SUITE_COUNT) * 0.5 })
    edges.push({ source: 'root', target: suiteId, kind: 'root', strength: 0.55 })
    for (let child = 0; child < SUITE_CHILDREN; child += 1) {
      const childId = `skill:套件${suite}/${child}`
      nodes.push({ id: childId, kind: 'skill', label: `技能 ${suite}-${child}`, parent: suiteId, depth: 1, weight: 0.45 + (child / SUITE_CHILDREN) * 0.4 })
      edges.push({ source: suiteId, target: childId, kind: 'suite', strength: 0.9 })
    }
  }

  // 顶层独立技能：buildGraph 里挂 root 边；有 derivedFrom 经验时再挂 exp -> skill 的 derived 边。
  for (let index = 0; index < TOP_SKILL_COUNT; index += 1) {
    const id = `skill:独立技能${index}`
    nodes.push({ id, kind: 'skill', label: `独立技能 ${index}`, parent: '', depth: 0, weight: 0.45 + ((index % 5) / 5) * 0.5 })
    edges.push({ source: 'root', target: id, kind: 'root', strength: 0.55 })
  }
  const maxDerived = Math.min(TOP_SKILL_COUNT, experienceCount)
  for (let index = 0; index < maxDerived; index += 1) {
    const experienceIndex = (index * 97 + 13) % experienceCount
    edges.push({ source: expId(experienceIndex), target: `skill:独立技能${index}`, kind: 'derived', strength: 0.5 + ((index % 5) / 5) * 0.45 })
  }

  return {
    nodes,
    edges,
    summary: { types: TYPE_COUNT, experiences: experienceCount, skills: HIERARCHY_COUNT, suites: SUITE_COUNT },
  }
}

/** 两次布局的坐标校验和：只判断确定性，不做性能。 */
export function checksumOf(positions) {
  const ids = [...positions.keys()].sort()
  let hash = 2166136261
  for (const id of ids) {
    const point = positions.get(id)
    const text = `${id}:${point.x},${point.y},${point.z}`
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index)
      hash = Math.imul(hash, 16777619)
    }
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/**
 * 跑 `runs` 次 layoutGraph，返回中位数耗时、样本、最后一次位置、第一次位置。
 * 位置只在计时窗口内算，不把夹具构造算进去。
 */
export function measureLayout(module, data, runs = RUNS) {
  const samples = []
  let firstPositions = null
  let positions = null
  for (let index = 0; index < runs; index += 1) {
    const started = process.hrtime.bigint()
    positions = module.layoutGraph(data)
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6
    samples.push(elapsedMs)
    if (index === 0) firstPositions = positions
  }
  const sorted = [...samples].sort((left, right) => left - right)
  return { samples, medianMs: sorted[Math.floor(sorted.length / 2)], positions, firstPositions }
}

/** 布局结果必须覆盖所有非 root 节点：坐标有限、数量吻合、根节点不占位置。 */
export function validateLayout(positions, data) {
  const problems = []
  const expected = data.nodes.length - 1
  if (positions.size !== expected) problems.push(`位置数 ${positions.size} ≠ 非 root 节点数 ${expected}`)
  if (positions.has('root')) problems.push('根节点不该有位置（画布把它放在原点）')
  for (const [id, point] of positions) {
    if (![point.x, point.y, point.z].every((value) => Number.isFinite(value))) {
      problems.push(`节点 ${id} 的坐标不是有限值：${JSON.stringify(point)}`)
      break
    }
  }
  return problems
}

async function main() {
  const module = loadClientModule()
  console.log(`关系图布局基准（layoutGraph，纯函数；Node ${process.version}）`)
  console.log(`固定夹具：1 root + ${TYPE_COUNT} 类型 + N 经验 + ${HIERARCHY_COUNT} 技能/套件（${SUITE_COUNT} 套件 × ${SUITE_CHILDREN} 子技能）`)
  console.log(`每档 ${RUNS} 次取中位数；阈值：${BENCH_THRESHOLDS.map((row) => `${row.size}<${row.limitMs}ms`).join(' / ')}`)
  console.log('')

  // 预热：小夹具跑两遍，让 layoutGraph 的代码路径先过 JIT（不计入结果）。
  const warmup = buildGraphFixture(TYPE_COUNT + HIERARCHY_COUNT + 2)
  module.layoutGraph(warmup)
  module.layoutGraph(warmup)

  const rows = []
  console.log('size    ms        positions  threshold  status')
  for (const { size, limitMs } of BENCH_THRESHOLDS) {
    const data = buildGraphFixture(size)
    const measured = measureLayout(module, data, RUNS)
    const problems = validateLayout(measured.positions, data)
    const stable = checksumOf(measured.firstPositions) === checksumOf(measured.positions)
    if (!stable) problems.push('两次布局的坐标校验和不同（布局不确定）')
    if (measured.medianMs >= limitMs) problems.push(`中位数 ${measured.medianMs.toFixed(2)}ms ≥ 阈值 ${limitMs}ms`)
    rows.push({ size, measured, problems })
    console.log(
      `${String(size).padEnd(6)}${measured.medianMs.toFixed(2).padStart(8)}ms`
      + `${String(measured.positions.size).padStart(11)}`
      + `${String(`${limitMs}ms`).padStart(11)}`
      + `   ${problems.length === 0 ? 'ok' : 'FAIL'}`,
    )
  }

  const failures = rows.filter((row) => row.problems.length > 0)
  if (failures.length > 0) {
    console.log('')
    console.log('失败原因：')
    for (const row of failures) {
      for (const problem of row.problems) console.log(`  - ${row.size}: ${problem}`)
    }
  }
  console.log('')
  for (const row of rows) {
    const samples = row.measured.samples.map((value) => value.toFixed(2)).join(' / ')
    console.log(`  ${row.size} 样本：${samples}ms；校验和 ${checksumOf(row.measured.firstPositions)}`)
  }
  console.log('')
  console.log(failures.length > 0 ? '结论：存在超出阈值或不一致的档位' : '结论：全部通过（布局耗时在阈值内，位置确定，根节点无位置）')
  process.exitCode = failures.length > 0 ? 1 : 0
}

const invokedDirectly = process.argv[1] !== undefined
  && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`基准运行失败：${error && error.stack ? error.stack : error}`)
    process.exit(1)
  })
}
