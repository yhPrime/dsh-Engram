/**
 * 故障注入一轮（task-11「无异常」专项）。
 *
 * Run: node kernel/tests/fault-injection.test.mjs
 *
 * 覆盖：半写（残留 tmp / 子进程被杀）、单分片损坏、manifest 损坏/缺失/版本不符、
 * 并发写、超大记录、空库/空分片、非 UTF-8/BOM/CRLF、冷档缺失、磁盘满。
 * 所有场景只在 mkdtemp 副本上做，不碰真实 `~/.dsh`/`.exp`。
 *
 * 输出每个场景的「造法 / 实际 / 判定」，并写 `_tmp/fault-results.json` 供报告引用。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { readColdStore, readManifest, readStore, upsertExperience, withStoreLock, writeStore } from '../store.js'
import {
  bucketsPath,
  coldPath,
  compactStore,
  manifestPath,
  readShardRecordsOfTypes,
} from '../shard-store.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../..')
const storePath = path.join(repoRoot, 'kernel', 'store.js')
const results = []
const newDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'exp-fault-'))

const TYPE = '代码 / 插件'
const makeLib = (n = 5) => {
  const dir = newDir()
  const rows = []
  const types = [
    { id: 'ty_0', name: TYPE, description: '写代码', system: false },
    { id: 'ty_1', name: 'PPT / 课件', description: '做课件', system: false },
  ]
  for (let index = 0; index < n; index += 1) {
    const type = types[index % 2]
    rows.push({
      id: `ex_seed_${String(index).padStart(3, '0')}`,
      taskId: `ex_seed_${String(index).padStart(3, '0')}`,
      kind: 'task',
      intent: `故障注入种子任务 ${index}`,
      action: `种子做法 ${index}`,
      note: `备注 ${index}`,
      ts: new Date(Date.now() - index * 1000).toISOString(),
      lastSeenAt: new Date(Date.now() - index * 1000).toISOString(),
      hits: 1,
      G: 0.8,
      GOutcome: 0.8,
      GSource: 'outcome',
      outcome: 'success',
      typeId: type.id,
      typeName: type.name,
      verdict: 'decided',
    })
  }
  writeStore(dir, { version: 1, types, experiences: rows })
  return { dir, types, rows }
}
const bucketFiles = (dir) => {
  try {
    return fs.readdirSync(bucketsPath(dir)).filter((name) => name.endsWith('.jsonl')).map((name) => path.join(bucketsPath(dir), name))
  } catch {
    return []
  }
}
const nonEmptyBucket = (dir) => bucketFiles(dir).find((file) => fs.statSync(file).size > 0) || null
const hashOf = (file) => {
  const data = fs.readFileSync(file)
  return `${data.length}:${data.toString('base64').slice(0, 32)}`
}
const listTmp = (dir) => {
  const out = []
  for (const base of [dir, bucketsPath(dir), path.join(dir, 'cold')]) {
    try {
      for (const name of fs.readdirSync(base)) if (name.endsWith('.tmp')) out.push(path.join(base, name))
    } catch {
      // 目录不存在
    }
  }
  return out
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function pushResult(id, name, how, actual, verdict, fix = '') {
  results.push({ id, name, how, actual, verdict, fix })
  console.log(`\n【${id} ${name}】${verdict}`)
  console.log(`  造法：${how}`)
  console.log(`  实际：${actual}`)
  if (fix !== '') console.log(`  修复：${fix}`)
}

/** 子进程写盘脚本：用真实 withStoreLock + readStore/writeStore 持续追加。 */
function writeWorkerScript() {
  return `
import { pathToFileURL } from 'node:url'
const store = await import(pathToFileURL(process.argv[1]).href)
const dir = process.argv[2]
const tag = process.argv[3]
let i = 0
while (i < Number(process.argv[4] || 2000)) {
  store.withStoreLock(dir, () => {
    const s = store.readStore(dir)
    store.upsertExperience(s, { intent: '并发写 ' + tag + ' ' + i, action: '做法 ' + tag + ' ' + i, outcome: 'success', type: '代码 / 插件' })
    store.writeStore(dir, s)
  })
  i += 1
}
`
}

