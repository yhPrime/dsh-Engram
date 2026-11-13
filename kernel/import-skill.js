/**
 * 从外部导入技能（kernel 半）。
 *
 * 「外部」= 一份不在经验库里的技能文本：本地 SKILL.md 文件路径，或直接粘贴的正文。
 * 导入要做三件事：
 *   1. 解析 frontmatter（name / description / 正文）；
 *   2. 让**一个临时模型会话**读一遍正文，给出「分类 / 标签 / 排序分」——
 *      这一层是可选增强：宿主没有模型服务、或模型调用失败时，退回本地关键词归类，
 *      并在返回值里如实标明 classifier = 'local'，不假装算过；
 *   3. 落成经验库里的技能包（`skills/<slug>/SKILL.md` + `skill.json`）。
 *
 * 这里不碰 cordis、不碰 HTTP：llm 与路由由调用方（ui/shell.js）注入，
 * 所以单测可以完全离线跑。
 */

import fs from 'node:fs'
import path from 'node:path'

import { createHash } from 'node:crypto'

import { assertSafePathSegment, assertSafeRelPath, commitSkills, createSkill, defaultMeta, listSkills, META_FILENAME, readSkill, skillDirOf, SKILL_SCAN_SKIP_DIRS, slugify, writeFileAtomic } from './skills.js'

/** 单次导入的正文上限：技能是给人读的，超过这个大小说明导错了东西。 */
export const MAX_IMPORT_BYTES = 512 * 1024

/** 本地兜底给出的排序分（0–100，越高越靠前）。没有模型判断时用中位值。 */
// 新技能天生高排序：刚加进来的先让人看见、能被触发，之后靠实际使用回归正常。
export const DEFAULT_ORDER = 90

export const MAX_TAGS = 6

/** 临时会话的硬超时：卡住的 provider 不能把导入一直挂着；所有临时会话统一最小预算。 */
export const SESSION_TIMEOUT_MS = 20_000
export const SESSION_MAX_TOKENS = 200

/** 分类/标签用的系统提示。只出 JSON，别让模型加解释。 */
export const CLASSIFY_SYSTEM = [
  '你是一个技能归档器。读用户给的技能文本，判断它属于哪个已有类型、打哪些标签、以及排序分。',
  '只输出一个 JSON 对象，不要任何解释、不要代码块。',
  '字段：category（必须是给定类型列表里的一个；都不合适就给空字符串）、tags（3–6 个中文或英文短词）、order（0–100 的整数，越通用越常用越高）、summaryZh（用一句中文说清这个技能处理什么任务，12–40 字；技能原文是英文时也必须给）。',
  '例：{"category":"代码 / 插件","tags":["dsh 插件","提交 PR"],"order":60,"summaryZh":"给 DSH 写插件并提交 PR 的完整流程"}',
].join('\n')

const TAG_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'are', 'was', 'were', 'has', 'have',
  'not', 'but', 'you', 'your', 'can', 'will', 'when', 'then', 'than', 'into', 'out', 'use',
  '使用', '可以', '如果', '这个', '那个', '我们', '你们', '他们', '以及', '或者', '但是',
  '因为', '所以', '已经', '需要', '进行', '一个', '没有', '就是', '不是', '这样', '那样',
  '技能', '用户', '时候', '东西', '内容', '情况', '方式', '问题', '结果', '部分', '相关',
])

/** 把 CRLF 统一成 LF，避免 frontmatter 正则漏匹配。 */
function normalizeNewlines(text) {
  return String(text || '').replace(/\r\n/g, '\n')
}

/**
 * 解析 SKILL.md：拆出 frontmatter 的 name / description 与正文。
 * 没有 frontmatter 时整篇当正文，名字留给调用方兜底。
 */
/** 标签 = 分类器给的 tags + 中文摘要：两者都当检索关键词用，去重并限制条数。 */
function skillTagsOf(decided) {
  const tags = Array.isArray(decided && decided.tags) ? decided.tags : []
  const summary = String((decided && decided.summaryZh) || '').trim()
  const merged = [...tags.map(String), ...(summary === '' ? [] : [summary])]
    .map((item) => item.trim())
    .filter((item) => item !== '')
  return [...new Set(merged)].slice(0, 12)
}

