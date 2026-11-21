/**
 * 技能沉淀（0.29.0）：`.exp/skills/` 下每技能一个文件夹。
 *
 * - `SKILL.md`：标准技能模板（name/description + 正文），可直接注册；
 * - `skill.json`：引擎账本（confidence/obstacles/resolved/derivedFrom/pendingCommit）；
 * - 仓库根在 `.exp`（`.exp/.git`），引擎只提交 `skills/` 路径；
 * - 事件按「障碍签名」独立记录：干净成功给每个活跃签名各记 clean；
 *   同一签名连续 3 次 → 覆盖技能并归档，之后复发从 1 重新累计。
 *
 * 0.45.0 拆分（纯搬代码，行为与导出面不变）：路径与安全校验 → skill-paths.js；
 * 磁盘表示（SKILL.md/skill.json/附件清单）→ skill-files.js；列表与提示段缓存、全局注册、
 * 套件树、附件挂载与 git 提交 → skill-registry.js。本文件保留匹配、沉淀、目录与复用回执，
 * 并把三个新模块的导出名原样转出。
 */

import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

import { abstractState, stateSimilarity } from './kernel.js'
import { DEFAULT_SKILL_VOLATILITY, HALF_LIFE_DAYS } from './retrieval.js'

import {
  SKILLS_DIRNAME,
  SCRIPTS_DIRNAME,
  SKILL_FILENAME,
  META_FILENAME,
  skillsRootOf,
  assertSafeSlug,
  assertSafePathSegment,
  assertSafeRelPath,
  pathIsLink,
  skillDirOf,
  slugify,
  SKILL_SCAN_SKIP_DIRS,
} from './skill-paths.js'

import {
  RESOLVED_LIMIT,
  writeFileAtomic,
  defaultMeta,
  readSkill,
  readSkillBySlug,
  runnerForScript,
  skillRuntimeOf,
  clipSkillBody,
  writeSkill,
  normalizeMeta,
  readJsonFile,
  writeJsonFile,
  headingIndex,
  sectionBounds,
  safeSliceEnd,
} from './skill-files.js'

import {
  listSkills,
  listSkillsCached,
  clearSkillsHintCache,
  attachSkillFiles,
  dshGlobalSkillsRoot,
  globalRegistrationOf,
  registerSkillGlobally,
  unregisterSkillFromDsh,
  updateSkillMeta,
  forgetSkill,
  buildSkillTree,
  subtreeSkills,
  findSkillTreeNode,
  registerSkillTree,
  unregisterSkillTree,
  forgetSkillTree,
  rewriteSkillIds,
  moveSkillToTop,
  applySkillNodeAction,
  ensureSkillsRepo,
  commitSkills,
  sleepSync,
} from './skill-registry.js'
export const EXCEPTION_LIMIT = 5

export const EVENTS_LIMIT = 10
export const MATCH_MIN_SIMILARITY = 0.12
export const MATCH_AMBIGUITY_MARGIN = 0.15
export const CONFIDENT_MIN_USES = 3
export const CONFIDENT_MIN_RATIO = 0.8

/** 错误文本归一化：去路径/时间戳/行号，保留错误码与关键 token。 */
export function normalizeSignature(text) {
  let out = String(text || '').split(/\r?\n/)[0]
  out = out.toLowerCase()
  out = out.replace(/[a-z]:\\[^\s]+/g, ' ')
  out = out.replace(/\\\\[^\s]+/g, ' ')
  out = out.replace(/\d{4}-\d{2}-\d{2}[t ][\d:.]+z?/g, ' ')
  // 只去掉「行号」类数字，保留错误码/版本号（err-1、PS 5.1）。
  out = out.replace(/(?:line|行|第)\s*\d+(?:\s*行)?/gi, ' ')
  out = out.replace(/:\d+:\d+/g, ' ')
  out = out.replace(/\s+/g, ' ').trim()
  return out === '' ? 'obstacle' : out.slice(0, 80)
}

export function summarizeSignature(text) {
  const line = String(text || '').split(/\r?\n/)[0].replace(/\s+/g, ' ').trim()
  return line === '' ? '未命名障碍' : line.slice(0, 60)
}

/** 从同族经验归纳出技能草稿：≥minSamples 条、≥2 正 ≥1 负、抽共同词与反例。 */
export function deriveSkillDraft(candidates, options = {}) {
  const intent = String(options.intent || '').trim()
  const minSamples = Math.max(2, Math.trunc(Number(options.minSamples) || 3))
  const rows = []
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    for (const evidence of candidate.evidence || []) {
      if (!rows.some((row) => row.id === evidence.id)) rows.push(evidence)
    }
  }
  const groups = new Map()
  for (const row of rows) {
    const key = String(row.typeName || '未分类')
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(row)
  }
  let best = null
  for (const [typeName, list] of groups) {
    if (best === null || list.length > best.list.length) best = { typeName, list }
  }
  if (best === null || best.list.length < minSamples) return null
  const positives = best.list.filter((row) => (Number(row.G) || 0) > 0)
  const negatives = best.list.filter((row) => (Number(row.G) || 0) < 0)
  if (positives.length < 2 || negatives.length === 0) return null
  const tokenFreq = (subset) => {
    const freq = new Map()
    for (const row of subset) {
      // 动作词优先：意图里通常只有「PPT/插页」这类主题词，抽进「做法」会把规则写空。
      let state = abstractState(String(row.action || ''))
      let tokens = new Set([...(state.tokens || []).filter((token) => String(token).length >= 2), ...(state.cgrams || [])])
      if (tokens.size === 0) {
        state = abstractState(`${row.intent || ''} ${row.action || ''}`)
        tokens = new Set([...(state.tokens || []).filter((token) => String(token).length >= 2), ...(state.cgrams || [])])
      }
      for (const token of tokens) if (String(token).length >= 2) freq.set(token, (freq.get(token) || 0) + 1)
    }
    return freq
  }
  const posFreq = tokenFreq(positives)
  const negFreq = tokenFreq(negatives)
  const need = Math.max(2, Math.ceil(positives.length * 0.6))
  const shared = [...posFreq.entries()].filter(([, count]) => count >= need).map(([token]) => token)
  const avoid = [...negFreq.keys()].filter((token) => !shared.includes(token))
  if (shared.length === 0 && avoid.length === 0) return null
  const label = options.name || `${best.typeName}：${shared[0] || avoid[0] || '经验'}`
  const positiveActions = [...new Set(positives.map((row) => String(row.action || '').trim()).filter(Boolean))].slice(0, 3)
  const negativeActions = [...new Set(negatives.map((row) => String(row.action || '').trim()).filter(Boolean))].slice(0, 3)
  const procedure = positiveActions.length > 0
    ? positiveActions.map((action) => `- 优先：${action.slice(0, 80)}`).join('\n')
    : '- （按经验做法执行）'
  const avoidLines = negativeActions.length > 0
    ? negativeActions.map((action) => `- 避免：${action.slice(0, 80)}`).join('\n')
    : '- （暂无明确反例）'
  return {
    slug: slugify(label),
    name: label.slice(0, 48),
    description: (intent || label).slice(0, 120),
    typeName: best.typeName,
    context: Array.isArray(options.context) ? options.context : [],
    triggers: [...shared, ...avoid].slice(0, 8),
    derivedFrom: best.list.map((row) => row.id),
    body: `# 何时用\n${intent || label}\n\n## 做法\n${procedure}\n\n## 避免\n${avoidLines}\n\n## 常见例外\n`,
  }
}

/**
 * 按技能树顶层目录分组（0.37 P1/P2 共用）。
 *
 * 组 = slug 的第一段；套件入口技能的 slug 没有斜杠（`ai-base-tools`），
 * 只要存在 `ai-base-tools/...` 的子技能，就把它算进同名组（按磁盘目录直读会得到同样的结果）。
 * 根下没有任何子技能的独立技能归「未分组」，与各组并列。
 *
 * @param {object[]} skills - `listSkills` / `listSkillsCached` 的返回
 * @returns {{groups: {name: string, skills: object[]}[], ungrouped: object[]}}
 */
export function skillGroupsOf(skills) {
  const list = Array.isArray(skills) ? skills : []
  const slugs = list.map((skill) => String((skill && (skill.slug || skill.id)) || ''))
  const groupNames = new Set()
  for (const slug of slugs) {
    const cut = slug.indexOf('/')
    if (cut > 0) groupNames.add(slug.slice(0, cut))
  }
  const groups = new Map()
  for (const name of [...groupNames].sort()) groups.set(name, [])
  const ungrouped = []
  for (let index = 0; index < list.length; index += 1) {
    const slug = slugs[index]
    const cut = slug.indexOf('/')
    if (cut > 0) {
      groups.get(slug.slice(0, cut)).push(list[index])
    } else if (groupNames.has(slug)) {
      groups.get(slug).push(list[index])
    } else {
      ungrouped.push(list[index])
    }
  }
  return {
    groups: [...groups.entries()].map(([name, items]) => ({ name, skills: items })),
    ungrouped,
  }
}

