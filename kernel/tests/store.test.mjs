/**
 * 存储语义测试：upsert 三分支、软删墓碑、过滤、排序、观测数据。
 * Run: node tests/store.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  dataDirFromProviderState,
  ensureDefaultTypes,
  forgetExperience,
  graphSnapshot,
  listInsights,
  purgeTombstones,
  rankExperiences,
  readStore,
  resolveDataDir,
  resolveToolDataDir,
  statsOf,
  upsertExperience,
  visibleExperiences,
  writeStore,
} from '../store.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-provider-store-'))
const store = readStore(dir)
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

const INTENT = '制作一个研学课的六页PPT并导出成演示文稿'
const actionA = '先定主题色再排版'
const actionB = '先排版再统一调色'

check('新增：第一条写入是 added', () => {
  const result = upsertExperience(store, { intent: INTENT, action: actionA, outcome: 'success', type: 'PPT / 课件', note: '红色党政风' })
  assert.equal(result.action, 'added')
  assert.equal(store.experiences.length, 1)
  assert.equal(result.experience.hits, 1)
  // 口径只有一份：kernel 的 OUTCOME_SCORES（success +0.8、accepted +1.0）。
  assert.equal(result.experience.G, 0.8)
  assert.equal(result.experience.typeName, 'PPT / 课件')
})

check('重复：同意图同做法 → 就地更新，hits+1，不新增行', () => {
  const result = upsertExperience(store, { intent: INTENT, action: actionA, outcome: 'partial', note: '第二次' })
  assert.equal(result.action, 'updated')
  assert.equal(store.experiences.length, 1)
  assert.equal(result.experience.hits, 2)
  assert.equal(result.experience.outcome, 'partial')
  assert.equal(result.experience.G, 0.3)
})

check('近似替换：同类型不同做法 → 新条 + 旧条 superseded_by', () => {
  const result = upsertExperience(store, { intent: INTENT, action: actionB, outcome: 'success', type: 'PPT / 课件' })
  assert.equal(result.action, 'superseded')
  assert.equal(store.experiences.length, 2)
  const old = store.experiences.find((item) => item.action === actionA)
  assert.equal(old.superseded_by, result.experience.id)
  assert.equal(result.experience.supersedes, old.id)
})

check('过滤：可见经验排除已被取代的旧条', () => {
  const visible = visibleExperiences(store)
  assert.equal(visible.length, 1)
  assert.equal(visible[0].action, actionB)
})

check('排序：只对可见经验排序，返回优势/置信度/证据', () => {
  const ranked = rankExperiences(store, INTENT, 5)
  assert.ok(ranked.candidates.length >= 1)
  const top = ranked.candidates[0]
  assert.equal(top.action, actionB)
  assert.equal(typeof top.advantage, 'number')
  assert.equal(typeof top.confidence, 'number')
  assert.ok(top.evidence.length >= 1)
  assert.equal(top.evidence[0].intent, INTENT)
})

check('软删：forget 后不可见但仍在文件里', () => {
  const target = store.experiences.find((item) => !item.deleted_at && !item.superseded_by)
  assert.ok(forgetExperience(store, target.id))
  assert.equal(visibleExperiences(store).length, 1, '删掉取代者后，被它取代的旧条回到可见')
  assert.equal(visibleExperiences(store)[0].action, actionA)
  assert.equal(store.experiences.length, 2)
  assert.equal(store.experiences.filter((item) => item.deleted_at).length, 1)
})

check('墓碑 TTL：过期的软删行被物理清理', () => {
  const stale = store.experiences.find((item) => item.deleted_at)
  stale.deleted_at = new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString()
  const removed = purgeTombstones(store, 30)
  assert.equal(removed, 1)
  assert.equal(store.experiences.some((item) => item.id === stale.id), false)
})

check('观测：listInsights / graph / stats 形状正确', () => {
  upsertExperience(store, { intent: '做一节课的任务卡', action: 'task-card-builder', outcome: 'success', type: '文档 / 教案' })
  const insights = listInsights(store, { limit: 10 })
  assert.ok(insights.length >= 1)
  assert.ok(typeof insights[0].content === 'string' && insights[0].content.includes('任务卡'))
  assert.ok(Array.isArray(insights[0].entities))

  const graph = graphSnapshot(store)
  assert.ok(graph.nodes.length >= 1)
  assert.ok(Array.isArray(graph.edges))

  const stats = statsOf(store, dir)
  assert.ok(stats.totalInsights >= 1)
  assert.equal(typeof stats.dbSizeBytes, 'number')
  assert.ok(stats.byCategory['文档 / 教案'] >= 1)
})

check('持久化：writeStore 后 readStore 内容一致', () => {
  writeStore(dir, store)
  const again = readStore(dir)
  assert.equal(again.experiences.length, store.experiences.length)
  assert.ok(again.types.length >= 1)
})

check('类型按需创建 + 近似合并 + 泛化名 + 上限 + 每日上限', () => {
  const d1 = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-types-'))
  const s1 = readStore(d1)
  assert.equal(s1.types.length, 1)
  assert.equal(s1.types[0].name, '未分类')
  assert.equal(s1.types.at(-1).name, '未分类')

  const created = upsertExperience(s1, { intent: '做研学课', action: '先定主题色', type: '研学课设计', typeDescription: '研学课教案与流程' })
  assert.equal(created.type.created, true)
  assert.equal(created.experience.typeName, '研学课设计')
  assert.equal(s1.types.filter((type) => type.system !== true).length, 1)

  const exact = upsertExperience(s1, { intent: '做研学课', action: '先定主题色', type: '研学课设计' })
  assert.equal(exact.type.created, false)

  const near = upsertExperience(s1, { intent: '做研学课', action: '先写大纲', type: '研学课设计方法' })
  assert.equal(near.type.created, false)
  assert.equal(near.type.mergedInto, '研学课设计')

  const generic = upsertExperience(s1, { intent: '随便做点', action: '试试', type: '其他' })
  assert.equal(generic.experience.typeName, '未分类')
  assert.equal(generic.type.created, false)

  const capped = readStore(fs.mkdtempSync(path.join(os.tmpdir(), 'exp-types-cap-')))
  upsertExperience(capped, { intent: '任务一', action: '做法一', type: 'PPT制作' }, { maxTypes: 1 })
  const over = upsertExperience(capped, { intent: '任务二', action: '做法二', type: '量子航线' }, { maxTypes: 1 })
  assert.equal(over.type.created, false)
  assert.equal(over.type.rejected, 'limit')
  assert.equal(over.experience.typeName, '未分类')

  const rated = readStore(fs.mkdtempSync(path.join(os.tmpdir(), 'exp-types-rate-')))
  upsertExperience(rated, { intent: '任务一', action: '做法一', type: 'PPT制作' }, { maxTypes: 10, newTypesPerDay: 1 })
  const rate = upsertExperience(rated, { intent: '任务二', action: '做法二', type: '潮汐算法' }, { maxTypes: 10, newTypesPerDay: 1 })
  assert.equal(rate.type.created, false)
  assert.equal(rate.type.rejected, 'rate')

  for (const temp of [d1]) fs.rmSync(temp, { recursive: true, force: true })
})

check('首次初始化才种默认分类；已有分类不覆盖', () => {
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-defaults-'))
  ensureDefaultTypes(d2)
  const seeded = readStore(d2)
  const defaults = seeded.types.filter((type) => type.system !== true)
  assert.equal(defaults.length, 6)
  assert.ok(defaults.some((type) => type.name === '开发'))
  assert.ok(defaults.some((type) => type.name === '办公'))

  upsertExperience(seeded, { intent: '自定义任务', action: '自定义做法', type: '自定义分类' })
  writeStore(d2, seeded)
  ensureDefaultTypes(d2)
  const again = readStore(d2)
  assert.equal(again.types.filter((type) => type.name === '自定义分类').length, 1)
  assert.equal(again.types.filter((type) => type.name === '开发').length, 1)
  fs.rmSync(d2, { recursive: true, force: true })
})

check('跟随配置：从记忆插件状态里读 Provider 数据目录', () => {
  const stateFile = path.join(dir, 'memory-providers.json')
  fs.writeFileSync(stateFile, JSON.stringify({ services: { 'exp-lib': { dataDir: path.join(dir, 'from-state') } } }), 'utf8')
  const resolved = dataDirFromProviderState({ providerStateFile: stateFile, mnemonDataDir: path.join(dir, 'none') })
  assert.equal(resolved, path.join(dir, 'from-state'))
})

check('可换机器：无配置时数据目录从 DSH_HOME 派生，不落进程工作目录', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-dsh-home-'))
  const previous = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = home
    assert.equal(resolveDataDir({}), path.join(home, 'exp-lib', 'provider-data'))
    assert.notEqual(resolveDataDir({}), path.join(process.cwd(), '.exp', 'exp-lib-provider'))
    assert.equal(resolveDataDir({ dataDir: '~/custom' }), path.join(os.homedir(), 'custom'))
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    fs.rmSync(home, { recursive: true, force: true })
  }
})

check('可换机器：记忆插件自定义存储根走 MNEMON_DATA_DIR', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-mnemon-root-'))
  const previous = process.env.MNEMON_DATA_DIR
  try {
    fs.mkdirSync(path.join(root, 'state'), { recursive: true })
    fs.writeFileSync(path.join(root, 'state', 'memory-providers.json'), JSON.stringify({ services: { 'exp-lib': { dataDir: path.join(root, 'library') } } }), 'utf8')
    process.env.MNEMON_DATA_DIR = root
    assert.equal(resolveToolDataDir({}), path.join(root, 'library'))
  } finally {
    if (previous === undefined) delete process.env.MNEMON_DATA_DIR
    else process.env.MNEMON_DATA_DIR = previous
    fs.rmSync(root, { recursive: true, force: true })
  }
})

check('不开配置也能定位：从 profile 的 cordis.patch.yml 读 mnemon 的 dataDir', () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-profile-'))
  const mnemonRoot = path.join(profile, 'mnemon-store')
  const previous = {
    DSH_PROFILE_DIR: process.env.DSH_PROFILE_DIR,
    DSH_HOME: process.env.DSH_HOME,
    DSH_MNEMON_DATA_DIR: process.env.DSH_MNEMON_DATA_DIR,
    MNEMON_DATA_DIR: process.env.MNEMON_DATA_DIR,
  }
  try {
    fs.mkdirSync(path.join(mnemonRoot, 'state'), { recursive: true })
    fs.writeFileSync(path.join(mnemonRoot, 'state', 'memory-providers.json'), JSON.stringify({ services: { 'exp-lib': { dataDir: path.join(profile, 'library') } } }), 'utf8')
    fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), [
      '- id: mnemon',
      '  name: dsh-mnemon',
      '  config:',
      '    storageScope: custom',
      `    dataDir: ${mnemonRoot.replace(/\\/g, '\\\\')}`,
      '- id: other',
      '  config:',
      '    dataDir: /should/not/be/read',
      '',
    ].join('\n'), 'utf8')
    process.env.DSH_PROFILE_DIR = profile
    delete process.env.DSH_MNEMON_DATA_DIR
    delete process.env.MNEMON_DATA_DIR
    assert.equal(resolveToolDataDir({}), path.join(profile, 'library'))
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    fs.rmSync(profile, { recursive: true, force: true })
  }
})

check('环境缺省也能定位：扫 $DSH_HOME/profiles/* 的 cordis.patch.yml，跳过 backup-*', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-dsh-home-scan-'))
  const profiles = path.join(home, 'profiles')
  const real = path.join(profiles, 'desktop')
  const backup = path.join(profiles, 'backup-2026-01-01')
  const realRoot = path.join(real, 'mnemon-store')
  const backupRoot = path.join(backup, 'mnemon-store')
  const previous = {
    DSH_HOME: process.env.DSH_HOME,
    DSH_PROFILE_DIR: process.env.DSH_PROFILE_DIR,
    DSH_PROFILE: process.env.DSH_PROFILE,
    DSH_MNEMON_DATA_DIR: process.env.DSH_MNEMON_DATA_DIR,
    MNEMON_DATA_DIR: process.env.MNEMON_DATA_DIR,
  }
  const patchText = (mnemonRoot) => [
    '- id: mnemon',
    '  name: dsh-mnemon',
    '  config:',
    '    storageScope: custom',
    `    dataDir: ${mnemonRoot.replace(/\\/g, '\\\\')}`,
    '',
  ].join('\n')
  try {
    fs.mkdirSync(path.join(realRoot, 'state'), { recursive: true })
    fs.mkdirSync(path.join(backupRoot, 'state'), { recursive: true })
    const realLibrary = path.join(real, 'library')
    const backupLibrary = path.join(backup, 'library')
    fs.writeFileSync(path.join(realRoot, 'state', 'memory-providers.json'), JSON.stringify({ services: { 'exp-lib': { dataDir: realLibrary } } }), 'utf8')
    fs.writeFileSync(path.join(backupRoot, 'state', 'memory-providers.json'), JSON.stringify({ services: { 'exp-lib': { dataDir: backupLibrary } } }), 'utf8')
    fs.writeFileSync(path.join(real, 'cordis.patch.yml'), patchText(realRoot), 'utf8')
    fs.writeFileSync(path.join(backup, 'cordis.patch.yml'), patchText(backupRoot), 'utf8')
    process.env.DSH_HOME = home
    delete process.env.DSH_PROFILE_DIR
    delete process.env.DSH_PROFILE
    delete process.env.DSH_MNEMON_DATA_DIR
    delete process.env.MNEMON_DATA_DIR
    // backup-* 在 readdir 排序里排在 desktop 前面：没跳过就会错读到备份 profile。
    assert.equal(resolveToolDataDir({}), realLibrary)
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    fs.rmSync(home, { recursive: true, force: true })
  }
})

check('环境缺省也能定位：从 cwd 祖先链找 .mnemon', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-cwd-ancestors-'))
  const home = path.join(root, 'dsh-home')
  const emptyHome = path.join(root, 'user-home')
  const work = path.join(root, 'work', 'sub')
  const mnemonRoot = path.join(root, 'work', '.mnemon')
  const previousCwd = process.cwd()
  const previous = {
    DSH_HOME: process.env.DSH_HOME,
    DSH_PROFILE_DIR: process.env.DSH_PROFILE_DIR,
    DSH_PROFILE: process.env.DSH_PROFILE,
    DSH_MNEMON_DATA_DIR: process.env.DSH_MNEMON_DATA_DIR,
    MNEMON_DATA_DIR: process.env.MNEMON_DATA_DIR,
    USERPROFILE: process.env.USERPROFILE,
    HOME: process.env.HOME,
  }
  try {
    fs.mkdirSync(path.join(mnemonRoot, 'state'), { recursive: true })
    fs.mkdirSync(home, { recursive: true })
    fs.mkdirSync(emptyHome, { recursive: true })
    fs.mkdirSync(work, { recursive: true })
    const library = path.join(root, 'library')
    fs.writeFileSync(path.join(mnemonRoot, 'state', 'memory-providers.json'), JSON.stringify({ services: { 'exp-lib': { dataDir: library } } }), 'utf8')
    process.env.DSH_HOME = home
    // 家目录也换到空目录，别让本机真实的 ~/.mnemon 影响断言。
    process.env.USERPROFILE = emptyHome
    process.env.HOME = emptyHome
    delete process.env.DSH_PROFILE_DIR
    delete process.env.DSH_PROFILE
    delete process.env.DSH_MNEMON_DATA_DIR
    delete process.env.MNEMON_DATA_DIR
    process.chdir(work)
    assert.equal(resolveToolDataDir({}), library)
  } finally {
    process.chdir(previousCwd)
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    fs.rmSync(root, { recursive: true, force: true })
  }
})

check('显式配置优先：给了 mnemonDataDir 就不去扫 profile', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-explicit-wins-'))
  const explicitRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-explicit-root-'))
  const profile = path.join(home, 'profiles', 'desktop')
  const profileRoot = path.join(profile, 'mnemon-store')
  const previous = {
    DSH_HOME: process.env.DSH_HOME,
    DSH_PROFILE_DIR: process.env.DSH_PROFILE_DIR,
    DSH_PROFILE: process.env.DSH_PROFILE,
    DSH_MNEMON_DATA_DIR: process.env.DSH_MNEMON_DATA_DIR,
    MNEMON_DATA_DIR: process.env.MNEMON_DATA_DIR,
  }
  try {
    fs.mkdirSync(path.join(profileRoot, 'state'), { recursive: true })
    fs.mkdirSync(path.join(explicitRoot, 'state'), { recursive: true })
    fs.writeFileSync(path.join(profileRoot, 'state', 'memory-providers.json'), JSON.stringify({ services: { 'exp-lib': { dataDir: path.join(home, 'from-profile') } } }), 'utf8')
    fs.writeFileSync(path.join(explicitRoot, 'state', 'memory-providers.json'), JSON.stringify({ services: { 'exp-lib': { dataDir: path.join(explicitRoot, 'from-explicit') } } }), 'utf8')
    fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), [
      '- id: mnemon',
      '  name: dsh-mnemon',
      '  config:',
      `    dataDir: ${profileRoot.replace(/\\/g, '\\\\')}`,
      '',
    ].join('\n'), 'utf8')
    process.env.DSH_HOME = home
    delete process.env.DSH_PROFILE_DIR
    delete process.env.DSH_PROFILE
    delete process.env.DSH_MNEMON_DATA_DIR
    delete process.env.MNEMON_DATA_DIR
    assert.equal(resolveToolDataDir({ mnemonDataDir: explicitRoot }), path.join(explicitRoot, 'from-explicit'))
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(explicitRoot, { recursive: true, force: true })
  }
})

try {
  fs.rmSync(dir, { recursive: true, force: true })
} catch {}

console.log('')
console.log(`结果：通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exit(1)
