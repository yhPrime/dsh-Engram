/**
 * 读缓存验收（task-7 / 计划书 §4.8）：
 *  1. 默认关闭：两次读返回不同对象、可自由修改（写路径读-改-写必须走默认）；
 *  2. `{cache:true}`：指纹不变 → 返回同一份**冻结**对象（就地修改会抛错）；
 *  3. 写盘后立刻失效（writeStore / writeTypeShards），不返回旧对象；
 *  4. 其它进程式写法（直接改分片、不改 manifest）靠指纹失效；
 *  5. LRU：超过 cacheMaxBytes 淘汰最旧，不会无限涨；
 *  6. 命中明显快于冷读（台架记录，宽松阈值，避免环境抖动假红）。
 *
 * Run: node kernel/tests/shard-cache.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  clearStoreReadCache,
  readManifest,
  readStore,
  readStoreCacheInfo,
  writeStore,
} from '../store.js'
import { CACHE_MAX_BYTES, readShardRecordsOfTypes, writeTypeShards } from '../shard-store.js'

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

const now = Date.now()
const at = (days) => new Date(now - days * 86400000).toISOString()
const newDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'exp-shard-cache-'))

const makeType = (id, name) => ({ id, name, description: `${name} 的描述`, system: false })

/** 造一个有两条类型、若干记录的库（用 writeStore 落盘，走真实写路径）。 */
function seed(dir, count = 40) {
  const types = [makeType('ty_a', 'A类'), makeType('ty_b', 'B类')]
  const experiences = []
  for (let index = 0; index < count; index += 1) {
    const type = types[index % types.length]
    experiences.push({
      id: `ex_${String(index).padStart(3, '0')}`,
      taskId: `task_${String(index).padStart(3, '0')}`,
      kind: 'task',
      intent: `任务 ${index}：给课件插页 ${'件'.repeat(20)}`,
      action: `做法 ${index}：先克隆再改字`,
      note: `备注 ${index} ${'注'.repeat(60)}`,
      ts: at(index % 5),
      lastSeenAt: at(index % 5),
      hits: 1,
      G: 0.8,
      GOutcome: 0.8,
      GSource: 'outcome',
      outcome: 'success',
      state: { tokens: [], cgrams: [], artifacts: [] },
      step_rewards: [0.8],
      typeId: type.id,
      typeName: type.name,
      verdict: 'decided',
      sessionId: `s_${index % 7}`,
    })
  }
  writeStore(dir, { version: 1, types, experiences })
  return dir
}

const makeRow = (id) => ({
  id,
  taskId: id,
  kind: 'task',
  intent: `新增任务 ${id}`,
  action: '新增做法',
  outcome: 'success',
  G: 0.8,
  GOutcome: 0.8,
  GSource: 'outcome',
  hits: 1,
  ts: at(0),
  lastSeenAt: at(0),
  state: { tokens: [], cgrams: [], artifacts: [] },
  step_rewards: [0.8],
  typeId: 'ty_a',
  typeName: 'A类',
  verdict: 'decided',
})

check('默认关闭：两次读返回不同对象、可自由修改（写路径读-改-写安全）', () => {
  const dir = seed(newDir(), 20)
  const a = readStore(dir)
  const b = readStore(dir)
  assert.notEqual(a, b, '默认路径不能吃缓存，必须每次新对象')
  assert.equal(Object.isFrozen(a), false)
  a.experiences.push(makeRow('ex_manual'))
  assert.equal(a.experiences.length, b.experiences.length + 1, '默认对象必须可改')
})

check('cache:true 命中：同一份冻结对象，就地修改抛 TypeError', () => {
  const dir = seed(newDir(), 20)
  clearStoreReadCache()
  const first = readStore(dir, { cache: true })
  const second = readStore(dir, { cache: true })
  assert.equal(second, first, '指纹没变时必须返回同一份缓存对象')
  assert.equal(Object.isFrozen(first), true)
  assert.equal(Object.isFrozen(first.experiences), true)
  assert.equal(Object.isFrozen(first.experiences[0]), true)
  assert.equal(Object.isFrozen(first.types[0]), true)
  assert.equal(Object.isFrozen(first.clusters), true)
  assert.throws(() => { first.experiences.push(makeRow('ex_bad')) }, TypeError, '冻结数组 push 必须抛错')
  assert.throws(() => { first.types[0].name = '改不动' }, TypeError, '冻结对象赋值必须抛错')
  assert.equal(first.experiences.length, 20, '抛错不能改变缓存内容')
  assert.ok(readStoreCacheInfo().entries >= 1)
})

check('writeStore 后立刻读到新数据（不返回旧对象、不丢更新）', () => {
  const dir = seed(newDir(), 10)
  clearStoreReadCache()
  const before = readStore(dir, { cache: true })
  // 写路径必须用默认读：可修改的对象
  const writable = readStore(dir)
  writable.experiences.push(makeRow('ex_after_write'))
  writeStore(dir, writable)
  const after = readStore(dir, { cache: true })
  assert.notEqual(after, before, '写盘后不能返回旧缓存对象')
  assert.equal(after.experiences.length, before.experiences.length + 1)
  assert.ok(after.experiences.some((row) => row.id === 'ex_after_write'))
})