/** 提交 skills/ 路径；失败返回 false（写入仍然保留，调用方记 pendingCommit）。 */
function skillWarningFor(skill, intent) {
  if (!skill) return null
  const text = [skill.name, skill.description, ...(skill.meta.triggers || []), ...(skill.meta.context || [])].join(' ')
  const similarity = stateSimilarity(abstractState(String(intent || '')), abstractState(text))
  // 中文短意图与技能描述的词面相似度天然很低（正确技能实测 0.035），阈值压到 0.01：
  // 只有几乎零重叠才提示「可能写错」，避免正常调用被误报。
  return similarity < 0.01
    ? `skillId 与 intent 的相似度只有 ${Math.round(similarity * 100) / 100}，确认没有写错技能（账本已按该 id 更新）。`
    : null
}

function withSkillLock(dataDir, slug, fn, options = {}) {
  const lockDir = path.join(String(dataDir || ''), '.locks')
  fs.mkdirSync(lockDir, { recursive: true })
  // 套件子技能的 id 带 `/`，不能直接当文件名：压成单段，避免把锁写到不存在的子目录。
  const lockName = String(slug || '').replace(/[^\w.\u4e00-\u9fa5-]+/gu, '_').slice(0, 120) || 'skill'
  const lockFile = path.join(lockDir, `${lockName}.lock`)
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : 2000
  const staleMs = Number.isFinite(Number(options.staleMs)) ? Number(options.staleMs) : 5000
  const deadline = Date.now() + timeoutMs
  let fd = null
  while (fd === null) {
    try {
      fd = fs.openSync(lockFile, 'wx')
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      try {
        const stat = fs.statSync(lockFile)
        if (Date.now() - stat.mtimeMs > staleMs) {
          fs.unlinkSync(lockFile)
          continue
        }
      } catch {
        // 锁刚被释放：重试
      }
      if (Date.now() > deadline) return { busy: true }
      sleepSync(20)
    }
  }
  try {
    fs.writeSync(fd, `${process.pid} ${Date.now()}`)
  } finally {
    try { fs.closeSync(fd) } catch { /* 忽略 */ }
  }
  try {
    return { value: fn() }
  } finally {
    try { fs.unlinkSync(lockFile) } catch { /* 锁已不存在也正常 */ }
  }
}

/* -------------------------------------------------------------------------- */
/* 创建                                                                       */
/* -------------------------------------------------------------------------- */

function defaultBody(draft) {
  return `# 何时用\n${draft.description || draft.name}\n\n## 做法\n${draft.procedure || '- （待补充）'}\n\n## 常见例外\n`
}

function mergeSkillBodies(existingBody, draftBody) {
  let merged = String(draftBody || '').trim()
  const existing = String(existingBody || '').split(/\r?\n/)
  for (const title of ['常见例外', '已内化']) {
    const index = headingIndex(existing, title)
    if (index < 0) continue
    const { from, to } = sectionBounds(existing, index)
    const content = existing.slice(from, to).filter((line) => line.trim() !== '')
    if (!content.some((line) => /^-\s/.test(line))) continue
    const draftLines = merged.split(/\r?\n/)
    const draftIndex = headingIndex(draftLines, title)
    if (draftIndex >= 0) {
      const bounds = sectionBounds(draftLines, draftIndex)
      draftLines.splice(draftIndex, bounds.to - draftIndex)
    }
    merged = draftLines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()
    merged += `\n\n## ${title}\n${content.join('\n')}`
  }
  return `${merged.trim()}\n`
}

/** 创建/更新技能（带锁）：同一 id 的读-改-写串行。id 可以是套件里的相对路径。 */
export function createSkill(dataDir, draft) {
  const id = assertSafeRelPath(draft.id || draft.slug || slugify(draft.name))
  const locked = withSkillLock(dataDir, id, () => createSkillUnlocked(dataDir, { ...draft, id }))
  if (locked.busy === true) throw new Error(`技能正在被另一个进程写入：${id}`)
  // 0.37 P0：写路径主动失效，导入/新建后当次可见（目录签名只覆盖到顶层，深层写入靠这一句）。
  clearSkillsHintCache(dataDir)
  return locked.value
}

function persistSkill(dataDir, dir, draft, meta, message) {
  meta.pendingCommit = false
  writeSkill(dir, draft, meta)
  const committed = commitSkills(dataDir, message)
  if (!committed) {
    meta.pendingCommit = true
    writeJsonFile(path.join(dir, META_FILENAME), meta)
  }
  return committed
}

function createSkillUnlocked(dataDir, draft) {
  const id = assertSafeRelPath(draft.id || draft.slug || slugify(draft.name))
  const dir = skillDirOf(dataDir, id)
  const existing = readSkill(dir, id)
  // SKILL.md 暂时读不出（是目录 EISDIR / 文件被删）但账本 skill.json 还在：这仍是「更新已有技能」，
  // 不能当新建把累积的 confidence/obstacles 冲回默认值（D1 的写路径一侧；读路径见 readSkill 的 try）。
  const metaPath = path.join(dir, META_FILENAME)
  const orphanLedger = existing === null && fs.existsSync(metaPath)
  const action = existing !== null || orphanLedger ? 'updated' : 'created'
  const meta = existing !== null
    ? existing.meta
    : orphanLedger ? normalizeMeta(readJsonFile(metaPath), id) : defaultMeta(id)
  meta.id = id
  meta.typeName = draft.typeName || meta.typeName || ''
  if (Array.isArray(draft.typeNames)) meta.typeNames = draft.typeNames.map(String).map((item) => item.trim()).filter((item) => item !== '').slice(0, 12)
  if (Array.isArray(draft.notes)) meta.notes = draft.notes.map(String).map((item) => item.trim()).filter((item) => item !== '').slice(0, 50)
  meta.context = Array.isArray(draft.context) ? draft.context : meta.context
  meta.triggers = Array.isArray(draft.triggers) ? draft.triggers : meta.triggers
  if (draft.order !== undefined && Number.isFinite(Number(draft.order))) {
    meta.order = Math.max(0, Math.min(100, Math.round(Number(draft.order))))
  }
  if (Array.isArray(draft.derivedFrom)) {
    meta.derivedFrom = [...new Set([...meta.derivedFrom, ...draft.derivedFrom.map(String)])].slice(0, 50)
  }
  const body = typeof draft.body === 'string' && draft.body.trim() !== ''
    ? (existing !== null ? mergeSkillBodies(existing.body, draft.body) : draft.body.trim())
    : (existing !== null ? existing.body : defaultBody(draft))
  const message = action === 'created'
    ? `skill: ${id} — 创建（源自 ${meta.derivedFrom.length} 条经验）`
    : `skill: ${id} — 更新定义`
  const committed = persistSkill(dataDir, dir, {
    name: draft.name || (existing !== null ? existing.name : id),
    description: draft.description || (existing !== null ? existing.description : ''),
    body,
  }, meta, message)
  return { action, slug: id, id, dir, commit: committed }
}

/* -------------------------------------------------------------------------- */
/* 计数与修订                                                                  */
/* -------------------------------------------------------------------------- */

export function highConfidence(meta) {
  const confidence = (meta && meta.confidence) || {}
  const helped = Number(confidence.helped) || 0
  const hurt = Number(confidence.hurt) || 0
  const uses = helped + hurt
  const ratio = uses === 0 ? 0 : helped / uses
  const open = Object.values((meta && meta.obstacles) || {}).some((entry) => (Number(entry.streak) || 0) >= 3)
  return uses >= CONFIDENT_MIN_USES && ratio >= CONFIDENT_MIN_RATIO && !open
}

/** 给模型看的置信说明：helped 比例 + 未解决连续障碍。 */
export function confidenceReason(meta) {
  const confidence = (meta && meta.confidence) || {}
  const helped = Number(confidence.helped) || 0
  const hurt = Number(confidence.hurt) || 0
  const uses = helped + hurt
  const ratio = uses === 0 ? 0 : Math.round((helped / uses) * 100) / 100
  const open = Object.entries((meta && meta.obstacles) || {})
    .filter(([, entry]) => (Number(entry.streak) || 0) >= 3)
    .map(([signature]) => signature)
  return `helped ${helped}/${uses}（比例 ${ratio}）${open.length > 0 ? `；未解决连续障碍：${open.join('、')}` : '；无未解决连续障碍'}`
}