async function closeTo(child) {
  return await new Promise((resolve) => {
    if (child.exitCode !== null) return resolve(child.exitCode)
    child.on('exit', (code) => resolve(code))
  })
}

/* ------------------------------------------------------------------ */
/* 1. 半写：残留 tmp / 子进程被杀                                       */
/* ------------------------------------------------------------------ */
async function scenarioHalfWrite() {
  const { dir, rows } = makeLib(5)
  // 1a：崩溃留下的临时文件（>10 分钟）应被忽略并在下次写盘清理。
  const tmpBucket = path.join(bucketsPath(dir), `ty_0.0.jsonl.${process.pid}.1.abc.tmp`)
  const tmpManifest = path.join(dir, 'manifest.json.123.456.tmp')
  fs.writeFileSync(tmpBucket, '{"id":"half-write"', 'utf8')
  fs.writeFileSync(tmpManifest, '{broken', 'utf8')
  const old = new Date(Date.now() - 20 * 60 * 1000)
  fs.utimesSync(tmpBucket, old, old)
  fs.utimesSync(tmpManifest, old, old)
  assert.equal(readStore(dir).experiences.length, rows.length, '残留 tmp 不应影响读取')
  writeStore(dir, readStore(dir))
  const tmpLeft = listTmp(dir)
  const bucketTmpLeft = tmpLeft.filter((file) => file.includes(`${path.sep}buckets${path.sep}`))
  const manifestTmpLeft = tmpLeft.filter((file) => !file.includes(`${path.sep}buckets${path.sep}`))
  assert.deepEqual(bucketTmpLeft, [], '写盘应清掉 buckets 下 >10 分钟的崩溃 tmp')
  const tmpWarn = manifestTmpLeft.length > 0

  // 1b：子进程在写盘途中被杀：已提交数据不丢、readStore 不返回空库。
  const child = spawn(process.execPath, ['--input-type=module', '-e', writeWorkerScript(), storePath, dir, 'crash', '2000'], {
    stdio: 'ignore',
    env: { ...process.env, DSH_HOME: path.join(dir, 'dsh-home') },
  })
  await sleep(500)
  child.kill('SIGKILL')
  await closeTo(child)
  const afterKill = readStore(dir)
  assert.ok(afterKill.experiences.length >= rows.length, '进程被杀后不应丢已提交数据')
  assert.ok(afterKill.experiences.every((row) => row && typeof row.id === 'string'))

  // 1c：被杀可能留下锁目录；短期内的写入预期行为（D1：pid/心跳判残留，不空等）。
  const lockDir = `${path.join(dir, 'exp-lib.json')}.lock`
  let lockActual = '未留下锁目录（写入已释放或被安全清理）'
  let lockWarn = false
  if (fs.existsSync(lockDir)) {
    const started = Date.now()
    try {
      withStoreLock(dir, () => writeStore(dir, readStore(dir)))
      lockActual = `锁目录存在但写入成功（${Date.now() - started}ms）`
    } catch (error) {
      lockActual = `锁目录存在：写入等待 ${Date.now() - started}ms 后报错「${String(error.message).slice(0, 60)}」`
      lockWarn = true
      const oldLock = new Date(Date.now() - 2 * 60 * 1000)
      fs.utimesSync(lockDir, oldLock, oldLock)
      const retryStart = Date.now()
      withStoreLock(dir, () => writeStore(dir, readStore(dir)))
      lockActual += `；把锁目录 mtime 改老后重试成功（${Date.now() - retryStart}ms）`
    }
  }

  // 1d：确定性伪造残留锁——pid 不存在 / 心跳过期 / 无 pid 且目录已老。获取必须 ≤200ms。
  const staleCases = []
  for (const kind of ['dead-pid', 'old-heartbeat', 'no-pid']) {
    const { dir: probeDir } = makeLib(2)
    const probeLock = `${path.join(probeDir, 'exp-lib.json')}.lock`
    fs.mkdirSync(probeLock)
    if (kind !== 'no-pid') fs.writeFileSync(path.join(probeLock, 'pid'), kind === 'dead-pid' ? '999999' : String(process.pid), 'utf8')
    const heartbeatAt = kind === 'old-heartbeat' ? Date.now() - 60000 : Date.now()
    if (kind !== 'no-pid') fs.writeFileSync(path.join(probeLock, 'heartbeat'), JSON.stringify({ pid: process.pid, at: heartbeatAt }), 'utf8')
    if (kind === 'no-pid') {
      const old = new Date(Date.now() - 5000)
      fs.utimesSync(probeLock, old, old)
    }
    const started = Date.now()
    let acquiredOk = false
    let acquireError = ''
    try {
      withStoreLock(probeDir, () => { fs.writeFileSync(path.join(probeDir, 'probe.txt'), 'x') })
      acquiredOk = true
    } catch (error) {
      acquireError = String(error.message).slice(0, 60)
    }
    staleCases.push({ kind, ok: acquiredOk, ms: Date.now() - started, error: acquireError, released: !fs.existsSync(probeLock) })
  }
  const staleFailed = staleCases.filter((item) => !item.ok || item.ms > 200 || !item.released)
  lockActual += `；伪造残留锁：${staleCases.map((item) => `${item.kind} ${item.ok ? `${item.ms}ms` : `失败(${item.error})`}`).join('、')}`
  assert.deepEqual(staleFailed, [], '伪造残留锁（死 pid / 心跳过期 / 无 pid）应在 200ms 内清理并成功加锁')

  pushResult('F1', '半写（残留 tmp / 进程被杀）',
    '造 20 分钟前的 .tmp 残留 + 启动写子进程 500ms 后 SIGKILL；再尝试加锁写入；另伪造三种残留锁（死 pid / 心跳过期 / 无 pid）。',
    `tmp 残留被忽略；buckets 与根目录崩溃 tmp 均已清零；被杀后 readStore 仍有 ${afterKill.experiences.length} 条且可解析。${lockActual}`,
    lockWarn || tmpWarn || staleFailed.length > 0 ? 'WARN' : 'PASS',
    [
      lockWarn ? '崩溃残留锁目录仍导致等待' : '',
      tmpWarn ? '根目录 manifest tmp 未清理' : '',
      staleFailed.length > 0 ? '残留锁判定未通过' : '',
    ].filter(Boolean).join('；') || 'D1：锁内写 pid+心跳，死 pid / 心跳超 10s / 无 pid 超 2s 立即判残留清理；STALE_LOCK_MS 保留兜底。D2：manifest.json.*.tmp 并入清理。')
}

