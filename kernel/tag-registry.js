/**
 * 标签词表（P0 · 标签分类与召回治理，2026-11-14）
 *
 * 职责：给标签指定「面」（action/topic/quality）、维护别名与 core 种子词、
 * 提供命名校验。标签只描述**类型**，不描述**实例**：
 *  - `DSH-Engram` 这类项目实例名统一归一成 `DSH插件`；
 *  - `EigenFlux`（已拍板 2026-11-14）：具体项目名不是泛 Agent，项目类型统一为 `智能体平台`，
 *    只保留隐藏别名；具体功能用主题标签（`问答`/`社交`/`交易`）表达。
 *
 * 本文件不 import store.js（store 反过来 import 本文件），保持单向依赖。
 */

import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { normalizeFamilyName } from './family-name.js'

/** 标签最长字符数（短名词）。旧规则同样是 12，这里只集中一处。 */
export const TAG_MAX_CHARS = 12
/** 硬上限：一条经验最多 8 个标签（旧规则）。 */
export const TAG_MAX_COUNT = 8
/** 推荐区间：2–6 个。 */
export const TAG_RECOMMEND_MIN = 2
export const TAG_RECOMMEND_MAX = 6

/** 0.38：回执/告警里回显标签名要截断，别把 10 万字符的输入原样撑爆回执。按码元截但在代理对边界退一格，不劈 emoji。 */
function clipTag(value, max = 60) {
  const text = String(value === undefined || value === null ? '' : value)
  if (text.length <= max) return text
  let cut = max
  if (cut > 0) {
    const code = text.charCodeAt(cut - 1)
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1
  }
  return `${text.slice(0, cut)}…`
}

/** 四个面。顺序即 UI 分组顺序。0.37：object 面已退休并物理删除。0.38：新增 direction（族内场景）。 */
export const TAG_FACETS = ['action', 'direction', 'topic', 'quality']
/** 参与意图抽取/召回打分的面（direction 是族内场景，不参与意图抽取）。 */
const RANK_FACETS = ['action', 'topic', 'quality']

/** 用户覆盖文件（相对数据根）：只放手动登记的新标签，内建词不写这里。 */
export const TAG_REGISTRY_FILE = 'tag-registry.json'

export const TAG_FACET_LABELS = {
  action: '动作/任务',
  direction: '方向/场景',
  topic: '主题/场景',
  quality: '质量/异常',
  other: '其他已用标签',
}

/** 缺面时的提示文案（UI 与工具回执共用一套，别两处各写一句）。 */
export const TAG_FACET_HINTS = {
  action: '再补一个动作标签，例如 提交/推送/校验/验收',
}

/**
 * 面 → 是否必填。
 * 0.38：动作语义由「族」承担，标签只表达方向/主题内容，不再强制动作面（拍板①）。
 */
export const TAG_REQUIRED_FACETS = []

/**
 * 种子词表。
 * core=true：0 次使用也出现在选择器里（计划书 §5.2 的例外规则）。
 * status='pending'：等拍板的标签（当前词表里已没有 pending 条目；EigenFlux 已于 2026-11-14
 * 拍板归一成 `智能体平台`，见下）。
 */