/** 校验单个技能的账本/正文不变量；返回问题数组（空 = 健康）。 */
export function validateSkill(skill) {
  if (!skill) return ['技能为空']
  const problems = []
  if (!skill.name) problems.push('name 为空')
  if (!skill.description) problems.push('description 为空')
  const meta = skill.meta || {}
  const confidence = meta.confidence || {}
  const uses = Number(confidence.uses) || 0
  const helped = Number(confidence.helped) || 0
  const hurt = Number(confidence.hurt) || 0
  if (uses !== helped + hurt) problems.push('uses != helped + hurt')
  if (helped < 0 || hurt < 0 || uses < 0) problems.push('confidence 出现负数')
  if (typeof meta.pendingCommit !== 'boolean') problems.push('pendingCommit 不是布尔')
  for (const file of Array.isArray(meta.files) ? meta.files : []) {
    if (!file || typeof file.path !== 'string' || file.path.trim() === '') {
      problems.push('files 有条目缺少 path')
      continue
    }
    const abs = path.join(skill.dir || '', file.path)
    if (skill.dir === undefined || !fs.existsSync(abs)) problems.push(`附件缺失：${file.path}`)
  }
  const obstacles = meta.obstacles && typeof meta.obstacles === 'object' ? meta.obstacles : {}
  for (const [signature, entry] of Object.entries(obstacles)) {
    const total = Number(entry.total) || 0
    const streak = Number(entry.streak) || 0
    if (total < 0 || streak < 0) problems.push(`活跃签名 ${signature} 出现负数`)
    if (total < streak) problems.push(`活跃签名 ${signature}：total < streak`)
    if (Array.isArray(entry.events) && entry.events.length > EVENTS_LIMIT) problems.push(`活跃签名 ${signature}：events > ${EVENTS_LIMIT}`)
  }
  const resolved = Array.isArray(meta.resolved) ? meta.resolved : []
  if (resolved.length > RESOLVED_LIMIT) problems.push(`resolved > ${RESOLVED_LIMIT}`)
  const seen = new Set()
  for (const item of resolved) {
    const signature = String((item && item.signature) || '')
    if (seen.has(signature)) problems.push(`resolved 重复：${signature}`)
    seen.add(signature)
    if (obstacles[signature]) problems.push(`签名同时活跃与归档：${signature}`)
  }
  const headings = String(skill.body || '').split(/\r?\n/).filter((line) => /^##\s/.test(line)).map((line) => line.replace(/^##\s+/, '').trim())
  for (const title of ['常见例外', '已内化']) {
    if (headings.filter((heading) => heading === title).length > 1) problems.push(`正文重复段：${title}`)
  }
  return problems
}

/** 扫描全部技能并返回有问题的条目。 */
export function validateAllSkills(dataDir) {
  return listSkills(dataDir)
    .map((skill) => {
      const problems = validateSkill(skill)
      if (skill.meta && skill.meta.corrupt === true) problems.push(String(skill.meta.metaError || '技能账本损坏'))
      return { slug: skill.slug, problems }
    })
    .filter((item) => item.problems.length > 0)
}

/** 查询拆成可比较的单元（英文 token + 中文字二元组），小写去重。 */
function queryUnits(query) {
  return [...new Set([...(query.tokens || []), ...(query.cgrams || [])]
    .map((unit) => String(unit || '').toLowerCase())
    .filter((unit) => unit.length > 1))]
}

/**
 * 查询单元的 IDF 权重：在越少技能里出现的词越值钱。
 * 「左右镜像」「编程板」「页码」这种专有短语权重高，「课件」「程序」这种到处都是的权重低——
 * 否则套件总入口那段超长描述会把所有意图都吸走。
 */
function unitIdf(units, corpusTexts) {
  const total = Math.max(1, corpusTexts.length)
  const idf = new Map()
  for (const unit of units) {
    let df = 0
    for (const text of corpusTexts) {
      if (text.includes(unit)) df += 1
    }
    idf.set(unit, Math.log(1 + total / (1 + df)))
  }
  return idf
}

/** 加权覆盖率：命中单元的权重和 / 查询总权重。 */
function weightedCoverage(units, idf, candidateText) {
  const text = String(candidateText || '')
  let total = 0
  let hit = 0
  for (const unit of units) {
    const weight = idf.get(unit) || 0
    total += weight
    if (text.includes(unit)) hit += weight
  }
  return total === 0 ? 0 : hit / total
}

export function matchSkill(skills, intent, options = {}) {
  const list = Array.isArray(skills) ? skills : []
  const query = abstractState(String(intent || ''))
  // R3 缺陷（既有路径）：context 里放 null 原型对象 / toString 抛错的对象时 String() 会崩；
  // 逐项兜住，保留数字/布尔等可字符串化的值，只跳过真转不了的。
  const queryContext = Array.isArray(options.context)
    ? options.context.flatMap((tag) => {
      try {
        return [String(tag).toLowerCase()]
      } catch {
        return []
      }
    })
    : []
  const units = queryUnits(query)
  const corpusTexts = list.map((skill) => [skill.name, skill.description, ...(skill.meta.triggers || []), ...(skill.meta.context || [])].join(' ').toLowerCase())
  const idf = unitIdf(units, corpusTexts)
  const candidates = []
  for (let index = 0; index < list.length; index += 1) {
    const skill = list[index]
    if (options.requireConfident !== false && !highConfidence(skill.meta)) continue
    const text = corpusTexts[index]
    const headText = [skill.name, String(skill.description || '').slice(0, 160)].join(' ').toLowerCase()
    const jaccardScore = stateSimilarity(query, abstractState(text))
    const coverage = weightedCoverage(units, idf, text)
    const headCoverage = weightedCoverage(units, idf, headText)
    // 三块拼起来：
    // ① jaccard 兜通用词面；② 加权覆盖率补「关键短语命中」；
    // ③ 名称/描述前 160 字的覆盖率再给一次加成——技能真正讲的主题通常在开头，
    //    这样「编程板」「研学」这类开头就点题的技能不会被长描述或套件入口挤掉。
    // 另按描述长度做 specificity：超长描述（套件总入口 600+ 字）命中一切，需要压一档。
    const specificity = Math.min(1, 500 / Math.max(200, text.length))
    const similarity = jaccardScore + coverage * (0.2 + jaccardScore) * specificity + 0.25 * headCoverage 
    if (similarity < (Number(options.minSimilarity) || MATCH_MIN_SIMILARITY)) continue
    let contextScore = 0
    if (queryContext.length > 0) {
      const tags = (skill.meta.context || []).map((tag) => String(tag).toLowerCase())
      if (tags.length > 0) {
        const hit = queryContext.filter((tag) => tags.includes(tag)).length
        // 情境不匹配 = 技能不适用于当前环境：直接跳过，而不是只少加一点分。
        if (hit === 0) continue
        contextScore = hit / queryContext.length
      }
    }
    // 刚加进来的技能（还没被用过）给一点「新鲜度」加成：先让它有机会被触发，
    // 一有反馈（uses>0）就回落，排序随实际使用回归正常。
    const freshBoost = (Number((skill.meta.confidence || {}).uses) || 0) === 0 ? 0.06 : 0
    const score = similarity + contextScore * 0.1 + freshBoost
    // 命中词：把「query 的哪些词在这个技能里找到了」一起带出去，
    // 让模型能自查相关性（命中词跟任务明显无关 = 错配，应该换 intent 重试）。
    const matchedTerms = units.filter((unit) => text.includes(unit)).slice(0, 8)
    candidates.push({ skill, score, size: text.length, matchedTerms })
  }
  if (candidates.length === 0) return null
  candidates.sort((left, right) => right.score - left.score)
  const top = candidates[0]
  if (candidates.length === 1) return top
  const second = candidates[1]
  // 分数接近时不再直接放弃（交回经验列表），而是选「更具体」的那个：
  // 套件总入口 / 合集类技能描述长、什么都沾一点，同一个主题下应该让给专门的子技能。
  // 只有两者长度也接近才放弃，避免「随机选一个」。
  if (second.score >= top.score * (1 - MATCH_AMBIGUITY_MARGIN)) {
    const tight = Math.min(top.score, second.score) / Math.max(top.score, second.score)
    if (tight >= 0.92) {
      const specific = top.size <= second.size ? top : second
      const other = specific === top ? second : top
      if (specific.size >= other.size * 0.9) return null
      return specific
    }
    return null
  }
  return top
}

function upsertBullet(lines, title, key, text) {
  let index = headingIndex(lines, title)
  if (index < 0) {
    lines.push('', `## ${title}`, text)
    return
  }
  const { from, to } = sectionBounds(lines, index)
  for (let i = from; i < to; i += 1) {
    if (lines[i].startsWith(`- ${key}`)) { lines[i] = text; return }
  }
  lines.splice(to, 0, text)
}

function removeBullet(lines, title, key) {
  const index = headingIndex(lines, title)
  if (index < 0) return
  const { from, to } = sectionBounds(lines, index)
  for (let i = from; i < to; i += 1) {
    if (lines[i].startsWith(`- ${key}`)) {
      lines.splice(i, 1)
      break
    }
  }
  // 删掉空标题，避免正文残留「## 已内化」空段。
  const freshIndex = headingIndex(lines, title)
  if (freshIndex < 0) return
  const fresh = sectionBounds(lines, freshIndex)
  if (lines.slice(fresh.from, fresh.to).some((line) => line.trim() !== '')) return
  let end = freshIndex + 1
  while (end < lines.length && lines[end].trim() === '') end += 1
  lines.splice(freshIndex, end - freshIndex)
  if (freshIndex > 0 && lines[freshIndex - 1].trim() === '' && (freshIndex >= lines.length || lines[freshIndex].trim() === '')) lines.splice(freshIndex - 1, 1)
}

function pruneBullets(lines, title, limit, mergeLabel) {
  const index = headingIndex(lines, title)
  if (index < 0) return
  const { from, to } = sectionBounds(lines, index)
  const bullets = []
  for (let i = from; i < to; i += 1) if (/^-\s/.test(lines[i])) bullets.push(i)
  if (bullets.length <= limit) return
  const dropCount = bullets.length - limit + 1
  const drop = bullets.slice(0, dropCount)
  for (const lineNumber of [...drop].reverse()) lines.splice(lineNumber, 1)
  const freshIndex = headingIndex(lines, title)
  const fresh = sectionBounds(lines, freshIndex)
  lines.splice(fresh.to, 0, `- ${mergeLabel}（合并 ${dropCount} 条）`)
}

function exceptionText(label, total, now) {
  return `- ${label}（出现 ${total} 次，最近 ${now.slice(0, 10)}）`
}

function normalizeBody(lines) {
  const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n\n(?=-\s)/g, '\n')
  return `${text.trimEnd()}\n`
}

