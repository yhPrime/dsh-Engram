/**
 * exp-ui 客户端半测试：模块形状、插槽注册、图标尺寸与回退、渲染冒烟。
 * 用 vm 截获 window.__ModuleLoader__.load，用最小 React 桩让组件真跑一遍渲染。
 * Run: node tests/client.test.mjs
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

/** 宿主的图标组件（只看传参，不画）。 */
const primitivesStub = {
  IconChecklistOutlineRegular(props) {
    return { type: 'primitives-icon', props }
  },
}

/**
 * 载入客户端模块。
 * @param {{primitives?: boolean}} [options] - primitives=false 模拟旧宿主拿不到图标族。
 */
function loadClient(options = {}) {
  const source = fs.readFileSync(path.join(root, 'client.js'), 'utf8')
  const withPrimitives = options.primitives !== false
  let moduleConfig = null
  let fetchCount = 0
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
    fetch: async () => {
      fetchCount += 1
      return { ok: true, status: 200, json: async () => ({ ok: true, data: {} }) }
    },
    URL,
    URLSearchParams,
    console,
    setTimeout,
    clearTimeout,
  }
  vm.createContext(sandbox)
  new vm.Script(source, { filename: 'client.js' }).runInContext(sandbox)
  assert.ok(moduleConfig !== null, 'loader 未被调用')
  const module = moduleConfig.factory((name) => {
    if (name === 'react') return React
    if (name === '@deepseek-ai/dsh-client-ui-primitives') {
      if (!withPrimitives) throw new Error('primitives not injected')
      return primitivesStub
    }
    throw new Error(`unexpected require: ${name}`)
  })
  return { moduleConfig, module, source, fetchCount: () => fetchCount }
}

function makeCtx() {
  const injected = []
  const registrations = []
  const opened = []
  const ctx = {
    slots: {
      inject(name, callback) {
        injected.push(name)
        const disposer = callback()
        return typeof disposer === 'function' ? disposer : () => {}
      },
      register(registration, component) {
        registrations.push({ registration, component })
        return () => {}
      },
    },
    layout: {
      selectPanel(id) {
        opened.push(id)
      },
    },
    effect(callback) {
      const disposer = callback()
      assert.equal(typeof disposer, 'function', 'effect 必须返回清理函数')
      return () => {}
    },
  }
  return { ctx, injected, registrations, opened }
}

const loaded = loadClient()
const { moduleConfig, module } = loaded

check('loader id 是 dsh-exp-ui，模块声明 slots / layout 依赖', () => {
  assert.equal(moduleConfig.id, 'dsh-exp-ui')
  assert.equal(module.inject.join(','), 'slots,layout')
  assert.equal(typeof module.apply, 'function')
})

check('模块加载时不发请求（首屏才请求）', () => {
  assert.equal(loaded.fetchCount(), 0)
})

const { ctx, injected, registrations } = makeCtx()
module.apply(ctx)

check('注册三处：侧栏 exp-ui、主面板、插件页卡片', () => {
  assert.deepEqual(injected, ['sidebar.panellist', 'main', 'plugins.bundle.config'])
  const names = registrations.map((entry) => entry.registration.name)
  assert.deepEqual(names, ['sidebar.panellist', 'main', 'plugins.bundle.config'])
  for (const entry of registrations) {
    assert.equal(typeof entry.component, 'function', `${entry.registration.name} 没有组件`)
  }
})

check('侧栏 id 与主面板 key 都是 exp-ui，label 是 exp-ui', () => {
  const panellist = registrations.find((entry) => entry.registration.name === 'sidebar.panellist')
  const main = registrations.find((entry) => entry.registration.name === 'main')
  assert.equal(panellist.registration.id, 'exp-ui')
  assert.equal(main.registration.key, 'exp-ui')
  assert.equal(panellist.registration.label(), 'exp-ui')
})