const SEED = [
  // —— 动作 / 任务 ——
  { name: '提交', facet: 'action', core: true, description: 'git commit、表单提交、单据提交。', aliases: ['commit'] },
  { name: '推送', facet: 'action', core: true, description: 'git push、上传到远端。', aliases: ['push'] },
  { name: '校验', facet: 'action', core: true, description: '跑测试、对拍、验数值、查契约。', aliases: [] },
  { name: '验收', facet: 'action', core: true, description: '按判据验收交付物、写验收结论。', aliases: [] },
  { name: '恢复', facet: 'action', core: true, description: '回滚、还原、从坏状态救回来。', aliases: [] },
  { name: '分类', facet: 'action', core: true, description: '归类、打标签、整理类型。', aliases: [] },
  { name: '沉淀', facet: 'action', core: true, description: '把做法固化成技能/文档。', aliases: ['exp_consolidate'] },
  { name: '注册', facet: 'action', core: true, description: '把产物登记到某个系统（技能注册、插件注册）。', aliases: [] },
  { name: '技能沉淀', facet: 'action', core: false, description: '把多条经验固化成一条技能。', aliases: [] },
  // 0.24.0：自动记录没有命令可抽时（只写了 .pptx/.docx、没有 git/测试），需要至少一个动作面词。
  { name: '编写', facet: 'action', core: true, description: '写文档/改文稿/产出一版内容（不限于代码）。', aliases: ['撰写', '写作'] },

  // —— 主题 / 场景 ——
  // 已拍板（2026-11-14）：EigenFlux 的「具体功能」用主题标签表达，不做层级树。
  { name: '问答', facet: 'topic', core: true, description: '问答类功能/场景。', aliases: [] },
  { name: '社交', facet: 'topic', core: true, description: '社交类功能/场景。', aliases: ['交友'] },
  { name: '交易', facet: 'topic', core: true, description: '交易类功能/场景。', aliases: ['生意'] },
  { name: '研学课', facet: 'topic', core: true, description: '研学课程/活动这类教学场景。', aliases: ['研学', '研学活动', '研学课程'] },
  { name: '思政', facet: 'topic', core: true, description: '思政/德育语境。', aliases: [] },
  { name: '互动推演', facet: 'topic', core: true, description: '互动推演/角色推演类课堂活动。', aliases: [] },
  { name: '史实核校', facet: 'topic', core: true, description: '史实核对、史料校准。', aliases: [] },

  // —— 质量 / 异常 ——
  { name: '假绿', facet: 'quality', core: true, description: '测试显示通过、实际没验到东西。', aliases: [] },
  { name: '负控', facet: 'quality', core: true, description: '负对照/必败样本：工具应报错而确实报错。', aliases: [] },
  { name: '不可判定', facet: 'quality', core: true, description: '判据无法给出结论，只能记不可判定。', aliases: [] },
  { name: '独立性', facet: 'quality', core: true, description: '两次验证彼此独立、不共享同一假设。', aliases: [] },
  { name: '指纹', facet: 'quality', core: true, description: '用指纹/哈希判断是否同一份产物。', aliases: [] },
  { name: '截断', facet: 'quality', core: true, description: '输出或上下文被截断。', aliases: [] },
  { name: '分母', facet: 'quality', core: true, description: '通过率/覆盖率的分母口径问题。', aliases: [] },
  { name: '通过率', facet: 'quality', core: true, description: '通过率口径与统计。', aliases: [] },
  { name: '第三态', facet: 'quality', core: false, description: '既非通过也非失败的第三态。', aliases: [] },
  { name: '可证伪性', facet: 'quality', core: false, description: '结论能否被反例证伪。', aliases: [] },
  { name: '不可比', facet: 'quality', core: false, description: '两组数据口径不同、不能直接比。', aliases: [] },
  { name: '篡改检测', facet: 'quality', core: false, description: '检测产物/记录是否被改过。', aliases: [] },
  { name: '静默失败', facet: 'quality', core: false, description: '出错但没报错，症状是「什么都没发生」。', aliases: ['silent failure'] },
  { name: '数值边界', facet: 'quality', core: false, description: '2^53、浮点精度这类边界。', aliases: ['2^53'] },
  { name: 'TLS握手超时', facet: 'quality', core: false, description: 'TLS 握手阶段超时。', aliases: ['tls握手超时'] },

  // —— 历史词：保留可用，但不进默认分组 ——
  { name: '技能', facet: 'topic', core: false, description: '技能沉淀/注册/附件这一块。', aliases: ['skills'] },
  { name: '客户端', facet: 'topic', core: false, description: '经验库客户端面板。', aliases: ['client.js'] },
  { name: 'React 客户端', facet: 'topic', core: false, description: 'React 版的客户端实现。', aliases: ['react 客户端 client.js'] },
  { name: '沙箱', facet: 'topic', core: false, description: '沙箱/权限模式。', aliases: ['workspace-write'] },
]

/** 句子碎片：旧规则沿用（>5 字才判，避免误伤「不可判定」这类短词）。 */
const TAG_BAD_WORDS = /(的|了|也|已经|这个|那个|就是|不是|可以|需要|参与|纳入|进行|我们|你们|他们)/u

/**
 * 宽松校验：**读取/归一旧数据**用。
 * 只挡住长度、字符集、明显句子碎片；实例名与版本号之类的形态问题留给写入路径。
 */
