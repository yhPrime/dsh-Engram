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
  const source = fs.readFileSync(path.join(root, '..', 'client.js'), 'utf8')
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

check('loader id 是 dsh-engram，模块声明 slots / layout 依赖', () => {
  assert.equal(moduleConfig.id, 'dsh-engram')
  assert.equal(module.inject.join(','), 'slots,layout')
  assert.equal(typeof module.apply, 'function')
})

check('模块加载时不发请求（首屏才请求）', () => {
  assert.equal(loaded.fetchCount(), 0)
})

const { ctx, injected, registrations } = makeCtx()
module.apply(ctx)

check('注册四处：侧栏经验库、主面板、插件页卡片、会话底部「存经验」', () => {
  assert.deepEqual(injected, ['sidebar.panellist', 'main', 'plugins.bundle.config', 'conversation.chat.assistant-actions'])
  const names = registrations.map((entry) => entry.registration.name)
  assert.deepEqual(names, ['sidebar.panellist', 'main', 'plugins.bundle.config', 'conversation.chat.assistant-actions'])
  for (const entry of registrations) {
    assert.equal(typeof entry.component, 'function', `${entry.registration.name} 没有组件`)
  }
})

check('侧栏 id 与主面板 key 都是 exp-ui，label 是「经验库」', () => {
  const panellist = registrations.find((entry) => entry.registration.name === 'sidebar.panellist')
  const main = registrations.find((entry) => entry.registration.name === 'main')
  assert.equal(panellist.registration.id, 'exp-ui')
  assert.equal(main.registration.key, 'exp-ui')
  assert.equal(panellist.registration.label(), '经验库')
})

check('侧栏那格只放自己的 16 栅格标记：按 size 透传、没有按钮/点击', () => {
  const panellist = registrations.find((entry) => entry.registration.name === 'sidebar.panellist')
  const element = panellist.component({ size: 18, active: true })
  // 自绘标记（经验库自己的记忆弧），不再借用宿主图标族。
  assert.equal(typeof element.type, 'function')
  const svg = element.type(element.props)
  assert.equal(svg.type, 'svg')
  assert.equal(svg.props.width, 18)
  assert.equal(svg.props.height, 18)
  assert.equal(svg.props.viewBox, '0 0 16 16')
  assert.equal(svg.props.stroke, 'currentColor')
  // 不能是按钮：点击、label、aria 都由宿主那一行负责。
  assert.notEqual(element.type, 'button')
  assert.equal(element.props.onClick, undefined)
  const wide = panellist.component({ size: 16, active: false })
  assert.equal(wide.props.size, 16)
})

check('标记不依赖宿主图标族：拿不到 primitives 也画得出来', () => {
  const fallbackLoaded = loadClient({ primitives: false })
  const { ctx: fallbackCtx, registrations: fallbackRegs } = makeCtx()
  fallbackLoaded.module.apply(fallbackCtx)
  const panellist = fallbackRegs.find((entry) => entry.registration.name === 'sidebar.panellist')
  const element = panellist.component({ size: 16, active: true })
  const svg = element.type(element.props)
  assert.equal(svg.type, 'svg')
  assert.equal(svg.props.width, 16)
  assert.equal(svg.props.height, 16)
  assert.equal(svg.props.viewBox, '0 0 16 16')
  assert.equal(svg.props.stroke, 'currentColor')
  assert.ok(svg.children.length >= 3)
})

check('插件页卡片挂在自己的包名上（dsh-engram）', () => {
  const card = registrations.find((entry) => entry.registration.name === 'plugins.bundle.config')
  assert.equal(card.registration.key, 'dsh-engram')
  const element = card.component()
  assert.equal(typeof element.type, 'string')
  assert.ok(JSON.stringify(element).includes('经验库'))
})

check('主面板首屏（state=null）渲染不抛错', () => {
  const panel = registrations.find((entry) => entry.registration.name === 'main').component
  const tree = panel()
  assert.equal(tree.type, 'div')
  assert.ok(tree.children.length > 0)
})

check('详情面板：选中一条经验时真的渲染出意图/做法/收起（不是空白）', () => {
  const pane = module.DetailPane
  assert.equal(typeof pane, 'function', '详情面板没有导出给测试')
  const row = { id: 'ex_1', intent: '测试意图文本', action: '测试做法文本', outcome: 'success', G: 0.8, typeName: '代码 / 插件' }
  const element = pane({ selected: 'ex_1', detail: { data: { row }, error: '' }, send: () => {}, onClose: () => {} })
  const serialized = JSON.stringify(element, (key, value) => (typeof value === 'function' ? '[fn]' : value))
  assert.ok(serialized.includes('测试意图文本'), '没渲染意图')
  assert.ok(serialized.includes('测试做法文本'), '没渲染做法')
  assert.ok(serialized.includes('收起'), '没有收起按钮')
})

