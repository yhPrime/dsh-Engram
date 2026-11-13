/**
 * 关系图 P0 静态守卫：删除布局主题、位置 tween、边批处理、LOD、悬停标签。
 * Run: node ui/tests/graph.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..', '..')
const client = fs.readFileSync(path.join(root, 'client.js'), 'utf8')
const shell = fs.readFileSync(path.join(root, 'ui', 'shell.js'), 'utf8')

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
    console.log(`       ${error && error.message ? error.message : error}`)
  }
}

check('7 个布局主题已删除（client + settings spec）', () => {
  assert.equal(client.includes('GRAPH_THEMES'), false, 'client.js 还留着 GRAPH_THEMES')
  assert.equal(client.includes('ui.graphTheme'), false, 'client.js 还在读 ui.graphTheme')
  assert.equal(shell.includes("key: 'graphTheme'"), false, '设置 spec 还留着 graphTheme')
})

check('sync 更新已有节点目标位置，draw 做 tween', () => {
  assert.ok(client.includes('existing.targetX = shape.x'), '已有节点没有目标 X')
  assert.ok(client.includes('entry.baseX += (entry.targetX - entry.baseX)'), 'draw 没有位置 tween')
  assert.ok(client.includes('targetX: shape.x'), '新节点没有初始 targetX')
})

check('边不再每帧排序 / 不再逐边建渐变', () => {
  assert.equal(client.includes('[...store.edges.entries()].sort'), false, '边还在每帧排序')
  assert.equal(client.includes('createLinearGradient'), false, '还有逐边线性渐变')
  assert.ok(client.includes('const edgeList = store.edges'), '边没有改成直接遍历 Map')
  assert.ok(client.includes('bloom && bright'), '阴影没有只留给焦点边')
})

check('远景 LOD + 屏幕裁剪', () => {
  assert.ok(client.includes('screenRadius <= 1.1'), '没有远景 LOD 分支')
  assert.ok(client.includes('entry.screenX < -60'), '没有屏幕外裁剪')
})

check('选中/悬停标签与开发统计存在', () => {
  assert.ok(client.includes('addLabel(store.selected'), '没有画选中/悬停标签')
  assert.ok(client.includes('window.__engGraph'), '没有 __engGraph 统计')
})

check('节点形状函数只保留默认外观', () => {
  assert.ok(client.includes('function drawGraphShape(ctx, radius, kind'), '形状函数没按类型分轮廓')
  assert.equal(client.includes("theme === 'knowledge'"), false, '还留着 knowledge 形状分支')
})

check('P3：主星/技能轮廓、边虚线、暗角、按权重分层', () => {
  assert.ok(client.includes("kind === 'type'") && client.includes('Math.PI / 3'), '类型不是六边形')
  assert.ok(client.includes("kind === 'skill'") && client.includes('radius * 1.18'), '技能不是菱形')
  assert.ok(client.includes("edgeState.edge.kind === 'suite' ? [5, 3]"), '套件边没有虚线')
  assert.ok(client.includes('const vignette = ctx.createRadialGradient'), '没有暗角')
  assert.ok(client.includes('(1 - Math.pow(weight, 0.7)) * 26'), '经验没按权重分层')
})

check('P3 正多面体：kind 映射、线框绘制、自旋与子节点随父转', () => {
  assert.ok(client.includes("root: 'icosa', type: 'dodeca', suite: 'cube', skill: 'tetra'"), '正多面体映射缺失')
  assert.ok(client.includes('const graphSolidForNode ='), '主技能没有单独形状')
  assert.ok(client.includes('function drawPolyhedron('), '没有线框多面体绘制')
  assert.ok(client.includes('entry.spinAngle = -store.t'), '多面体没有自旋角')
  assert.ok(client.includes('const parentMap = new Map()'), '没有父子关系')
  assert.ok(client.includes('entry.x = parent.baseX + dx * Math.cos(angle)'), '子节点没有随父旋转')
  assert.ok(client.includes('baseWidth * 3.4'), '线框没有两遍发光')
  assert.equal(client.includes('shadowBlur = options.glow'), false, '还在逐边开 shadowBlur')
  assert.ok(client.includes('const GRAPH_POLY_BUDGET = 80'), '没有多面体帧预算')
  assert.ok(client.includes('const frontFaces ='), '没有正面片')
  assert.ok(client.includes("node.kind === 'root' ? 0.20 : node.kind === 'type' ? 0.38"), '面还是太透')
  assert.ok(client.includes('const bands = 6'), '棱没有按深度分档')
  assert.ok(client.includes('0.22 + 0.74 * Math.pow(depth, 1.15)'), '棱亮度没有平滑过渡')
})

check('连接线脉冲光点：批量收集、上限 180、无 shadow', () => {
  assert.ok(client.includes('const pulses = []'), '没有脉冲收集')
  assert.ok(client.includes('pulses.length < 180'), '脉冲没有数量上限')
  assert.equal(client.includes('const throb ='), false, '脉冲还在呼吸闪烁')
  assert.ok(client.includes('x: px') && client.includes('r: Math.max(0.7'), '脉冲不是点')
  assert.ok(client.includes('ctx.arc(pulse.x, pulse.y'), '脉冲没有白热核心')
  assert.equal(client.includes('pulse.x1'), false, '脉冲还在画线段')
})

check('进入关系图默认放大一档（滚轮 0.9）', () => {
  assert.ok(client.includes('fitCamera(true, 0.9)'), '默认镜头没有放大一档')
  assert.ok(client.includes('bound * 2.9 * scale'), 'fitCamera 没有缩放参数')
})

check('P3 中心主星：日冕 + 8 条恒星芒 + 白热核心', () => {
  assert.ok(client.includes('function drawStarRays('), '没有恒星芒')
  assert.ok(client.includes("node.kind === 'root'") && client.includes('const corona ='), '没有中心日冕')
  assert.ok(client.includes('const starCore ='), '没有白热星心')
  assert.ok(client.includes('screenRadius * 5.2'), '恒星芒没有伸出晶壳')
})

check('整体旋转顺时针（相机 yaw 递减、多面体反向自旋）', () => {
  assert.ok(client.includes('cam.yaw -= rotation * dt'), '主相机还是逆时针')
  assert.ok(client.includes('entry.spinAngle = -store.t'), '多面体自旋没跟主相机同向')
  assert.equal(client.includes('screenRadius * 2.05'), false, '选中还在用八面体包裹')
})

check('右上角全屏：DSH NavIcon 图标 + requestFullscreen + 样式', () => {
  assert.ok(client.includes('eng-graph-fullscreen'), '没有全屏按钮')
  assert.ok(client.includes('requestFullscreen'), '没有进入全屏')
  assert.ok(client.includes('fullscreenchange'), '没有全屏状态同步')
  assert.ok(client.includes("name: fullscreen ? 'collapse' : 'expand'"), '全屏图标没复用 NavIcon')
  assert.ok(client.includes('.eng-graph-canvas-wrap:fullscreen'), '没有全屏样式')
})

check('P1：1,200 上限 / DPR 1.5 / 拾取网格 / 隐藏暂停 / 空闲降帧', () => {
  assert.ok(client.includes('const GRAPH_NODE_CAP = 1200'), '没有 1,200 节点上限')
  assert.ok(client.includes('Math.min(1.5, window.devicePixelRatio'), 'DPR 没降到 1.5')
  assert.ok(client.includes('const cell = 32'), '拾取没用屏幕网格')
  assert.ok(client.includes('new IntersectionObserver'), '没有视口暂停')
  assert.ok(client.includes('now - lastInteraction > 2000'), '没有空闲降帧')
  assert.ok(client.includes('layoutGraph(data)'), 'Graph 没用纯布局函数')
})

check('P2：搜索 / 筛选 / 键盘 / 隔离 / 读屏 / 触屏', () => {
  assert.ok(client.includes("className: 'eng-graph-search'"), '没有图内搜索')
  assert.ok(client.includes('const cycleNode ='), '没有键盘节点遍历')
  assert.ok(client.includes('只看邻居'), '没有邻居隔离')
  assert.ok(client.includes('eng-visually-hidden'), '没有读屏列表')
  assert.ok(client.includes("addEventListener('touchstart'"), '没有触屏 pinch')
  assert.ok(client.includes('screenF > 1.05 && entry.currentWeight >= 0.5'), '没有放大后高权重经验标签')
  assert.ok(client.includes('resultFilter'), '没有结果筛选')
  assert.ok(client.includes('recentOnly'), '没有最近 30 天筛选')
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed > 0 ? 1 : 0