export function isStorableTag(value) {
  const tag = String(value === undefined || value === null ? '' : value).trim()
  if (tag.length < 1 || tag.length > TAG_MAX_CHARS) return false
  if (!/^[\p{L}\p{N}][\p{L}\p{N} _-]*$/u.test(tag)) return false
  if (TAG_BAD_WORDS.test(tag) && tag.length > 5) return false
  return true
}

export { TAG_BAD_WORDS }

/** 项目/仓库/分支实例名：不许当标签写（读取旧数据不受影响，见 isStorableTag）。 */
export const TAG_INSTANCE_NAMES = [
  'dsh-engram',
  'awesome-dsh-plugin',
  'dsh-engram-dev',
  'dsh-engram-console',
  'yxjd-explib',
  'engram-ui',
]

/** 新标签禁止命中的形态：路径、URL、文件名、版本号、日期、提交号。 */
const TAG_BAD_SHAPES = [
  [/[\\/]/, '不能含路径分隔符'],
  [/:\/\//, '不能是 URL'],
  [/\.(?:js|mjs|cjs|ts|tsx|jsx|json|md|py|css|html|yml|yaml)$/iu, '不能是文件名'],
  [/^v?\d+(?:\.\d+){1,3}$/iu, '不能是版本号'],
  [/^\d{4}[-/年]\d{1,2}(?:[-/月]\d{1,2}日?)?$/u, '不能是日期'],
  [/^[0-9a-f]{7,40}$/iu, '不能是提交号'],
]

/** 词表索引：canonical 名 → 条目。 */
const BY_NAME = new Map()
/** 别名索引：小写 → canonical 名。canonical 自身也进索引，保证大小写归一。 */
const BY_ALIAS = new Map()

/** 已加载的用户覆盖（`.exp/tag-registry.json`）所在的根；'' = 还没加载。 */
let overridesDir = ''
/** 上次加载时词表文件的内容指纹（长度+sha1）；用来发现别的进程改过词表、需要重载（同 mtime 也能发现）。 */
let overridesSignature = ''
/** 用户覆盖的条目（与 SEED 同形），按规范名。 */
let overrideEntries = []

function indexPath(dataDir) {
  return path.join(String(dataDir || '.'), TAG_REGISTRY_FILE)
}

/** 读词表原文（不存在/读不了返回 ''）。 */
function readOverridesRaw(dir) {
  try {
    return fs.readFileSync(indexPath(dir), 'utf8')
  } catch {
    return ''
  }
}

/** 内容指纹：长度 + sha1。缓存重载判据不能只看 mtime——外部可能用 utimes 保持 mtime 不变而改内容。 */
function overridesSignatureOf(raw) {
  return `${raw.length}:${createHash('sha1').update(raw).digest('hex')}`
}

function indexFrom(entries) {
  BY_NAME.clear()
  BY_ALIAS.clear()
  for (const entry of entries) {
    const item = {
      name: entry.name,
      facet: entry.facet,
      description: entry.description || '',
      aliases: Array.isArray(entry.aliases) ? entry.aliases.slice() : [],
      core: entry.core === true,
      status: entry.status === 'pending' ? 'pending' : 'active',
      source: entry.source === 'user' ? 'user' : 'core',
      // 0.38：direction 面带族归属（这个方向属于哪个动作族）；其余面为空串。
      family: typeof entry.family === 'string' ? entry.family : '',
    }
    BY_NAME.set(item.name, item)
    if (!BY_ALIAS.has(item.name.toLowerCase())) BY_ALIAS.set(item.name.toLowerCase(), item.name)
    for (const alias of item.aliases) {
      const key = String(alias || '').trim().toLowerCase()
      // 先到先得：同一个别名被两个标签声明时，以先登记的为准（SEED 在前，保护内建词）。
      if (key !== '' && !BY_ALIAS.has(key)) BY_ALIAS.set(key, item.name)
    }
  }
}

indexFrom(SEED.map((entry) => ({ ...entry, source: 'core' })))

/**
 * 把 `.exp/tag-registry.json` 的用户覆盖并进索引。
 * 同一目录：内容指纹没变才跳过；变了（别的进程改过词表）就重载——否则长驻进程会拿旧缓存判定，错摘/放行方向。
 * 用内容指纹而不是 mtime：外部可能 utimes 保持 mtime 不变而改内容。
 */
export function ensureTagOverrides(dataDir) {
  const dir = String(dataDir || '').trim()
  if (dir === '') return false
  const raw = readOverridesRaw(dir)
  const signature = overridesSignatureOf(raw)
  if (dir === overridesDir && signature === overridesSignature) return false
  overridesDir = dir
  overridesSignature = signature
  try { overrideEntries = parseTagOverrides(raw) } catch { overrideEntries = [] }
  indexFrom([
    ...SEED.map((entry) => ({ ...entry, source: 'core' })),
    // 用户覆盖不能改内建词的面（内建在前，同名的用户条目后被 Map.set 覆盖？——不，这里用「内建优先」顺序：
    // 先内建再用户，indexFrom 里 BY_NAME.set 会覆盖同名。为了「内建优先」，用户条目过滤掉与 SEED 同名的。
    ...overrideEntries.filter((entry) => !SEED.some((seed) => seed.name.toLowerCase() === String(entry.name || '').toLowerCase())),
  ])
  return true
}

/** 解析词表原文（坏 JSON 会抛；调用方决定当空还是当「不可读」）。 */
function parseTagOverrides(raw) {
  const parsed = JSON.parse(raw)
  const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed && parsed.tags) ? parsed.tags : [])
  return list
    .map((item) => ({
      name: String(item && item.name || '').trim(),
      facet: String(item && item.facet || '').trim(),
      description: String(item && item.description || '').trim(),
      aliases: Array.isArray(item && item.aliases) ? item.aliases.map(String) : [],
      family: String(item && item.family || '').trim(),
      core: false,
      status: 'active',
      source: 'user',
    }))
    .filter((item) => item.name !== '' && TAG_FACETS.includes(item.facet))
}

