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

check('新建仓库并推送：不再被局部变量遮盖 sync 句柄，失败原因要显示出来', () => {
  const source = loaded.source
  assert.equal(/(^|\\n)\\s*const sync = data\\.sync/u.test(source), false, 'sync 句柄又被 data.sync 遮盖了')
  assert.ok(source.includes('pushResult'), '没有单独的推送结果变量')
  assert.ok(source.includes('推送没成功'), '推送失败没有可读提示')
  assert.ok(source.includes('初始化失败'), '初始化失败没有可读提示')
  assert.ok(source.includes('[engram] sync.reload failed'), '刷新失败没有留日志')
})
check('技能：全局注册 / 忘记技能都由人点按钮，模型没有自动注册的路径', () => {
  const source = loaded.source
  assert.equal(source.includes('/skill-install'), false, '还留着旧的自动安装接口')
  assert.ok(source.includes('/skill-global'), '没有「注册技能到全局」的接口调用')
  assert.ok(source.includes('/skill-forget'), '没有「忘记技能」的接口调用')
  assert.ok(source.includes('注册技能到全局'), '没有「注册技能到全局」按钮')
  assert.ok(source.includes('忘记技能'), '没有「忘记技能」按钮')
  assert.ok(source.includes("current.globalRegistered ? '取消注册' : '注册技能到全局'"), '注册后按钮没有变成「取消注册」')
  assert.ok(source.includes('确认忘记'), '忘记技能没有两步确认')
  assert.ok(source.includes('/skill-meta'), '没有保存分类/便签的接口')
  assert.ok(source.includes('SkillMetaEditor'), '没有分类/便签编辑器')
  assert.ok(source.includes('分类（逗号分隔，可多个）'), '技能详情里没有多分类输入')
  // 两颗管理胶囊贴在详情标题行右上角（用户指的绿框位置），且在正文/反馈按钮之前
  const cardAt = source.indexOf("className: 'eng-card eng-skill-actions'")
  assert.ok(cardAt >= 0, '没有单独的管理按钮卡片')
  const cardBlock = source.slice(cardAt, source.indexOf('eng-detail-card', cardAt))
  assert.ok(cardBlock.includes("'注册技能到全局'),"), '注册按钮没放进管理卡片')
  assert.ok(cardBlock.includes("'忘记技能'"), '忘记按钮没放进管理卡片')
  assert.ok(source.indexOf("eng-card eng-skill-actions") < source.lastIndexOf('eng-card eng-detail-card'), 'JSX 里管理卡片应在详情卡片前面')
  // 详情卡全局 order:-1 会把管理卡顶到它下面，所以管理卡必须是更小的 order（-2）
  assert.ok(/\.eng-split\[data-open="true"\] \.eng-stack > \.eng-skill-actions \{[^}]*order:\s*-2/u.test(source), '管理卡没设 order:-2，会被详情卡压到下面')
  assert.ok(source.includes('便签（每行一条）'), '技能详情里没有便签输入')
  assert.ok(source.includes('整包：') && source.includes('row.packageFiles'), '技能详情没有整包文件摘要')
  assert.ok(source.includes('含 ${firstPkg.fileCount} 个文件'), '导入回执没说带了多少文件')
  const tree = JSON.stringify(module.Skills({ onChanged: () => {} }), (key, value) => (typeof value === 'function' ? '[fn]' : value))
  assert.ok(tree.includes('eng-skill-row') || tree.includes('还没有固化技能'), '技能页没渲染')
})
check('导入成功后弹窗自动关闭并刷新列表，同时留一条「已导入」回执', () => {
  const source = loaded.source
  assert.ok(source.includes('onImported: (out) => {'), '导入成功没有回调处理')
  assert.ok(source.includes('setImportOpen(false)'), '导入成功没有关弹窗')
  assert.ok(source.includes('setImportNotice('), '导入成功没有留下可见回执')
  assert.ok(source.includes('refreshAll()'), '导入成功后没有刷新列表')
  const tree = JSON.stringify(module.ImportSkillDialog({ onClose: () => {}, onImported: () => {} }), (key, value) => (typeof value === 'function' ? '[fn]' : value))
  assert.ok(tree.includes('高级'), '弹窗没有「高级」折叠入口（分类/便签藏在里面）')
  assert.ok(source.includes('分类（逗号分隔，可多个）') && source.includes('便签（逗号分隔，可多条）'), '高级里没有分类/便签输入')
})
check('添加技能弹窗：拖拽区 + 来源路径，高级选项折叠（做过减法）', () => {
  const dialog = module.ImportSkillDialog
  assert.equal(typeof dialog, 'function', '弹窗没导出给测试')
  const tree = JSON.stringify(dialog({ onClose: () => {}, onImported: () => {} }), (key, value) => (typeof value === 'function' ? '[fn]' : value))
  for (const text of ['拖拽技能到此处', '选择文件夹', '选择文件', '或粘贴来源路径', '取消', '安装', '高级：分类 / 便签 / 粘贴正文']) {
    assert.ok(tree.includes(text), `弹窗缺少：${text}`)
  }
  assert.equal(tree.includes('SKILL.md 路径（绝对路径）'), false, '还有旧的安装路径输入框')
  assert.equal(tree.includes('安装位置'), false, '安装位置那块说明已经砍掉')
  assert.equal(tree.includes('会产生额外消耗'), false, '长篇费用说明已压成一行小字')
  assert.ok(tree.includes('webkitdirectory'), '没有「选择文件夹」的目录选择器')
  const source = loaded.source
  assert.ok(source.includes('{ path: sourcePath.trim() }'), '来源路径没有走服务端直读分支')
  assert.ok(source.includes('droppedPathOf'), '拖放没有从 uri-list 里抠路径的兜底')
  assert.ok(source.includes('contentsDraft'), '浏览器选文件夹没有多技能（套件）处理')
  assert.ok(source.includes('const batch = sourcePath.trim()'), '套件没有走批量分支')
  assert.ok(source.includes('body: { content: batch[index]'), '套件没有逐个提交（进度条要靠逐个推进）')
  assert.ok(source.includes('eng-progress-track'), '批量导入没有进度条视图')
  assert.ok(source.includes('eng-session'), '进度视图没有临时会话')
  assert.ok(source.includes("'data-role'"), '临时会话消息没有角色标记')
  assert.ok(source.includes('临时会话已启动'), '临时会话没有启动说明')
  assert.ok(source.includes('正在导入技能'), '进度视图没有标题')
})
check('推送前发现远端有新提交：弹窗给「覆盖 / 换远端仓库 / 另建分支」三条路', () => {
  const dialog = module.PushConflictDialog
  assert.equal(typeof dialog, 'function', '冲突弹窗没导出给测试')
  const tree = JSON.stringify(dialog({
    conflict: { remoteAhead: 3, branch: 'main' },
    busy: false,
    onClose: () => {},
    onOverwrite: () => {},
    onNewBranch: () => {},
    onSwitchRepo: () => {},
  }), (key, value) => (typeof value === 'function' ? '[fn]' : value))
  for (const text of ['远端有本机没有的提交', '覆盖远端', '换远端仓库', '另建分支', 'refs/engram/overwritten']) {
    assert.ok(tree.includes(text), `弹窗缺少：${text}`)
  }
  const source = loaded.source
  assert.ok(source.includes('needsDecision'), '前端没处理内核的 needsDecision')
  assert.ok(source.includes('runPush({ force: true })'), '覆盖分支没走 force 推送')
  assert.ok(source.includes('engram-'), '另建分支没生成新分支名')
  assert.ok(source.includes('resolvePushConflict'), '冲突没有统一的处置入口')
})
check('关系图节点是「中心向外发光」而不是球体高光', () => {
  const source = loaded.source
  assert.equal(source.includes('createRadialGradient(-screenRadius * 0.35'), false, '还在用左上偏移的球体高光')
  assert.ok(source.includes('createRadialGradient(0, 0, 0, 0, 0'), '亮心没有落在正中心')
  assert.ok(source.includes('haloRadius'), '没有向外的光晕层')
  assert.ok(source.includes('drawStarFlare'), '没有十字星芒（恒星感）')
  assert.ok(source.includes("globalCompositeOperation = 'lighter'"), '光晕没用叠加混合，浅色主题会叠成脏晕')
  assert.ok(/core\.addColorStop\(0, withAlpha\(hot/u.test(source), '星心不是发亮的（hot）')
  assert.ok(source.includes('screenRadius * 0.34'), '星心没有那一圈高光')
  const withAlpha = module.withAlpha
  assert.equal(typeof withAlpha, 'function', 'withAlpha 没导出')
  assert.equal(withAlpha('#4d93f8', 0.5), 'rgba(77, 147, 248, 0.5)')
  assert.equal(withAlpha('rgba(147, 51, 234, 1)', 0.2), 'rgba(147, 51, 234, 0.2)')
  assert.equal(withAlpha('nonsense', 0.3), 'rgba(128, 128, 128, 0.3)')
})
check('关系图页：整块画布 + 右上角配色胶囊（跟随主题 / 蓝紫星辰）', () => {
  const tree = JSON.stringify(module.Graph({}), (key, value) => (typeof value === 'function' ? '[fn]' : value))
  assert.ok(tree.includes('eng-graph-canvas'), '没有画布')
  assert.ok(tree.includes('eng-graph-pill'), '没有配色胶囊')
  assert.ok(tree.includes('跟随主题'), '胶囊缺少「跟随主题」')
  assert.ok(tree.includes('蓝紫星辰'), '胶囊缺少「蓝紫星辰」')
  assert.ok(tree.includes('eng-graph-pill-bottom'), '缺少左下角背景胶囊')
  assert.ok(tree.includes('浅色') && tree.includes('深色'), '左侧胶囊缺少深浅两项')
  const source = loaded.source
  assert.ok(source.includes('graphSurface'), '背景深浅没有写进 ui 设置')
  assert.ok(source.includes("#0b1020"), '深色背景没有实际底色')
  assert.ok(source.includes("#f6f8fc"), '浅色背景没有实际底色')
})
check('关系图像星系盘：重节点靠内且转得快、经验绕自己的类型、子技能绕套件', () => {
  const data = {
    nodes: [
      { id: 'root', kind: 'root', weight: 1 },
      { id: 'type:重', kind: 'type', weight: 1, label: '重' },
      { id: 'type:轻', kind: 'type', weight: 0.3, label: '轻' },
      { id: 'exp:1', kind: 'experience', typeId: '重', weight: 0.5 },
      { id: 'exp:2', kind: 'experience', typeId: '轻', weight: 0.5 },
      { id: 'skill:套件子', kind: 'skill', weight: 0.5 },
      { id: 'suite:组', kind: 'suite', weight: 0.4 },
      { id: 'skill:裸', kind: 'skill', weight: 0.2 },
    ],
    edges: [
      { source: 'type:重', target: 'exp:1', kind: 'derived', strength: 0.5 },
      { source: 'suite:组', target: 'skill:套件子', kind: 'suite', strength: 0.5 },
    ],
  }
  const orbits = module.galaxyOrbits(data)
  assert.equal(orbits.size, 7, 'root 之外每个节点都要有轨道')
  assert.equal(orbits.has('root'), false, 'root 是核，不该有轨道')
  const heavy = orbits.get('type:重')
  const light = orbits.get('type:轻')
  assert.ok(heavy.radius < light.radius, `重节点应更靠内：${heavy.radius} vs ${light.radius}`)
  assert.ok(heavy.omega > light.omega, `重节点应转得更快：${heavy.omega.toFixed(3)} vs ${light.omega.toFixed(3)}`)
  assert.equal(orbits.get('exp:1').parentId, 'type:重', '经验应挂在它的类型上')
  assert.equal(orbits.get('skill:套件子').parentId, 'suite:组', '子技能应挂在套件上')
  assert.equal(orbits.get('skill:裸').parentId, null, '没有父的技能应绕核')
  assert.ok(Math.abs(orbits.get('exp:1').radius - orbits.get('type:重').radius) <= 90, '经验的半径应贴着它的类型（同一段旋臂）')
  assert.equal(orbits.get('exp:1').arm, orbits.get('type:重').arm, '经验应和它的类型在同一条臂上')
  for (const [id, orbit] of orbits) {
    assert.ok(orbit.theta0 >= 0 && orbit.theta0 <= Math.PI * 4 + 0.5, `${id} 的初始角度越界：${orbit.theta0}`)
  }
  // 时间推进后节点要真的在转（重力 → 公转），不是静态分布
  const orbit = orbits.get('type:重')
  const start = module.galaxyOrbitPoint(orbit, 0.5, 0, 0, 1, null)
  const later = module.galaxyOrbitPoint(orbit, 0.5, 0, 1, 1, null)
  assert.ok(Math.abs(start.x - later.x) > 0.5 || Math.abs(start.z - later.z) > 0.5, '过了 1 秒节点没有移动')
  // spinScale=0 时静止（设置里把旋转关掉）
  const still = module.galaxyOrbitPoint(orbit, 0.5, 0, 5, 0, null)
  const still2 = module.galaxyOrbitPoint(orbit, 0.5, 0, 0, 0, null)
  assert.equal(still.x, still2.x, 'spinScale=0 时应停在初始角度')
})
check('关系图配色：多层背景只取 linear 那层；浅色停靠点压进可读区间；有「蓝紫星辰」', () => {
  const parse = module.parseGradientStops
  // 昔涟主题真实写法：4 层 radial 光斑 + 最后一层 linear 底色
  const layered = [
    'radial-gradient(1100px 760px at 12% -6%, rgba(255,196,226,.95), rgba(255,196,226,0) 62%)',
    'radial-gradient(900px 700px at 88% 4%, rgba(206,190,255,.8), rgba(206,190,255,0) 60%)',
    'linear-gradient(158deg, #fff8fc 0%, #ffeef7 34%, #f7ecff 68%, #eef6ff 100%)',
  ].join(', ')
  const stops = parse(layered)
  assert.equal(JSON.stringify(stops), JSON.stringify(['#fff8fc', '#ffeef7', '#f7ecff', '#eef6ff']), '多层背景应只取 linear 那层的停靠点')
  const slice = module.sliceLinearGradient(layered)
  assert.ok(slice.startsWith('linear-gradient('), '没切出 linear-gradient 段')

  // 浅色主题：接近纯白的停靠点必须被压暗，否则画在浅色底上等于没有
  const shaped = module.graphStops(stops, false)
  const luminanceOf = (color) => {
    const hex = String(color).match(/^#([0-9a-f]{6})$/iu)
    const rgb = String(color).match(/^rgba?\(([^)]+)\)$/iu)
    const parts = hex !== null
      ? [parseInt(hex[1].slice(0, 2), 16), parseInt(hex[1].slice(2, 4), 16), parseInt(hex[1].slice(4, 6), 16)]
      : (rgb !== null ? rgb[1].split(/[\s,\/]+/u).filter(Boolean).slice(0, 3).map(Number) : null)
    assert.ok(parts !== null, `停靠点既不是 hex 也不是 rgb：${color}`)
    return (parts[0] * 0.299 + parts[1] * 0.587 + parts[2] * 0.114) / 255
  }
  for (const color of shaped) {
    const luminance = luminanceOf(color)
    assert.ok(luminance <= 0.66, `浅色主题停靠点仍然太亮：${color} (${luminance.toFixed(2)})`)
    assert.ok(luminance >= 0.2, `浅色主题停靠点被压得太黑：${color} (${luminance.toFixed(2)})`)
    assert.ok(module.colorSaturation(color) >= 0.4, `停靠点被压成灰色了：${color}（sat ${module.colorSaturation(color).toFixed(2)}）`)
  }

  // 主题背景是「接近纯白的粉 + radial 光斑」时，要取有颜色的那几个，而不是把白色压成灰
  const blobs = [
    'radial-gradient(1100px 760px at 12% -6%, rgba(255,196,226,.95), rgba(255,196,226,0) 62%)',
    'radial-gradient(900px 700px at 88% 4%, rgba(206,190,255,.8), rgba(206,190,255,0) 60%)',
    'radial-gradient(760px 620px at 76% 96%, rgba(178,220,255,.65), rgba(178,220,255,0) 62%)',
    'linear-gradient(158deg, #fff8fc 0%, #ffeef7 34%, #f7ecff 68%, #eef6ff 100%)',
  ].join(', ')
  const vividStops = module.parseAllGradientStops(blobs).filter((color) => module.colorSaturation(color) >= 0.2)
  assert.ok(vividStops.length >= 3, `主题里有颜色的停靠点没取到：${JSON.stringify(vividStops)}`)
  const pink = module.vividColor('rgb(255, 248, 252)', false)
  assert.ok(module.colorSaturation(pink) >= 0.4, `近白粉色处理后仍是灰色：${pink}`)

  const codex = module.GRAPH_PALETTES.codex
  assert.ok(codex !== undefined, '没有「蓝紫星辰」配色')
  const joined = JSON.stringify(codex).toLowerCase()
  for (const hex of ['#6d28d9', '#4d93f8', '#9333ea', '#c084fc']) {
    assert.ok(joined.includes(hex), `蓝紫星辰缺少推理滑条渐变色 ${hex}`)
  }
  assert.ok(codex.node !== codex.node2, '蓝紫星辰应该是双色，不该压成单色')
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
  assert.ok(render('backup').includes('Git 同步'))
  assert.ok(render('backup').includes('用 GitHub 登录'))
  assert.ok(render('backup').includes('立即同步'))
  assert.ok(render('backup').includes('断开'))
  assert.ok(render('backup').includes('新建并连接'))
  assert.equal(render('backup').includes('用这个'), false, '还留着「用这个」二次确认')
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

check('顶部刷新有可见回执；真实数据不再占位子', () => {
  const source = loaded.source
  assert.equal(source.includes('数据：${source.label}'), false, '还在显示「数据：…」徽标')
  assert.ok(source.includes("刷新中…"), '刷新没有进行中状态')
  assert.ok(source.includes('已刷新'), '刷新完成没有时间回执')
  assert.ok(source.includes('reloadToken'), '刷新没有重新挂载当前页，列表不会重新请求')
  const tree = JSON.stringify(module.Console({}), (key, value) => (typeof value === 'function' ? '[fn]' : value))
  assert.ok(tree.includes('刷新'), '顶部没有刷新按钮')
  assert.ok(tree.includes('经验与技能的本地控制台'), '控制台标题没渲染')
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