function applyObstacle(skill, signature, label, now) {
  const meta = skill.meta
  const obstacles = meta.obstacles
  const lines = String(skill.body || '').split(/\r?\n/)
  const existing = obstacles[signature]
  if (existing === undefined) {
    const revived = meta.resolved.some((item) => item.signature === signature)
    obstacles[signature] = { total: 1, streak: 1, events: ['hit'], lastAt: now, label }
    if (revived) {
      removeBullet(lines, '已内化', label)
      meta.resolved = meta.resolved.filter((item) => item.signature !== signature)
    }
    upsertBullet(lines, '常见例外', label, exceptionText(label, 1, now))
    pruneBullets(lines, '常见例外', EXCEPTION_LIMIT, '其它历史例外')
    return { action: revived ? 'reopened' : 'appended', total: 1, streak: 1, body: normalizeBody(lines) }
  }
  existing.total += 1
  existing.streak = (Number(existing.streak) || 0) + 1
  existing.events = [...(existing.events || []), 'hit'].slice(-EVENTS_LIMIT)
  existing.lastAt = now
  if (existing.streak < 3) {
    upsertBullet(lines, '常见例外', existing.label, exceptionText(existing.label, existing.total, now))
    pruneBullets(lines, '常见例外', EXCEPTION_LIMIT, '其它历史例外')
    return { action: 'appended', total: existing.total, streak: existing.streak, body: normalizeBody(lines) }
  }
  // 连续第 3 次：覆盖并归档该签名。
  const finalTotal = existing.total
  removeBullet(lines, '常见例外', existing.label)
  upsertBullet(lines, '已内化', existing.label, `- ${existing.label}（${now.slice(0, 10)} 覆盖）`)
  pruneBullets(lines, '已内化', 10, '更早的内化记录')
  meta.resolved = [...meta.resolved, {
    signature,
    total: finalTotal,
    revisions: (Number(meta.revisions) || 0) + 1,
    archivedAt: now,
  }].slice(-RESOLVED_LIMIT)
  meta.revisions = (Number(meta.revisions) || 0) + 1
  delete obstacles[signature]
  return { action: 'replaced', total: finalTotal, streak: 0, body: normalizeBody(lines) }
}

function commitFor(action, slug, signature) {
  if (action === 'replaced') return `skill: ${slug} — 连续 3 次障碍，覆盖并归档（sig: ${signature}）`
  if (action === 'reopened') return `skill: ${slug} — 复发重新累计（sig: ${signature}）`
  return `skill: ${slug} — 追加例外（sig: ${signature}）`
}

/** 撞到障碍：按签名计数，追加/覆盖/复发。 */
function applySkillObstacleUnlocked(dataDir, slug, options = {}) {
  let dir
  try {
    dir = skillDirOf(dataDir, slug)
  } catch {
    return { action: 'invalid', slug }
  }
  const skill = readSkill(dir, slug)
  if (skill === null) return { action: 'missing', slug }
  const signature = normalizeSignature(options.signature || options.blockedBy || 'obstacle')
  const label = options.label || summarizeSignature(options.signature || options.blockedBy || signature)
  const now = new Date().toISOString()
  const result = applyObstacle(skill, signature, label, now)
  const committed = persistSkill(dataDir, dir, { name: skill.name, description: skill.description, body: result.body }, skill.meta, commitFor(result.action, slug, signature))
  const warning = skillWarningFor(skill, options.intent)
  return { ...result, slug, signature, commit: committed, ...(warning ? { warning } : {}) }
}

/** 撞到障碍（带锁）：同一技能串行，避免并发丢更新。 */
export function applySkillObstacle(dataDir, slug, options = {}) {
  let dir
  try {
    dir = skillDirOf(dataDir, slug)
  } catch {
    return { action: 'invalid', slug }
  }
  const locked = withSkillLock(dataDir, assertSafeRelPath(String(slug)), () => applySkillObstacleUnlocked(dataDir, slug, options), options)
  return locked.busy === true ? { action: 'busy', slug } : locked.value
}

/**
 * 把「裸 slug」解析成真实技能 id（0.13.0）：套件里的技能 id 是 `套件/子技能`，
 * 用户/模型常只写子技能名。精确匹配优先；唯一后缀匹配自动补全；歧义或不存在要报错，
 * 绝不静默成功（以前 feedback 裸 slug 返回成功但账本没写）。
 */
export function resolveSkillId(dataDir, raw) {
  // 前缀与 tools.js 的显式技能分支保持一致：`skill:`（显式 id）与 `engram:`（会话技能目录条目名）
  // 都接受，大小写不敏感（模型常把目录名原样抄回来）。
  const wanted = String(raw || '').trim().replace(/^(?:skill|engram):/i, '').replace(/\\/g, '/')
  if (wanted === '') throw new Error('技能 id 不能为空（形如 skill:<套件/技能名>；目录条目名 engram:<slug> 也接受）')
  const skills = listSkills(dataDir, { onlyLocal: true })
  const wantedLower = wanted.toLowerCase()
  const exact = skills.find((item) => String(item.slug || '').toLowerCase() === wantedLower)
  if (exact !== undefined) return String(exact.slug)
  const suffix = skills.filter((item) => String(item.slug || '').toLowerCase().endsWith(`/${wantedLower}`))
  if (suffix.length === 1) return String(suffix[0].slug)
  if (suffix.length > 1) {
    throw new Error(`技能 id 有歧义：${wanted}；候选：${suffix.map((item) => item.slug).join('、')}`)
  }
  const available = skills.slice(0, 8).map((item) => item.slug)
  throw new Error(`没有这个技能：${wanted}${available.length > 0 ? `；可用 id：${available.join('、')}` : '（技能库为空）'}`)
}

/** 用后结果：成功 = helped + 每个活跃签名记 clean；失败 = hurt。 */
function applySkillOutcomeUnlocked(dataDir, slug, result, options = {}) {
  let dir
  try {
    dir = skillDirOf(dataDir, slug)
  } catch {
    return { action: 'invalid', slug }
  }
  const skill = readSkill(dir, slug)
  if (skill === null) return { action: 'missing', slug }
  const now = new Date().toISOString()
  const confidence = skill.meta.confidence
  // neutral（含 pending 未判定）只更新时间，不抬 uses：uses 必须恒等于 helped + hurt。
  if (result === 'helped' || result === 'hurt') {
    confidence.uses = (Number(confidence.uses) || 0) + 1
    if (result === 'helped') confidence.helped = (Number(confidence.helped) || 0) + 1
    else confidence.hurt = (Number(confidence.hurt) || 0) + 1
  }
  confidence.lastUsedAt = now
  if (result === 'helped') {
    // 成功使用 = 一次真实验证（比人工 verify 更强的证据）：写 lastVerifiedAt 并按易腐层重排复核时间。
    // 以前只更 lastUsedAt，界面一直显示「从未验证」，复核时间也只能靠最后使用时间推算。
    skill.meta.lastVerifiedAt = now
    const halfLife = HALF_LIFE_DAYS[skill.meta.volatility] || HALF_LIFE_DAYS[DEFAULT_SKILL_VOLATILITY] || HALF_LIFE_DAYS.semi
    skill.meta.reviewAfter = new Date(Date.parse(now) + halfLife * 86400000).toISOString()
    for (const entry of Object.values(skill.meta.obstacles)) {
      entry.events = [...(entry.events || []), 'clean'].slice(-EVENTS_LIMIT)
      entry.streak = 0
    }
  }
  const committed = persistSkill(dataDir, dir, { name: skill.name, description: skill.description, body: skill.body }, skill.meta, `skill: ${slug} — 用后反馈 ${result}`)
  const warning = skillWarningFor(skill, options.intent)
  return { action: 'feedback', slug, result, confident: highConfidence(skill.meta), commit: committed, ...(warning ? { warning } : {}) }
}

