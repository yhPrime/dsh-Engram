/**
 * exp-ui — Host 半（HTTP 外壳）。
 *
 * 一个前缀路由 `/exp-ui/api`，客户端半只认这里的返回值；data source 可换
 * （mock = 内置示例数据，live = 读真实经验库文件），路由与返回形状不变。
 * 这样「外壳测试通过 → 接真实经验库」只是换 config，不是改界面。
 *
 * 响应envelope：
 *   成功 { ok: true, data: … }
 *   失败 { ok: false, error: { code, message } }
 */

import { createLiveSource, resolveLiveDataDir } from './live.js'
import { createMockSource } from './mock.js'
import {
  FEEDBACK_ETA,
  RECALL_PASSTHROUGH_KEYS,
  codedError,
  detailOf,
  emptyStore,
  listOf,
  numberParam,
  recallOf,
  rowOf,
  visibleOf,
  statsOf,
  statsOfManifest,
  typesOf,
  typesOfManifest,
  usageSummary,
} from './data-source.js'
import fs from 'node:fs'
import path from 'node:path'

import { defaultDataDir, moveDataRoot, readEngineConfig, readGitConfig, readSettings, readUiConfig, resolveEngramDataDir, setCurrentRoot, writeEngineConfig, writeGitConfig, writeUiConfig } from '../kernel/settings.js'
import { ensureDefaultTypes } from '../kernel/store.js'
import { galleryHtml } from './icons-gallery.js'
import { gitInit, gitPull, gitPush, gitStatus } from '../kernel/git-sync.js'
import { importSkills } from '../kernel/import-skill.js'
import { applySkillNodeAction, buildSkillTree, forgetSkill, registerSkillGlobally, unregisterSkillFromDsh, updateSkillMeta } from '../kernel/skills.js'
import { findSessionFile, probeSessions, saveTurnAsExperience } from '../kernel/chat-save.js'
import { classifyExperienceWithSession, localClassifyExperience } from '../kernel/experience-classify.js'
import { normalizeContext, readStore, tagCatalog, writeStore } from '../kernel/store.js'
import { githubCreateRepo, githubLogin, githubRepos } from '../kernel/github.js'
import { pollDeviceFlow, startDeviceFlow } from '../kernel/github-device.js'
import { spawn } from 'node:child_process'

/** 客户端调用前缀（与 client.js 拼的 URL 一致）。 */
export const API_PREFIX = '/exp-ui/api'
/** 外显名；与真实经验库（exp-lib）区分开。 */
export const APP_NAME = '经验库'

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 300

/** 设置页可编辑项（全部都在这里，未知键不落盘）。 */
export const SETTINGS_SPEC = {
  config: [
    { key: 'hint', label: '每轮提示段', type: 'boolean', hint: '关闭后不再向系统提示写经验库用法', tip: '开启时，每轮系统提示里会多一段以「【经验库】」开头的说明（条数/类型目录/用法）。关掉后要重载插件才会撤掉已经注册的那一段——保存后提示段不会立刻消失。' },
    { key: 'hintMode', label: '提示段样式', type: 'enum', values: ['slim', 'full'], labels: { slim: '瘦身（默认，约 120 字符）', full: '完整（含类型/技能目录）' }, tip: '瘦身档只写「怎么用 + 条数 + 待判定 + 前几个技能」；完整档会列全部类型与技能，每轮固定开销约 1,300 字符。' },
    { key: 'hintSkills', label: '提示段列技能', type: 'boolean', tip: '瘦身档里是否列技能名（按顺序最多 8 个）；关掉后技能只在 exp_recall 命中时出现。' },
    { key: 'recallLimitDefault', label: '召回默认条数', type: 'number', hint: '默认 3', tip: 'exp_recall 不传 limit 时返回几条候选。显式传 limit 时按传的来（上限 8）。' },
    { key: 'pendingTtl', label: '待判定提醒次数', type: 'number', hint: '默认 3', tip: '一条待判定记录随回执出现几次仍未被回填，就自动转 skipped（止损，不再打扰模型）。' },
    { key: 'pendingReceipt', label: '回执带待判定', type: 'boolean', tip: '关闭后 exp_record / exp_recall 的返回里不再附带 pending，判定只能靠控制台查看。' },
    { key: 'usageLog', label: '用法日志', type: 'boolean', hint: '记录 exp_* 调用，用于使用记录页', tip: '把每次 exp_record / exp_recall / exp_feedback 的调用写进 <数据目录>/usage.jsonl，零 token 开销；关掉后「使用记录」页就没有新数据。' },
    { key: 'usageLogMaxBytes', label: '日志上限（字节）', type: 'number', tip: 'usage.jsonl 超过这个大小就轮转成 usage.jsonl.1（只保留一份旧文件）。内部有 1024 字节下限：填 1 也按 1024 生效。' },
    { key: 'feedbackEta', label: '反馈学习率 η', type: 'number', hint: '0~1，默认 0.35', tip: '每次「有帮助/没帮上」把 G 往 +1 / -1 拉的幅度。η 越大改得越快；默认 0.35。' },
    { key: 'feedbackDecayDays', label: '反馈衰减（天）', type: 'number', tip: '它不是「G 随时间自然衰减」，而是「超过天数的旧反馈事件折叠进基准 GOutcome」——折叠后 G 值不变，只是日志变短（压缩）。填 0 表示不折叠。' },
    { key: 'routing', label: '簇路由', type: 'enum', values: ['on', 'shadow', 'off'], tip: 'on：召回先用簇路由收窄候选；shadow：只记录路由结果不实际收窄（用来对比效果）；off：全库检索。' },
    { key: 'autoAssign', label: '自动归族', type: 'boolean', tip: '记录经验时没写类型，就按簇路由自动归到某个类型；关掉后一律落「未分类」。' },
    { key: 'consolidation', label: '沉淀候选', type: 'boolean', tip: '召回结果里附带一条「候选规则」：同族样本够多、且正负对照都有时才给，用来提示可以沉淀成技能。不写库、不花 token。' },
    { key: 'consolidationMinSamples', label: '沉淀最少样本', type: 'number', tip: '同族至少多少条才给「候选规则」（默认 3，且必须同时有正回报和负回报）。' },
    { key: 'induction', label: '归纳提示', type: 'boolean', tip: '召回到同族多条时，额外给一段「原料」让模型自己归纳共性；它明确写着「别当结论」，只是提示。' },
    { key: 'inductionMinSamples', label: '归纳最少样本', type: 'number', tip: '同族至少多少条才给归纳提示（默认 3）。' },
    { key: 'maxTypes', label: '类型上限', type: 'number', tip: '用户类型最多几个（不含系统「未分类」）。超限后新类型名会归到「未分类」并把原因写进 exp_record 的回执。' },
    { key: 'newTypesPerDay', label: '每日新类型上限', type: 'number', tip: '一天最多新建几个类型，防止类型爆炸；超了同样归「未分类」。' },
    { key: 'mergeThreshold', label: '类型合并阈值', type: 'number', tip: '重记一条「没写类型」的经验时，若同做法的旧经验相似度达到这个阈值，就继承它的类型。注意：类型名互相包含（如「文档写作」/「文档写作文案」）会直接合并，不受这个阈值影响。' },
    { key: 'replaceThreshold', label: '经验取代阈值', type: 'number', tip: '新记录与旧经验意图相似度达到这个阈值时，旧条标记为「被取代」（保留历史但不再参与召回）。' },
    { key: 'typeSimilarity', label: '类型相似度阈值', type: 'number', tip: '新建类型时，名字与已有类型的相似度（二元组 Jaccard）达到这个值就并入已有类型，不新建。' },
  ],
  ui: [
    { key: 'source', label: '数据源', type: 'enum', values: ['live', 'mock'], hint: 'mock 仅用于界面演示', tip: 'live：读真实经验库；mock：读内置示例数据（只用于看界面效果，不写真实库）。' },
    { key: 'dataDir', label: '目录覆盖', type: 'string', hint: '留空则用「存储位置」里的当前根', tip: '只影响「控制台读哪份库」，不影响工具写入。工具始终写到「存储位置」里的当前根；两边可以指向不同目录——看起来「数据不一致」时先来这里检查。' },
    { key: 'graphPalette', label: '关系图配色', type: 'enum', values: ['dsh', 'codex', 'universe', 'cosmos', 'cyberpunk', 'aurora', 'blackgold', 'steampunk', 'qingmo', 'minimal', 'lava'], labels: { dsh: '跟随当前主题', codex: '默认主题', universe: '超能量体', cosmos: '宇宙', cyberpunk: '赛博朋克', aurora: '极光空灵', blackgold: '黑金科幻', steampunk: '蒸汽复古', qingmo: '青墨国风', minimal: '极简冷科技', lava: '熔岩炽热' }, tip: '「默认主题」是蓝紫星辰，首次安装/未选择时使用；之后改过哪个就记住哪个。「跟随当前主题」实时读当前主题的渐变。' },
    { key: 'graphSurface', label: '关系图背景', type: 'enum', values: ['theme', 'light', 'dark'], labels: { theme: '跟随主题', light: '浅色', dark: '深色' }, tip: '关系图画布的背景深浅。跟随主题＝透明，用页面本来的底色；浅色/深色会铺一层固定底色，同时把节点的明暗补偿一起切过去。图左下角的胶囊也能直接切。' },
    { key: 'graphRotation', label: '自动旋转速度', type: 'number', hint: '弧度/秒，0 为关闭', tip: '关系图自动旋转的速度（弧度/秒）；0 = 不转。拖动时暂停，松手继续。' },
    { key: 'graphBloom', label: '泛光 bloom', type: 'boolean', tip: '给亮节点叠一层柔光，暗色主题下更明显；关掉更省绘制。' },
    { key: 'graphGlitch', label: '色散/毛刺', type: 'boolean', tip: '给高亮节点/连线加一点 RGB 分离的故障感；关掉更干净。' },
    { key: 'graphDust', label: '浮尘数量', type: 'number', hint: '0~240', tip: '背景里漂浮的尘埃粒子数量（0~240）；太吃性能就调低。' },
  ],
  git: [
    { key: 'repoUrl', label: '远端仓库', type: 'string', hint: 'https://… 或 git@host:path 或本机绝对路径', tip: '经验库会以这个仓库为备份目标。https 推公开/私有仓库都行；地址里不要写账号密码，token 填在下面。' },
    { key: 'branch', label: '分支', type: 'string', hint: '默认 main', tip: '推送到哪个分支；不存在会自动建。' },
    { key: 'pushStrategy', label: '推送策略', type: 'enum', values: ['ask', 'overwrite', 'fast-forward'], labels: { ask: '检测到远端有新提交时问我（默认）', overwrite: '直接本地覆盖云端', 'fast-forward': '只允许快进' }, tip: '本地覆盖云端：远端有本机没有的提交时直接用本机强推（覆盖前会把旧远端 HEAD 存到本地的 refs/engram/overwritten/*，还能捞回来）。只允许快进：分叉就报错、交回人处理。经验库是本机资产、云端只是备份，所以默认本地赢。' },
    { key: 'token', label: '访问 token（可选）', type: 'string', hint: '设备登录成功后自动填；也可手动贴 PAT', tip: '优先用上面的「用 GitHub 登录」（设备码，免 token）。这里只作后备：手动贴 GitHub PAT（classic 勾 repo），或设备登录后自动写入。它只存在本机 ~/.dsh/engram/settings.json，推送时走 http.extraHeader，错误信息里打码。' },
    { key: 'authorName', label: '提交作者名', type: 'string', hint: '留空用全局 git 身份', tip: '写进 commit 的作者名；留空就用你机器上的 git 全局配置。' },
    { key: 'authorEmail', label: '提交作者邮箱', type: 'string', hint: '留空用全局 git 身份', tip: '写进 commit 的邮箱；留空用全局 git 配置。' },
    { key: 'autoBackupMinutes', label: '自动备份间隔（分钟）', type: 'number', hint: '0 = 关闭；最小 15', tip: '开启后插件会按这个间隔自动 commit + push（没有改动就跳过）。0 表示只手动推送；最小 15 分钟，避免频繁推。' },
  ],
}