function createdOrderOf(decidedOrder) {
  const value = Number(decidedOrder)
  if (!Number.isFinite(value)) return DEFAULT_ORDER
  return Math.max(DEFAULT_ORDER, Math.max(0, Math.min(100, Math.round(value))))
}

export function parseSkillMarkdown(text) {
  const raw = normalizeNewlines(text)
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?/)
  if (match === null) return { name: '', description: '', body: raw.trim() }
  const lines = match[1].split('\n')
  const fields = {}
  for (let index = 0; index < lines.length; index += 1) {
    const field = lines[index].match(/^([A-Za-z_-]+):\s*(.*)$/)
    if (field === null) continue
    const key = field[1]
    let value = field[2].trim().replace(/^['"]|['"]$/g, '').trim()
    // YAML 块标量（`description: |` / `>`）：值在下面缩进的行里，
    // 不认这个会把描述解析成「|」或「>」，技能路由直接废掉（ai-base-tools / ppt-master 就是这样）。
    if (/^[|>][+-]?$/.test(value)) {
      const block = []
      let cursor = index + 1
      for (; cursor < lines.length; cursor += 1) {
        const line = lines[cursor]
        if (line.trim() !== '' && !/^\s/.test(line)) break
        block.push(line)
      }
      const nonEmpty = block.filter((line) => line.trim() !== '')
      const indent = nonEmpty.length === 0 ? 0 : Math.min(...nonEmpty.map((line) => (line.match(/^\s*/) || [''])[0].length))
      const dedented = block.map((line) => line.slice(indent)).join('\n').trim()
      value = value.startsWith('>') ? dedented.replace(/\n(?=\S)/gu, ' ') : dedented
      index = cursor - 1
    }
    fields[key] = value
  }
  return {
    name: fields.name || '',
    description: fields.description || '',
    body: raw.slice(match[0].length).trim(),
  }
}

/** 从正文里抽词：中文按 2 字以上连续块，英文/数字按 3 字以上标识符。 */
export function extractTags(text, limit = MAX_TAGS) {
  const body = normalizeNewlines(text)
  const counts = new Map()
  const pattern = /[\u4e00-\u9fa5]{2,}|[A-Za-z][A-Za-z0-9_-]{2,}/g
  let hit = pattern.exec(body)
  while (hit !== null) {
    const word = hit[0]
    const key = word.toLowerCase()
    if (!TAG_STOPWORDS.has(key) && !/^\d+$/.test(key)) {
      counts.set(word, (counts.get(word) || 0) + 1)
    }
    hit = pattern.exec(body)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'))
    .slice(0, Math.max(1, limit))
    .map(([word]) => word)
}

/**
 * 把类型名拆成可分别计分的词：类型名常写成「PPT / 课件」「代码 / 插件」，
 * 而正文里这两个词往往是分开出现的，整串匹配会永远落空。
 * 所以整串命中给高权重，拆出来的词（≥2 字）命中各自计分。
 */
export function typeTokensOf(name) {
  return String(name || '')
    .split(/[^A-Za-z0-9\u4e00-\u9fa5]+/)
    .map((token) => token.trim())
    .filter((token) => token !== '' && token.length >= 2)
}

function countOf(haystack, needle) {
  if (needle === '') return 0
  let count = 0
  let from = haystack.indexOf(needle)
  while (from >= 0) {
    count += 1
    from = haystack.indexOf(needle, from + needle.length)
  }
  return count
}

/** 按类型名（整串 + 拆词）在正文里的命中次数挑一个；一个都没有就返回空串。 */
export function guessCategory(text, typeNames = []) {
  const body = normalizeNewlines(text)
  let best = ''
  let bestScore = 0
  for (const name of typeNames) {
    const label = String(name || '').trim()
    if (label === '') continue
    let score = countOf(body, label) * 10
    for (const token of typeTokensOf(label)) score += countOf(body, token)
    if (score > bestScore) {
      best = label
      bestScore = score
    }
  }
  return best
}

/**
 * 本地兜底归类：不联网、不花钱，只按关键词。
 * classifier = 'local'，调用方要把这句话如实告诉用户。
 */
export function localClassify({ text = '', typeNames = [] } = {}) {
  return {
    category: guessCategory(text, typeNames),
    tags: extractTags(text),
    order: DEFAULT_ORDER,
    classifier: 'local',
    note: '宿主没有可用的模型会话，已退回本地关键词归类（不额外消耗）',
  }
}

/**
 * 从模型回复里挖出 JSON 对象。模型偶尔会包 ```json 代码块，所以先剥壳。
 * 解析失败返回 null，交给调用方兜底。
 */
export function parseClassification(rawText) {
  const text = String(rawText || '').trim()
  if (text === '') return null
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = fenced === null ? text : fenced[1]
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let parsed = null
  try {
    parsed = JSON.parse(candidate.slice(start, end + 1))
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const category = typeof parsed.category === 'string' ? parsed.category.trim() : ''
  const tags = Array.isArray(parsed.tags)
    ? [...new Set(parsed.tags.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean))].slice(0, MAX_TAGS)
    : []
  const order = Number(parsed.order)
  const summaryZh = typeof parsed.summaryZh === 'string' ? parsed.summaryZh.trim().slice(0, 120) : ''
  return {
    category,
    tags,
    order: Number.isFinite(order) ? Math.max(0, Math.min(100, Math.round(order))) : DEFAULT_ORDER,
    summaryZh,
  }
}

/**
 * 把模型给的分类对齐到真实类型列表：模型可能编一个不存在的类型名。
 * 对不上就留空，让技能落在「未分类」而不是伪造一个类型。
 */
export function alignClassification(parsed, typeNames = []) {
  if (parsed === null) return null
  const names = typeNames.map((name) => String(name || '').trim()).filter(Boolean).slice(0, 8)
  const category = names.includes(parsed.category) ? parsed.category : ''
  return { category, tags: parsed.tags, order: parsed.order, summaryZh: parsed.summaryZh || "" }
}

/**
 * 逐个吐块地拼出文本。不同适配器的块形状不一样，按常见几种都认一遍，
 * 认不出就跳过——宁可拼少了，也不要抛错把整次导入废掉。
 */
export function collectStreamText(chunks) {
  let text = ''
  for (const chunk of chunks) {
    if (typeof chunk === 'string') {
      text += chunk
      continue
    }
    if (chunk === null || typeof chunk !== 'object') continue
    if (typeof chunk.text === 'string') {
      text += chunk.text
      continue
    }
    const delta = chunk.delta && typeof chunk.delta.text === 'string' ? chunk.delta.text : ''
    if (delta !== '') text += delta
  }
  return text
}

/** 把当前选中的 provider/model 规整成 llm.stream 要的形状。 */
export function routeOf(selection) {
  if (selection === null || typeof selection !== 'object') return null
  const provider = String(selection.provider || '').trim()
  const model = String(selection.model || '').trim()
  if (provider === '' || model === '') return null
  return { provider, model }
}

/**
 * 用一个**临时会话**做分类。失败一律返回 null（调用方退回本地），
 * 因为「导入技能」不该被一次模型抖动整体卡死。
 */
export async function classifyWithSession({ llm, route, text, typeNames = [] }) {
  if (llm === null || llm === undefined || typeof llm.stream !== 'function') return null
  if (route === null || route === undefined) return null
  const names = typeNames.map((name) => String(name || '').trim()).filter(Boolean).slice(0, 8)
  if (names.length === 0) return null
  const body = normalizeNewlines(text).slice(0, 2000)
  const user = [`可选类型：${names.join('、')}`, '', '技能文本：', body].join('\n')
  try {
    const stream = llm.stream({
      provider: route.provider,
      model: route.model,
      messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
      system: CLASSIFY_SYSTEM,
      maxTokens: SESSION_MAX_TOKENS,
      temperature: 0,
      signal: AbortSignal.timeout(SESSION_TIMEOUT_MS),
    })
    const pieces = []
    for await (const chunk of stream) pieces.push(chunk)
    const parsed = alignClassification(parseClassification(collectStreamText(pieces)), names)
    if (parsed === null) return null
    return {
      category: parsed.category,
      tags: parsed.tags,
      order: parsed.order,
      summaryZh: parsed.summaryZh || '',
      classifier: 'session',
      model: route.model,
      provider: route.provider,
      note: '分类 / 标签 / 排序由一个临时模型会话给出',
    }
  } catch {
    return null
  }
}

/** 读来源：优先文件路径，其次粘贴的正文。两者都空就报错。 */
export function readImportSource({ filePath = '', content = '' } = {}) {
  const target = String(filePath || '').trim()
  if (target !== '') {
    let stat = null
    try {
      stat = fs.statSync(target)
    } catch {
      throw new Error(`读不到这个路径：${target}`)
    }
    // 允许直接给「技能文件夹」：人想的永远是文件夹，不是里面那个文件名。
    if (stat.isDirectory()) {
      let names = []
      try {
        names = fs.readdirSync(target)
      } catch {
        names = []
      }
      const found = names.find((name) => /^skill\.md$/iu.test(name))
      if (found === undefined) {
        throw new Error(`这个文件夹里没有 SKILL.md：${target}（技能文件夹的根目录要放 SKILL.md）`)
      }
      const file = path.join(target, found)
      const fileStat = fs.statSync(file)
      if (fileStat.size > MAX_IMPORT_BYTES) throw new Error(`文件太大（${fileStat.size} 字节），上限 ${MAX_IMPORT_BYTES}`)
      return { text: fs.readFileSync(file, 'utf8'), source: found, dir: target, file }
    }
    if (!stat.isFile()) throw new Error(`不是一个文件或文件夹：${target}`)
    if (stat.size > MAX_IMPORT_BYTES) throw new Error(`文件太大（${stat.size} 字节），上限 ${MAX_IMPORT_BYTES}`)
    const isSkillDoc = /^skill\.md$/iu.test(path.basename(target))
    // dir 只在「给的是 SKILL.md 本身」时才有意义：整包导入要把同目录的 scripts/references 一起带走
    return { text: fs.readFileSync(target, 'utf8'), source: path.basename(target), dir: isSkillDoc ? path.dirname(target) : '', file: target }
  }
  const pasted = String(content || '')
  if (pasted.trim() === '') throw new Error('要么给一个 SKILL.md 路径，要么粘贴正文')
  if (Buffer.byteLength(pasted, 'utf8') > MAX_IMPORT_BYTES) throw new Error(`正文太大，上限 ${MAX_IMPORT_BYTES} 字节`)
  return { text: pasted, source: '粘贴内容' }
}

function findSkillDoc(dir) {
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return null
  }
  const found = names.find((name) => /^skill\.md$/iu.test(name))
  return found === undefined ? null : path.join(dir, found)
}

/**
 * 读来源，可能返回多条：
 * - 给文件 → 一条；
 * - 给「单个技能文件夹」（根上有 SKILL.md）→ 一条；
 * - 给「技能套件文件夹」（根上没有，但子目录各带 SKILL.md）→ 每个子技能一条。
 * 浏览器拖进来的文件夹只会走 content（单条），套件需要服务端直读路径。
 */
export function readImportSources({ filePath = '', content = '' } = {}) {
  const target = String(filePath || '').trim()
  if (target !== '') {
    let stat = null
    try {
      stat = fs.statSync(target)
    } catch {
      throw new Error(`读不到这个路径：${target}`)
    }
    if (stat.isFile()) return [readImportSource({ filePath: target })]
    if (!stat.isDirectory()) throw new Error(`不是一个文件或文件夹：${target}`)
    const subSkills = fs.readdirSync(target, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(target, entry.name))
      .filter((dir) => findSkillDoc(dir) !== null)
    // 根上有 SKILL.md：可能是单个技能，也可能是「套件总入口 + 一堆子技能」（ai-base-tools 就是）。
    // 有子技能就一起按套件导入——不然点了整包也只进得去总入口那一条。
    if (findSkillDoc(target) !== null) {
      if (subSkills.length === 0) return [readImportSource({ filePath: target })]
      return [readImportSource({ filePath: target }), ...subSkills.map((dir) => readImportSource({ filePath: dir }))]
    }
    if (subSkills.length === 0) {
      throw new Error(`这个文件夹里没有 SKILL.md，也没有带 SKILL.md 的子目录（技能套件要求每个技能一个子目录）：${target}`)
    }
    return subSkills.map((dir) => readImportSource({ filePath: dir }))
  }
  return [readImportSource({ content })]
}

const PACKAGE_MAX_BYTES = 120 * 1024 * 1024
const PACKAGE_MAX_FILES = 20000
const PACKAGE_MAX_FILE_BYTES = 8 * 1024 * 1024
const PACKAGE_SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.idea', '.vscode', 'dist', 'build'])

/**
 * 把来源技能目录**整包**复制进 `<dataDir>/skills/<slug>/`。
 *
 * 之前只落 SKILL.md，技能包里的 scripts/、references/、templates/ 全丢了——
 * 那些恰恰是技能能跑起来的部分。这里按目录递归复制，带三道闸：
 * 单文件 ≤8MB、总文件 ≤20000、总大小 ≤120MB；超了只跳过并如实记在 package.skipped。
 * `files` 仍只登记 scripts/（≤40 条），避免上万条把 skill.json 撑爆。
 */
export function copySkillPackage(dataDir, slug, fromDir, options = {}) {
  const target = skillDirOf(dataDir, slug)
  const dirs = new Set()
  const scriptFiles = []
  let fileCount = 0
  let bytes = 0
  let skipped = 0
  const walk = (current, rel) => {
    let entries = []
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (PACKAGE_SKIP_DIRS.has(entry.name)) continue
      const from = path.join(current, entry.name)
      const relPath = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory()) {
        dirs.add(relPath.split('/')[0])
        walk(from, relPath)
        continue
      }
      if (!entry.isFile()) continue
      if (fileCount >= PACKAGE_MAX_FILES || bytes > PACKAGE_MAX_BYTES) {
        skipped += 1
        continue
      }
      const stat = fs.statSync(from)
      if (stat.size > PACKAGE_MAX_FILE_BYTES) {
        skipped += 1
        continue
      }
      const to = path.join(target, ...relPath.split('/'))
      fs.mkdirSync(path.dirname(to), { recursive: true })
      fs.copyFileSync(from, to)
      bytes += stat.size
      fileCount += 1
      if (/^scripts\//u.test(relPath) && stat.size <= 2 * 1024 * 1024) {
        scriptFiles.push({
          path: relPath,
          bytes: stat.size,
          sha256: createHash('sha256').update(fs.readFileSync(to)).digest('hex'),
          addedAt: new Date().toISOString(),
        })
      }
    }
  }
  walk(fromDir, '')
  const dirsList = [...dirs].sort()
  if (options.writeMeta !== false) {
    const metaPath = path.join(target, 'skill.json')
    let meta = {}
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
    } catch {
      meta = {}
    }
    meta.package = {
      source: fromDir,
      files: fileCount,
      bytes,
      dirs: dirsList,
      skipped,
      copiedAt: new Date().toISOString(),
    }
    if (scriptFiles.length > 0) {
      const merged = Array.isArray(meta.files) ? [...meta.files] : []
      for (const file of scriptFiles) {
        const index = merged.findIndex((item) => item && item.path === file.path)
        if (index >= 0) merged[index] = file
        else merged.push(file)
      }
      meta.files = merged.slice(0, 40)
    }
    fs.writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
  }
  return { fileCount, bytes, dirs: dirsList, skipped }
}