/** 读用户覆盖（坏文件当空，不让词表把面板拖垮）。 */
export function readTagOverrides(dataDir) {
  try {
    return parseTagOverrides(readOverridesRaw(String(dataDir || '')))
  } catch {
    return []
  }
}

/**
 * 登记一个用户标签（手动新增时必须带面）。
 * 写盘用「临时文件 + rename」，与 store 的写盘手法一致，绝不直接覆盖。
 */
export function saveTagOverride(dataDir, { name, facet, description = '', aliases = [], family = '' } = {}) {
  const dir = String(dataDir || '').trim()
  const cleanName = String(name || '').trim()
  const cleanFacet = String(facet || '').trim()
  const cleanFamily = String(family || '').trim()
  if (dir === '') throw new Error('没有数据目录，无法登记标签')
  if (cleanName === '') throw new Error('标签名不能为空')
  if (!TAG_FACETS.includes(cleanFacet)) throw new Error(`标签面必须是 ${TAG_FACETS.join(' / ')} 之一`)
  // 0.38：方向是族内场景，必须指明归属族（拍板⑤）；其余面不带族。
  if (cleanFacet === 'direction' && cleanFamily === '') throw new Error('方向标签必须指明归属族（family）')
  if (cleanFacet !== 'direction' && cleanFamily !== '') throw new Error('只有方向标签能带族归属（family）')
  const current = readTagOverrides(dir)
  if (current.some((item) => item.name.toLowerCase() === cleanName.toLowerCase())) {
    throw new Error(`标签「${cleanName}」已经登记过`)
  }
  if (SEED.some((item) => item.name.toLowerCase() === cleanName.toLowerCase())) {
    throw new Error(`标签「${cleanName}」是内建词，不需要再登记`)
  }
  const next = [...current, { name: cleanName, facet: cleanFacet, description: String(description || '').slice(0, 120), aliases: aliases.map(String).slice(0, 8), ...(cleanFacet === 'direction' ? { family: normalizeFamilyName(cleanFamily) } : {}) }]
  const text = `${JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), tags: next }, null, 2)}\n`
  const file = indexPath(dir)
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(temp, text, 'utf8')
    fs.renameSync(temp, file)
  } catch (error) {
    // 0.38 健壮性：写失败（如路径被目录占用）要清掉临时文件，并给可读业务错误而不是裸 EPERM。
    try { fs.unlinkSync(temp) } catch { /* 临时文件不存在就算了 */ }
    throw new Error(`词表写入失败：${file} 路径不可写（可能被目录占用或无权限），已清理临时文件`)
  }
  // 立刻生效：不用等下一次 ensureTagOverrides（同一个进程里 UI 马上要看到）。
  overrideEntries = readTagOverrides(dir)
  overridesDir = dir
  overridesSignature = overridesSignatureOf(readOverridesRaw(dir))
  indexFrom([
    ...SEED.map((entry) => ({ ...entry, source: 'core' })),
    ...overrideEntries.filter((entry) => !SEED.some((seed) => seed.name.toLowerCase() === String(entry.name || '').toLowerCase())),
  ])
  return { name: cleanName, facet: cleanFacet }
}