function sanitizeSettings(input, fields) {
  const out = {}
  for (const field of fields) {
    if (input === null || typeof input !== 'object' || !Object.prototype.hasOwnProperty.call(input, field.key)) continue
    const value = input[field.key]
    if (field.type === 'boolean') out[field.key] = value === true
    else if (field.type === 'number') {
      const number = Number(value)
      out[field.key] = Number.isFinite(number) && value !== '' && value !== null ? number : null
    } else if (field.type === 'enum') {
      out[field.key] = field.values.includes(String(value)) ? String(value) : null
    } else {
      out[field.key] = value !== null && value !== undefined && String(value).trim() !== '' ? String(value).trim() : null
    }
  }
  return out
}

let cachedVersion = ''
/** 插件版本：读包根 package.json（老布局回退到 ui/package.json），读不到用 0.0.0。 */
export function pluginVersion() {
  if (cachedVersion !== '') return cachedVersion
  for (const url of [new URL('../package.json', import.meta.url), new URL('./package.json', import.meta.url)]) {
    try {
      const raw = JSON.parse(fs.readFileSync(url, 'utf8'))
      if (typeof raw.version === 'string' && raw.version !== '') {
        cachedVersion = raw.version
        return cachedVersion
      }
    } catch {
      // 试下一个位置
    }
  }
  cachedVersion = '0.0.0'
  return cachedVersion
}

/** 客户端半最近一次回打（诊断用；每次插件重载清空）。 */
let clientProbes = []

/** 设备码登录的临时会话（只存在内存，不落盘；成功换到 token 才写 settings）。 */
let deviceSession = null

/** 打开系统浏览器（尽力而为，失败不影响登录流程）。 */
function openExternal(url) {
  try {
    const command = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open'
    const child = spawn(command, [url], { detached: true, stdio: 'ignore', windowsHide: true })
    child.unref()
    return true
  } catch {
    return false
  }
}

/** 把验证码写进系统剪贴板（Windows 用 clip.exe；其他平台尽力而为）。 */
function copyToClipboard(text) {
  return new Promise((resolve) => {
    try {
      const command = process.platform === 'win32' ? 'clip' : process.platform === 'darwin' ? 'pbcopy' : 'xclip'
      const args = process.platform === 'linux' ? ['-selection', 'clipboard'] : []
      const child = spawn(command, args, { windowsHide: true })
      child.on('error', () => resolve(false))
      child.on('close', (code) => resolve(code === 0))
      child.stdin.end(text)
    } catch {
      resolve(false)
    }
  })
}

/** 同一 config 复用同一个 data source（mock 的反馈状态才不会每请求丢一次）。 */
const sources = new Map()

function withUiConfig(config = {}) {
  const ui = readUiConfig()
  const merged = { ...config }
  if (ui.source !== undefined) merged.source = ui.source
  if (ui.dataDir !== undefined) merged.dataDir = ui.dataDir
  return merged
}

export function sourceKeyOf(config = {}) {
  const merged = withUiConfig(config)
  const mode = String(merged.source || 'live').toLowerCase() === 'mock' ? 'mock' : 'live'
  return `${mode}|${mode === 'live' ? resolveLiveDataDir(merged) : ''}`
}

/** 按 config 取 data source。 */
export function createSource(config = {}) {
  const effective = withUiConfig(config)
  const key = sourceKeyOf(effective)
  const existing = sources.get(key)
  if (existing !== undefined) return existing
  const mode = String(effective.source || 'live').toLowerCase() === 'mock' ? 'mock' : 'live'
  const source = mode === 'live' ? createLiveSource(effective) : createMockSource()
  sources.set(key, source)
  return source
}

/** 测试用：清掉 source 缓存（包括 mock 反馈状态）。 */
export function resetSourceCache() {
  sources.clear()
}

/** 安全取用法日志：任何异常都当空。 */
function safeUsage(source, limit) {
  try {
    const rows = source.usageRows(limit)
    return Array.isArray(rows) ? rows : []
  } catch {
    return []
  }
}

/** 安全取固化技能：读不到 / 读坏都当空。 */
function metaOf(source) {
  const src = source && typeof source === 'object' ? source : {}
  return { id: src.id, mode: src.mode, label: src.label, readOnly: src.readOnly === true }
}

function readOf(source) {
  if (!source || typeof source.read !== 'function') return {}
  try {
    return source.read() || {}
  } catch {
    return {}
  }
}

/**
 * 取整库行，并把「读失败」作为结构化错误带出来（X3）。
 *
 * 为什么不让 storeOf 自己抛：列表/关系图要照常渲染（空页 + 横幅），只有详情页需要 503。
 * 所以这里统一成 `{ store, error }`：调用方自己决定是显示横幅还是回 503。
 */
function storeReadOf(source) {
  if (source && typeof source.hot === 'function') {
    try {
      const hot = source.hot()
      if (hot && hot.store && typeof hot.store === 'object') {
        return { store: hot.store, error: hot.error === undefined ? null : hot.error }
      }
    } catch (error) {
      return { store: emptyStore(), error: storeErrorOf(error, source) }
    }
  }
  const read = readOf(source)
  if (read.store && typeof read.store === 'object') return { store: read.store, error: null }
  return { store: emptyStore(), error: null }
}

/** 把任意读取异常翻成统一错误形状（code/message/file）；不再向上抛。 */
function storeErrorOf(error, source) {
  const read = readOf(source)
  return {
    code: 'store-unreadable',
    message: String((error && error.message) || error),
    file: String(read.file || ''),
  }
}

/** 取整库行（页面级）：live 的 read() 只给 manifest/storage（P3-A），行走 `hot()`。语义不变。 */
function storeOf(source) {
  return storeReadOf(source).store
}