/** 用后结果（带锁）。 */
export function applySkillOutcome(dataDir, slug, result, options = {}) {
  let dir
  try {
    dir = skillDirOf(dataDir, slug)
  } catch {
    return { action: 'invalid', slug }
  }
  const locked = withSkillLock(dataDir, assertSafeRelPath(String(slug)), () => applySkillOutcomeUnlocked(dataDir, slug, result, options), options)
  return locked.busy === true ? { action: 'busy', slug } : locked.value
}

/* -------------------------------------------------------------------------- */
/* 会话级技能复用与技能目录（0.21.x）：P0 记账/复用回执 + P1 目录/补发           */
/* -------------------------------------------------------------------------- */

/**
 * 移植官方 `dsh-tool-skill` 的「目录是投影、按可见面判在不在、不在就整份重发」。
 *
 * 口径（计划书 §1/§3）：
 * - 只借机制，不借宿主 `ctx.skills`；注册表是**纯内存**的，重启即丢（宁可多给一次全文）；
 * - 目录消息手搓成 V2 `UserMessage`（零 `@deepseek-ai/*` import），`source.kind` 用自定义值；
 * - 正文不复原：压缩遮罩后由模型用 `exp_recall({skill, load:true})` 重取。
 */
export const SESSION_CATALOG_KIND = 'engram-skill-catalog'
/** 宿主 `ContextForm` 封闭词表里的「清单」语义。 */
export const CATALOG_FORM = 'catalog'
/** 单会话目录条数上限（同时是注册表 maxGiven 默认值）。 */
export const CATALOG_MAX_SKILLS = 5
/** 目录里每条描述的截断长度默认值。 */
export const CATALOG_DESCRIPTION_CHARS = 300
/** 复用回执（JSON 序列化后）的硬上限，单位字符。 */
export const REUSE_RECEIPT_MAX_CHARS = 400
/** 单进程最多记住多少个会话；超出淘汰最早创建的会话（纯内存，防长跑进程涨）。 */
const SKILL_SESSION_LIMIT = 128
const CATALOG_DIGEST_VERSION = 'engram-catalog-v1'
/** 这些二级标题是收尾节（附件清单/例外清单），不是可对照执行的步骤锚点。 */
const REUSE_ANCHOR_SKIP = new Set(['Resources', '脚本'])
/** 单条锚点的建议上限（含 `## ` 前缀）：超长标题按此截断，保留可辨识前缀。 */
const ANCHOR_MAX_CHARS = 60
/** Markdown 围栏开/收行（锚点只认正文标题，围栏里的 `## ...` 是代码内容）。 */
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/u
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/u
/** 单条锚点继续收紧的长度阶梯：条数优先保留，先短锚点、最后才丢锚点。 */
const ANCHOR_CAP_LADDER = [48, 40, 32]
/** note 压缩到最短语义后，锚点还能再短一档。 */
const ANCHOR_CAP_LADDER_DEEP = [24, 18, 12, 8]
/** 减少条数后重截锚点用的阶梯（条数变少，单条可以更长）。 */
const ANCHOR_CAP_LADDER_SPARSE = [60, 40, 24, 12, 8]
/** 超长 skillFile 收紧后保留的尾部长度（保留即可读回全文）。 */
const SKILL_FILE_TAIL_CHARS = 80
/** 反扫可见面时最多回看的事件数（只有 lastCatalogSeq 缺失时才用这个上限）。 */
const CATALOG_SCAN_LIMIT = 4000

/**
 * 会话级注册表：`Map<sessionId, { skills: Map<slug, entry>, maxGiven, lastCatalogSeq, turnCounter }>`。
 * 纯内存、进程内；键用 sessionId（`tools.js` 的 `hostSessionOf` 已能拿到），不用全局 key。
 */
export const skillSessionRegistry = new Map()

/** 清空注册表（测试/排障用；生产重启本来也会丢）。 */
export function resetSkillSessions() {
  skillSessionRegistry.clear()
}

function positiveInt(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : fallback
}

/** 正文指纹：sha256 前 16 位（写进 usage 行与注册表，用于判断正文是否变过）。 */
export function bodyHashOf(body) {
  return createHash('sha256').update(String(body || ''), 'utf8').digest('hex').slice(0, 16)
}

/** 会话标识短哈希（8 位）：不落原始 sessionId（usage.jsonl 在 git 备份范围）。 */
export function sessionHashOf(sessionId) {
  const raw = String(sessionId || '')
  if (raw === '') return ''
  return createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 8)
}

/**
 * 把「从这里切起」的码元下标收到字符边界：`start` 落在代理对中间（低代理）时退一位，把整个字符纳入。
 * 只在 UTF-16 码元层面取尾部窗口时用（emoji 等非 BMP 字符占 2 个码元）。
 */
function safeSliceStart(value, start) {
  if (start <= 0) return 0
  if (start >= value.length) return value.length
  const at = value.charCodeAt(start)
  if (at < 0xdc00 || at > 0xdfff) return start
  const before = value.charCodeAt(start - 1)
  return before >= 0xd800 && before <= 0xdbff ? start - 1 : start
}

/**
 * 截断到 `max` 个字符（含省略号）：`max <= 0` 返回空串，超长时留前缀 + `…`。
 * 用于把锚点/skillFile/兜底字段压进复用回执的硬预算（按字符计，与 JSON 长度口径接近）。
 * 切片点按字符边界收口：不把 emoji 等代理对切成孤立码元（否则落盘 UTF-8 会变 U+FFFD）。
 */
function clipChars(text, max) {
  const value = String(text === null || text === undefined ? '' : text)
  const cap = Math.trunc(Number(max))
  if (!Number.isFinite(cap) || cap <= 0) return ''
  if (value.length <= cap) return value
  return `${value.slice(0, safeSliceEnd(value, Math.max(1, cap - 1)))}…`
}

/**
 * 锚点：正文二级标题原文，默认取前 3 条。
 * 复用回执只给锚点不给正文——模型能拿它对照上文是否还对得上，对不上就重取。
 *
 * 单条锚点有长度上限（`ANCHOR_MAX_CHARS`，默认 60）：超长二级标题按前缀 + `…` 截断，
 * 避免把 120+ 字的标题原样存进注册表、再原样塞进 ≤400 字的复用回执。
 * 调用方要更短/更长时用第三个参数 `{maxChars}` 覆盖（`maxChars` 非法值时回退默认）。
 */
export function skillAnchorsOf(body, limit = 3, options = {}) {
  const cap = positiveInt(limit, 3)
  const maxChars = positiveInt(options !== null && typeof options === 'object' ? options.maxChars : undefined, ANCHOR_MAX_CHARS)
  const anchors = []
  const lines = String(body || '').split(/\r\n|[\n\r\u2028\u2029]/u)
  let fence = null
  for (const line of lines) {
    if (fence !== null) {
      // 围栏内一律是代码内容；只有同种标记、长度不短于开栏的收栏行才关掉围栏。
      const close = FENCE_CLOSE_RE.exec(line)
      if (close !== null && close[1][0] === fence.marker && close[1].length >= fence.length) fence = null
      continue
    }
    // Markdown 围栏：≤3 空格缩进 + 连续 ≥3 个 ` 或 ~（反引号围栏的 info string 里不能再有反引号）。
    const open = FENCE_OPEN_RE.exec(line)
    if (open !== null && !(open[1][0] === '`' && open[2].includes('`'))) {
      fence = { marker: open[1][0], length: open[1].length }
      continue
    }
    const match = /^##[ \t]+([^\n\r]+?)[ \t]*$/u.exec(line)
    if (match === null) continue
    const title = match[1].trim()
    if (title === '' || REUSE_ANCHOR_SKIP.has(title)) continue
    anchors.push(clipChars(`## ${title}`, maxChars))
    if (anchors.length >= cap) break
  }
  return anchors
}