/**
 * 0.38：改一个已登记标签的面（label 显式指定 facet=direction 时，纠正「写入即登记」先记成 topic 的方向词）。
 * 未登记 / 非法面 / 非方向带族 一律业务错误。
 */
export function updateTagFacet(dataDir, { name, facet, family = '' } = {}) {
  const dir = String(dataDir || '').trim()
  const cleanName = String(name || '').trim()
  const cleanFacet = String(facet || '').trim()
  const cleanFamily = String(family || '').trim()
  if (dir === '') throw new Error('没有数据目录，无法改标签面')
  if (cleanName === '') throw new Error('标签名不能为空')
  if (!TAG_FACETS.includes(cleanFacet)) throw new Error(`标签面必须是 ${TAG_FACETS.join(' / ')} 之一`)
  if (cleanFacet === 'direction' && cleanFamily === '') throw new Error('方向标签必须指明归属族（family）')
  if (cleanFacet !== 'direction' && cleanFamily !== '') throw new Error('只有方向标签能带族归属（family）')
  const current = readTagOverrides(dir)
  const index = current.findIndex((item) => item.name.toLowerCase() === cleanName.toLowerCase())
  if (index < 0) throw new Error(`标签「${cleanName}」未登记，不能改面`)
  const next = current.map((item, at) => (at === index
    ? { ...item, facet: cleanFacet, ...(cleanFacet === 'direction' ? { family: normalizeFamilyName(cleanFamily) } : { family: '' }) }
    : item))
  const text = `${JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), tags: next }, null, 2)}\n`
  const file = indexPath(dir)
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(temp, text, 'utf8')
    fs.renameSync(temp, file)
  } catch (error) {
    try { fs.unlinkSync(temp) } catch { /* 临时文件不存在就算了 */ }
    throw new Error(`词表写入失败：${file} 路径不可写（可能被目录占用或无权限），已清理临时文件`)
  }
  overrideEntries = readTagOverrides(dir)
  overridesDir = dir
  overridesSignature = overridesSignatureOf(readOverridesRaw(dir))
  indexFrom([
    ...SEED.map((entry) => ({ ...entry, source: 'core' })),
    ...overrideEntries.filter((entry) => !SEED.some((seed) => seed.name.toLowerCase() === String(entry.name || '').toLowerCase())),
  ])
  return { name: cleanName, facet: cleanFacet }
}

/**
 * 0.38：族改名/合并后，把 direction 条目的归属族从旧名迁到新名。
 * @param {Array<[string,string]>} mappings [旧族名, 新族名] 列表
 * @returns {{moved:number}}
 */
export function remapDirectionFamily(dataDir, mappings) {
  const dir = String(dataDir || '').trim()
  if (dir === '') return { moved: 0 }
  const file = indexPath(dir)
  // 族名按 normalizeFamilyName 归一后匹配：行/注册表用的是规范化族键，原始串（内部空格/大小写）不能直接比。
  const pairs = (Array.isArray(mappings) ? mappings : [])
    .map((pair) => [normalizeFamilyName(pair && pair[0]), normalizeFamilyName(pair && pair[1])])
    .filter(([from, to]) => from !== '' && to !== '' && from !== to)
  if (pairs.length === 0) return { moved: 0 }
  const current = readTagOverrides(dir)
  let moved = 0
  const next = current.map((item) => {
    if (item.facet !== 'direction') return item
    const key = normalizeFamilyName(item.family)
    const hit = pairs.find(([from]) => from === key)
    if (hit === undefined) return item
    moved += 1
    return { ...item, family: hit[1] }
  })
  if (moved === 0) return { moved: 0 }
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  const text = `${JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), tags: next }, null, 2)}\n`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(temp, text, 'utf8')
    fs.renameSync(temp, file)
  } catch (error) {
    try { fs.unlinkSync(temp) } catch { /* 忽略 */ }
    throw new Error(`方向归属迁移写盘失败：${file} 路径不可写（可能被目录占用或无权限），已清理临时文件`)
  }
  overrideEntries = readTagOverrides(dir)
  overridesDir = dir
  overridesSignature = overridesSignatureOf(readOverridesRaw(dir))
  indexFrom([
    ...SEED.map((entry) => ({ ...entry, source: 'core' })),
    ...overrideEntries.filter((entry) => !SEED.some((seed) => seed.name.toLowerCase() === String(entry.name || '').toLowerCase())),
  ])
  return { moved }
}