function safeSkills(source) {
  try {
    const rows = source && typeof source.skills === 'function' ? source.skills() : []
    // 行数据畸形（null/缺 slug）不能把整个技能页打崩：过滤掉，页面照常渲染。
    return Array.isArray(rows)
      ? rows.filter((row) => row && typeof row === 'object' && (typeof row.slug === 'string' || typeof row.id === 'string'))
      : []
  } catch {
    return []
  }
}

/** 技能状态分布（给面板顶部与页签用）。 */
function skillSummaryOf(rows) {
  const summary = { total: rows.length, solid: 0, trial: 0, risky: 0, new: 0, blocked: 0 }
  for (const row of rows) {
    if (summary[row.status] !== undefined) summary[row.status] += 1
  }
  return summary
}

/** 从 manifest 的桶/簇/统计算 `/state` 的 totals（G6；字段名兼容几种写法）。 */
function totalsOfManifest(manifest, types, skills) {
  const stats = manifest && manifest.stats !== null && typeof manifest.stats === 'object' ? manifest.stats : {}
  const buckets = Array.isArray(manifest && manifest.buckets) ? manifest.buckets : []
  const all = buckets.reduce((sum, bucket) => sum + (Number(bucket && bucket.count) || 0), 0)
  const visible = types.reduce((sum, type) => sum + (Number(type.count) || 0), 0)
  const numberOr = (keys, fallback) => {
    for (const key of keys) {
      const value = Number(stats[key])
      if (Number.isFinite(value)) return value
    }
    return fallback
  }
  return {
    all: numberOr(['all', 'total'], all),
    visible: numberOr(['visible'], visible),
    deleted: numberOr(['deleted', 'deletedInsights'], 0),
    superseded: numberOr(['superseded', 'supersededInsights'], 0),
    retired: numberOr(['retired', 'retiredInsights'], 0),
    types: types.length,
    skills: skills.length,
  }
}

/** 概览（`/state` 的 data）：有 manifest.stats 时只读 manifest（P3-A），否则退回全量行。 */
export function buildState(source) {
  const read = readOf(source)
  const manifest = read.manifest !== null && typeof read.manifest === 'object' ? read.manifest : null
  const storage = read.storage !== null && typeof read.storage === 'object' ? read.storage : null
  const skills = safeSkills(source)
  const bytes = Number(read.bytes) || (storage === null ? 0 : Number(storage.totalBytes) || 0)
  let cold = null
  if (source !== null && source !== undefined && typeof source.cold === 'function') {
    try {
      cold = source.cold()
    } catch (error) {
      // 冷档读坏不能让概览整页打不开：保留明确错误给界面显示。
      cold = { years: [], total: 0, samples: [], error: String((error && error.message) || error) }
    }
  }
  const base = {
    app: APP_NAME,
    version: pluginVersion(),
    source: metaOf(source),
    dataDir: String(read.dataDir || ''),
    file: String(read.file || ''),
    exists: Boolean(read.exists),
    bytes,
    updatedAt: read.updatedAt === null || read.updatedAt === undefined ? '' : String(read.updatedAt),
    notice: String(read.notice || ''),
    ...(storage !== null ? { storage } : {}),
    ...(cold !== null ? { cold } : {}),
    feedbackEta: FEEDBACK_ETA,
    skillSummary: skillSummaryOf(skills),
    usage: usageSummary(safeUsage(source, 500)),
  }
  if (manifest !== null && manifest.stats !== null && typeof manifest.stats === 'object') {
    const types = typesOfManifest(manifest)
    return {
      ...base,
      totals: totalsOfManifest(manifest, types, skills),
      stats: statsOfManifest(manifest, bytes),
      types,
    }
  }
  // 没有 manifest / G6 未落地 / mock：退回全量行，行为与 0.13.0 一致（不静默改语义）。
  const store = storeOf(source)
  const experiences = Array.isArray(store.experiences) ? store.experiences : []
  const types = typesOf(store)
  const stats = statsOf(store)
  return {
    ...base,
    totals: {
      all: experiences.length,
      visible: stats.totalInsights,
      deleted: experiences.filter((item) => item.deleted_at).length,
      superseded: experiences.filter((item) => item.superseded_by).length,
      retired: experiences.filter((item) => item.retired_at).length,
      types: types.length,
      skills: skills.length,
    },
    stats: { ...stats, dbSizeBytes: bytes },
    types,
  }
}

/** 类型目录：有 manifest 时只读 manifest（P3-A），否则退回整库行。 */
function typeListOf(source, read = readOf(source)) {
  if (read && read.manifest !== null && typeof read.manifest === 'object') {
    const types = typesOfManifest(read.manifest)
    if (types.length > 0) return types
  }
  return typesOf(storeOf(source))
}

/** `/experiences` 的 data。 */
export function buildExperiences(source, params) {
  const read = readOf(source)
  const storeRead = storeReadOf(source)
  const query = String((params && typeof params.get === 'function' ? params.get('query') : '') || '').trim()
  const meta = {
    source: metaOf(source),
    notice: String(read.notice || ''),
    storeError: storeRead.error,
  }
  if (query !== '') {
    const limit = numberParam(params && typeof params.get === 'function' ? params.get('limit') : null, 8, 50)
    if (source && typeof source.recall === 'function') {
      const recalled = source.recall({ intent: query, limit })
      return { ...meta, ...recalled, query }
    }
    return { ...meta, ...recallOf(storeRead.store, query, limit) }
  }
  return { ...meta, ...listOf(storeRead.store, params || new URLSearchParams()) }
}

/** `/experience` 的 data；找不到返回 null；坏档抛 store-unreadable（路由回 503）。 */
export function buildExperience(source, id) {
  const storeRead = storeReadOf(source)
  if (storeRead.error !== null) throw codedError('store-unreadable', storeRead.error.message)
  return detailOf(storeRead.store, id)
}

/** `/feedback` 的 data：delegates 到 data source（live 会抛 read-only）。 */
export function buildFeedback(source, id, result) {
  return source.feedback(id, result)
}

/** `/pending` 的 data：待判定队列（最多 5 条）。 */
export function buildPending(source) {
  return source && typeof source.pending === 'function' ? source.pending(5) : []
}

/** `/verdicts` 的 data：把回填交给 source（逐条返回 ok/失败原因）。 */
export function buildVerdicts(source, list) {
  if (!source || typeof source.verdicts !== 'function') throw new Error('当前数据源不支持判定回填')
  return source.verdicts(Array.isArray(list) ? list : [])
}

/** `/usage-summary` 的 data：调用次数与回执字符数汇总（token 账）。 */
export function buildUsageSummary(source) {
  return source && typeof source.usageSummary === 'function'
    ? source.usageSummary()
    : { calls: 0, chars: 0, avgChars: 0, byTool: {} }
}

function treeOrderOf(node) {
  if (node.skill) return Number(node.skill.order) || 0
  return node.children.reduce((max, child) => Math.max(max, treeOrderOf(child)), 0)
}

/** 把内核树节点转成给界面的轻量节点（不把整行 skill 对象塞进去）。 */
function publicTreeNode(node, rootName) {
  const root = rootName || node.path
  const skill = node.skill
  return {
    id: node.path,
    path: node.path,
    name: skill ? skill.name : node.name,
    kind: node.kind,
    depth: node.depth,
    rootName: root,
    parentPath: node.depth > 0 ? node.path.slice(0, node.path.lastIndexOf('/')) : '',
    skillCount: node.skillCount,
    registeredCount: node.registeredCount,
    childCount: Math.max(0, node.skillCount - (skill ? 1 : 0)),
    children: node.children.map((child) => publicTreeNode(child, root)),
  }
}

/** 技能行补上树上的位置信息（path/depth/rootName/childCount）。 */
function decorateSkillRows(tree, rows) {
  const info = new Map()
  const visit = (node, root) => {
    if (node.skill) {
      info.set(node.path, {
        path: node.path,
        depth: node.depth,
        rootName: root,
        parentPath: node.depth > 0 ? node.path.slice(0, node.path.lastIndexOf('/')) : '',
        childCount: Math.max(0, node.skillCount - 1),
      })
    }
    for (const child of node.children) visit(child, root)
  }
  for (const node of tree) visit(node, node.path)
  return rows.map((row) => ({ ...row, ...(info.get(row.id) || { path: row.id }) }))
}

/** `/skills` 的 data：固化技能列表 + 状态分布 + 目录树。 */
export function buildSkills(source) {
  const read = readOf(source)
  const rows = safeSkills(source)
  const tree = buildSkillTree(rows)
  tree.sort((left, right) => treeOrderOf(right) - treeOrderOf(left) || left.name.localeCompare(right.name, 'zh'))
  return {
    source: metaOf(source),
    notice: String(read.notice || ''),
    total: rows.length,
    summary: skillSummaryOf(rows),
    skills: decorateSkillRows(tree, rows),
    tree: tree.map((node) => publicTreeNode(node)),
  }
}

/**
 * 控制台动作：召回 / 记录 / 沉淀 / 类型 / 校验 / 设置。
 * live 交给 kernel engine；mock 能做记录与简化召回，其余明确「示例模式不支持」。
 */
