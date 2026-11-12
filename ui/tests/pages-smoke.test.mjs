/**
 * 八个页面冒烟：用桩递归执行每个页面组件（含空数据），任何渲染异常都算失败。
 * 这次崩溃的回归点：经验页 list.data 为 null 时 rows.length 抛错。
 * Run: node tests/pages-smoke.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

import { createMockSource } from '../mock.js'
import { buildState } from '../shell.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const source = fs.readFileSync(path.join(root, '..', 'client.js'), 'utf8')
const TABS = ['overview', 'graph', 'experiences', 'recall', 'record', 'skills', 'types', 'usage', 'settings']

let passed = 0
let failed = 0

function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}`)
    console.log(`       ${error && error.stack ? error.stack : error}`)
  }
}

function buildTree(tab) {
  let config = null
  let firstRender = true
  let firstCalls = 0
  const React = {
    createElement(type, props, ...children) { const merged = props || {}; if (children.length === 1) merged.children = children[0]; else if (children.length > 1) merged.children = children; return { type, props: merged, children } },
    useState(initial) {
      if (firstRender && firstCalls < 3) {
        const preset = firstCalls === 0 ? tab : firstCalls === 1 ? null : ''
        firstCalls += 1
        return [preset, () => {}]
      }
      return [typeof initial === 'function' ? initial() : initial, () => {}]
    },
    useEffect() {},
    useCallback(fn) { return fn },
    useMemo(fn) { return fn() },
    useRef(value) { return { current: value } },
  }
  const sandbox = {
    window: { __ModuleLoader__: { load(value) { config = value } } },
    require(name) {
      if (name === 'react') return React
      if (name === '@deepseek-ai/dsh-client-ui-primitives') return { IconChecklistOutlineRegular: () => ({}) }
      throw new Error(`unexpected require ${name}`)
    },
    console,
    fetch: async () => ({ status: 500, json: async () => ({ ok: false, error: { message: 'offline' } }) }),
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'client.js' })
  const registrations = []
  config.factory(sandbox.require).apply({
    slots: { inject(name, fn) { fn(); return () => {} }, register(registration, component) { registrations.push({ registration, component }) } },
    layout: { selectPanel() {} },
    effect() {},
  })
  const Console = registrations.find((entry) => entry.registration.name === 'main').component
  firstRender = true
  const tree = Console()
  firstRender = false
  return tree
}

function walk(node, visit) {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) { node.forEach((child) => walk(child, visit)); return }
  if (typeof node.type === 'function') {
    if (node.type.name === 'Console') return
    visit(node)
    const output = node.type(node.props)
    if (output !== undefined && output !== null) walk(output, visit)
    return
  }
  for (const child of node.children || []) walk(child, visit)
}

check('八个页面（空数据）渲染不抛错', () => {
  for (const tab of TABS) {
    const tree = buildTree(tab)
    walk(tree, () => {})
  }
})

check('经验页：list.data=null 不再读 rows.length', () => {
  const tree = buildTree('experiences')
  let rendered = false
  walk(tree, (element) => {
    if (element.type.name === 'Experiences') rendered = true
  })
  assert.ok(rendered, '应渲染到 Experiences 页面')
})

/** 找到概览页组件函数（walk 会在调用前 visit，拿到的就是它）。 */
function overviewOf(tab) {
  const tree = buildTree(tab)
  let component = null
  walk(tree, (element) => {
    if (element.type.name === 'Overview') component = element.type
  })
  return component
}

check('概览页：存储结构四格 + 总计 + legacy 可删（mock 有数据）', () => {
  const Overview = overviewOf('overview')
  assert.equal(typeof Overview, 'function', '应能定位到 Overview 组件')
  const state = buildState(createMockSource())
  assert.ok(state.storage !== null && typeof state.storage === 'object', 'mock 应带 storage')
  assert.equal(state.cold.total, 2, 'mock 应造 2 条冷档')
  const text = JSON.stringify(Overview({ state, onGo: () => {}, onOpen: () => {} }), (key, value) => (typeof value === 'function' ? '[fn]' : value))
  for (const label of ['存储结构', 'manifest', '分片', '冷档', 'legacy', '可删', '总计', '个文件', '2 条']) {
    assert.ok(text.includes(label), `缺少「${label}」`)
  }
})

check('概览页：无冷档显示「暂无冷档」，不空白不报错', () => {
  const Overview = overviewOf('overview')
  const state = buildState(createMockSource())
  const noCold = { ...state, cold: { years: [], total: 0, samples: [] } }
  const text = JSON.stringify(Overview({ state: noCold, onGo: () => {}, onOpen: () => {} }), (key, value) => (typeof value === 'function' ? '[fn]' : value))
  assert.ok(text.includes('暂无冷档（容量安全阀未触发）'), '无冷档时应显示明确文案')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
