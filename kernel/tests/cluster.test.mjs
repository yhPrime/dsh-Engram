/**
 * 簇派生视图测试：迁移（旧库 → 簇）、归属、签名聚合、统计口径、不落盘、类型管理联动。
 * Run: node tests/cluster.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  CLUSTER_SYSTEM,
  ROUTE_MIN_SCORE,
  clusterIdOf,
  clusterStateOf,
  ensureClusters,
  refreshClusters,
  routeCluster,
  signatureOf,
} from '../cluster.js'
import {
  assignType,
  createType,
  deleteType,
  forgetExperience,
  mergeTypes,
  readManifest,
  readStore,
  renameType,
  upsertExperience,
  writeStore,
} from '../store.js'
import { similarityV2, stateOf } from '../retrieval.js'
import { readShardRecords } from '../shard-store.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-provider-cluster-'))
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

function freshStore() {
  return readStore(dir)
}

function seed(store) {
  return upsertExperience(store, { intent: '做一份研学课的六页 PPT', action: '先定主题色再排版', outcome: 'success', type: 'PPT / 课件' })
}

check('空库：readStore 挂上 clusters，且至少含「未分类」', () => {
  const store = freshStore()
  assert.ok(Array.isArray(store.clusters))
  assert.equal(store.clusters.length, store.types.length)
  assert.ok(store.clusters.some((cluster) => cluster.id === 'ty_other'))
})

check('写入后：经验归入 type 对应的簇，count 同步', () => {
  const store = freshStore()
  seed(store)
  const cluster = store.clusters.find((item) => item.name === 'PPT / 课件')
  assert.ok(cluster)
  assert.equal(cluster.stats.count, 1)
  assert.equal(cluster.system, CLUSTER_SYSTEM)
})

check('未分类经验：typeId 缺失时不崩，归「未分类」统计', () => {
  const store = freshStore()
  upsertExperience(store, { intent: '一次没有类型的任务', action: '随手做', outcome: 'success' })
  const other = store.clusters.find((item) => item.id === 'ty_other')
  assert.ok(other.stats.count >= 1)
})

check('损坏数据：typeId 指向不存在的类型 → 归「未分类」，不新建簇', () => {
  const store = freshStore()
  store.experiences.push({ id: 'ex_broken', intent: '坏数据', action: 'x', G: 0.5, typeId: 'ty_ghost', typeName: '幽灵' })
  ensureClusters(store)
  assert.equal(store.clusters.some((item) => item.id === 'ty_ghost'), false)
  const other = store.clusters.find((item) => item.id === 'ty_other')
  assert.ok(other.stats.count >= 1)
})

check('签名：artifacts / tokens / cgrams 从 intent+action 聚合，note 不参与', () => {
  const store = freshStore()
  upsertExperience(store, { intent: '导出 pptx 演示文稿', action: '用 python-pptx 生成', outcome: 'success', type: 'PPT / 课件', note: '路径 C:\\secret\\cmd 不应进签名' })
  const cluster = store.clusters.find((item) => item.name === 'PPT / 课件')
  assert.ok(cluster.signature.artifacts.includes('ppt'))
  assert.ok(cluster.signature.tokens.includes('pptx'))
  assert.equal(cluster.signature.tokens.includes('secret'), false)
  assert.ok(cluster.signature.cgrams.length > 0)
})

check('签名：频次排序，top 上限生效', () => {
  const signature = signatureOf([
    { intent: 'ppt ppt ppt 导出', action: 'a' },
    { intent: 'ppt 导出', action: 'b' },
    { intent: 'excel 表格', action: 'c' },
  ])
  assert.equal(signature.tokens[0], 'ppt')
  assert.ok(signature.tokens.length <= 12)
  assert.ok(signature.cgrams.length <= 12)
  assert.ok(signature.artifacts.length <= 6)
})

check('聚类状态：clusterStateOf 可被 similarityV2 比较，且相关意图得分高于无关意图', () => {
  const store = freshStore()
  seed(store)
  const cluster = store.clusters.find((item) => item.name === 'PPT / 课件')
  const state = clusterStateOf(cluster)
  const related = similarityV2(stateOf('做个研学课 PPT'), state)
  const unrelated = similarityV2(stateOf('清理嵌套 git 仓库'), state)
  assert.ok(related > 0)
  assert.ok(related > unrelated)
})

check('统计：success / fail 按 G 符号、uses 按 hits 累加、lastUsedAt 取最大', () => {
  const store = freshStore()
  upsertExperience(store, { intent: '任务甲', action: '做法甲', outcome: 'success', type: '代码 / 插件' })
  upsertExperience(store, { intent: '任务乙', action: '做法乙', outcome: 'failed', type: '代码 / 插件' })
  const cluster = store.clusters.find((item) => item.name === '代码 / 插件')
  assert.equal(cluster.stats.count, 2)
  assert.equal(cluster.stats.success, 1)
  assert.equal(cluster.stats.fail, 1)
  assert.equal(cluster.stats.uses, 2)
  assert.ok(cluster.stats.lastUsedAt.length > 0)
})

check('被取代 / 删除的经验不计入统计', () => {
  const store = freshStore()
  upsertExperience(store, { intent: '同一张表的任务意图', action: '做法一', outcome: 'success', type: '表格 / 数据' })
  const second = upsertExperience(store, { intent: '同一张表的任务意图', action: '做法二', outcome: 'success', type: '表格 / 数据' })
  const cluster = store.clusters.find((item) => item.name === '表格 / 数据')
  // 旧条被 superseded_by 标记后不可见，簇里只剩新条。
  assert.equal(cluster.stats.count, 1)
  forgetExperience(store, second.experience.id)
  const after = store.clusters.find((item) => item.name === '表格 / 数据')
  // 删掉取代者后，被它取代的旧条回到可见，簇里还剩 1 条。
  assert.equal(after.stats.count, 1)
  assert.equal(after.stats.success, 1)
})

check('幂等：连续 ensureClusters 结果一致', () => {
  const store = freshStore()
  seed(store)
  const once = JSON.stringify(store.clusters)
  ensureClusters(store)
  ensureClusters(store)
  assert.equal(JSON.stringify(store.clusters), once)
})

check('派生不夹带：分片记录里没有 clusters，manifest 只是缓存，readStore 重算', () => {
  const store = freshStore()
  seed(store)
  writeStore(dir, store)
  // 0.14.0 分片布局：经验记录里不能夹带派生字段（写回会变成两套真相）；
  // 簇签名落 manifest 当缓存（§7.3），读时仍从分片重算。
  const manifest = readManifest(dir)
  for (const row of readShardRecords(dir, manifest)) assert.equal('clusters' in row, false)
  assert.equal(manifest.clusters.length, store.types.length)
  const reloaded = readStore(dir)
  assert.ok(reloaded.clusters.length === reloaded.types.length)
  assert.equal(reloaded.clusters.find((item) => item.name === 'PPT / 课件').stats.count, 1)
})

check('类型管理：rename 后簇名同步，签名重算', () => {
  const store = freshStore()
  seed(store)
  renameType(store, 'PPT / 课件', '课件 / 幻灯片')
  const cluster = store.clusters.find((item) => item.name === '课件 / 幻灯片')
  assert.ok(cluster)
  assert.equal(store.clusters.some((item) => item.name === 'PPT / 课件'), false)
})

check('类型管理：merge 后经验归入目标簇', () => {
  const store = freshStore()
  upsertExperience(store, { intent: '甲任务', action: '甲做法', outcome: 'success', type: '子类甲' })
  upsertExperience(store, { intent: '乙任务', action: '乙做法', outcome: 'success', type: '子类乙' })
  mergeTypes(store, ['子类甲', '子类乙'], '合并类')
  const cluster = store.clusters.find((item) => item.name === '合并类')
  assert.equal(cluster.stats.count, 2)
})

check('类型管理：assign 后簇 count 迁移', () => {
  const store = freshStore()
  upsertExperience(store, { intent: '待改挂任务', action: '做法', outcome: 'success', type: '文档 / 教案' })
  const target = createType(store, '剪辑 / 视频')
  const experience = store.experiences.find((item) => item.intent === '待改挂任务')
  assignType(store, experience.id, target.name)
  assert.equal(store.clusters.find((item) => item.name === '文档 / 教案').stats.count, 0)
  assert.equal(store.clusters.find((item) => item.name === '剪辑 / 视频').stats.count, 1)
})

check('类型管理：delete 后经验归「未分类」簇', () => {
  const store = freshStore()
  upsertExperience(store, { intent: '删除类任务', action: '做法', outcome: 'success', type: '临时类' })
  deleteType(store, '临时类')
  const other = store.clusters.find((item) => item.id === 'ty_other')
  assert.equal(other.stats.count, 1)
})

check('clusterIdOf：空值兜底「未分类」，未知 typeId 原样返回（由 ensureClusters 决定归属）', () => {
  assert.equal(clusterIdOf(''), 'ty_other')
  assert.equal(clusterIdOf(undefined), 'ty_other')
  assert.equal(clusterIdOf('ty_ppt'), 'ty_ppt')
})

check('refreshClusters 返回与 ensureClusters 相同结果', () => {
  const store = freshStore()
  seed(store)
  const a = JSON.stringify(refreshClusters(store))
  const b = JSON.stringify(ensureClusters(store))
  assert.equal(a, b)
})

check('路由：有签名的簇能接住同类意图', () => {
  const store = freshStore()
  upsertExperience(store, { intent: '做研学课的六页 PPT 并导出 pptx', action: '先定主题色再排版', outcome: 'success', type: 'PPT / 课件' })
  upsertExperience(store, { intent: '清理嵌套 git 仓库并删除大件', action: 'escalate 到 danger-full-access', outcome: 'success', type: '环境 / 部署' })
  const route = routeCluster(store, '做个研学课 PPT')
  assert.equal(route.fallback, false)
  assert.equal(route.name, 'PPT / 课件')
  assert.ok(route.score >= ROUTE_MIN_SCORE)
})

check('路由：无信号意图回退全库，不硬塞一个簇', () => {
  const store = freshStore()
  upsertExperience(store, { intent: '做研学课的六页 PPT', action: '先定主题色再排版', outcome: 'success', type: 'PPT / 课件' })
  const route = routeCluster(store, '查一下这个角色设定')
  assert.equal(route.fallback, true)
  assert.equal(route.clusterId, null)
  assert.ok(route.score < ROUTE_MIN_SCORE)
})

check('路由：空簇不参与（没有签名，不能靠手写描述硬接）', () => {
  const store = freshStore()
  createType(store, '表格 / 数据')
  const route = routeCluster(store, '做个 Excel 统计表')
  assert.equal(route.candidates.some((item) => item.name === '表格 / 数据'), false)
  assert.equal(route.fallback, true)
})

check('路由：门槛可调，minScore=0 时总能选出一个簇', () => {
  const store = freshStore()
  upsertExperience(store, { intent: '做研学课的六页 PPT', action: '先定主题色再排版', outcome: 'success', type: 'PPT / 课件' })
  const route = routeCluster(store, '查一下这个角色设定', { minScore: 0 })
  assert.equal(route.fallback, false)
  assert.equal(route.name, 'PPT / 课件')
})

try {
  fs.rmSync(dir, { recursive: true, force: true })
} catch {}

console.log('')
console.log(`结果：通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exit(1)