check('侧栏那格只放图标：用宿主图标族、按 size 传参、没有按钮/点击', () => {
  const panellist = registrations.find((entry) => entry.registration.name === 'sidebar.panellist')
  const element = panellist.component({ size: 18, active: true })
  // 有 primitives 时直接用宿主图标组件，尺寸原样透传（宽栏 16 / 收起 18）。
  assert.equal(element.type, primitivesStub.IconChecklistOutlineRegular)
  assert.equal(element.props.size, 18)
  // 不能是按钮：点击、label、aria 都由宿主那一行负责。
  assert.notEqual(element.type, 'button')
  assert.equal(element.props.onClick, undefined)
  const wide = panellist.component({ size: 16, active: false })
  assert.equal(wide.props.size, 16)
})

check('拿不到宿主图标族时退回自绘 16 栅格图标，尺寸仍然对齐', () => {
  const fallbackLoaded = loadClient({ primitives: false })
  const { ctx: fallbackCtx, registrations: fallbackRegs } = makeCtx()
  fallbackLoaded.module.apply(fallbackCtx)
  const panellist = fallbackRegs.find((entry) => entry.registration.name === 'sidebar.panellist')
  const element = panellist.component({ size: 16, active: true })
  assert.equal(element.type, 'svg')
  assert.equal(element.props.width, 16)
  assert.equal(element.props.height, 16)
  assert.equal(element.props.viewBox, '0 0 16 16')
  assert.equal(element.props.stroke, 'currentColor')
  assert.ok(element.children.length >= 4)
})

check('插件页卡片挂在自己的包名上（dsh-exp-ui）', () => {
  const card = registrations.find((entry) => entry.registration.name === 'plugins.bundle.config')
  assert.equal(card.registration.key, 'dsh-exp-ui')
  const element = card.component()
  assert.equal(typeof element.type, 'function')
  const tree = element.type({ openPanel: () => {} })
  assert.equal(typeof tree.type, 'string')
})

check('主面板首屏（state=null）渲染不抛错', () => {
  const panel = registrations.find((entry) => entry.registration.name === 'main').component
  const tree = panel()
  assert.equal(tree.type, 'div')
  assert.ok(tree.children.length > 0)
})

check('主面板对空数据渲染也不抛错，且标题是 exp-ui', () => {
  const panel = registrations.find((entry) => entry.registration.name === 'main').component
  const tree = panel({})
  const serialized = JSON.stringify(tree, (key, value) => (typeof value === 'function' ? '[fn]' : value))
  assert.ok(serialized.includes('exp-ui'))
  assert.ok(serialized.includes('经验'))
  assert.ok(serialized.includes('固化技能'))
  assert.ok(serialized.includes('使用记录'))
})

check('客户端不弹窗（无 alert / confirm / prompt）', () => {
  assert.equal(/(^|[^\w.])alert\s*\(/u.test(loaded.source), false)
  assert.equal(/(^|[^\w.])confirm\s*\(/u.test(loaded.source), false)
  assert.equal(/(^|[^\w.])prompt\s*\(/u.test(loaded.source), false)
})

check('manifest：客户端半、图标、本地化、宿主图标族 peer 声明齐全', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  assert.equal(manifest.name, 'dsh-exp-ui')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.equal(manifest.exports['./client'], './client.js')
  assert.equal(manifest.exports['./icon'], './icon.svg')
  for (const file of ['client.js', 'shell.js', 'mock.js', 'live.js', 'data-source.js', 'API.md', 'icon.svg']) {
    assert.ok(manifest.files.includes(file), `files 缺少 ${file}`)
  }
  assert.ok(manifest.peerDependencies['@deepseek-ai/dsh-client-ui-primitives'])
  assert.equal(manifest.peerDependenciesMeta['@deepseek-ai/dsh-client-ui-primitives'].optional, true)
  const icon = fs.statSync(path.join(root, 'icon.svg'))
  assert.ok(icon.size > 0 && icon.size < 256 * 1024)
  for (const locale of ['zh', 'en']) {
    const dict = JSON.parse(fs.readFileSync(path.join(root, 'locale', `${locale}.json`), 'utf8'))
    assert.equal(dict.meta.title, 'exp-ui')
    assert.ok(dict.meta.description.length > 10)
  }
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