/** 取（必要时创建）一个会话的注册表；sessionId 为空时返回 null（不建全局桶）。 */
export function skillSessionOf(sessionId, options = {}) {
  const key = String(sessionId || '').trim()
  if (key === '') return null
  const maxGiven = positiveInt(options.maxGiven, CATALOG_MAX_SKILLS)
  let state = skillSessionRegistry.get(key)
  if (state === undefined) {
    state = { skills: new Map(), maxGiven, lastCatalogSeq: null, turnCounter: 0 }
    skillSessionRegistry.set(key, state)
    while (skillSessionRegistry.size > SKILL_SESSION_LIMIT) {
      const oldest = skillSessionRegistry.keys().next().value
      skillSessionRegistry.delete(oldest)
    }
  }
  state.maxGiven = maxGiven
  return state
}

/**
 * 会话当前回合号：从日志末尾回扫最近的 `turn/start`（`data.turn`）。
 * 伪造会话/纯脚本场景没有该事件时返回 fallback，由调用方退回「给全文的序号」。
 */
export function skillSessionTurnOf(session, fallback = 0) {
  try {
    if (session === null || session === undefined) return fallback
    if (typeof session.eventAt !== 'function' || !Number.isSafeInteger(session.seq)) return fallback
    for (let index = session.seq - 1; index >= 0; index -= 1) {
      const event = session.eventAt(index)
      if (event === undefined || event === null) break
      if (event.type !== 'turn/start') continue
      const turn = event.data && event.data.turn
      if (Number.isSafeInteger(turn) && turn > 0) return turn
    }
  } catch {
    // 读不到就退回 fallback：不阻断命中。
  }
  return fallback
}

/**
 * 三态判定（计划书 §3.4）：
 * - `first`：本会话没给过 → 全文；
 * - `reuse`：给过、正文没变、那条结果仍在可见面 → 短回执（≤400 字），**绝不改 uses/lastUsedAt**；
 * - `regive`：给过但正文变了 / 被压缩遮罩 / 读不到可见面 / 显式 load → 全文。
 *
 * `visible` 是 `Set<seq>`（`session.surface.nodes`）；null 表示宿主没暴露可见面 → 降级为每次全文。
 * `givenAt` 约定为「给全文时 session.seq（下一条事件 seq）」：工具结果落后一条提交。
 */
export function skillGiveDecision(options = {}) {
  const sessionId = String(options.sessionId || '')
  const slug = String(options.slug || '')
  const body = String(options.body || '')
  const bodyHash = bodyHashOf(body)
  const anchors = skillAnchorsOf(body)
  const load = options.load === true
  const reuseReceipt = options.reuseReceipt !== false
  const state = skillSessionOf(sessionId, { maxGiven: options.maxGiven })
  if (state === null) {
    return { state: 'first', reason: 'no-session', bodyHash, anchors, entry: null }
  }
  const previous = state.skills.get(slug) || null
  const visible = options.visible instanceof Set ? options.visible : null
  const givenAt = Number.isSafeInteger(options.givenAt)
    ? options.givenAt
    : (options.session !== null && options.session !== undefined && Number.isSafeInteger(options.session.seq) ? options.session.seq : null)
  // givenAt 约定为「给全文时的 session.seq（下一条事件 seq）」，不可能大于当前 seq：
  // 未来时间戳（注册表被伪造/损坏、会话 seq 回退）不能算「仍在可见面」，按方向安全重给全文（§3.1/§3.4）。
  const stillVisible = previous !== null && visible !== null && Number.isSafeInteger(previous.givenAt)
    && visible.has(previous.givenAt)
    && (!Number.isSafeInteger(givenAt) || previous.givenAt <= givenAt)

  if (previous !== null && previous.bodyHash === bodyHash && stillVisible && !load && reuseReceipt) {
    const reused = {
      ...previous,
      reuses: (Number(previous.reuses) || 0) + 1,
      lastReuseAt: new Date().toISOString(),
    }
    state.skills.delete(slug)
    state.skills.set(slug, reused)
    return {
      state: 'reuse',
      reason: 'visible',
      bodyHash,
      anchors: Array.isArray(previous.anchors) && previous.anchors.length > 0 ? previous.anchors : anchors,
      entry: reused,
    }
  }

  let reason
  if (previous === null) reason = 'first'
  else if (previous.bodyHash !== bodyHash) reason = 'body-changed'
  else if (visible === null) reason = 'surface-unavailable'
  else if (!stillVisible) reason = 'shadowed'
  else if (load) reason = 'load'
  else reason = 'receipt-disabled'

  const hostTurn = skillSessionTurnOf(options.session, 0)
  state.turnCounter = (Number(state.turnCounter) || 0) + 1
  const turn = hostTurn > 0 ? hostTurn : state.turnCounter
  const entry = {
    name: String(options.name || (previous !== null && previous.name) || slug),
    turn,
    chars: body.length,
    bodyHash,
    givenAt,
    giveCount: (Number(previous !== null && previous.giveCount) || 0) + 1,
    reuses: Number(previous !== null && previous.reuses) || 0,
    lastReuseAt: previous !== null ? previous.lastReuseAt || null : null,
    anchors,
  }
  state.skills.delete(slug)
  state.skills.set(slug, entry)
  while (state.skills.size > state.maxGiven) {
    const oldest = state.skills.keys().next().value
    if (oldest === slug) break
    state.skills.delete(oldest)
  }
  return { state: previous === null ? 'first' : 'regive', reason, bodyHash, anchors, entry }
}

/**
 * 复用回执（≤400 字）：`reused:{turn, chars, skillFile}` + 锚点（能容下几条给几条）+ 重取指引。
 *
 * 收紧阶梯（每级都先判 `fits()`，命中即返回）：
 * 1. 丢 `reused.giveCount`；
 * 2. note 去掉冗余前缀（保留「对不上锚点就重取」与 slug）；
 * 3. **anchors 纳入预算**：先按单条建议上限 60 字截断（条数不变）；
 * 4. 超长 `skillFile` 只留尾部 80 字（路径可读回全文）；
 * 5. 单条锚点继续收紧（48/40/32），仍优先保住条数；
 * 6. note 压到最短语义（仍保留重取指引与 slug）；
 * 7. 单条锚点再短一档（24/18/12/8）；
 * 8. 才减少锚点条数（3→2→1），条数变少后单条可恢复更长；
 * 9. 清空 `skillFile`、丢锚点；
 * 10. **最终硬兜底**：任何路径下都在 return 前用 `fits()` 校验，极端情况删 note、
 *     截断超长 slug，保证 `JSON.stringify(receipt).length <= REUSE_RECEIPT_MAX_CHARS`。
 *
 * 语义不变：只要预算容得下，回执必含 `reused:{turn,chars,skillFile}`、
 * 「对不上锚点就 exp_recall({skill:'<slug>', load:true}) 重取，别凭印象执行步骤」这句。
 */
export function buildReuseReceipt(options = {}) {
  const slug = String(options.slug || '')
  const entry = options.entry !== null && typeof options.entry === 'object' ? options.entry : {}
  const turn = Number.isFinite(Number(entry.turn)) ? Number(entry.turn) : 0
  const chars = Number.isFinite(Number(entry.chars)) ? Number(entry.chars) : 0
  const anchorsAll = (Array.isArray(entry.anchors) ? entry.anchors : []).slice(0, 3)
  const noteFull = `复用回执：第 ${turn} 回合已给过全文（${chars} 字），本次不重发。对不上锚点就 exp_recall({skill:'${slug}', load:true}) 重取，别凭印象执行步骤。`
  const noteShort = `第 ${turn} 回合已给全文；对不上锚点就 exp_recall({skill:'${slug}', load:true}) 重取，别凭印象执行步骤。`
  const noteMin = `对不上锚点就 exp_recall({skill:'${slug}', load:true}) 重取。`
  const receipt = {
    mode: 'skill-reuse',
    skill: slug,
    reused: {
      turn,
      chars,
      skillFile: String(options.skillFile || ''),
      giveCount: Number(entry.giveCount) || 1,
    },
    anchors: anchorsAll.slice(),
    note: noteFull,
  }
  const fits = () => JSON.stringify(receipt).length <= REUSE_RECEIPT_MAX_CHARS
  /** 从原始锚点重截：`count` 条、每条最多 `maxChars` 字（含 `## ` 前缀）。 */
  const clipAnchors = (count, maxChars) => {
    receipt.anchors = anchorsAll.slice(0, count).map((anchor) => clipChars(anchor, maxChars))
  }
  if (fits()) return receipt
  delete receipt.reused.giveCount
  if (fits()) return receipt
  receipt.note = noteShort
  if (fits()) return receipt
  // ① 先按建议上限截单条锚点（条数不变）：修复「anchors 从不参与预算」。
  clipAnchors(anchorsAll.length, ANCHOR_MAX_CHARS)
  if (fits()) return receipt
  // ② 超长 skillFile 只留尾部（路径比锚点更长要，但比条数次要）。
  const skillFile = receipt.reused.skillFile
  if (skillFile.length > SKILL_FILE_TAIL_CHARS) {
    const tailStart = skillFile.length - (SKILL_FILE_TAIL_CHARS - 1)
    const cleanStart = safeSliceStart(skillFile, tailStart)
    // 尾部窗口起点落在代理对中间（深层 emoji/CJK 目录名会命中）：把整个字符纳入窗口，
    // 结果仍是 80 字、仍是原路径后缀，且不切出孤立代理码元（否则落盘 UTF-8 会变成 U+FFFD）。
    // 这一种对齐下再加 `…` 会顶成 81 字，所以窗口扩到字符边界时不再带省略号。
    receipt.reused.skillFile = cleanStart === tailStart
      ? `…${skillFile.slice(tailStart)}`
      : skillFile.slice(cleanStart)
  }
  if (fits()) return receipt
  // ③ 单条锚点继续收紧，条数优先保留。
  for (const maxChars of ANCHOR_CAP_LADDER) {
    clipAnchors(anchorsAll.length, maxChars)
    if (fits()) return receipt
  }
  // ④ note 压到最短语义（仍保留 load:true 重取指引与 slug）。
  receipt.note = noteMin
  if (fits()) return receipt
  // ⑤ 单条锚点再短一档。
  for (const maxChars of ANCHOR_CAP_LADDER_DEEP) {
    clipAnchors(anchorsAll.length, maxChars)
    if (fits()) return receipt
  }
  // ⑥ 才减少锚点条数（3→2→1）：条数少了，单条可以恢复更长。
  for (const count of [2, 1]) {
    for (const maxChars of ANCHOR_CAP_LADDER_SPARSE) {
      clipAnchors(count, maxChars)
      if (fits()) return receipt
    }
  }
  // ⑦ 清空 skillFile、丢锚点。
  receipt.reused.skillFile = ''
  if (fits()) return receipt
  receipt.anchors = []
  if (fits()) return receipt
  // ⑧ 最终硬兜底：只剩 slug/turn/chars 也必须合规（正常 slug 走不到这里）。
  delete receipt.note
  while (!fits() && receipt.skill.length > 1) {
    const over = JSON.stringify(receipt).length - REUSE_RECEIPT_MAX_CHARS
    receipt.skill = receipt.skill.slice(0, Math.max(1, receipt.skill.length - Math.max(1, over)))
  }
  return receipt
}