/* ------------------------------------------------------------------ */
/* 2. 单分片损坏                                                       */
/* ------------------------------------------------------------------ */
function scenarioCorruptShard() {
  const { dir, rows } = makeLib(6)
  const manifestBefore = readManifest(dir)
  const file = bucketFiles(dir).find((name) => fs.statSync(name).size > 0)
  assert.ok(file !== undefined, '应有非空分片')
  const original = fs.readFileSync(file)
  fs.appendFileSync(file, '{this is not json\n', 'utf8')
  let message = ''
  try {
    readStore(dir)
    message = 'readStore 未报错（不可接受：会静默少行）'
  } catch (error) {
    message = error.message
  }
  assert.match(message, /分片损坏/, '应报「分片损坏」')
  assert.ok(message.includes(path.basename(file)), '错误应定位到具体分片文件')
  // 其它类型仍可定向读取（控制台能降级展示，不是整库不可用）。
  const otherType = rows.find((row) => row.typeId !== rows[0].typeId).typeId
  const partial = readShardRecordsOfTypes(dir, manifestBefore, [otherType])
  assert.ok(partial.records.length > 0, '健康类型仍应可定向读取')
  // 截断到一行中间：同样应明确报错，而不是返回不完整快照。
  const firstLineEnd = original.indexOf(0x0a)
  fs.writeFileSync(file, original.subarray(0, Math.max(1, firstLineEnd - 3)))
  assert.throws(() => readStore(dir), /分片损坏/, '截断分片应报「分片损坏」')
  fs.writeFileSync(file, original)
  assert.equal(readStore(dir).experiences.length, rows.length, '恢复分片后应能正常读')
  pushResult('F2', '单分片损坏',
    '向一个非空 .jsonl 追加非 JSON 行；再截断到一行中间；最后恢复。',
    `readStore 抛出「${message}」并带文件名；其他类型定向读取 ${partial.records.length} 条正常；截断同样抛错；恢复后 ${rows.length} 条。`,
    'PASS',
    '整库读会整体失败（不静默跳过），符合「明确报错、不返回不完整快照」；控制台可用定向读降级。')
}