/* -------------------------------------------------------------------------- */
/* 套件树导入                                                                  */
/* -------------------------------------------------------------------------- */

const GENERIC_SUITE_NAMES = new Set(['skills', 'skill', 'skills-master', 'skills-main', 'skills-dev'])

function safeRootName(raw) {
  const candidate = String(raw || '').trim() || 'suite'
  try {
    return assertSafePathSegment(candidate)
  } catch {
    return slugify(candidate) || `suite-${Date.now().toString(36)}`
  }
}

function collectSkillDocs(dir, rel, out, depth = 0) {
  if (depth > 12) return
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('.')) continue
    if (SKILL_SCAN_SKIP_DIRS.has(entry.name)) continue
    const childDir = path.join(dir, entry.name)
    const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
    const doc = findSkillDoc(childDir)
    if (doc !== null) {
      const stat = fs.statSync(doc)
      if (stat.size > MAX_IMPORT_BYTES) throw new Error(`文件太大（${stat.size} 字节），上限 ${MAX_IMPORT_BYTES}：${doc}`)
      out.push({
        relPath: childRel,
        name: entry.name,
        text: fs.readFileSync(doc, 'utf8'),
        file: doc,
        dir: childDir,
      })
    }
    collectSkillDocs(childDir, childRel, out, depth + 1)
  }
}