check('外部写（writeTypeShards，不经过 store.js）后缓存失效', () => {
  const dir = seed(newDir(), 20)
  clearStoreReadCache()
  const before = readStore(dir, { cache: true })
  const manifest = readManifest(dir)
  const rows = readShardRecordsOfTypes(dir, manifest, ['ty_a']).records
  rows[0].note = '外部写改过'
  writeTypeShards(dir, manifest, { touchedTypeIds: ['ty_a'], rowsByType: { ty_a: rows } })
  const after = readStore(dir, { cache: true })
  assert.notEqual(after, before)
  assert.equal(after.experiences.find((row) => row.id === rows[0].id).note, '外部写改过')
})

check('指纹兜底：直接改分片（同字节长度、不改 manifest）也能发现', () => {
  const dir = seed(newDir(), 20)
  clearStoreReadCache()
  const before = readStore(dir, { cache: true })
  const manifest = readManifest(dir)
  const bucketFile = path.join(dir, manifest.buckets[0].file)
  const text = fs.readFileSync(bucketFile, 'utf8')
  // 等长替换：字节数不变，只有内容与 mtime 变 → 模拟「另一个进程写了分片但 manifest 一样」。
  const patched = text.replace('先克隆再改字', '先克隆再改色')
  assert.notEqual(patched, text, '夹具里必须有可替换的等长片段')
  assert.equal(Buffer.byteLength(patched, 'utf8'), Buffer.byteLength(text, 'utf8'), '替换必须等字节')
  fs.writeFileSync(bucketFile, patched, 'utf8')
  const after = readStore(dir, { cache: true })
  assert.notEqual(after, before, '分片 mtime 变 → 指纹变 → 必须重读')
  assert.ok(after.experiences.some((row) => row.action.includes('改色')), '必须看到外部写入的内容')
})

check('LRU：超过 cacheMaxBytes 淘汰最旧，不无限涨内存', () => {
  clearStoreReadCache()
  const dirA = seed(newDir(), 8)
  const dirB = seed(newDir(), 8)
  const a1 = readStore(dirA, { cache: true, cacheMaxBytes: 1 })
  readStore(dirB, { cache: true, cacheMaxBytes: 1 })
  const a2 = readStore(dirA, { cache: true, cacheMaxBytes: 1 })
  assert.notEqual(a2, a1, '被 LRU 挤掉后必须重算')
  assert.ok(readStoreCacheInfo().entries <= 1, `上限 1 字节时最多留一个 dataDir，实际 ${readStoreCacheInfo().entries}`)
  clearStoreReadCache()
  assert.deepEqual(readStoreCacheInfo(), { entries: 0, bytes: 0 }, 'clearStoreReadCache() 必须清空')
})

check('默认上限：CACHE_MAX_BYTES=32MiB；两个小库可以同时缓存', () => {
  assert.equal(CACHE_MAX_BYTES, 32 * 1024 * 1024)
  clearStoreReadCache()
  const dirA = seed(newDir(), 10)
  const dirB = seed(newDir(), 10)
  const a1 = readStore(dirA, { cache: true })
  const b1 = readStore(dirB, { cache: true })
  assert.notEqual(a1, b1)
  assert.equal(readStore(dirA, { cache: true }), a1, 'A 不该被 B 挤掉')
  assert.equal(readStore(dirB, { cache: true }), b1)
  clearStoreReadCache()
})

check('性能：命中明显快于冷读（记录数字，宽松阈值）', () => {
  const dir = seed(newDir(), 300)
  clearStoreReadCache()
  const timeIt = (fn) => {
    const t0 = process.hrtime.bigint()
    fn()
    return Number(process.hrtime.bigint() - t0) / 1e6
  }
  const cold = timeIt(() => readStore(dir, { cache: true }))
  let cachedMin = Infinity
  for (let index = 0; index < 5; index += 1) cachedMin = Math.min(cachedMin, timeIt(() => readStore(dir, { cache: true })))
  const uncached = Math.min(
    timeIt(() => readStore(dir)),
    timeIt(() => readStore(dir)),
    timeIt(() => readStore(dir)),
  )
  console.log(`       冷读 ${cold.toFixed(2)}ms｜命中 ${cachedMin.toFixed(2)}ms｜无缓存 ${uncached.toFixed(2)}ms（300 条）`)
  assert.ok(cachedMin < cold, `命中（${cachedMin.toFixed(2)}ms）应快于冷读（${cold.toFixed(2)}ms）`)
  assert.ok(cachedMin < uncached, `命中（${cachedMin.toFixed(2)}ms）应快于无缓存读（${uncached.toFixed(2)}ms）`)
  clearStoreReadCache()
})

console.log('')
console.log(`结果：通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exit(1)