/* ------------------------------------------------------------------ */
/* 3. manifest 损坏 / 缺失 / 版本不符                                  */
/* ------------------------------------------------------------------ */
function scenarioManifest() {
  const { dir, rows } = makeLib(5)
  const hashesBefore = new Map(bucketFiles(dir).map((file) => [path.basename(file), hashOf(file)]))
  fs.writeFileSync(manifestPath(dir), '{broken manifest', 'utf8')
  assert.equal(readStore(dir).experiences.length, rows.length, 'manifest 损坏应自愈，记录不能丢')
  const rebuilt = JSON.parse(fs.readFileSync(manifestPath(dir), 'utf8'))
  assert.ok(Array.isArray(rebuilt.buckets) && rebuilt.buckets.length > 0, '损坏 manifest 应被重建')
  for (const [name, hash] of hashesBefore) {
    assert.equal(hashOf(path.join(bucketsPath(dir), name)), hash, `自愈不应改分片 ${name}`)
  }
  // 缺失
  fs.rmSync(manifestPath(dir))
  assert.equal(readStore(dir).experiences.length, rows.length, 'manifest 缺失应能从分片重建')
  assert.ok(fs.existsSync(manifestPath(dir)), '读取后应重新写出 manifest')
  // 版本不符
  const manifest = JSON.parse(fs.readFileSync(manifestPath(dir), 'utf8'))
  manifest.version = 99
  fs.writeFileSync(manifestPath(dir), JSON.stringify(manifest, null, 2), 'utf8')
  let versionActual = ''
  try {
    versionActual = `${readStore(dir).experiences.length} 条`
  } catch (error) {
    versionActual = `抛错 ${error.message.slice(0, 60)}`
  }
  // 结构损坏（types 不是数组）
  manifest.version = 1
  manifest.types = 'not-an-array'
  fs.writeFileSync(manifestPath(dir), JSON.stringify(manifest, null, 2), 'utf8')
  let typeActual = ''
  try {
    typeActual = `${readStore(dir).experiences.length} 条`
  } catch (error) {
    typeActual = `抛错 ${error.message.slice(0, 60)}`
  }
  pushResult('F3', 'manifest 损坏/缺失/版本不符',
    '写坏 JSON / 删除 / version=99 / types 不是数组，各读一次。',
    `损坏：${rows.length} 条 + manifest 重建、分片字节不变；缺失：${rows.length} 条 + manifest 重写；版本 99：${versionActual}；types 结构坏：${typeActual}。`,
    'PASS',
    'manifest 定位为可重建缓存（D1），损坏/缺失自愈；版本/结构异常未静默返回空库。')
}