/** 0.38：词表文件存在但不是普通文件（被目录占用等）→ true；不存在 → false。 */
export function wordlistUnreadable(dataDir) {
  const dir = String(dataDir || '').trim()
  if (dir === '') return false
  let stat
  try { stat = fs.statSync(indexPath(dir)) } catch { return false } // 文件不存在 = 词表为空，算可读
  if (!stat.isFile()) return true // 被目录占用等
  // 文件在但 JSON 坏了也当「不可读」：否则 rename/merge 静默以为方向迁移成功。
  try { parseTagOverrides(readOverridesRaw(dir)); return false } catch { return true }
}

/** 测试用：把索引重置回内建词。 */
export function resetTagOverridesForTests() {
  overridesDir = ''
  overridesSignature = ''
  overrideEntries = []
  indexFrom(SEED.map((entry) => ({ ...entry, source: 'core' })))
}

/** 别名 → 规范名；不是别名就返回 null。 */
export function aliasTarget(value) {
  const raw = String(value === undefined || value === null ? '' : value).replace(/\s+/gu, ' ').trim()
  if (raw === '') return null
  const target = BY_ALIAS.get(raw.toLowerCase())
  return target === undefined ? null : target
}

/** 词表条目（按规范名查，不解析别名）。 */
export function tagEntry(name) {
  const raw = String(name === undefined || name === null ? '' : name).replace(/\s+/gu, ' ').trim()
  return BY_NAME.get(raw) || null
}

/** 别名归一后的规范名；未登记返回 null。 */
export function canonicalRegisteredName(value) {
  const target = aliasTarget(value)
  return target === null ? null : target
}

/** 标签的面；未登记（或 pending 未分组）返回 null。 */

/**
 * 猜测一个新词属于哪个面（写入即登记用）：只做粗判，判不出来归 topic。
 * 依据：动作类多为动词/动宾（提交/推送/校验…），产物类多为名词（PPT/课件/插件…），其余当主题。
 */
export function inferTagFacet(value) {
  const name = String(value || '').trim()
  if (name === '') return 'topic'
  if (/提交|推送|校验|验收|编写|注册|安装|分类|沉淀|恢复|还原|修复|生成|整理|回滚|删除|清理|导出|导入|合并|改名|查询|统计|对比|评测|部署|发布/u.test(name)) return 'action'
  return 'topic'
}
export function facetOf(value) {
  const target = aliasTarget(value)
  if (target === null) return null
  const entry = BY_NAME.get(target)
  if (entry === undefined) return null
  return TAG_FACETS.includes(entry.facet) ? entry.facet : null
}

/** 是否 core 种子词（0 次使用也要展示）。 */
export function isCoreTag(value) {
  const target = aliasTarget(value)
  const entry = target === null ? null : BY_NAME.get(target)
  return entry !== undefined && entry !== null && entry.core === true
}

/** 条目的公开快照（去掉内部字段）。 */
export function describeTag(value) {
  const target = aliasTarget(value)
  const entry = target === null ? null : BY_NAME.get(target)
  if (entry === undefined || entry === null) return null
  return {
    name: entry.name,
    facet: entry.facet,
    description: entry.description,
    core: entry.core,
    status: entry.status,
    source: entry.source === 'user' ? 'user' : 'core',
    aliases: entry.aliases.slice(),
    aliased: target !== String(value === undefined || value === null ? '' : value).trim(),
    // 0.38：方向条目要带归属族，GET /tag-registry 的 tagCatalog/groups.direction 才能显示「哪个族的方向」。
    ...(entry.facet === 'direction' ? { family: entry.family || '' } : {}),
  }
}

/** 某面的 core 标签名（按 SEED 顺序）。 */
export function coreTagsOf(facet) {
  return SEED.filter((entry) => entry.core === true && entry.facet === facet).map((entry) => entry.name)
}

/**
 * 命名规则（**写入时**用，比读取严格）。
 * @returns {{ok: boolean, name: string, reason: string, aliasHit: string}}
 */