export function buildRecall(source, body = {}) {
  if (!source || typeof source.recall !== 'function') throw new Error('当前数据源不支持检索')
  const intent = String(body.intent || '').trim()
  if (intent === '') throw codedError('intent-required', '缺少 intent')
  const limit = Math.max(1, Math.min(50, Math.trunc(Number(body.limit) || 8)))
  const context = Array.isArray(body.context) ? body.context.map(String) : []
  const args = { intent, limit, context }
  // A4：高级参数原样透传（undefined 不传，否则会覆盖内核默认值）。
  for (const key of RECALL_PASSTHROUGH_KEYS) {
    if (body[key] !== undefined) args[key] = body[key]
  }
  return source.recall(args)
}

export function buildRecord(source, body = {}) {
  if (!source || typeof source.record !== 'function') throw codedError('read-only', '当前数据源不支持写入经验')
  return source.record(body)
}

export function buildConsolidate(source, body = {}) {
  const intent = String(body.intent || '').trim()
  if (intent === '') throw codedError('intent-required', '缺少 intent')
  if (typeof source.consolidate !== 'function') throw codedError('unsupported', '当前数据源不支持沉淀')
  return source.consolidate({ intent, context: Array.isArray(body.context) ? body.context.map(String) : [] })
}

/** 一个目录「是经验库」的判定文件：分片布局 / 旧单文件 / 迁移留档 / 分片目录。 */
const LIBRARY_MARKERS = ['manifest.json', 'exp-lib.json', 'exp-lib.legacy.json', 'buckets']

/** 这个目录里有没有经验库的痕迹。 */
function looksLikeLibrary(dir) {
  try {
    return LIBRARY_MARKERS.some((name) => fs.existsSync(path.join(dir, name)))
  } catch {
    return false
  }
}

/**
 * 把「人选的文件夹」翻成「经验库根」。
 *
 * 经验库根就是含 `exp-lib.json` / `manifest.json` 的那个目录。人选到它的父级
 * （例如 `C:/Users/yh/WorkDeepSeek`）时，别在他那儿另起一份空库——顺手用里面的 `.exp`。
 */
export function resolvePickedDirectory(picked) {
  const dir = String(picked || '').trim()
  if (dir === '') return { path: '', note: '' }
  if (looksLikeLibrary(dir)) return { path: dir, note: '' }
  const nested = path.join(dir, '.exp')
  if (looksLikeLibrary(nested)) return { path: nested, note: '用的是该文件夹下的 .exp' }
  return { path: dir, note: '这里还没有经验库，选它等于从这个文件夹新建一份空库' }
}

/**
 * 宿主给的目录选择能力，能弹系统窗口就返回选目录方法，否则抛出原因。
 *
 * @param deps - `getDirectoryPicker()`：可选，返回宿主的目录选择服务。
 * @returns {{ pick: (signal?: AbortSignal) => Promise<string|null>, kind: string }}
 */
function nativePickerOf(deps = {}) {
  const picker = typeof deps.getDirectoryPicker === 'function' ? deps.getDirectoryPicker() : null
  if (picker === null || picker === undefined) {
    throw codedError('picker-unavailable', '这个宿主没有系统目录选择器（桌面版才有），请手动填路径')
  }
  const capability = typeof picker.capability === 'function' ? picker.capability() : null
  if (capability === null || capability === undefined || capability.kind !== 'native') {
    const kind = capability && capability.kind ? String(capability.kind) : '未知'
    throw codedError('picker-unavailable', `当前目录选择器是 ${kind} 版，打不开系统窗口，请手动填路径`)
  }
  return { pick: (signal) => capability.pick(signal), kind: 'native' }
}

/**
 * 只读探针：这个宿主能不能弹系统选目录窗口（不弹，只回答）。
 * 界面「?」与出问题时自查都用它——别靠点一下猜。
 */
export function describeDirectoryPicker(deps = {}) {
  try {
    const picker = nativePickerOf(deps)
    return { available: true, kind: picker.kind, message: '能弹系统选目录窗口' }
  } catch (error) {
    return { available: false, kind: null, message: String((error && error.message) || error) }
  }
}

/**
 * 在宿主屏幕上弹系统自带的选目录窗口，返回人选的那个路径（取消则 null）。
 *
 * 用的是宿主自己的 `ctx.directoryPicker`（桌面版是 Windows 的 IFileOpenDialog，
 * 跟「选工作区目录」是同一个窗口）。远程浏览器那种组合只有 browse 能力，
 * 这里如实拒绝，让界面退回手填路径，不假装弹出过窗口。
 *
 * @param deps - `getDirectoryPicker()`：可选，返回宿主的目录选择服务。
 * @param signal - 调用方生命周期；中止就关掉窗口。
 */
export async function pickDirectory(deps = {}, signal) {
  const picker = nativePickerOf(deps)
  const picked = await picker.pick(signal)
  if (picked === null || picked === undefined || String(picked).trim() === '') return { path: null, canceled: true, note: '' }
  return { canceled: false, ...resolvePickedDirectory(picked) }
}

/**
 * `/skills/import` 的 data：把一条外部技能文本导进来。
 *
 * 分类 / 标签 / 排序由 `deps.getLlm` / `deps.getRoute` 提供的临时模型会话算；
 * 宿主没有模型服务时 kernel 会退回本地关键词归类，并如实回 classifier='local'。
 * 所以前端必须把 classifier 与 note 原样展示，不能假装算过。
 */
export async function buildImportSkill(source, body = {}, deps = {}) {
  if (source.mode !== 'live') throw codedError('unsupported', '示例数据不支持导入技能')
  const read = readOf(source)
  const dataDir = String(read.dataDir || '')
  if (dataDir === '') throw codedError('no-data-dir', '没有数据目录，无法写入技能')
  const typeNames = typeListOf(source, read).map((type) => String(type.name || '')).filter((name) => name !== '')
  const filePath = String(body.path || '').trim()
  const content = typeof body.content === 'string' ? body.content : ''
  const categories = Array.isArray(body.categories) ? body.categories.map(String) : []
  const notes = Array.isArray(body.notes) ? body.notes.map(String) : []
  // 套件导入走 contents 数组（浏览器选文件夹/多选 SKILL.md）：字符串或 {text, suiteRoot, relPath} 都收。
  let contents = Array.isArray(body.contents)
    ? body.contents.filter((item) => {
      if (typeof item === 'string') return item.trim() !== ''
      if (item && typeof item === 'object') return String(item.text || item.content || '').trim() !== ''
      return false
    })
    : []
  // 兼容客户端另一种写法：顶层给 suiteRoot/relPath + 单条 content。
  const suiteRoot = String(body.suiteRoot || '').trim()
  const relPath = String(body.relPath || '').trim()
  if (contents.length === 0 && content.trim() !== '' && (suiteRoot !== '' || relPath !== '')) {
    contents = [{ text: content, suiteRoot, relPath }]
  }
  if (filePath === '' && content.trim() === '' && contents.length === 0) {
    throw codedError('source-required', '要么拖入/选择 SKILL.md，要么粘贴正文')
  }
  return importSkills({ dataDir, filePath, content, contents, typeNames, categories, notes, deps })
}

export function buildSkillFeedback(source, body = {}) {
  const slug = String(body.slug || '').trim()
  const result = String(body.result || '').trim().toLowerCase()
  if (slug === '') throw codedError('slug-required', '缺少技能 slug')
  if (!['helped', 'hurt', 'neutral'].includes(result)) throw codedError('bad-result', 'result 只能是 helped / hurt / neutral')
  if (typeof source.skillFeedback !== 'function') throw codedError('unsupported', '当前数据源不支持技能反馈')
  return source.skillFeedback(slug, result)
}

export function buildTypeOp(source, body = {}) {
  if (!source || typeof source.typeOp !== 'function') throw codedError('unsupported', '当前数据源不支持类型管理')
  return source.typeOp(body)
}

export function buildValidate(source) {
  if (!source || typeof source.validate !== 'function') return { problems: [] }
  return { problems: source.validate() }
}

export function buildSettings(source) {
  const read = readOf(source)
  const extra = source && typeof source.settings === 'function' ? source.settings() : {}
  const storage = read.storage !== null && typeof read.storage === 'object' ? read.storage : null
  return {
    source: metaOf(source),
    dataDir: String(read.dataDir || ''),
    file: String(read.file || ''),
    exists: Boolean(read.exists),
    bytes: Number(read.bytes) || (storage === null ? 0 : Number(storage.totalBytes) || 0),
    updatedAt: read.updatedAt === null || read.updatedAt === undefined ? '' : String(read.updatedAt),
    ...(storage !== null ? { storage } : {}),
    currentRoot: String(extra.currentRoot || ''),
    version: pluginVersion(),
  }
}

/** 关系图 summary 模式的默认/上限经验条数（0.19.0）。 */
export const GRAPH_SUMMARY_LIMIT = 300
export const GRAPH_SUMMARY_LIMIT_MAX = 1200