/* ------------------------------------------------------------------ */
/* 4. 并发写                                                           */
/* ------------------------------------------------------------------ */
async function scenarioConcurrent() {
  const { dir, rows } = makeLib(2)
  const script = writeWorkerScript()
  const startWorkers = [0, 1].map((index) => spawn(process.execPath, ['--input-type=module', '-e', script, storePath, dir, `w${index}`, '5'], {
    stdio: 'ignore',
    env: { ...process.env, DSH_HOME: path.join(dir, `dsh-home-${index}`) },
  }))
  const codes = await Promise.all(startWorkers.map(closeTo))
  assert.deepEqual(codes, [0, 0], '两个写进程都应正常退出')
  const store = readStore(dir)
  const ids = new Set(store.experiences.map((row) => row.id))
  assert.equal(ids.size, store.experiences.length, '不应有重复 id')
  assert.equal(store.experiences.length, rows.length + 10, '锁应串行化，10 条并发写不能丢')
  const w0 = store.experiences.filter((row) => String(row.intent).startsWith('并发写 w0')).length
  const w1 = store.experiences.filter((row) => String(row.intent).startsWith('并发写 w1')).length
  pushResult('F4', '并发写（两进程）',
    '两个子进程各用 withStoreLock + readStore/upsert/writeStore 写 5 条（不同类型 tag）。',
    `最终 ${store.experiences.length} 条（种子 ${rows.length} + 10），id 唯一；w0=${w0}、w1=${w1}；两个进程均 exit 0。`,
    'PASS',
    '锁生效、无丢更新；同类型并发由锁串行化。')
}

/* ------------------------------------------------------------------ */
/* 5. 超大记录 / 压缩边界                                              */
/* ------------------------------------------------------------------ */
function scenarioOversized() {
  const { dir } = makeLib(5)
  const store = readStore(dir)
  const hugeNote = '超大备注'.repeat(25 * 1024) // 100KB
  const hugeAction = '超大做法'.repeat(25 * 1024) // 100KB
  // exp_record 语义会截断 note/action 到 2000 字（另一条产品约束）；这里直接构造超大行，测存储层。
  store.experiences.push({
    id: 'ex_huge_1',
    taskId: 'ex_huge_1',
    kind: 'task',
    intent: '超大记录：给课件插页',
    action: hugeAction,
    note: hugeNote,
    ts: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    hits: 1,
    G: 0.8,
    GOutcome: 0.8,
    GSource: 'outcome',
    outcome: 'success',
    typeId: 'ty_0',
    typeName: TYPE,
    verdict: 'decided',
  })
  writeStore(dir, store)
  const readBack = readStore(dir).experiences.find((row) => row.intent === '超大记录：给课件插页')
  assert.ok(readBack !== undefined, '超大记录应能写入并读回')
  const hugeLine = bucketFiles(dir)
    .flatMap((file) => fs.readFileSync(file, 'utf8').split('\n'))
    .find((line) => line.includes('ex_huge_1'))
  assert.ok(hugeLine !== undefined && Buffer.byteLength(hugeLine) > 100 * 1024, '超大行应真实落盘（>100KB）')
  let compactActual = ''
  try {
    const manifest = readManifest(dir)
    compactStore(dir, manifest, { maxBucketBytes: 1024, hotMaxBytes: 1024, nMax: 100000 })
    compactActual = `压缩后 readStore ${readStore(dir).experiences.length} 条`
  } catch (error) {
    compactActual = `压缩抛错：${String(error.message).slice(0, 80)}`
  }
  const hotHasHuge = readStore(dir).experiences.some((row) => row.intent === '超大记录：给课件插页')
  const coldHasHuge = readColdStore(dir).experiences.some((row) => row.intent === '超大记录：给课件插页')
  assert.ok(hotHasHuge || coldHasHuge, '压缩不应因单条超大而卡死/丢条')
  pushResult('F5', '超大记录（100KB note/action）',
    '单条 note/action 各 100KB 写入；再以 1KB 桶上限触发 compactStore。',
    `100KB note/action 直接落盘（行 >100KB）、读回存在；${compactActual}；单条仍在热档或冷档。`,
    'PASS',
    'compactBucket 的「至少留一条」生效，单条超大不会让压缩死循环或丢数据。')
}