/**
 * 读导入来源的目录树：
 * - 单文件 / 粘贴正文 → single；
 * - 文件夹里只有一个 SKILL.md → single（保持旧行为，按一个技能导入）；
 * - 文件夹里 ≥2 个 SKILL.md（含根上的总入口）→ suite，子技能按相对路径保留。
 */
export function readImportTree({ filePath = '', content = '' } = {}) {
  const target = String(filePath || '').trim()
  if (target === '') {
    const pasted = String(content || '')
    if (pasted.trim() === '') throw new Error('要么给一个 SKILL.md 路径，要么粘贴正文')
    if (Buffer.byteLength(pasted, 'utf8') > MAX_IMPORT_BYTES) throw new Error(`正文太大，上限 ${MAX_IMPORT_BYTES} 字节`)
    return { mode: 'single', rootName: '', sourceDir: '', singlePath: '', nodes: [{ relPath: '', text: pasted, file: '', dir: '' }] }
  }
  let stat = null
  try {
    stat = fs.statSync(target)
  } catch {
    throw new Error(`读不到这个路径：${target}`)
  }
  if (stat.isFile()) {
    return { mode: 'single', rootName: '', sourceDir: '', singlePath: target, nodes: [] }
  }
  if (!stat.isDirectory()) throw new Error(`不是一个文件或文件夹：${target}`)
  const nodes = []
  const rootDoc = findSkillDoc(target)
  if (rootDoc !== null) {
    const rootStat = fs.statSync(rootDoc)
    if (rootStat.size > MAX_IMPORT_BYTES) throw new Error(`文件太大（${rootStat.size} 字节），上限 ${MAX_IMPORT_BYTES}`)
    nodes.push({ relPath: '', name: path.basename(target), text: fs.readFileSync(rootDoc, 'utf8'), file: rootDoc, dir: target })
  }
  collectSkillDocs(target, '', nodes)
  if (nodes.length === 0) {
    throw new Error(`这个文件夹里没有 SKILL.md，也没有带 SKILL.md 的子目录（技能套件要求每个技能一个子目录）：${target}`)
  }
  if (nodes.length === 1) {
    return { mode: 'single', rootName: '', sourceDir: nodes[0].dir, singlePath: nodes[0].dir, nodes }
  }
  let rootName = path.basename(target)
  if (GENERIC_SUITE_NAMES.has(rootName.toLowerCase())) {
    rootName = path.basename(path.dirname(target)) || rootName
  }
  return { mode: 'suite', rootName: safeRootName(rootName), sourceDir: target, singlePath: '', nodes }
}

