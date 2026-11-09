/**
 * 经验库控制台渲染冒烟：新控制台外壳（左栏 + 八个页面入口）不带数据渲染不抛错。
 * Run: node tests/render.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')

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

const React = {
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

function loadPanel() {
  let moduleConfig = null
  const source = fs.readFileSync(path.join(root, '..', 'client.js'), 'utf8')
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(config) {
          moduleConfig = config
        },
      },
    },
    require(name) {
      if (name === 'react') return React
      if (name === '@deepseek-ai/dsh-client-ui-primitives') return { IconChecklistOutlineRegular: (props) => ({ type: 'icon', props }) }
      throw new Error(`unexpected require ${name}`)
    },
    console,
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'client.js' })
  const registrations = []
  moduleConfig.factory(sandbox.require).apply({
    slots: {
      inject(name, fn) {
        fn()
        return () => {}
      },
      register(registration, component) {
        registrations.push({ registration, component })
      },
    },
    layout: { selectPanel() {} },
    effect() {},
  })
  return registrations.find((entry) => entry.registration.name === 'main').component
}

const panel = loadPanel()

check('空数据渲染：不抛错，带品牌名与导航', () => {
  const tree = panel()
  const text = JSON.stringify(tree, (key, value) => (typeof value === 'function' ? '[fn]' : value))
  for (const label of ['经验库', '概览', '经验', '检索', '记录', '技能', '类型', '使用记录', '设置']) {
    assert.ok(text.includes(label), `缺少 ${label}`)
  }
})

check('渲染树里包含页面组件（函数元素），不是静态占位', () => {
  const tree = panel()
  const serialize = JSON.stringify(tree, (key, value) => (typeof value === 'function' ? '[fn]' : value))
  assert.ok(serialize.includes('[fn]'))
})

check('页面结构没有裸字符串子节点错误（children 均为对象/字符串）', () => {
  const tree = panel()
  const walk = (node) => {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node.children)) {
      for (const child of node.children) {
        assert.ok(child === null || typeof child === 'string' || typeof child === 'object')
        walk(child)
      }
    }
  }
  walk(tree)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