export function validateNewTagName(value) {
  const raw = String(value === undefined || value === null ? '' : value).replace(/\s+/gu, ' ').trim()
  if (raw === '') return { ok: false, name: '', reason: '标签不能为空', aliasHit: '' }
  // 1) 别名优先：DSH-Engram / dsh 插件 这类历史名在写入时直接归一成规范词。
  const target = aliasTarget(raw)
  if (target !== null) {
    // 已登记（含 pending 的历史词）一律放行：pending 只表示「归并口径还没拍板」，
    // 不是「不许写」——历史数据里的旧词必须能继续写入并归一，不能因为词表改版而变非法。
    return { ok: true, name: target, reason: '', aliasHit: target }
  }
  // 2) 形态：长度、字符集、句子碎片。
  if (raw.length > TAG_MAX_CHARS) return { ok: false, name: raw, reason: `不能超过 ${TAG_MAX_CHARS} 字`, aliasHit: '' }
  if (!/^[\p{L}\p{N}][\p{L}\p{N} _-]*$/u.test(raw)) return { ok: false, name: raw, reason: '只能是短名词（字母/数字/空格/_/-）', aliasHit: '' }
  if (TAG_BAD_WORDS.test(raw) && raw.length > 5) return { ok: false, name: raw, reason: '像句子片段，不像标签', aliasHit: '' }
  // 3) 实例名与形态黑名单。
  if (TAG_INSTANCE_NAMES.includes(raw.toLowerCase())) return { ok: false, name: raw, reason: '是项目实例名，请用类型标签（如 DSH插件）', aliasHit: '' }
  for (const [pattern, reason] of TAG_BAD_SHAPES) {
    if (pattern.test(raw)) return { ok: false, name: raw, reason, aliasHit: '' }
  }
  return { ok: true, name: raw, reason: '', aliasHit: '' }
}

/**
 * 一条经验的标签集合校验。
 * @param {string[]} values 原始标签（可为别名/垃圾值）
 * @returns {{tags: string[], rejected: {value: string, reason: string}[], facets: Record<string, string[]>, missing: string[], warning: string, ok: boolean}}
 */
export function validateTagSet(values) {
  const list = Array.isArray(values) ? values : (values === undefined || values === null || values === '' ? [] : [values])
  const tags = []
  const rejected = []
  for (const value of list) {
    const check = validateNewTagName(value)
    if (!check.ok) {
      rejected.push({ value: String(value === undefined || value === null ? '' : value).trim(), reason: check.reason })
      continue
    }
    if (!tags.some((existing) => existing.toLowerCase() === check.name.toLowerCase())) tags.push(check.name)
  }
  const facets = groupByFacet(tags)
  const missing = TAG_REQUIRED_FACETS.filter((facet) => facets[facet].length === 0)
  const warning = missing.map((facet) => TAG_FACET_HINTS[facet]).join('；')
  return {
    tags,
    rejected,
    facets,
    missing,
    warning: [warning, ...rejected.map((item) => `已忽略「${clipTag(item.value)}」：${clipTag(item.reason, 120)}`)].filter(Boolean).join('；'),
    ok: missing.length === 0 && rejected.length === 0,
  }
}

/** 按面分组；未登记的进 other。名字保持调用方顺序。 */
export function groupByFacet(values) {
  const out = { action: [], direction: [], topic: [], quality: [], other: [] }
  for (const value of Array.isArray(values) ? values : []) {
    const name = String(value === undefined || value === null ? '' : value).trim()
    if (name === '') continue
    const facet = facetOf(name)
    if (facet === null) out.other.push(name)
    else out[facet].push(name)
  }
  return out
}

/**
 * 从意图文本里抽取 queryTags（P1 · 类型路由影子对比，纯函数、不调模型）。
 *
 * 规则：词表里的规范名或别名，只要作为「词面」出现在 intent 里就算命中；
 * 大小写不敏感、空白折叠。三个面固定返回，没有命中就是三个空数组。
 * 只收**已登记**的词（含用户覆盖），词表外的自由标签不凭空造。
 *
 * @param {string} intent
 * @returns {{action: string[], topic: string[], quality: string[]}}
 */