/** 目录摘要：文件数/字节/一级目录，写进 skill.json 的 package。 */
function summarizeDir(dir) {
  const dirs = new Set()
  let files = 0
  let bytes = 0
  let skipped = 0
  const walk = (current, rel) => {
    let entries = []
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      if (PACKAGE_SKIP_DIRS.has(entry.name)) continue
    }
  }
  walk(dir, '')
  return { source: dir, files, bytes, dirs: [...dirs].sort(), skipped, copiedAt: new Date().toISOString() }
}

function existingMetaOf(dir, id) {
  const skill = readSkill(dir, id)
  return skill !== null ? skill.meta : defaultMeta(id)
}

/** 套件目录：整棵树复制一次，再给每个 SKILL.md 写账本（不重写正文，保持来源原样）。 */
async function importSuiteTree({ dataDir, tree, typeNames, categories, notes, deps }) {
  const rootName = tree.rootName
  const existingIds = new Set(listSkills(dataDir).map((skill) => skill.id))
  const copied = copySkillPackage(dataDir, rootName, tree.sourceDir, { writeMeta: false })
  const getLlm = typeof deps.getLlm === 'function' ? deps.getLlm : () => null
  const getRoute = typeof deps.getRoute === 'function' ? deps.getRoute : () => null
  let llm = null
  let route = null
  try {
    llm = getLlm()
  } catch {
    llm = null
  }
  try {
    route = routeOf(getRoute())
  } catch {
    route = null
  }
  const items = []
  for (const node of tree.nodes) {
    const id = node.relPath === '' ? rootName : `${rootName}/${node.relPath}`
    const dir = skillDirOf(dataDir, id)
    const parsed = parseSkillMarkdown(node.text)
    const name = parsed.name.trim() !== '' ? parsed.name.trim() : (node.name || id.split('/').pop())
    const body = parsed.body.trim() !== '' ? parsed.body.trim() : node.text.trim()
    const bySession = await classifyWithSession({ llm, route, text: body, typeNames })
    const decided = bySession !== null ? bySession : localClassify({ text: body, typeNames })
    const meta = existingMetaOf(dir, id)
    meta.id = id
    meta.typeName = decided.category || meta.typeName || ''
    if (Array.isArray(categories)) meta.typeNames = categories.map(String).map((item) => item.trim()).filter((item) => item !== '').slice(0, 12)
    if (Array.isArray(notes)) meta.notes = notes.map(String).map((item) => item.trim()).filter((item) => item !== '').slice(0, 50)
    meta.context = skillTagsOf(decided)
    meta.triggers = skillTagsOf(decided)
    meta.order = createdOrderOf(decided.order)
    meta.package = summarizeDir(dir)
    writeFileAtomic(path.join(dir, META_FILENAME), `${JSON.stringify(meta, null, 2)}\n`)
    items.push({
      action: existingIds.has(id) ? 'updated' : 'created',
      slug: id,
      id,
      name,
      source: node.file,
      category: decided.category,
      tags: decided.tags,
      order: meta.order,
      classifier: decided.classifier,
      model: decided.model || '',
      note: decided.note,
      package: { fileCount: meta.package.files, bytes: meta.package.bytes, dirs: meta.package.dirs, skipped: meta.package.skipped },
    })
  }
  const committed = commitSkills(dataDir, `skill(${rootName}): import suite (${items.length})`)
  return { suite: true, rootName, count: items.length, items, copied, commit: committed }
}