/** 技能目录/复用回执的四个配置键；缺省值见 `kernel/settings.js` 的 `ENGINE_CONFIG_DEFAULTS`。 */
export function catalogConfigOf(config = {}) {
  const source = config !== null && typeof config === 'object' ? config : {}
  return {
    enabled: source.skillCatalog !== false,
    maxSkills: positiveInt(source.catalogMaxSkills, CATALOG_MAX_SKILLS),
    descriptionChars: positiveInt(source.catalogDescriptionChars, CATALOG_DESCRIPTION_CHARS),
    reuseReceipt: source.reuseReceipt !== false,
  }
}

/** USAGE 附加键：目录开没开、本会话目录里已记了几个技能（P1）。 */
export function skillCatalogUsageOf(sessionId, config = {}) {
  const cfg = catalogConfigOf(config)
  const state = cfg.enabled ? skillSessionOf(sessionId, { maxGiven: cfg.maxSkills }) : null
  return { catalog: cfg.enabled, catalogSize: state === null ? 0 : state.skills.size }
}

function clipCatalogDescription(text, limit) {
  const normalized = String(text || '').replace(/\s+/gu, ' ').trim()
  const cap = positiveInt(limit, CATALOG_DESCRIPTION_CHARS)
  return normalized.length <= cap ? normalized : `${normalized.slice(0, safeSliceEnd(normalized, Math.max(0, cap - 1)))}…`
}

/**
 * 本会话目录快照：条目只来自**本会话已命中**的技能（注册表），不是全库。
 * 每条只有 `engram:` 前缀 + 名字（截断描述）；`bodyHashes` 与条目同序，参与 digest。
 *
 * 条目按 name 固定排序后再截断：注册表的 LRU 移位（§3.4 复用命中把条目移到 Map 末尾）
 * 只改 Map 顺序、不改目录内容；若按 Map 顺序出条目，复用一次就会让 digest 变化、整份重发目录。
 * 排序后 digest 只对「增删 / 描述变化 / 正文变化」敏感，符合 §1.3/§3.3 的补发触发条件。
 */
export function catalogSnapshotOf(state, dataDir, config = {}) {
  const cfg = catalogConfigOf(config)
  const snapshot = { entries: [], bodyHashes: [] }
  if (state === null || state === undefined || !(state.skills instanceof Map)) return snapshot
  const rows = []
  for (const slug of state.skills.keys()) {
    const skill = readSkillBySlug(dataDir, slug)
    if (skill === null) continue
    rows.push({
      name: `engram:${skill.slug}`,
      description: clipCatalogDescription(skill.description || skill.name || skill.slug, cfg.descriptionChars),
      bodyHash: bodyHashOf(skill.body),
    })
  }
  rows.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  const picked = rows.slice(0, cfg.maxSkills)
  snapshot.entries = picked.map((row) => ({ name: row.name, description: row.description }))
  snapshot.bodyHashes = picked.map((row) => row.bodyHash)
  return snapshot
}

/**
 * 目录指纹：sha256(版本标记 + 每条 [name,description] + bodyHash 集合)。
 * 正文一变 digest 就变 → 下一步补发整份替换目录（计划书 §1.3「技能正文变化」）。
 */
export function catalogDigestOf(snapshot) {
  const entries = snapshot !== null && snapshot !== undefined && Array.isArray(snapshot.entries) ? snapshot.entries : []
  const bodyHashes = snapshot !== null && snapshot !== undefined && Array.isArray(snapshot.bodyHashes) ? snapshot.bodyHashes : []
  const canonical = entries.map((entry) => JSON.stringify([entry.name, entry.description])).join('\n')
  return createHash('sha256')
    .update(`${CATALOG_DIGEST_VERSION}\n`)
    .update(canonical)
    .update('\n')
    .update(bodyHashes.join(','))
    .digest('hex')
}

/** 从目录消息的 `source` 读回 entries/bodyHashes；不可读的记录当作「不是我们的目录」。 */
function catalogSourceOf(source) {
  if (source === null || typeof source !== 'object' || !Array.isArray(source.entries)) return null
  const entries = []
  for (const item of source.entries) {
    if (item === null || typeof item !== 'object') return null
    if (typeof item.name !== 'string' || item.name === '' || typeof item.description !== 'string') return null
    entries.push({ name: item.name, description: item.description })
  }
  const bodyHashes = Array.isArray(source.bodyHashes) ? source.bodyHashes.filter((item) => typeof item === 'string') : []
  return { entries, bodyHashes }
}

/**
 * 可见面反扫（照官方 `catalogHistory`）：判「在不在」用 `surface.nodes`，不是日志存在性。
 *
 * 返回 `{ available, published, visibleDigest, entries, bodyHashes, visibleSeq, publishedSeq }`。
 * `available:false` 表示宿主没暴露 `session.surface`/`eventAt` → 调用方降级（不发目录）。
 */
export function catalogHistoryOf(session, state = null) {
  const unavailable = { available: false, published: false, visibleDigest: undefined, entries: [], bodyHashes: [], visibleSeq: null, publishedSeq: null }
  if (session === null || session === undefined || typeof session !== 'object') return unavailable
  const surface = session.surface
  if (surface === null || surface === undefined || !Array.isArray(surface.nodes)) return unavailable
  if (typeof session.eventAt !== 'function' || !Number.isSafeInteger(session.seq)) return unavailable
  let visible
  try {
    visible = new Set(surface.nodes)
  } catch {
    return unavailable
  }
  const anchor = state !== null && state !== undefined && Number.isSafeInteger(state.lastCatalogSeq) ? state.lastCatalogSeq : null
  const lastSeq = session.seq - 1
  // 锚点倒流：lastCatalogSeq 可能因会话回退/注册表损坏比当前 seq 还大。此时按它算窗口会得到
  // 空区间（high < low），可见面里的同版目录会被漏判 → hook 重复发「首发」目录。退回无锚点全量反扫。
  const anchorUsable = anchor !== null && anchor >= 0 && anchor <= lastSeq
  // lastCatalogSeq 限界：上次发布的 seq 附近 ±64 条足够（本进程只在这个钩子里发目录）；
  // 没有记录时退全量反扫，但最多回看 CATALOG_SCAN_LIMIT 条。
  const high = anchorUsable ? Math.min(lastSeq, anchor + 64) : lastSeq
  const low = anchorUsable ? Math.max(0, anchor - 1) : Math.max(0, lastSeq - CATALOG_SCAN_LIMIT)
  let published = false
  let newestSeq = null
  try {
    for (let index = high; index >= low; index -= 1) {
      const event = session.eventAt(index)
      if (event === undefined || event === null) break
      if (event.type !== 'user/message') continue
      const source = event.data && event.data.source
      if (source === null || source === undefined || source.kind !== SESSION_CATALOG_KIND) continue
      const parsed = catalogSourceOf(source)
      if (parsed === null) continue
      published = true
      if (newestSeq === null) newestSeq = event.seq
      if (!visible.has(event.seq)) continue
      return {
        available: true,
        published: true,
        visibleDigest: catalogDigestOf(parsed),
        entries: parsed.entries,
        bodyHashes: parsed.bodyHashes,
        visibleSeq: event.seq,
        publishedSeq: newestSeq,
      }
    }
  } catch {
    return unavailable
  }
  return { available: true, published, visibleDigest: undefined, entries: [], bodyHashes: [], visibleSeq: null, publishedSeq: newestSeq }
}