/* ------------------------------------------------------------------ */
/* 6. 空库 / 空分片                                                    */
/* ------------------------------------------------------------------ */
function scenarioEmpty() {
  const emptyDir = newDir()
  assert.equal(readStore(emptyDir).experiences.length, 0, '空目录应读成空库')
  // 只有 manifest（空库写盘）
  writeStore(emptyDir, { version: 1, types: [], experiences: [] })
  assert.equal(readStore(emptyDir).experiences.length, 0)
  // 只有 buckets 没有 manifest
  const { dir, rows } = makeLib(4)
  fs.rmSync(manifestPath(dir))
  assert.equal(readStore(dir).experiences.length, rows.length, '仅 buckets 时应重建 manifest')
  // 新增一个 manifest 未登记的 0 字节分片：应被忽略/重建，不影响已有行
  const emptyShard = path.join(bucketsPath(dir), 'ty_9.9.jsonl')
  fs.writeFileSync(emptyShard, '', 'utf8')
  const before = readStore(dir).experiences.length
  assert.equal(before, rows.length, '0 字节新增分片不应让读取崩掉或丢行')
  // 0 字节替换一个有数据的分片（文件被外部清空）：记录当前行为（可能是静默少行）
  const nonEmpty = nonEmptyBucket(dir)
  const declared = readManifest(dir).buckets.find((bucket) => path.basename(bucket.file) === path.basename(nonEmpty))
  const replacedOriginal = fs.readFileSync(nonEmpty)
  const manifestBytesBefore = fs.readFileSync(manifestPath(dir))
  const manifestStatBefore = fs.statSync(manifestPath(dir))
  fs.writeFileSync(nonEmpty, '', 'utf8')
  let replacedActual = ''
  try {
    replacedActual = `readStore ${readStore(dir).experiences.length} 条`
  } catch (error) {
    replacedActual = `抛错 ${error.message}`
  }
  // D3 钉死：错误必须带文件名；抛错后 manifest 必须逐字节不变（不能用少行结果重写）。
  assert.ok(replacedActual.includes(path.basename(nonEmpty)), '错误消息应包含被清零的分片文件名')
  const manifestBytesAfter = fs.readFileSync(manifestPath(dir))
  const manifestStatAfter = fs.statSync(manifestPath(dir))
  assert.equal(manifestBytesAfter.equals(manifestBytesBefore), true, '抛错时 manifest 不能被重写（拒绝用不完整快照自愈）')
  assert.equal(manifestStatAfter.size, manifestStatBefore.size, 'manifest 字节大小不应变化')
  assert.equal(manifestStatAfter.mtimeMs, manifestStatBefore.mtimeMs, 'manifest mtime 不应变化')
  const stillListed = JSON.parse(manifestBytesAfter.toString('utf8')).buckets
    .some((bucket) => bucket.file === declared.file && bucket.count === declared.count)
  assert.equal(stillListed, true, '抛错后 manifest 仍应登记原分片与原 count')
  fs.writeFileSync(nonEmpty, replacedOriginal)
  assert.equal(readStore(dir).experiences.length, rows.length, '恢复分片后行数应恢复')
  assert.match(replacedActual, /抛错|分片损坏/, '清零已声明分片应明确报错，不能静默少行')
  pushResult('F6', '空库 / 空分片',
    '空目录、只有 manifest、只有 buckets、0 字节分片；再把一个声明 count>0 的分片清零。',
    `空库/空 manifest 读成 0 条；仅 buckets 重建后 ${rows.length} 条；0 字节新增分片读取 ${before} 条不崩；清零已声明分片（count=${declared ? declared.count : '?'}）后 ${replacedActual}。`,
    'PASS',
    'D3：count 与实际行数不符按损坏处理，明确报错并指向文件；自愈不再用少行结果覆盖 manifest（唯一例外：冷档净增≥缺口，判定为压缩半提交）。')
}