export function extractQueryTags(intent) {
  const queryTags = { action: [], topic: [], quality: [] }
  const text = String(intent === undefined || intent === null ? '' : intent).replace(/\s+/gu, ' ').trim().toLowerCase()
  if (text === '') return queryTags
  for (const entry of BY_NAME.values()) {
    const facet = RANK_FACETS.includes(entry.facet) ? entry.facet : null
    if (facet === null) continue
    const terms = [entry.name, ...entry.aliases]
      .map((term) => String(term || '').replace(/\s+/gu, ' ').trim().toLowerCase())
      .filter((term) => term !== '')
    if (!terms.some((term) => text.includes(term))) continue
    if (!queryTags[facet].some((name) => name.toLowerCase() === entry.name.toLowerCase())) queryTags[facet].push(entry.name)
  }
  // 同面的重叠词只留更具体的那个：意图里相邻的包含关系只保留长词，避免覆盖率被多余查询词拉低。
  for (const facet of RANK_FACETS) {
    const list = queryTags[facet]
    queryTags[facet] = list.filter((name, index) => !list.some((other, otherIndex) => (
      otherIndex !== index && other.toLowerCase() !== name.toLowerCase() && other.toLowerCase().includes(name.toLowerCase())
    )))
  }
  return queryTags
}

/** 词表快照（给 `/tag-registry` 与测试用）。含用户覆盖条目。 */
export function registrySnapshot() {
  const groups = { action: [], direction: [], topic: [], quality: [] }
  for (const entry of BY_NAME.values()) {
    const bucket = groups[entry.facet]
    if (bucket === undefined) continue
    bucket.push({
      name: entry.name,
      facet: entry.facet,
      description: entry.description || '',
      core: entry.core === true,
      status: entry.status === 'pending' ? 'pending' : 'active',
      aliases: Array.isArray(entry.aliases) ? entry.aliases.slice() : [],
      source: entry.source === 'user' ? 'user' : 'core',
      ...(entry.facet === 'direction' ? { family: entry.family || '' } : {}),
    })
  }
  return {
    facets: TAG_FACETS,
    labels: TAG_FACET_LABELS,
    hints: TAG_FACET_HINTS,
    required: TAG_REQUIRED_FACETS,
    groups,
    overrideDir: overridesDir,
  }
}

/** direction 标签的归属族；不是 direction 返回 null。 */
export function directionFamilyOf(value) {
  const target = aliasTarget(value)
  const entry = target === null ? null : BY_NAME.get(target)
  if (entry === undefined || entry === null || entry.facet !== 'direction') return null
  return entry.family || ''
}

/** 某族下已登记的方向标签名（族键按 normalizeFamilyName 归一后比较）。 */
export function directionsOfFamily(family) {
  const want = normalizeFamilyName(family)
  if (want === '') return []
  const names = []
  for (const entry of BY_NAME.values()) {
    if (entry.facet === 'direction' && normalizeFamilyName(entry.family) === want) names.push(entry.name)
  }
  return names
}

/** 0.39：一次建「族→方向名[]」映射（避免每族都全表扫 BY_NAME）。 */
export function directionsByFamily() {
  const out = new Map()
  for (const entry of BY_NAME.values()) {
    if (entry.facet !== 'direction') continue
    const family = normalizeFamilyName(entry.family)
    if (family === '') continue
    if (!out.has(family)) out.set(family, [])
    out.get(family).push(entry.name)
  }
  return out
}

/**
 * 校验一个方向能否用于某族：必须是已登记 direction 标签 + 归属族匹配（拍板⑤）。
 * family 为空时只校验「是已登记方向」。
 * @returns {{ok: boolean, name: string, reason: string}}
 */
export function validateDirectionForFamily(value, family) {
  const raw = String(value === undefined || value === null ? '' : value).replace(/\s+/gu, ' ').trim()
  const fam = String(family || '').trim()
  if (raw === '') return { ok: false, name: '', reason: '方向不能为空' }
  const target = aliasTarget(raw)
  if (target === null) return { ok: false, name: raw, reason: '方向必须是已登记的方向标签（先用 exp_type label 登记，facet=direction + family）' }
  const entry = BY_NAME.get(target)
  if (entry === undefined || entry === null || entry.facet !== 'direction') {
    return { ok: false, name: target, reason: `「${target}」不是方向标签` }
  }
  if (fam !== '' && normalizeFamilyName(entry.family) !== normalizeFamilyName(fam)) {
    return { ok: false, name: target, reason: `方向「${target}」属于族「${entry.family || '(未归属)'}」，不属于「${fam}」` }
  }
  return { ok: true, name: target, reason: '' }
}
