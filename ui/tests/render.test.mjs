/**
 * exp-ui 渲染冒烟：把真实示例数据塞进各页签，跑一遍渲染，抓「有空数据但渲染时炸」的问题。
 *
 * 做法：vm 载入 client.js，用「按调用顺序返回预置值」的 React 桩代替 hooks，
 * 让组件带着数据真跑一次；不验证像素，只验证不抛错 + 关键文案在。
 * Run: node tests/render.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

import { buildSkills, buildState } from '../shell.js'
import { createMockSource } from '../mock.js'
import { detailOf, listOf, recallOf } from '../data-source.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const source = createMockSource()
const store = source.read().store

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

const primitivesStub = {
  IconChecklistOutlineRegular(props) {
    return { type: 'primitives-icon', props }
  },
}

/**
 * 渲染主面板一次。
 * @param {object} preset - 各 useState 的预置值（state/list/skills/usage/tab/selectedId/detail/…）。
 */
function renderPanel(preset) {
  const seq = [
    preset.state === undefined ? null : preset.state,
    preset.list === undefined ? null : preset.list,
    preset.usage === undefined ? null : preset.usage,
    preset.skills === undefined ? null : preset.skills,
    preset.expandedSkill === undefined ? '' : preset.expandedSkill,
    preset.tab === undefined ? 'experiences' : preset.tab,
    preset.queryInput === undefined ? '' : preset.queryInput,
    preset.query === undefined ? '' : preset.query,
    preset.typeFilter === undefined ? '' : preset.typeFilter,
    preset.outcomeFilter === undefined ? '' : preset.outcomeFilter,
    preset.sort === undefined ? 'recent' : preset.sort,
    preset.selectedId === undefined ? '' : preset.selectedId,
    preset.cursorId === undefined ? '' : preset.cursorId,
    preset.detail === undefined ? null : preset.detail,
    '',
    false,
    '',
  ]
  let index = 0
  const React = {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children }
    },
    useState() {
      const value = index < seq.length ? seq[index] : undefined
      index += 1
      return [value, () => {}]
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

  const sourceCode = fs.readFileSync(path.join(root, 'client.js'), 'utf8')
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
    navigator: { clipboard: { writeText: async () => {} } },
    URL,
    URLSearchParams,
    console,
    setTimeout,
    clearTimeout,
  }
  vm.createContext(sandbox)
  new vm.Script(sourceCode, { filename: 'client.js' }).runInContext(sandbox)
  const module = moduleConfig.factory((name) => {
    if (name === 'react') return React
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitivesStub
    throw new Error(`unexpected require: ${name}`)
  })
  const registrations = []
  module.apply({
    slots: {
      inject(name, callback) {
        return callback()
      },
      register(registration, component) {
        registrations.push({ registration, component })
        return () => {}
      },
    },
    layout: { selectPanel() {} },
    effect(callback) {
      return callback()
    },
  })
  const panel = registrations.find((entry) => entry.registration.name === 'main').component
  const tree = panel()
  return JSON.stringify(tree, (key, value) => (typeof value === 'function' ? '[fn]' : value))
}

const state = buildState(source)
const list = listOf(store, new URLSearchParams())
const skills = buildSkills(source)
const usage = { rows: source.usageRows(100).slice().reverse() }
const detail = detailOf(store, 'ex_mock_01')

check('经验页：12 条列表 + 选中详情（上一条/下一条/用后反馈/复制 id）', () => {
  const out = renderPanel({ state, list, selectedId: 'ex_mock_01', detail })
  assert.ok(out.includes('经验'))
  assert.ok(out.includes('把 PPT 导出成 PDF'))
  assert.ok(out.includes('上一条'))
  assert.ok(out.includes('下一条'))
  assert.ok(out.includes('用后反馈'))
  assert.ok(out.includes('复制'))
})

check('检索态：候选组 + 证据 + 排序说明', () => {
  const recall = recallOf(store, '把 PPT 导出成 PDF', 8)
  const out = renderPanel({ state, list: { ...recall, source: state.source, notice: '' } })
  assert.ok(out.includes('按优势排序') || out.includes('按证据排序'))
  assert.ok(out.includes('相似'))
  assert.ok(out.includes('支持'))
})

check('技能页：卡片、状态、指标、展开正文', () => {
  const out = renderPanel({ state, tab: 'skills', skills })
  assert.ok(out.includes('固化技能'))
  assert.ok(out.includes('已固化'))
  assert.ok(out.includes('PPT 导出 PDF 前先查字体'))
  assert.ok(out.includes('障碍'))
  assert.ok(out.includes('来源'))
  const expanded = renderPanel({ state, tab: 'skills', skills, expandedSkill: 'ppt-export-pdf' })
  assert.ok(expanded.includes('## 做法'))
})

check('类型页与使用记录页：有数据时正常渲染', () => {
  const typesOut = renderPanel({ state, tab: 'types' })
  assert.ok(typesOut.includes('PPT / 课件'))
  assert.ok(typesOut.includes('看这些经验'))
  const usageOut = renderPanel({ state, tab: 'usage', usage })
  assert.ok(usageOut.includes('召回'))
  assert.ok(usageOut.includes('最近'))
})

check('空数据 / 空技能 / 空使用记录：空态不抛错', () => {
  const emptyState = { ...state, exists: false, totals: { ...state.totals, visible: 0, skills: 0, types: 0 }, types: [] }
  const emptyList = { ...list, mode: 'list', total: 0, rows: [], counts: {}, source: state.source, notice: '' }
  const out = renderPanel({ state: emptyState, list: emptyList })
  assert.ok(out.includes('清除筛选'))
  assert.ok(renderPanel({ state: emptyState, list: emptyList, tab: 'skills', skills: { skills: [], summary: { total: 0, solid: 0, trial: 0, risky: 0, new: 0, blocked: 0 } } }).includes('还没有固化技能'))
  assert.ok(renderPanel({ state: emptyState, list: emptyList, tab: 'usage', usage: { rows: [] } }).includes('还没有调用记录'))
  assert.ok(renderPanel({ state: emptyState, list: emptyList, tab: 'types' }).includes('还没有类型'))
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