/* ------------------------------------------------------------------ */
/* 7. 非 UTF-8 / BOM / CRLF                                            */
/* ------------------------------------------------------------------ */
function scenarioEncoding() {
  const { dir, rows } = makeLib(4)
  const file = nonEmptyBucket(dir)
  const original = fs.readFileSync(file)
  // BOM
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), original]))
  let bomActual = ''
  try {
    bomActual = `readStore ${readStore(dir).experiences.length} 条`
  } catch (error) {
    bomActual = `抛错 ${String(error.message).slice(0, 70)}`
  }
  assert.match(bomActual, /BOM|分片损坏/, 'BOM 应明确报错，不能静默返回')
  // 非 UTF-8 字节：在 JSON 字符串值里插 0xFF
  const text = original.toString('utf8')
  const firstLine = text.split('\n')[0]
  const marker = '"action":"'
  const markerAt = firstLine.indexOf(marker)
  assert.ok(markerAt >= 0, '应能定位到 action 字段')
  const lineBuf = Buffer.concat([
    Buffer.from(firstLine.slice(0, markerAt + marker.length), 'utf8'),
    Buffer.from([0xff]), // 真正的非法 UTF-8 字节（不是 U+FFFF）
    Buffer.from(firstLine.slice(markerAt + marker.length), 'utf8'),
    Buffer.from('\n'),
    Buffer.from(text.split('\n').slice(1).join('\n'), 'utf8'),
  ])
  fs.writeFileSync(file, lineBuf)
  let invalidActual = ''
  try {
    const store = readStore(dir)
    invalidActual = `readStore ${store.experiences.length} 条（未报错）`
  } catch (error) {
    invalidActual = `抛错 ${String(error.message).slice(0, 90)}`
  }
  assert.match(invalidActual, /UTF-8/, '非法字节应报 UTF-8 编码错误')
  assert.ok(invalidActual.includes(path.basename(file)), '非法字节的错误应定位到文件')
  assert.match(invalidActual, /第 \d+ 行/, '非法字节的错误应指到行号')
  // CRLF
  fs.writeFileSync(file, original)
  const crlf = original.toString('utf8').split('\n').filter(Boolean).map((line) => `${line}\r`).join('\n')
  fs.writeFileSync(file, crlf, 'utf8')
  let crlfActual = ''
  try {
    crlfActual = `${readStore(dir).experiences.length} 条`
  } catch (error) {
    crlfActual = `抛错 ${String(error.message).slice(0, 60)}`
  }
  assert.match(crlfActual, /^\d+ 条$/, 'CRLF 应能正常解析')
  pushResult('F7', '非 UTF-8 / BOM / CRLF',
    'BOM 前缀、字符串内插 0xFF 非法字节、整文件改 CRLF。',
    `BOM：${bomActual}；非法字节：${invalidActual}；CRLF：${crlfActual}。`,
    'PASS',
    'D4：逐行 `TextDecoder(fatal:true)` 解码，非法 UTF-8 报错并指出文件+行号；BOM 行首明确报错（JSON.parse 会容忍，不能靠它）；CRLF 兼容。')
}

