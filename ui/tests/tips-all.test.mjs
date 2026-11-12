/**
 * 全量巡检：设置页每一条「?」说明气泡（SETTINGS_SPEC 里的 config/ui/git 三组）都走同一个
 * body 层 fixed 气泡，且在窄/宽视口、四种锚点位置下都被夹在视口内、文字完整。
 * 回归点：0.14.1 之前气泡是 .eng-tip 里的绝对定位子元素，面板一窄就被 overflow 容器裁掉半截。
 * Run: node ui/tests/tips-all.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

import { SETTINGS_SPEC } from '../shell.js'

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

function makeDocument(width, height) {
  const layers = []
  const doc = {
    baseURI: 'http://127.0.0.1:1/',
    documentElement: { clientWidth: width, clientHeight: height },
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
      // 量不出布局，就按 CSS 的 max-width / max-height 规则给尺寸。
      Object.defineProperty(node, 'offsetWidth', { get: () => Math.min(340, width - 16) })
      Object.defineProperty(node, 'offsetHeight', { get: () => Math.min(240, height - 16) })
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

function loadClient(documentStub, themeVars = {}) {
  const source = fs.readFileSync(path.join(root, '..', 'client.js'), 'utf8')
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
  let moduleConfig = null
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
      getComputedStyle() {
        return { getPropertyValue: (name) => themeVars[name] || '' }
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
  return { module: moduleConfig.factory(sandbox.require), source }
}

const groups = ['config', 'ui', 'git']
const fields = groups.flatMap((group) => ((SETTINGS_SPEC && SETTINGS_SPEC[group]) || []).map((field) => ({ group, ...field })))
const tipped = fields.filter((field) => typeof field.tip === 'string' && field.tip.trim() !== '')

check(`设置项覆盖：三组共 ${fields.length} 项，其中 ${tipped.length} 项带「?」说明`, () => {
  assert.ok(fields.length >= 30, `SETTINGS_SPEC 项数异常：${fields.length}`)
  assert.ok(tipped.length >= 20, `带说明的项太少：${tipped.length}`)
})

for (const [width, height, label] of [[320, 560, '窄视口 320px'], [420, 720, '中等视口 420px'], [1280, 900, '宽视口 1280px']]) {
  const doc = makeDocument(width, height)
  const { module, source } = loadClient(doc, {
    '--dsw-alias-bg-layer-2': 'rgb(20, 22, 28)',
    '--dsw-alias-label-primary': 'rgb(240, 240, 245)',
    '--dsw-alias-border-l1': 'rgba(255,255,255,0.14)',
  })
  const layerWidth = Math.min(340, width - 16)
  const anchors = [
    { name: '贴左边', rect: { left: 0, top: 200, width: 15, height: 15, bottom: 215 } },
    { name: '贴右边', rect: { left: width - 15, top: 200, width: 15, height: 15, bottom: 215 } },
    { name: '贴顶部', rect: { left: Math.round(width / 2), top: 0, width: 15, height: 15, bottom: 15 } },
    { name: '贴底部', rect: { left: Math.round(width / 2), top: height - 15, width: 15, height: 15, bottom: height } },
  ]

  check(`${label}：${tipped.length} 条说明 × ${anchors.length} 个锚点位置，都能完整弹出且不出视口`, () => {
    for (const field of tipped) {
      const tip = module.Tip({ text: field.tip })
      assert.equal(tip, null ?? tip)
      assert.deepEqual(tip.children, ['?'], `${field.group}.${field.key}：问号里还套着内联气泡`)
      assert.equal(tip.props['aria-label'], field.tip)
      for (const anchor of anchors) {
        module.hideTipLayer()
        tip.props.onMouseEnter({ currentTarget: { getBoundingClientRect: () => anchor.rect } })
        assert.equal(doc.layers.length, 1, `${field.group}.${field.key}（${anchor.name}）：气泡数量 ${doc.layers.length}`)
        const layer = doc.layers[0]
        assert.equal(layer.textContent, field.tip, `${field.group}.${field.key}（${anchor.name}）：说明文字不完整`)
        assert.equal(layer.role, 'tooltip')
        const left = Number.parseFloat(layer.style.left)
        const top = Number.parseFloat(layer.style.top)
        assert.ok(Number.isFinite(left) && Number.isFinite(top), `${field.group}.${field.key}：没算位置`)
        assert.ok(left >= 8, `${field.group}.${field.key}（${anchor.name}）：左边溢出 ${left}`)
        assert.ok(left + layerWidth <= width - 8 + 0.5, `${field.group}.${field.key}（${anchor.name}）：右边溢出 ${left}+${layerWidth}`)
        assert.ok(top >= 8, `${field.group}.${field.key}（${anchor.name}）：顶部溢出 ${top}`)
        assert.ok(top + 96 <= height, `${field.group}.${field.key}（${anchor.name}）：底部溢出 ${top}+96`)
        assert.ok(String(layer.style.background || '').length > 0, `${field.group}.${field.key}：没抄到主题色`)
      }
      module.hideTipLayer()
    }
  })

  check(`${label}：气泡宽度上限按视口收（${layerWidth}px），并带 max-height 兜底`, () => {
    assert.ok(source.includes('max-width: min(340px, calc(100vw - 16px))'))
    assert.ok(source.includes('max-height: calc(100vh - 16px)'), '超高说明没有高度兜底，会被视口切掉')
    assert.equal(source.includes('eng-tip-bubble'), false, '旧内联气泡又回来了')
  })
}

check('说明气泡只有这一套机制：全文件不存在其它 hover 浮层', () => {
  const source = fs.readFileSync(path.join(root, '..', 'client.js'), 'utf8')
  const css = source.slice(source.indexOf('const PANEL_CSS'), source.indexOf('`\n', source.indexOf('const PANEL_CSS')))
  const reveal = [...css.matchAll(/:hover[^{}]*\{[^}]*display:\s*(?:block|flex|inline-flex)/gu)].map((match) => match[0])
  assert.deepEqual(reveal, [], `还有别的 hover 浮层：${reveal.join(' | ')}`)
  const absolute = [...css.matchAll(/\{([^}]*position:\s*absolute[^}]*)\}/gu)].map((match) => match[1].trim())
  for (const rule of absolute) assert.equal(/tooltip|bubble|tip/u.test(rule), false, `还有绝对定位的提示气泡：${rule}`)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