/**
 * 解析 `/graph` 的 `scope` / `limit`。
 *
 * 兼容性优先：不带 `scope=summary` 时一律全量（旧 client 只认全量，不能因为
 * 顺手加的 `limit` 参数就悄悄变少）。`limit` 只在 summary 下生效，非法值退回
 * 默认 300，越界夹到 1..1200（`limit=0` 也按 1 处理，避免返回 0 个经验节点）。
 */
function graphOptionsOf(params) {
  const get = (key) => (params && typeof params.get === 'function' ? params.get(key) : null)
  const summary = String(get('scope') || '').trim().toLowerCase() === 'summary'
  return { summary, limit: summary ? graphLimitOf(get('limit')) : Infinity }
}

function graphLimitOf(raw) {
  if (raw === null || raw === undefined || String(raw).trim() === '') return GRAPH_SUMMARY_LIMIT
  const parsed = Math.trunc(Number(raw))
  if (!Number.isFinite(parsed)) return GRAPH_SUMMARY_LIMIT
  return Math.min(GRAPH_SUMMARY_LIMIT_MAX, Math.max(1, parsed))
}

/** 经验节点排序：weight 降序，其次 recent，再按 lastSeenAt 降序（全量模式不动原顺序）。 */
function rankGraphExperiences(rows) {
  return rows
    .map((row) => {
      const lastSeen = Date.parse(String(row.lastSeenAt || row.ts || '')) || 0
      return {
        row,
        lastSeen,
        recent: lastSeen > 0 && Date.now() - lastSeen < 7 * 24 * 3600 * 1000,
        weight: Math.min(1, 0.3 + Math.abs(Number(row.G) || 0) * 0.35),
      }
    })
    .sort((left, right) => right.weight - left.weight
      || Number(right.recent) - Number(left.recent)
      || right.lastSeen - left.lastSeen)
}

/** 关系图数据：根 → 类型 → 经验 → 技能（derivedFrom）。 */
export function buildGraph(source, params) {
  const read = readOf(source)
  const storeRead = storeReadOf(source)
  const store = storeRead.store
  const rows = visibleOf(store).map(rowOf)
  const options = graphOptionsOf(params)
  // summary 只裁经验：root/type/skill/suite 全留，保证图骨架不塌。
  const keptRows = options.summary ? rankGraphExperiences(rows).slice(0, options.limit).map((entry) => entry.row) : rows
  const types = typesOf(store)
  const skills = source && typeof source.skills === 'function' ? (source.skills() || []) : []
  const nodes = [{ id: 'root', kind: 'root', label: '经验库' }]
  const edges = []
  const knownTypes = new Set()
  for (const type of types) {
    nodes.push({ id: `type:${type.id}`, kind: 'type', label: type.name, count: type.count || 0, weight: Math.min(1, 0.35 + (type.count || 0) / 12), system: type.system === true })
    edges.push({ source: 'root', target: `type:${type.id}`, kind: 'root', strength: 0.3 + Math.min(0.4, (type.count || 0) / 30) })
    knownTypes.add(type.id)
  }
  const expIds = new Set()
  for (const row of keptRows) {
    const typeId = row.typeId || 'ty_other'
    if (!knownTypes.has(typeId)) {
      nodes.push({ id: `type:${typeId}`, kind: 'type', label: row.typeName || '未分类', count: 0 })
      edges.push({ source: 'root', target: `type:${typeId}`, kind: 'root' })
      knownTypes.add(typeId)
    }
    const lastSeen = Date.parse(String(row.lastSeenAt || row.ts || '')) || 0
    nodes.push({ id: `exp:${row.id}`, kind: 'experience', label: row.intent || row.action || row.id, action: row.action || '', outcome: row.outcome, G: row.G, typeId, lastSeenAt: row.lastSeenAt || row.ts || '', weight: Math.min(1, 0.3 + Math.abs(Number(row.G) || 0) * 0.35), recent: lastSeen > 0 && Date.now() - lastSeen < 7 * 24 * 3600 * 1000 })
    edges.push({ source: `type:${typeId}`, target: `exp:${row.id}`, kind: 'type', strength: 0.25 + Math.min(0.5, Math.abs(Number(row.G) || 0) * 0.25) })
    expIds.add(row.id)
  }
  // 次级分类关系：同标签的经验连一条虚线，不新增节点；标签复用后图上能看出它们的关系。
  const labelMembers = new Map()
  for (const row of keptRows) {
    for (const tag of Array.isArray(row.context) ? row.context : []) {
      const name = String(tag || '').trim()
      if (name === '') continue
      const list = labelMembers.get(name) || []
      list.push(row.id)
      labelMembers.set(name, list)
    }
  }
  let labelEdges = 0
  for (const [name, ids] of labelMembers) {
    if (ids.length < 2 || ids.length > 6 || labelEdges >= 120) continue
    for (let index = 1; index < ids.length; index += 1) {
      edges.push({ source: `exp:${ids[0]}`, target: `exp:${ids[index]}`, kind: 'label', label: name, strength: 0.18 })
      labelEdges += 1
      if (labelEdges >= 120) break
    }
  }
  const skillTree = buildSkillTree(skills)
  const skillNodes = new Map()
  const walkSkill = (node, parentId) => {
    const id = node.kind === 'group' ? `suite:${node.path}` : `skill:${node.path}`
    if (node.kind === 'group') {
      nodes.push({
        id,
        kind: 'suite',
        label: node.name,
        path: node.path,
        parent: parentId || '',
        depth: node.depth,
        count: node.skillCount,
        weight: Math.min(1, 0.5 + node.skillCount / 20),
      })
    } else {
      const skill = node.skill
      const skillNode = {
        id,
        kind: 'skill',
        label: skill.name,
        path: node.path,
        parent: parentId || '',
        depth: node.depth,
        childCount: node.childCount,
        status: skill.status,
        uses: skill.uses || 0,
        helped: skill.helped || 0,
        hurt: skill.hurt || 0,
        weight: Math.min(1, 0.45 + (skill.uses || 0) / 12),
      }
      nodes.push(skillNode)
      skillNodes.set(node.path, skillNode)
    }
    // 顶层挂根；套件内部挂父节点（总技能或组节点），这样图上能看出母子关系。
    edges.push({
      source: parentId || 'root',
      target: id,
      kind: parentId === '' ? 'root' : 'suite',
      strength: parentId === '' ? 0.55 : 0.9,
    })
    for (const child of node.children) walkSkill(child, id)
  }
  for (const rootNode of skillTree) walkSkill(rootNode, '')
  for (const skill of skills) {
    const id = String(skill.id || '')
    const node = skillNodes.get(id)
    if (!node) continue
    const derived = Array.isArray(skill.derivedFrom) ? skill.derivedFrom : []
    const linked = derived.filter((experienceId) => expIds.has(String(experienceId)))
    for (const experienceId of linked) edges.push({ source: `exp:${experienceId}`, target: `skill:${id}`, kind: 'derived', strength: 0.5 + Math.min(0.45, (skill.uses || 0) / 12) })
    // 独立技能没有经验来源时仍然挂根；套件子技能已有父边，不再重复挂根。
    if (linked.length === 0 && !String(id).includes('/')) edges.push({ source: 'root', target: `skill:${id}`, kind: 'derived', strength: 0.55 })
  }
  const suiteRoots = skillTree.filter((node) => node.kind === 'group' || node.skillCount > 1).length
  // degree 用一遍边表累加（O(N+E)）：前端画图不用再自己数邻居。
  const degree = new Map()
  for (const edge of edges) {
    degree.set(edge.source, (degree.get(edge.source) || 0) + 1)
    degree.set(edge.target, (degree.get(edge.target) || 0) + 1)
  }
  const byKind = {}
  for (const node of nodes) {
    node.degree = degree.get(node.id) || 0
    byKind[node.kind] = (byKind[node.kind] || 0) + 1
  }
  return {
    notice: String(read.notice || ''),
    storeError: storeRead.error,
    nodes,
    edges,
    // total/truncated 只描述「经验」：summary 裁的就是经验，骨架节点不裁。
    total: rows.length,
    truncated: keptRows.length < rows.length,
    byKind,
    summary: { types: types.length, experiences: rows.length, skills: skills.length, suites: suiteRoots },
    updatedAt: String(read.updatedAt || ''),
  }
}

/** 统一 JSON 回执。 */
function json(res, status, payload) {
  const body = JSON.stringify(payload)
  if (typeof res.setHeader === 'function') {
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
  }
  res.end(body)
}

function fail(res, status, code, message, details) {
  return json(res, status, { ok: false, error: { code, message, ...(details === undefined ? {} : { details }) } })
}

/** 读请求体（上限 1MB）。 */
async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 1024 * 1024) throw codedError('body-too-large', '请求体超过 1MB')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  return text.trim() === '' ? {} : JSON.parse(text)
}