/** 目录正文（两套文案：首发 / 整份替换）。 */
export function renderCatalogText(entries, update = false) {
  const list = Array.isArray(entries) ? entries : []
  const lines = ['<system-reminder>']
  lines.push(update
    ? '经验库技能清单已更新，替换本会话此前所有同类清单；只用这份里的名字。'
    : '这是本会话已命中的经验库技能清单。正文已在上文；要细节按 exp_recall({skill, load:true}) 重取，别从清单猜步骤。')
  lines.push('')
  lines.push('<available_skills>')
  if (list.length === 0) lines.push('- （本会话已无可用经验库技能）')
  // 描述是用户可控数据（由 exp_record / exp_consolidate 的 action/note/intent 派生）：
  // 原样拼进来时，描述里的 `</system-reminder>` / `<available_skills>` 会让包裹提前闭合，
  // 清单后半段与收尾指引掉到提醒之外（R11-7 实测全文各出现 2 次）。渲染层把 `<` 中和成
  // 全角 `＜`；只改 `content[0].text`，`source.entries` 保留原文，digest 与补发判定不变。
  for (const entry of list) lines.push(`- \`${entry.name}\`: ${String(entry.description).replace(/</gu, '＜')}`)
  lines.push('</available_skills>')
  lines.push('')
  lines.push(list.length === 0
    ? '此前的经验库技能清单作废，不要再用那些名字。'
    : "清单只有名字与截断描述，不带正文。对不上锚点或正文已不在上文时，先用 exp_recall({skill:'<slug>', load:true}) 取回正文再动手。")
  lines.push('</system-reminder>')
  return lines.join('\n')
}

/**
 * 手搓 V2 UserMessage（零 `@deepseek-ai/*` import）：宿主只校验 id/role/content/source.kind，
 * 自定义 kind 与封闭词表里的 form 都透传。
 */
export function buildCatalogMessage(options = {}) {
  const entries = Array.isArray(options.entries) ? options.entries.map((entry) => ({ name: String(entry.name), description: String(entry.description) })) : []
  const bodyHashes = Array.isArray(options.bodyHashes) ? options.bodyHashes.map((item) => String(item)) : []
  const update = options.update === true
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: renderCatalogText(entries, update) }],
    source: {
      kind: SESSION_CATALOG_KIND,
      form: CATALOG_FORM,
      ...(update ? { update: true } : {}),
      entries,
      bodyHashes,
    },
  }
}

/**
 * 宿主回调里的会话键（与 `tools.js` 的 `hostSessionOf` 同口径）：
 * `agent.id` 非空优先；宿主只给 `session.id` 时回退。
 *
 * 两条入口必须用同一个键：工具入口按 hostSessionOf 口径把命中记进 `session.id` 桶，
 * pre-step 若只认 `agent.id` 就会取到空串 → `skillSessionOf('') === null` → 该会话的
 * 目录永远不发布（静默失效）。抽成一个函数，避免两处再漂移。
 */
export function sessionIdOfAgent(agent) {
  try {
    if (agent === null || agent === undefined) return ''
    if (typeof agent.id === 'string' && agent.id !== '') return agent.id
    const session = agent.session !== undefined ? agent.session : null
    return session !== null && session !== undefined && typeof session.id === 'string' ? session.id : ''
  } catch {
    return ''
  }
}

/**
 * `agent/pre-step` 监听：注册表为空直接 return（不扫日志）；有目录消息可见且 digest 一致就 return；
 * 目录被压缩遮罩（日志在、可见面没了）或条目/正文变了 → 追加一条**整份替换**目录。
 *
 * 任何异常都在内部吞掉并写审计：pre-step 抛错会让整轮会话失败，目录不值得这个代价。
 */
export function createSkillCatalogHook(options = {}) {
  const audit = typeof options.audit === 'function' ? options.audit : () => {}
  const dataDirOf = typeof options.dataDirOf === 'function' ? options.dataDirOf : () => ''
  const config = options.config !== null && typeof options.config === 'object' ? options.config : {}
  let degradedReported = false
  let degraded = false

  const listener = async (...args) => {
    const next = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null
    if (next === null) return undefined
    const payload = args[0] !== null && typeof args[0] === 'object' ? args[0] : {}
    const decision = await next()
    try {
      if (decision === null || typeof decision !== 'object' || decision.kind === 'reject') return decision
      const cfg = catalogConfigOf(config)
      if (!cfg.enabled) return decision
      const agent = payload.agent
      const session = agent !== null && agent !== undefined && agent.session !== undefined ? agent.session : null
      // 与 tools.js 的 hostSessionOf 同口径（agent.id 缺失时回退 session.id）：否则工具把命中记进
      // session.id 桶、这里却取空键，目录永远不发布（R8 D1）。
      const sessionId = sessionIdOfAgent(agent)
      const state = skillSessionOf(sessionId, { maxGiven: cfg.maxSkills })
      if (state === null || state.skills.size === 0) return decision
      let dataDir = ''
      try {
        dataDir = String(dataDirOf() || '')
      } catch {
        dataDir = ''
      }
      if (dataDir === '') return decision
      const snapshot = catalogSnapshotOf(state, dataDir, config)
      const history = catalogHistoryOf(session, state)
      if (!history.available) {
        if (!degradedReported) {
          degradedReported = true
          degraded = true
          audit('catalog: session surface unavailable → degrade to full body every hit')
        }
        return decision
      }
      if (Number.isSafeInteger(history.publishedSeq)) state.lastCatalogSeq = history.publishedSeq
      if (snapshot.entries.length === 0 && history.published !== true) return decision
      if (history.visibleDigest === catalogDigestOf(snapshot)) return decision
      const messages = Array.isArray(decision.messages) ? decision.messages : []
      const existingIndex = messages.findIndex((message) => message !== null && message !== undefined && message.source !== undefined && message.source !== null && message.source.kind === SESSION_CATALOG_KIND)
      const catalog = buildCatalogMessage({
        entries: snapshot.entries,
        bodyHashes: snapshot.bodyHashes,
        update: history.published === true,
      })
      if (Number.isSafeInteger(session && session.seq)) state.lastCatalogSeq = session.seq
      return {
        ...decision,
        messages: existingIndex >= 0
          ? messages.map((message, index) => (index === existingIndex ? catalog : message))
          : [...messages, catalog],
      }
    } catch (error) {
      if (!degradedReported) {
        degradedReported = true
        degraded = true
        audit(`catalog: skipped (${error && error.message ? error.message : String(error)})`)
      }
      return decision
    }
  }

  const register = (target) => {
    if (!catalogConfigOf(config).enabled) return null
    if (target === null || target === undefined || typeof target.on !== 'function') return null
    const off = target.on('agent/pre-step', listener)
    audit('catalog: agent/pre-step hook registered')
    return typeof off === 'function' ? off : null
  }

  return { listener, register, isDegraded: () => degraded, disabled: !catalogConfigOf(config).enabled }
}
export {
  SKILLS_DIRNAME,
  SCRIPTS_DIRNAME,
  SKILL_FILENAME,
  META_FILENAME,
  RESOLVED_LIMIT,
  skillsRootOf,
  assertSafeSlug,
  assertSafePathSegment,
  assertSafeRelPath,
  pathIsLink,
  skillDirOf,
  slugify,
  writeFileAtomic,
  defaultMeta,
  readSkill,
  readSkillBySlug,
  runnerForScript,
  skillRuntimeOf,
  clipSkillBody,
  SKILL_SCAN_SKIP_DIRS,
  listSkills,
  listSkillsCached,
  clearSkillsHintCache,
  writeSkill,
  attachSkillFiles,
  dshGlobalSkillsRoot,
  globalRegistrationOf,
  registerSkillGlobally,
  unregisterSkillFromDsh,
  updateSkillMeta,
  forgetSkill,
  buildSkillTree,
  subtreeSkills,
  findSkillTreeNode,
  registerSkillTree,
  unregisterSkillTree,
  forgetSkillTree,
  rewriteSkillIds,
  moveSkillToTop,
  applySkillNodeAction,
  ensureSkillsRepo,
  commitSkills,
}
