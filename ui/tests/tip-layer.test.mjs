/**
 * 设置项「?」悬浮说明不能被裁：气泡挂在 <body> 上 fixed 定位，位置夹回视口内。
 * 回归点（2026-11-12）：以前气泡是 .eng-tip 里的绝对定位子元素，面板一窄 / 一滚动就被
 * overflow 容器裁掉半截，长说明只露出中间几行。
 * Run: node ui/tests/tip-layer.test.mjs
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

/** 够用的文档桩：量不出布局，就按 CSS 的 max-width 规则给一个宽度。 */
function makeDocument(options = {}) {
  const viewportWidth = options.width || 380
  const viewportHeight = options.height || 640
  const layerWidth = Math.min(340, viewportWidth - 16)
  const layers = []
  const doc = {
    baseURI: 'http://127.0.0.1:1/',
    documentElement: { clientWidth: viewportWidth, clientHeight: viewportHeight },
    body: {
      appendChild(node) {
        layers.push(node)
        node.parentNode = doc.body
        return node
      },
      removeChild(node) {
        const index = layers.indexOf(node)
        if (index >= 0) layers.splice(index, 1)
      },
    },
    createElement(tag) {
      const node = {
        tagName: String(tag).toUpperCase(),
        className: '',
        textContent: '',
        style: {},
        parentNode: null,
        setAttribute(name, value) {
          node[name] = value
        },
        remove() {
          doc.body.removeChild(node)
        },
      }
      Object.defineProperty(node, 'offsetWidth', { get: () => layerWidth })
      Object.defineProperty(node, 'offsetHeight', { get: () => 96 })
      return node
    },
    querySelectorAll(selector) {
      const name = String(selector).replace(/^\./u, '')
      return layers.filter((node) => node.className === name)
    },
  }
  doc.layers = layers
  return doc
}

function loadClient(documentStub, options = {}) {
  const source = fs.readFileSync(path.join(root, '..', 'client.js'), 'utf8')
  const themeVars = options.themeVars || {}
  let moduleConfig = null
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
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(config) {
          moduleConfig = config
        },
      },
      addEventListener() {},
      innerWidth: documentStub.documentElement.clientWidth,
      innerHeight: documentStub.documentElement.clientHeight,
      getComputedStyle: options.getComputedStyle || function getComputedStyle() {
        return {
          getPropertyValue(name) {
            return themeVars[name] || ''
          },
        }
      },
    },
    document: documentStub,
    require(name) {
      if (name === 'react') return React
      if (name === '@deepseek-ai/dsh-client-ui-primitives') return { IconChecklistOutlineRegular: (props) => ({ type: 'icon', props }) }
      throw new Error(`unexpected require ${name}`)
    },
    console,
    URL,
    URLSearchParams,
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'client.js' })
  const module = moduleConfig.factory(sandbox.require)
  return { module, source }
}

const doc = makeDocument()
const { module, source } = loadClient(doc, {
  themeVars: {
    '--dsw-alias-bg-layer-2': 'rgb(20, 22, 28)',
    '--dsw-alias-label-primary': 'rgb(240, 240, 245)',
    '--dsw-alias-border-l1': 'rgba(255, 255, 255, 0.14)',
  },
})
const LONG_TIP = '开启时，每轮系统提示里会多一段以「【经验库】」开头的说明（条数/类型目录/用法）。关掉后要重载插件才会撤掉已经注册的那一段——保存后提示段不会立刻消失。'

check('样式：气泡在 body 层 fixed 定位，宽度按视口上限收（旧的内联气泡已移除）', () => {
  assert.ok(source.includes('.eng-tip-layer'), '缺少 .eng-tip-layer 样式')
  assert.ok(/\.eng-tip-layer \{[^}]*position: fixed/u.test(source), '气泡不是 fixed 定位，仍会被滚动容器裁')
  assert.ok(source.includes('max-width: min(340px, calc(100vw - 16px))'), '没有按视口收宽度')
  assert.equal(source.includes('eng-tip-bubble'), false, '还留着旧的内联气泡（会被裁）')
})

check('Tip 只渲染问号，不带内联气泡；悬停/聚焦挂事件', () => {
  const element = module.Tip({ text: LONG_TIP })
  assert.equal(element.type, 'span')
  assert.equal(element.props.className, 'eng-tip')
  assert.equal(element.props.tabIndex, 0)
  assert.equal(element.props['aria-label'], LONG_TIP)
  assert.deepEqual(element.children, ['?'], '问号外面还套了内联气泡')
  assert.equal(typeof element.props.onMouseEnter, 'function')
  assert.equal(typeof element.props.onMouseLeave, 'function')
  assert.equal(typeof element.props.onFocus, 'function')
  assert.equal(typeof element.props.onBlur, 'function')
  assert.equal(module.Tip({ text: '' }), null, '空说明不该渲染问号')
})