/** 处理一条请求；测试可直接调用（不必起宿主）。 */
export async function handleRequest(req, res, source, deps = {}) {
  try {
    const url = new URL(req.url || '/', 'http://dsh.internal')
    const route = url.pathname.slice(API_PREFIX.length) || '/'
    const method = String(req.method || 'GET').toUpperCase()
    const active = source || createSource({})

    if (route === '/icons') {
      if (method !== 'GET') return fail(res, 405, 'method-not-allowed', '只用 GET')
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(galleryHtml())
      return
    }
    if (route === '/health') {
      if (method !== 'GET') return fail(res, 405, 'method-not-allowed', '只用 GET')
      // 客户端半加载后会带 ?client=1 回打一次：用来区分「客户端没加载」与「加载了但没注册」。
      if (url.searchParams.get('client') === '1') {
        clientProbes.push({
          at: new Date().toISOString(),
          phase: String(url.searchParams.get('phase') || ''),
          id: String(url.searchParams.get('id') || ''),
          panels: Number(url.searchParams.get('panels')) || 0,
          errors: String(url.searchParams.get('errors') || ''),
          note: String(url.searchParams.get('note') || '').slice(0, 500),
        })
        if (clientProbes.length > 8) clientProbes = clientProbes.slice(-8)
      }
      return json(res, 200, {
        ok: true,
        data: {
          ok: true,
          app: APP_NAME,
          version: pluginVersion(),
          source: active.id,
          readOnly: active.readOnly === true,
          client: clientProbes,
        },
      })
    }
    if (route === '/state') {
      if (method !== 'GET') return fail(res, 405, 'method-not-allowed', '只用 GET')
      return json(res, 200, { ok: true, data: buildState(active) })
    }
    if (route === '/experiences') {
      if (method !== 'GET') return fail(res, 405, 'method-not-allowed', '只用 GET')
      return json(res, 200, { ok: true, data: buildExperiences(active, url.searchParams) })
    }
    if (route === '/experience') {
      if (method !== 'GET') return fail(res, 405, 'method-not-allowed', '只用 GET')
      const id = String(url.searchParams.get('id') || '').trim()
      if (id === '') return fail(res, 400, 'id-required', '缺少 id 参数')
      const detail = buildExperience(active, id)
      if (detail === null) return fail(res, 404, 'not-found', `没有这条经验：${id}`)
      return json(res, 200, { ok: true, data: detail })
    }
    if (route === '/cold') {
      if (method !== 'GET') return fail(res, 405, 'method-not-allowed', '只用 GET')
      const offset = numberParam(url.searchParams.get('offset'), 0, Number.MAX_SAFE_INTEGER)
      const limit = numberParam(url.searchParams.get('limit'), 50, 500)
      const query = String(url.searchParams.get('query') || '')
      const yearRaw = url.searchParams.get('year')
      const year = yearRaw === null || String(yearRaw).trim() === '' || !Number.isFinite(Number(yearRaw))
        ? null
        : Math.trunc(Number(yearRaw))
      let result = { years: [], total: 0, rows: [] }
      try {
        if (active && typeof active.coldRows === 'function') result = active.coldRows({ offset, limit, query, year })
      } catch (error) {
        // 冷档文件缺失/坏行：明确 500，不把「丢了」显示成「没有」。
        return fail(res, 500, 'cold-unreadable', String((error && error.message) || error))
      }
      const years = Array.isArray(result.years) ? result.years : []
      return json(res, 200, {
        ok: true,
        data: {
          source: metaOf(active),
          notice: '',
          exists: years.length > 0,
          total: Number(result.total) || 0,
          offset,
          limit,
          years,
          rows: Array.isArray(result.rows) ? result.rows : [],
          error: null,
        },
      })
    }
    if (route === '/types') {
      if (method !== 'GET') return fail(res, 405, 'method-not-allowed', '只用 GET')
      const read = active.read() || {}
      return json(res, 200, { ok: true, data: { types: typeListOf(active, read) } })
    }
    if (route === '/skills') {
      if (method !== 'GET') return fail(res, 405, 'method-not-allowed', '只用 GET')
      return json(res, 200, { ok: true, data: buildSkills(active) })
    }
    if (route === '/usage') {
      if (method !== 'GET') return fail(res, 405, 'method-not-allowed', '只用 GET')
      const limit = numberParam(url.searchParams.get('limit'), 100, 500)
      const rows = safeUsage(active, limit).slice(-limit).reverse().map((row) => ({
        at: String(row.at || ''),
        tool: String(row.tool || ''),
        ok: row.ok === undefined ? null : row.ok === true,
        op: String(row.op || ''),
        intent: String(row.intent || ''),
        action: String(row.action || ''),
        feedback: row.feedback === undefined || row.feedback === null ? null : String(row.feedback),
        id: row.id === undefined ? '' : String(row.id),
        error: String(row.error || ''),
        limit: row.limit === undefined ? null : Number(row.limit),
        routeScore: row.route_score === undefined ? null : Number(row.route_score),
        ids: Array.isArray(row.ids) ? row.ids.map(String) : [],
        chars: row.chars === undefined ? 0 : Number(row.chars) || 0,
      }))
      return json(res, 200, { ok: true, data: { rows } })
    }
    if (route === '/pending') {
      if (method !== 'GET') return fail(res, 405, 'method-not-allowed', '只用 GET')
      return json(res, 200, { ok: true, data: buildPending(active) })
    }
    if (route === '/verdicts') {
      if (method !== 'POST') return fail(res, 405, 'method-not-allowed', '只用 POST')
      const body = await readBody(req)
      try {
        return json(res, 200, { ok: true, data: buildVerdicts(active, body && body.verdicts) })
      } catch (error) {
        return fail(res, 400, 'verdict-failed', String((error && error.message) || error))
      }
    }
    if (route === '/usage-summary') {
      if (method !== 'GET') return fail(res, 405, 'method-not-allowed', '只用 GET')
      return json(res, 200, { ok: true, data: buildUsageSummary(active) })
    }
    if (route === '/recall') {
      if (method !== 'POST') return fail(res, 405, 'method-not-allowed', '只用 POST')
      return json(res, 200, { ok: true, data: buildRecall(active, await readBody(req)) })
    }
    if (route === '/record') {
      if (method !== 'POST') return fail(res, 405, 'method-not-allowed', '只用 POST')
      return json(res, 200, { ok: true, data: buildRecord(active, await readBody(req)) })
    }
    if (route === '/consolidate') {
      if (method !== 'POST') return fail(res, 405, 'method-not-allowed', '只用 POST')
      return json(res, 200, { ok: true, data: buildConsolidate(active, await readBody(req)) })
    }
    if (route === '/skills/import') {
      if (method !== 'POST') return fail(res, 405, 'method-not-allowed', '只用 POST')
      return json(res, 200, { ok: true, data: await buildImportSkill(active, await readBody(req), deps) })
    }
    if (route === '/skill-feedback') {
      if (method !== 'POST') return fail(res, 405, 'method-not-allowed', '只用 POST')
      return json(res, 200, { ok: true, data: buildSkillFeedback(active, await readBody(req)) })
    }
    if (route === '/skill-global') {
      if (method !== 'POST') return fail(res, 405, 'method-not-allowed', '只用 POST')
      const body = await readBody(req)
      const slug = String((body && body.slug) || '').trim()
      if (slug === '') return fail(res, 400, 'slug-required', '缺少技能 slug')
      const action = String((body && body.action) || 'register').trim().toLowerCase()
      if (!['register', 'unregister'].includes(action)) return fail(res, 400, 'bad-action', 'action 只能是 register / unregister')
      if (active.mode !== 'live') return fail(res, 400, 'unsupported', '示例数据不支持全局注册')
      const dataDir = String((active.read && active.read().dataDir) || '').trim() || resolveEngramDataDir()
      try {
        const result = action === 'register'
          ? registerSkillGlobally(dataDir, slug)
          : unregisterSkillFromDsh(dataDir, slug)
        resetSourceCache()
        return json(res, 200, { ok: true, data: { ...result, action } })
      } catch (error) {
        return fail(res, 400, 'skill-global-failed', error && error.message ? error.message : String(error))
      }
    }
    if (route === '/skill-node') {
      if (method !== 'POST') return fail(res, 405, 'method-not-allowed', '只用 POST')
      const body = await readBody(req)
      const nodePath = String((body && (body.path || body.slug)) || '').trim()
      if (nodePath === '') return fail(res, 400, 'node-required', '缺少节点 path')
      const action = String((body && body.action) || '').trim().toLowerCase()
      if (!['register', 'unregister', 'forget', 'detach'].includes(action)) {
        return fail(res, 400, 'bad-action', 'action 只能是 register / unregister / forget / detach')
      }
      if (active.mode !== 'live') return fail(res, 400, 'unsupported', '示例数据不支持节点操作')
      const dataDir = String((active.read && active.read().dataDir) || '').trim() || resolveEngramDataDir()
      try {
        const result = applySkillNodeAction(dataDir, action, nodePath, { expect: body && body.expect })
        resetSourceCache()
        return json(res, 200, { ok: true, data: result })
      } catch (error) {
        return fail(res, 400, 'skill-node-failed', error && error.message ? error.message : String(error))
      }
    }
    if (route === '/skill-meta') {
      if (method !== 'POST') return fail(res, 405, 'method-not-allowed', '只用 POST')
      const body = await readBody(req)
      const slug = String((body && body.slug) || '').trim()
      if (slug === '') return fail(res, 400, 'slug-required', '缺少技能 slug')
      if (active.mode !== 'live') return fail(res, 400, 'unsupported', '示例数据不支持改技能元数据')
      const dataDir = String((active.read && active.read().dataDir) || '').trim() || resolveEngramDataDir()
      try {
        const result = updateSkillMeta(dataDir, slug, body)
        resetSourceCache()
        return json(res, 200, { ok: true, data: result })
      } catch (error) {
        return fail(res, 400, 'skill-meta-failed', error && error.message ? error.message : String(error))
      }
    }
    if (route === '/skill-forget') {
      if (method !== 'POST') return fail(res, 405, 'method-not-allowed', '只用 POST')
      const body = await readBody(req)
      const slug = String((body && body.slug) || '').trim()
      if (slug === '') return fail(res, 400, 'slug-required', '缺少技能 slug')
      if (active.mode !== 'live') return fail(res, 400, 'unsupported', '示例数据不支持删除技能')
      const dataDir = String((active.read && active.read().dataDir) || '').trim() || resolveEngramDataDir()
      try {
        const result = forgetSkill(dataDir, slug)
        resetSourceCache()
        return json(res, 200, { ok: true, data: result })
      } catch (error) {
        return fail(res, 400, 'skill-forget-failed', error && error.message ? error.message : String(error))
      }
    }
    if (route === '/type') {
      if (method !== 'POST') return fail(res, 405, 'method-not-allowed', '只用 POST')
      return json(res, 200, { ok: true, data: buildTypeOp(active, await readBody(req)) })
    }
    if (route === '/classify-diag') {
      if (method !== 'GET') return fail(res, 405, 'method-not-allowed', '只用 GET')
      const llm = typeof deps.getLlm === 'function' ? deps.getLlm() : null
      const routeInfo = typeof deps.getRoute === 'function' ? deps.getRoute() : null
      return json(res, 200, { ok: true, data: { mode: active && active.mode ? active.mode : '', hasLlm: llm !== null && llm !== undefined, hasStream: llm !== null && llm !== undefined && typeof llm.stream === 'function', hasRoute: routeInfo !== null && routeInfo !== undefined, provider: routeInfo && routeInfo.provider ? String(routeInfo.provider) : '', model: routeInfo && routeInfo.model ? String(routeInfo.model) : '' } })
    }
    if (route === '/classify') {
      if (method !== 'POST') return fail(res, 405, 'method-not-allowed', '只用 POST')
      if (!active || active.mode !== 'live' || typeof active.hot !== 'function') return fail(res, 400, 'unsupported', '示例数据不支持自动分类')
      const body = await readBody(req)
      const dataDir = String(readOf(active).dataDir || '')
      let store
      try { store = readStore(dataDir) } catch (error) { return fail(res, 500, 'store-unreadable', String((error && error.message) || error)) }
      const row = (store.experiences || []).find((item) => item.id === String((body && body.id) || ''))
      if (row === undefined) return fail(res, 404, 'not-found', '经验不存在')
      const typeNames = (store.types || []).filter((type) => type && type.system !== true).map((type) => String(type.name || '')).filter(Boolean)
      const tagNames = tagCatalog(store, { limit: 60 }).map((item) => item.name)
      const text = [row.intent, row.action, row.note].filter(Boolean).join('\n')
      let decided = null
      try {
        decided = await classifyExperienceWithSession({
          llm: typeof deps.getLlm === 'function' ? deps.getLlm() : null,
          route: typeof deps.getRoute === 'function' ? deps.getRoute() : null,
          text,
          typeNames,
          tagNames,
        })
      } catch { decided = null }
      if (decided === null) decided = localClassifyExperience({ text, typeNames, tagNames })
      const target = (store.types || []).find((type) => type && type.name === decided.category && type.system !== true)
        || (store.types || []).find((type) => type && type.system !== true)
      if (target === undefined) return fail(res, 400, 'no-type', '没有可用的主分类')
      row.typeId = target.id
      row.typeName = target.name
      const existingTags = normalizeContext(row.context)
      const room = Math.max(0, 8 - existingTags.length)
      const addedTags = (Array.isArray(decided.tags) ? decided.tags : []).map(String).filter((tag) => tag !== '' && !existingTags.includes(tag)).slice(0, room)
      row.context = normalizeContext([...existingTags, ...addedTags])
      writeStore(dataDir, store)
      return json(res, 200, { ok: true, data: { id: row.id, typeName: target.name, tags: row.context, addedTags, classifier: decided.classifier, note: decided.note, model: decided.model || '' } })
    }
    if (route === '/graph') {
      if (method !== 'GET') return fail(res, 405, 'method-not-allowed', '只用 GET')
      return json(res, 200, { ok: true, data: buildGraph(active, url.searchParams) })
    }
    if (route === '/validate') {
      if (method !== 'GET') return fail(res, 405, 'method-not-allowed', '只用 GET')
      return json(res, 200, { ok: true, data: buildValidate(active) })
    }
    if (route === '/pick-directory') {
      // 只读探针：GET ?probe=1 只回答「能不能弹窗口」，不弹。
      if (url.searchParams.get('probe') === '1') {
        if (method !== 'GET') return fail(res, 405, 'method-not-allowed', '探针只用 GET')
        return json(res, 200, { ok: true, data: describeDirectoryPicker(deps) })
      }
      if (method !== 'POST') return fail(res, 405, 'method-not-allowed', '只用 POST')
      // 窗口是模态的：请求挂着等人选完；页面关了就把窗口一起收掉。
      // 听的是 res 的 close，不是 req 的——Node 16 起 req 的 close 在请求体收完就会发，
      // 那会立刻把窗口关掉。
      const controller = typeof AbortController === 'function' ? new AbortController() : null
      if (controller !== null && typeof res.on === 'function') {
        res.on('close', () => { if (res.writableEnded !== true) controller.abort() })
      }
      return json(res, 200, { ok: true, data: await pickDirectory(deps, controller === null ? undefined : controller.signal) })
    }
    if (route === '/settings') {
      if (method === 'POST') {
        const body = await readBody(req)
        if (body && Object.prototype.hasOwnProperty.call(body, 'currentRoot')) {
          const rawRoot = String(body.currentRoot || '').trim()
          const oldRoot = resolveEngramDataDir()
          const newRoot = rawRoot === '' ? defaultDataDir() : rawRoot
          try {
            if (path.resolve(oldRoot) !== path.resolve(newRoot)) moveDataRoot(oldRoot, newRoot)
            setCurrentRoot(rawRoot)
            // 用户第一次选择存储位置（或走默认根）：空库初始化默认主分类；已有数据不动。
            ensureDefaultTypes(resolveEngramDataDir())
          } catch (error) {
            return fail(res, 409, 'root-move-failed', error && error.message ? error.message : '切换存储位置失败')
          }
        }
        if (body && body.config !== undefined) writeEngineConfig(sanitizeSettings(body.config, SETTINGS_SPEC.config))
        if (body && body.ui !== undefined) writeUiConfig(sanitizeSettings(body.ui, SETTINGS_SPEC.ui))
        if (body && body.git !== undefined) writeGitConfig(sanitizeSettings(body.git, SETTINGS_SPEC.git))
        resetSourceCache()
        return json(res, 200, { ok: true, data: { action: 'saved' } })
      }
      if (method !== 'GET') return fail(res, 405, 'method-not-allowed', '只用 GET/POST')
      return json(res, 200, { ok: true, data: { ...buildSettings(active), config: readEngineConfig(), ui: readUiConfig(), git: readGitConfig(), spec: SETTINGS_SPEC } })
    }
    if (route === '/sync') {
      const dataDir = String((active.read && active.read().dataDir) || '').trim() || resolveEngramDataDir()
      const config = readGitConfig()
      if (method === 'GET') return json(res, 200, { ok: true, data: await gitStatus(dataDir, config) })
      if (method !== 'POST') return fail(res, 405, 'method-not-allowed', '只用 GET/POST')
      const body = await readBody(req)
      const action = String((body && body.action) || 'push').trim().toLowerCase()
      if (!['init', 'push', 'pull', 'status', 'disconnect'].includes(action)) return fail(res, 400, 'bad-action', `未知动作：${action}`)
      if (action === 'status') return json(res, 200, { ok: true, data: await gitStatus(dataDir, config) })
      if (action === 'init') return json(res, 200, { ok: true, data: await gitInit(dataDir, config) })
      if (action === 'pull') return json(res, 200, { ok: true, data: await gitPull(dataDir, config) })
      if (action === 'disconnect') {
        // 只断开「备份到哪个仓库」：清掉 repoUrl，本地提交历史与 GitHub 登录令牌都留着。
        writeGitConfig({ repoUrl: '' })
        return json(res, 200, { ok: true, data: { ok: true, action: 'disconnect', disconnected: true } })
      }
      return json(res, 200, {
        ok: true,
        data: await gitPush(dataDir, config, { message: body && body.message, force: body && body.force === true, branch: body && body.branch }),
      })
    }
    if (route === '/chat-save-probe') {
      const mid = String((req.url || '').split('mid=')[1] || '').split('&')[0]
      return json(res, 200, { ok: true, data: probeSessions(mid === '' ? '' : decodeURIComponent(mid)) })
    }
    if (route === '/chat-save') {
      if (method !== 'POST') return fail(res, 405, 'method-not-allowed', '只用 POST')
      const body = await readBody(req)
      const sessionId = String((body && body.sessionId) || '').trim()
      const messageId = String((body && body.messageId) || '').trim()
      if (messageId === '') return fail(res, 400, 'ids-required', '缺少 messageId')
      const dataDir = String((active.read && active.read().dataDir) || '').trim() || resolveEngramDataDir()
      try {
        const logFile = path.join(String(process.env.DSH_HOME || '').trim() === '' ? path.join(process.env.USERPROFILE || '', '.dsh') : String(process.env.DSH_HOME), 'engram', 'chat-save.log')
        fs.mkdirSync(path.dirname(logFile), { recursive: true })
        fs.appendFileSync(logFile, `${new Date().toISOString()} sessionId=${sessionId || '(空)'} messageId=${messageId}\n`)
      } catch {
        // 日志失败不影响保存
      }
      let saved
      try {
        saved = saveTurnAsExperience(dataDir, {
          sessionId,
          messageId,
          outcome: body && body.outcome,
          type: body && body.type,
          note: body && body.note,
        })
      } catch (error) {
        const debug = body && body.debug === true
          ? { dshHome: process.env.DSH_HOME || '(unset)', file: findSessionFile(sessionId), dataDir, sessionsRoot: path.join(String(process.env.DSH_HOME || '').trim() === '' ? path.join(process.env.USERPROFILE || '', '.dsh') : String(process.env.DSH_HOME), 'sessions') }
          : undefined
        return fail(res, 400, 'turn-not-found', error && error.message ? error.message : '读不到这条消息', debug)
      }
      return json(res, 200, { ok: true, data: saved })
    }

    if (route === '/github') {
      if (method !== 'POST') return fail(res, 405, 'method-not-allowed', '只用 POST')
      const body = await readBody(req)
      const action = String((body && body.action) || 'login').trim().toLowerCase()
      // 设备码登录：不需要用户先贴 token。
      if (action === 'device-start') {
        const flow = await startDeviceFlow({ clientId: readGitConfig().oauthClientId })
        deviceSession = {
          deviceCode: flow.deviceCode,
          expiresAt: Date.now() + flow.expiresIn * 1000,
          interval: flow.interval,
          nextPollAt: Date.now() + flow.interval * 1000,
        }
        // 自动打开浏览器 + 自动复制验证码（都尽力而为，失败不阻断）。
        // 自动化验证时传 noOpen:true，避免抢用户的浏览器和剪贴板。
        const quiet = body && body.noOpen === true
        const opened = quiet ? false : openExternal(flow.verificationUri)
        const copied = quiet ? false : await copyToClipboard(flow.userCode)
        return json(res, 200, {
          ok: true,
          data: {
            userCode: flow.userCode,
            verificationUri: flow.verificationUri,
            expiresIn: flow.expiresIn,
            interval: flow.interval,
            opened,
            copied,
          },
        })
      }
      if (action === 'device-poll') {
        if (deviceSession === null) return fail(res, 400, 'github', '没有正在进行的登录：先点「用 GitHub 登录」')
        if (Date.now() > deviceSession.expiresAt) {
          deviceSession = null
          return json(res, 200, { ok: true, data: { status: 'expired' } })
        }
        // 节奏由 host 掌握：客户端点得再快，也不会提前打 GitHub（否则必吃 slow_down）
        if (Date.now() < deviceSession.nextPollAt) {
          return json(res, 200, {
            ok: true,
            data: {
              status: 'pending',
              interval: deviceSession.interval,
              waitMs: Math.max(0, deviceSession.nextPollAt - Date.now()),
            },
          })
        }
        let polled
        try {
          polled = await pollDeviceFlow({ deviceCode: deviceSession.deviceCode, clientId: readGitConfig().oauthClientId })
        } catch (error) {
          if (deviceSession !== null) deviceSession.nextPollAt = Date.now() + deviceSession.interval * 1000
          throw error
        }
        if (deviceSession !== null) deviceSession.nextPollAt = Date.now() + deviceSession.interval * 1000
        if (polled.status === 'authorized') {
          writeGitConfig({ token: polled.token })
          deviceSession = null
          let user = null
          try {
            user = await githubLogin(polled.token)
            if (user && user.login) writeGitConfig({ login: user.login })
          } catch {
            user = null
          }
          return json(res, 200, { ok: true, data: { status: 'authorized', user } })
        }
        if (polled.status === 'expired' || polled.status === 'denied') deviceSession = null
        if (polled.status === 'slow-down' && deviceSession !== null) {
          deviceSession.interval += 5
          deviceSession.nextPollAt = Date.now() + deviceSession.interval * 1000
        }
        return json(res, 200, { ok: true, data: { status: polled.status, interval: deviceSession === null ? 0 : deviceSession.interval } })
      }
      if (action === 'device-cancel') {
        deviceSession = null
        return json(res, 200, { ok: true, data: { status: 'cancelled' } })
      }
      // 允许临时传 token（第一次登录），传了就顺手存下来，后面不用再贴。
      const provided = String((body && body.token) || '').trim()
      if (provided !== '') writeGitConfig({ token: provided })
      const git = readGitConfig()
      const token = provided !== '' ? provided : git.token
      if (!['login', 'repos', 'create', 'select'].includes(action)) return fail(res, 400, 'bad-action', `未知动作：${action}`)
      const dataDir = String((active.read && active.read().dataDir) || '').trim() || resolveEngramDataDir()
      if (action === 'login') {
        const user = await githubLogin(token)
        if (user.login !== '') writeGitConfig({ login: user.login })
        return json(res, 200, { ok: true, data: user })
      }
      if (action === 'repos') return json(res, 200, { ok: true, data: await githubRepos(token) })
      if (action === 'create') {
        const created = await githubCreateRepo(token, { name: body && body.name, private: body ? body.private !== false : true })
        writeGitConfig({ repoUrl: created.repo.cloneUrl, branch: created.repo.defaultBranch || git.branch })
        const nextConfig = readGitConfig()
        const init = await gitInit(dataDir, nextConfig)
        if (!init.ok) return json(res, 200, { ok: true, data: { action: 'create', repo: created.repo, init, sync: null } })
        const sync = await gitPush(dataDir, nextConfig, { message: body && body.message })
        return json(res, 200, { ok: true, data: { action: 'create', repo: created.repo, init, sync } })
      }
      // select：选中已有仓库 → 存地址 + 初始化 + 推送
      const repoUrl = String((body && body.repoUrl) || '').trim()
      if (repoUrl === '') return fail(res, 400, 'repo-required', '缺少 repoUrl')
      writeGitConfig({ repoUrl })
      const nextConfig = readGitConfig()
      const init = await gitInit(dataDir, nextConfig)
      const sync = init.ok ? await gitPush(dataDir, nextConfig, { message: body && body.message }) : null
      return json(res, 200, { ok: true, data: { action: 'select', repoUrl, init, sync } })
    }
    if (route === '/feedback') {
      if (method !== 'POST') return fail(res, 405, 'method-not-allowed', '只用 POST')
      const body = await readBody(req)
      const id = String((body && body.id) || '').trim()
      const result = String((body && body.result) || '').trim().toLowerCase()
      if (id === '') return fail(res, 400, 'id-required', '缺少 id')
      if (!['helped', 'hurt', 'neutral'].includes(result)) {
        return fail(res, 400, 'bad-result', 'result 只能是 helped / hurt / neutral')
      }
      const receipt = buildFeedback(active, id, result)
      return json(res, 200, { ok: true, data: receipt })
    }
    return fail(res, 404, 'not-found', `没有这个路由：${route}`)
  } catch (error) {
    const code = error && typeof error.code === 'string' ? error.code : 'internal'
    const message = String((error && error.message) || error)
    const status = code === 'unsupported'
      ? 501
      : code === 'read-only' || code === 'not-feedbackable'
        ? 409
      : code === 'store-unreadable'
        ? 503
      : code === 'not-found'
        ? 404
        : code === 'internal'
          ? 500
          : 400
    return fail(res, status, code, message)
  }
}

/**
 * 造一个绑定 config 的请求处理器（index.js 用它挂到 webServer）。
 * @param {object} config - 插件行 config（`source` / `dataDir`）。
 * @returns {(req: any, res: any) => Promise<void>}
 */
export function createApi(config = {}, deps = {}) {
  return (req, res) => handleRequest(req, res, createSource(config), deps)
}
