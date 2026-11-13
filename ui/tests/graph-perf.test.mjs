/**
 * 关系图布局性能 / 确定性（只测纯函数，不渲染 React 组件）：
 *   1. 1k / 3k / 5k 固定夹具的 layoutGraph 耗时在阈值内（与 tools/graph-bench.mjs 同口径）；
 *   2. 同一夹具两次布局的坐标完全一致（布局确定）；
 *   3. 根节点不占位置：位置数 = 节点数 - 1，坐标全部有限；
 *   4. 夹具形状本身正确（节点数精确、id 唯一、边两端存在），空/畸形输入不抛错。
 * 夹具与 vm 加载器复用 tools/graph-bench.mjs，避免测试和基准各造一套。
 * Run: node ui/tests/graph-perf.test.mjs
 */
import assert from 'node:assert/strict'

import {
  BENCH_THRESHOLDS,
  buildGraphFixture,
  checksumOf,
  loadClientModule,
  measureLayout,
  validateLayout,
} from '../../tools/graph-bench.mjs'

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

const module = loadClientModule()
const layoutGraph = module.layoutGraph

check('夹具形状：1k / 3k / 5k 节点数精确、id 唯一、边两端都存在', () => {
  for (const { size } of BENCH_THRESHOLDS) {
    const data = buildGraphFixture(size)
    assert.equal(data.nodes.length, size, `${size} 夹具节点数不对`)
    const ids = new Set(data.nodes.map((node) => node.id))
    assert.equal(ids.size, size, `${size} 夹具里有重复 id`)
    assert.ok(ids.has('root'), `${size} 夹具缺根节点`)
    for (const edge of data.edges) {
      assert.ok(ids.has(edge.source), `${size} 边源节点不存在：${edge.source}`)
      assert.ok(ids.has(edge.target), `${size} 边目标节点不存在：${edge.target}`)
    }
    assert.ok(data.summary.experiences > 0, `${size} 夹具没有经验节点`)
    assert.ok(data.summary.skills > 0, `${size} 夹具没有技能节点`)
  }
})

check('1k / 3k / 5k 布局耗时在阈值内（中位数，与基准同口径）', () => {
  for (const { size, limitMs } of BENCH_THRESHOLDS) {
    const data = buildGraphFixture(size)
    const measured = measureLayout(module, data, 3)
    const samples = measured.samples.map((value) => value.toFixed(2)).join(' / ')
    assert.ok(
      measured.medianMs < limitMs,
      `${size} 节点中位数 ${measured.medianMs.toFixed(2)}ms ≥ 阈值 ${limitMs}ms（样本 ${samples}ms）`,
    )
    assert.equal(measured.positions.size, size - 1, `${size} 节点布局漏了位置`)
  }
})

check('位置确定：同一夹具两次布局坐标完全一致', () => {
  for (const { size } of BENCH_THRESHOLDS) {
    const data = buildGraphFixture(size)
    const first = layoutGraph(data)
    const second = layoutGraph(data)
    assert.equal(first.size, second.size, `${size} 两次布局返回的位置数不同`)
    assert.equal(checksumOf(first), checksumOf(second), `${size} 两次布局校验和不同`)
    for (const [id, point] of first) {
      assert.deepEqual(second.get(id), point, `${size} 节点 ${id} 两次位置不同`)
    }
  }
})

check('根节点无位置：位置数 = 节点数 - 1，且坐标全部有限', () => {
  for (const { size } of BENCH_THRESHOLDS) {
    const data = buildGraphFixture(size)
    const positions = layoutGraph(data)
    assert.equal(positions.has('root'), false, `${size} 根节点不该有位置`)
    assert.equal(positions.size, data.nodes.length - 1, `${size} 位置数不等于非 root 节点数`)
    assert.deepEqual(validateLayout(positions, data), [], `${size} 布局结果校验未通过`)
  }
})

check('空 / 畸形输入不抛错，返回空 Map', () => {
  assert.equal(layoutGraph(null).size, 0)
  assert.equal(layoutGraph(undefined).size, 0)
  assert.equal(layoutGraph({}).size, 0)
  assert.equal(layoutGraph({ nodes: [], edges: [] }).size, 0)
  assert.equal(layoutGraph({ nodes: [{ id: 'root', kind: 'root' }] }).size, 0)
  const partial = layoutGraph({ nodes: [{ id: 'root', kind: 'root' }, { id: 'exp:e1', kind: 'experience' }] })
  assert.equal(partial.size, 1, '缺 typeId 的经验节点也应该有兜底位置')
  assert.ok(Number.isFinite(partial.get('exp:e1').x))
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