check('悬停把完整说明放进 body 层，位置夹在视口内（左侧贴边不溢出）', () => {
  const tip = module.Tip({ text: LONG_TIP })
  tip.props.onMouseEnter({ currentTarget: { getBoundingClientRect: () => ({ left: 2, top: 300, width: 15, height: 15, bottom: 315 }) } })
  assert.equal(doc.layers.length, 1, '气泡没挂到 body 上')
  const layer = doc.layers[0]
  assert.equal(layer.className, 'eng-tip-layer')
  assert.equal(layer.textContent, LONG_TIP, '说明文字没写全')
  assert.equal(layer.role, 'tooltip')
  const left = Number.parseFloat(layer.style.left)
  assert.ok(left >= 8, `左边溢出视口：${layer.style.left}`)
  assert.ok(left + 340 <= 380 - 8 + 0.5, `右边溢出视口：left ${layer.style.left} + 340 > 372`)
  assert.equal(layer.style.top, '196px')
})

check('靠右的锚点也夹回视口（不会排出屏幕右边）', () => {
  const tip = module.Tip({ text: LONG_TIP })
  tip.props.onMouseEnter({ currentTarget: { getBoundingClientRect: () => ({ left: 360, top: 300, width: 15, height: 15, bottom: 315 }) } })
  assert.equal(doc.layers.length, 1, '重复悬停堆积了多个气泡')
  const layer = doc.layers[0]
  const left = Number.parseFloat(layer.style.left)
  assert.ok(left + 340 <= 372.5, `右边溢出视口：left ${left}`)
  assert.ok(left >= 8)
})

check('顶部空间不够时翻到下方，底部空间不够再夹回来', () => {
  const tip = module.Tip({ text: LONG_TIP })
  tip.props.onMouseEnter({ currentTarget: { getBoundingClientRect: () => ({ left: 100, top: 4, width: 15, height: 15, bottom: 19 }) } })
  const layer = doc.layers[0]
  const top = Number.parseFloat(layer.style.top)
  assert.ok(top >= 8, `翻到上方被裁：top ${top}`)
  assert.ok(top >= 19, '顶部放不下时应翻到锚点下方')
  tip.props.onMouseEnter({ currentTarget: { getBoundingClientRect: () => ({ left: 100, top: 620, width: 15, height: 15, bottom: 635 }) } })
  const second = doc.layers[0]
  const secondTop = Number.parseFloat(second.style.top)
  assert.ok(secondTop + 96 <= 640, `底部溢出视口：top ${secondTop}`)
})

check('移开/失焦即移除气泡，只保留一个', () => {
  const tip = module.Tip({ text: LONG_TIP })
  const anchor = { getBoundingClientRect: () => ({ left: 100, top: 200, width: 15, height: 15, bottom: 215 }) }
  tip.props.onMouseEnter({ currentTarget: anchor })
  tip.props.onFocus({ currentTarget: anchor })
  assert.equal(doc.layers.length, 1, '同时存在多个气泡')
  tip.props.onMouseLeave()
  assert.equal(doc.layers.length, 0, '移开后气泡还在')
  tip.props.onFocus({ currentTarget: anchor })
  tip.props.onBlur()
  assert.equal(doc.layers.length, 0, '失焦后气泡还在')
})

check('缺 anchor / 没有 getBoundingClientRect 时安静降级，不抛错', () => {
  module.hideTipLayer()
  module.showTipLayer(LONG_TIP, null)
  module.showTipLayer(LONG_TIP, {})
  assert.equal(doc.layers.length, 0)
})

check('气泡主题色跟着面板走：从锚点抄 --dsw-alias-* 到 body 层', () => {
  const anchor = { getBoundingClientRect: () => ({ left: 100, top: 200, width: 15, height: 15, bottom: 215 }) }
  module.showTipLayer(LONG_TIP, anchor)
  const layer = doc.layers[0]
  assert.equal(layer.style.background, 'rgb(20, 22, 28)', '没抄到面板底色，深色主题下气泡会发白')
  assert.equal(layer.style.color, 'rgb(240, 240, 245)')
  assert.equal(layer.style.borderColor, 'rgba(255, 255, 255, 0.14)')
  module.hideTipLayer()
})

check('拿不到计算样式（getComputedStyle 抛错）也照样弹出来', () => {
  const throwingDoc = makeDocument()
  const throwing = loadClient(throwingDoc, {
    getComputedStyle() {
      throw new Error('nope')
    },
  })
  throwing.module.showTipLayer(LONG_TIP, { getBoundingClientRect: () => ({ left: 100, top: 200, width: 15, height: 15, bottom: 215 }) })
  assert.equal(throwingDoc.layers.length, 1, '拿不到计算样式就不弹了')
  assert.equal(throwingDoc.layers[0].style.background, undefined, '不该硬塞颜色')
  throwing.module.hideTipLayer()
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