check('详情面板：未选中 / 读取中 / 请求失败三种状态都有可见文案', () => {
  const pane = module.DetailPane
  const empty = JSON.stringify(pane({ selected: null, detail: { data: null, error: '' } }))
  assert.ok(empty.includes('选一条经验看详情'))
  const loading = JSON.stringify(pane({ selected: 'ex_1', detail: { data: null, error: '' } }))
  assert.ok(loading.includes('读取中'))
  const bad = JSON.stringify(pane({ selected: 'ex_1', detail: { data: null, error: '没有这条经验：ex_1' } }), (key, value) => (typeof value === 'function' ? '[fn]' : value))
  assert.ok(bad.includes('没有这条经验'), '错误没有显示出来')
})

check('关系图配色：能从主题背景渐变里取颜色停靠点（自带渐变的主题直接沿用）', () => {
  const parse = module.parseGradientStops
  assert.equal(typeof parse, 'function')
  const linear = parse('linear-gradient(158deg, #fff8fc 0%, #ffeef7 34%, #f7ecff 68%, #eef6ff 100%)')
  assert.equal(linear.length, 4)
  assert.equal(linear[0], '#fff8fc')
  const radial = parse('radial-gradient(1100px 760px at 12% -6%, rgba(255,196,226,.95), rgba(255,196,226,0) 62%)')
  assert.equal(JSON.stringify(radial), JSON.stringify(['rgba(255,196,226,.95)']))
  assert.equal(JSON.stringify(parse('none')), '[]')
  assert.equal(JSON.stringify(parse('url(a.png)')), '[]')
  assert.equal(JSON.stringify(parse('#123456')), '[]')
  const gradient = parse('linear-gradient(90deg, #ff2bd6 0%, #00f0ff 100%)')
  assert.equal(gradient.length, 2)
})
check('会话底部按钮：图标按钮，无文字无边框，尺寸对齐旁边图标，点击 POST /chat-save', () => {
  const action = module.SaveExperienceAction
  assert.equal(typeof action, 'function', '按钮组件没有导出给测试')
  const element = action({ sessionId: 's1', messageId: 'm1' })
  assert.equal(element.type, 'button')
  assert.equal(element.props['aria-label'], '存入经验库')
  assert.equal(element.props.style.width, 'calc(28px + var(--dsh-content-font-delta, 0px))')
  assert.equal(element.props.style.height, 'calc(28px + var(--dsh-content-font-delta, 0px))')
  assert.equal(element.props.style.border, 'none')
  assert.equal(element.props.style.padding, '6px')
  assert.equal(element.props.style.borderRadius, 'var(--dsw-radius-sm)')
  assert.equal(element.props.style.background, 'transparent')
  assert.ok(String(element.props.title).includes('存进经验库'))
  // 只放图标：不能有文字子节点
  const children = (element.children || []).filter((child) => child !== null && child !== undefined)
  assert.equal(children.length, 1)
  assert.equal(typeof children[0].type, 'function')
})
check('设置页：二级菜单分屏，默认只露出「存储位置」一档', () => {
  const settings = module.Settings
  assert.equal(typeof settings, 'function', '设置页没有导出给测试')
  const serialized = JSON.stringify(settings({}), (key, value) => (typeof value === 'function' ? '[fn]' : value))
  for (const label of ['存储位置', '备份与账号', '内核参数', '界面与关系图', '维护']) {
    assert.ok(serialized.includes(label), `缺少二级菜单：${label}`)
  }
  assert.ok(serialized.includes('恢复默认'), '存储位置的操作没渲染')
  assert.equal(serialized.includes('每轮提示段'), false, '内核参数不该在存储页露出')
  assert.equal(serialized.includes('关系图主题'), false, '界面参数不该在存储页露出')
  assert.equal(serialized.includes('用 GitHub 登录'), false, '备份/登录不该在存储页露出')
})
check('设置页：每一档都能单独渲染出自己的内容', () => {
  const render = (section) => JSON.stringify(module.Settings({ section }), (key, value) => (typeof value === 'function' ? '[fn]' : value))
  assert.ok(render('backup').includes('Git 仓库备份'))
  assert.ok(render('backup').includes('用 GitHub 登录'))
  assert.ok(render('kernel').includes('内核算力参数保存后动态生效'))
  assert.ok(render('ui').includes('保存数据源'))
  assert.ok(render('maintenance').includes('技能校验'))
  assert.ok(render('maintenance').includes('运行信息'))
})
check('主面板对空数据渲染也不抛错，且标题是「经验库」', () => {
  const panel = registrations.find((entry) => entry.registration.name === 'main').component
  const tree = panel({})
  const serialized = JSON.stringify(tree, (key, value) => (typeof value === 'function' ? '[fn]' : value))
  assert.ok(serialized.includes('经验库'))
  assert.ok(serialized.includes('经验'))
  assert.ok(serialized.includes('技能'))
  assert.ok(serialized.includes('使用记录'))
})