/** 浏览器批量导入：contents 可以是字符串，也可以是 {text, suiteRoot, relPath}。 */
async function importContents({ dataDir, contents, typeNames, categories, notes, deps }) {
  const items = []
  let suiteRoot = ''
  for (const raw of contents) {
    const entry = typeof raw === 'string' ? { text: raw } : (raw && typeof raw === 'object' ? raw : null)
    if (entry === null) continue
    const text = String(entry.text || entry.content || '')
    if (text.trim() === '') continue
    const rootRaw = String(entry.suiteRoot || '').trim()
    const relRaw = String(entry.relPath || '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    let id = ''
    if (rootRaw !== '') {
      const root = assertSafePathSegment(rootRaw)
      suiteRoot = suiteRoot || root
      id = relRaw === '' ? root : `${root}/${assertSafeRelPath(relRaw)}`
    } else if (relRaw !== '') {
      const rel = assertSafeRelPath(relRaw)
      suiteRoot = suiteRoot || rel.split('/')[0]
      id = rel
    }
    items.push(await importSkill({ dataDir, content: text, id, typeNames, categories, notes, deps }))
  }
  return { suite: suiteRoot !== '', rootName: suiteRoot, count: items.length, items }
}

/**
 * 导入一条外部技能。
 *
 * 返回里带 classifier（'session' 或 'local'）与 note，调用方要原样展示——
 * 用户有权知道这次导入到底花没花模型调用。
 */
export async function importSkill({ dataDir, filePath = '', content = '', id = '', typeNames = [], categories = [], notes = [], deps = {} } = {}) {
  if (String(dataDir || '') === '') throw new Error('没有数据目录，无法写入技能')
  const { text, source, dir: sourceDir = '' } = readImportSource({ filePath, content })
  const parsed = parseSkillMarkdown(text)
  const name = parsed.name.trim() !== ''
    ? parsed.name.trim()
    : (path.basename(String(filePath || '').trim(), path.extname(String(filePath || '').trim())) || '未命名技能')
  const body = parsed.body.trim() !== '' ? parsed.body : text.trim()
  if (body === '') throw new Error('技能正文是空的')

  const getLlm = typeof deps.getLlm === 'function' ? deps.getLlm : () => null
  const getRoute = typeof deps.getRoute === 'function' ? deps.getRoute : () => null
  let llm = null
  try {
    llm = getLlm()
  } catch {
    llm = null
  }
  let route = null
  try {
    route = routeOf(getRoute())
  } catch {
    route = null
  }

  const bySession = await classifyWithSession({ llm, route, text: body, typeNames })
  const decided = bySession !== null ? bySession : localClassify({ text: body, typeNames })

  const created = createSkill(dataDir, {
    // 套件子技能由调用方给相对路径 id；普通导入仍按名字生成顶层 slug。
    id: id || undefined,
    name,
    description: parsed.description,
    body,
    typeName: decided.category,
    typeNames: Array.isArray(categories) ? categories : [],
    notes: Array.isArray(notes) ? notes : [],
    // 中文摘要直接进标签：英文技能靠中文标签才能被中文任务匹配到（匹配读 name/description/tags）。
    context: skillTagsOf(decided),
    triggers: skillTagsOf(decided),
    // 新建技能一律先从高位起步（模型给的 order 只在更高时才采用），
    // 刚加进来的技能先让人看见、能被触发，之后靠实际使用回归正常。
    order: createdOrderOf(decided.order),
  })

  // 来源是文件夹（或 SKILL.md 本身）时，把 scripts/references/templates 一起搬进来
  const packed = sourceDir !== '' ? copySkillPackage(dataDir, created.slug, sourceDir) : null
  if (packed !== null) commitSkills(dataDir, `skill(${created.slug}): import package`)

  return {
    action: created.action,
    slug: created.slug,
    id: created.slug,
    name,
    source,
    category: decided.category,
    tags: decided.tags,
    order: createdOrderOf(decided.order),
    classifier: decided.classifier,
    model: decided.model || '',
    note: decided.note,
    package: packed,
  }
}

/**
 * 导入一到多个技能。
 * - 路径指向套件文件夹：整棵目录一次复制，子技能按相对路径保留（不再摊平）；
 * - 浏览器 contents：按 suiteRoot/relPath 还原层级；
 * - 单文件/单技能文件夹：仍按一个顶层技能导入。
 * 每个技能都会真实走一次分类（模型会话或本地关键词），界面上要如实说明。
 */
export async function importSkills({ dataDir, filePath = '', content = '', contents = [], typeNames = [], categories = [], notes = [], deps = {} } = {}) {
  const contentItems = Array.isArray(contents) ? contents : []
  if (contentItems.length > 0) {
    return importContents({ dataDir, contents: contentItems, typeNames, categories, notes, deps })
  }
  const target = String(filePath || '').trim()
  const tree = readImportTree({ filePath: target, content: target === '' ? content : '' })
  if (tree.mode === 'suite') {
    return importSuiteTree({ dataDir, tree, typeNames, categories, notes, deps })
  }
  const item = await importSkill({
    dataDir,
    filePath: tree.singlePath || '',
    content: target === '' ? content : '',
    typeNames,
    categories,
    notes,
    deps,
  })
  return { suite: false, count: 1, items: [item] }
}