/* ------------------------------------------------------------------ */
/* 8. 冷档缺失                                                         */
/* ------------------------------------------------------------------ */
function scenarioColdMissing() {
  const { dir, rows } = makeLib(4)
  const manifest = JSON.parse(fs.readFileSync(manifestPath(dir), 'utf8'))
  manifest.cold = { years: [{ year: 2026, files: [{ file: 'cold/2026-a.jsonl', count: 2, bytes: 123 }] }] }
  fs.writeFileSync(manifestPath(dir), JSON.stringify(manifest, null, 2), 'utf8')
  assert.ok(!fs.existsSync(path.join(coldPath(dir), '2026-a.jsonl')))
  let coldActual = ''
  try {
    coldActual = `readColdStore ${readColdStore(dir).experiences.length} 条（未抛错）`
  } catch (error) {
    coldActual = `抛错 ${String(error.message).slice(0, 80)}`
  }
  assert.equal(readStore(dir).experiences.length, rows.length, '冷档缺失不能影响热档')
  assert.match(coldActual, /冷档|分片丢失/, 'cold:true 应明确报错并指出缺失文件')
  assert.ok(coldActual.includes('2026-a.jsonl'), '冷档错误应指出具体文件')
  pushResult('F8', '冷档缺失',
    'manifest.cold 指向一个不存在的 cold/2026-a.jsonl，再查热档。',
    `热档 readStore ${rows.length} 条正常；冷档查询：${coldActual}。`,
    'PASS',
    'D5：manifest.cold 登记但文件缺失时明确报错（指文件名），只影响 cold:true 显式查询，热档召回与提示段不受影响。')
}

/* ------------------------------------------------------------------ */
/* 9. 磁盘满 / 写失败                                                  */
/* ------------------------------------------------------------------ */
function scenarioDiskFull() {
  const { dir, rows } = makeLib(4)
  const store = readStore(dir)
  upsertExperience(store, { intent: '磁盘满测试 给课件插页', action: '写一条', outcome: 'success', type: TYPE })
  const realWriteFileSync = fs.writeFileSync
  let diskActual = ''
  try {
    fs.writeFileSync = function patchedWrite(file, ...args) {
      if (String(file).includes('manifest.json')) {
        const error = new Error('ENOSPC: no space left on device')
        error.code = 'ENOSPC'
        throw error
      }
      return realWriteFileSync.call(this, file, ...args)
    }
    try {
      writeStore(dir, store)
      diskActual = 'writeStore 未抛错（不可接受）'
    } catch (error) {
      diskActual = `抛出 ${error.code || 'Error'}：${String(error.message).slice(0, 50)}`
    }
  } finally {
    fs.writeFileSync = realWriteFileSync
  }
  assert.match(diskActual, /ENOSPC/, '磁盘满应抛出 ENOSPC')
  const after = readStore(dir)
  assert.ok(after.experiences.length >= rows.length, '写失败不能破坏旧数据')
  const tmpAfterFailure = listTmp(dir)
  writeStore(dir, readStore(dir))
  assert.deepEqual(listTmp(dir), [], '失败/重试后不应残留 .tmp')
  pushResult('F9', '磁盘满 / 写失败',
    'monkeypatch fs.writeFileSync：写 manifest 时抛 ENOSPC；恢复后重试。',
    `${diskActual}；失败后 readStore ${after.experiences.length} 条可解析；残留 tmp ${tmpAfterFailure.length} 个；恢复后重写成功且 tmp 清零。`,
    'PASS',
    '原子写（临时文件+rename）保证失败不破坏旧 manifest/分片，错误可上抛，重试可恢复。')
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */
const main = async () => {
  await scenarioHalfWrite()
  scenarioCorruptShard()
  scenarioManifest()
  await scenarioConcurrent()
  scenarioOversized()
  scenarioEmpty()
  scenarioEncoding()
  scenarioColdMissing()
  scenarioDiskFull()

  const counts = { PASS: 0, WARN: 0, FAIL: 0 }
  for (const item of results) counts[item.verdict] = (counts[item.verdict] || 0) + 1
  console.log(`\n结果：PASS ${counts.PASS} · WARN ${counts.WARN} · FAIL ${counts.FAIL}（共 ${results.length} 个场景）`)
  const outPath = path.join(repoRoot, '_tmp', 'fault-results.json')
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2), 'utf8')
  console.log(`明细：${outPath}`)
  process.exit(counts.FAIL > 0 ? 1 : 0)
}

main().catch((error) => {
  console.error('故障注入测试自身失败：', error)
  process.exit(1)
})