check('每个页面都渲染出 eng-fill + 自己的滚动窗口', () => {
  const pages = [
    ['概览', module.Overview, { state: {}, onGo: () => {}, onOpen: () => {} }],
    ['检索', module.Recall, {}],
    ['记录', module.Record, {}],
    ['技能', module.Skills, {}],
    ['类型', module.Types, { onChanged: () => {} }],
    ['使用记录', module.Usage, {}],
    ['设置', module.Settings, {}],
  ].filter(([, fn]) => typeof fn === 'function')
  assert.ok(pages.length >= 7, `可渲染页面只有 ${pages.length} 个`)
  for (const [name, fn, props] of pages) {
    const tree = fn(props)
    const serialized = JSON.stringify(tree, (key, value) => (typeof value === 'function' ? '[fn]' : value))
    assert.ok(serialized.includes('eng-fill'), `${name} 缺少 eng-fill（页面高度传不下去）`)
    assert.ok(/eng-scroll|eng-split/u.test(serialized), `${name} 没有自己的滚动窗口`)
  }
})

check('经验 / 技能页：左右两栏各自独立滚动（页面不再整页滚）', () => {
  const source = loaded.source
  assert.ok(source.includes('.eng-content[data-fill="true"]'), '缺少 data-fill 布局规则')
  assert.ok(/\.eng-content\[data-fill="true"\][^{]*\.eng-split\s*\{[^}]*align-items:\s*stretch/u.test(source), '缺少两栏撑满规则')
  assert.ok(/\.eng-content\[data-fill="true"\][^{]*\.eng-split > \*[^{]*\{[^}]*overflow-y:\s*auto/u.test(source), '两栏没有独立滚动')
  assert.ok(source.includes("className: 'eng-fill'"), '页面根容器没有 eng-fill（高度传不下去）')
  assert.ok(/'data-fill':\s*tab === 'graph' \? 'false' : 'true'/u.test(source), '除关系图外的页面没有标记 data-fill')
  const fillCount = (source.match(/className: 'eng-fill'/gu) || []).length
  assert.ok(fillCount >= 7, `只有 ${fillCount} 个页面用了 eng-fill，应覆盖概览/经验/检索/记录/技能/类型/使用记录/设置`)
  const scrollCount = (source.match(/eng-scroll/gu) || []).length
  assert.ok(scrollCount >= 6, `只有 ${scrollCount} 处 eng-scroll，长内容没有自己的滚动窗口`)
})
check('客户端不弹窗（无 alert / confirm / prompt）', () => {
  assert.equal(/(^|[^\w.])alert\s*\(/u.test(loaded.source), false)
  assert.equal(/(^|[^\w.])confirm\s*\(/u.test(loaded.source), false)
  assert.equal(/(^|[^\w.])prompt\s*\(/u.test(loaded.source), false)
})

check('manifest：单包（dsh-engram）同时声明 bundle 与 client、图标、本地化', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, '..', 'package.json'), 'utf8'))
  assert.equal(manifest.name, 'dsh-engram')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.equal(manifest.exports['./client'], './client.js')
  assert.equal(manifest.exports['./plugin'], './plugin.js')
  assert.equal(manifest.exports['./icon'], './icon.svg')
  for (const file of ['index.js', 'plugin.js', 'cordis.patch.yml', 'icon.svg', 'client.js', 'ui/shell.js', 'ui/mock.js', 'ui/live.js', 'ui/data-source.js', 'ui/API.md']) {
    assert.ok(manifest.files.includes(file), `files 缺少 ${file}`)
  }
  assert.ok(manifest.peerDependencies['@deepseek-ai/dsh-client-ui-primitives'])
  const icon = fs.statSync(path.join(root, '..', 'icon.svg'))
  assert.ok(icon.size > 0 && icon.size < 256 * 1024)
  for (const locale of ['zh', 'en']) {
    const dict = JSON.parse(fs.readFileSync(path.join(root, 'locale', `${locale}.json`), 'utf8'))
    assert.equal(dict.meta.title, locale === 'zh' ? '经验库' : 'Engram')
    assert.ok(dict.meta.description.length > 10)
  }
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
