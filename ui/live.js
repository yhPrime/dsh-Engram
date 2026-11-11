/**
 * exp-ui — live data source（只读）。
 *
 * 「等 UI 外壳测试成功直接接入」的那一半：只要把 config 从
 * `source: mock` 改成 `source: live` 并给 `dataDir`，界面就读真实经验库文件
 * `<dataDir>/exp-lib.json`（与 dsh-exp-lib-provider 同一种结构），用同一套渲染。
 *
 * 为什么只读：真实经验库的写入语义（upsert/取代/退休/反馈重放）在正式引擎里，
 * 外壳不复制一份写逻辑。反馈按钮在 live 模式下禁用，返回 `read-only`。
 *
 * 读不到 / 读坏了都不抛：返回空库 + notice，界面照常显示。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { codedError, emptyStore, skillRowOf } from './data-source.js'
import { createEngine } from '../kernel/engine.js'
import { readSettings, resolveEngramDataDir } from '../kernel/settings.js'

/** 展开 `~`，返回绝对路径；空配置返回 ''。 */
export function resolveLiveDataDir(config = {}) {
  const raw = String(config && config.dataDir ? config.dataDir : '').trim()
  if (raw !== '') return path.resolve(raw.replace(/^~(?=$|[\\/])/, os.homedir()))
  // 没显式配 dataDir 时走 settings.currentRoot / ENGRAM_DATA_DIR / 默认目录
  return resolveEngramDataDir(config)
}

/** 容错：文件里的对象只取需要的字段，缺什么补什么。 */
function normalizeStore(parsed) {
  const raw = parsed !== null && typeof parsed === 'object' ? parsed : {}
  return {
    version: Number(raw.version) || 1,
    types: Array.isArray(raw.types) ? raw.types.filter((item) => item && typeof item === 'object') : [],
    experiences: Array.isArray(raw.experiences) ? raw.experiences.filter((item) => item && typeof item === 'object') : [],
  }
}

/* -------------------------------------------------------------------------- */
/* 固化技能：<dataDir>/skills/<slug>/（SKILL.md + skill.json）                   */
/* -------------------------------------------------------------------------- */

function parseFrontmatter(text) {
  const lines = String(text || '').split(/\r?\n/)
  if (lines[0] !== '---') return { fields: {}, body: String(text || '') }
  const fields = {}
  let idx = 1
  for (; idx < lines.length; idx += 1) {
    if (lines[idx] === '---') break
    const match = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(lines[idx])
    if (!match) continue
    let value = match[2].trim()
    // YAML 块标量（`description: |` / `>`）：值在缩进块里，不认就会只得到「|」
    if (/^[|>][+-]?$/.test(value)) {
      const block = []
      let cursor = idx + 1
      for (; cursor < lines.length; cursor += 1) {
        const inner = lines[cursor]
        if (inner === '---') break
        if (inner.trim() !== '' && !/^\s/.test(inner)) break
        block.push(inner)
      }
      const nonEmpty = block.filter((inner) => inner.trim() !== '')
      const indent = nonEmpty.length === 0 ? 0 : Math.min(...nonEmpty.map((inner) => (inner.match(/^\s*/) || [''])[0].length))
      const dedented = block.map((inner) => inner.slice(indent)).join('\n').trim()
      value = value.startsWith('>') ? dedented.replace(/\n(?=\S)/gu, ' ') : dedented
      idx = cursor - 1
    }
    fields[match[1]] = value
  }
  return { fields, body: lines.slice(idx + 1).join('\n').replace(/^\n+/, '') }
}

/** 读一个技能目录；没有 SKILL.md 就不算技能。 */
function readSkillRow(dir) {
  const skillFile = path.join(dir, 'SKILL.md')
  let parsed = { fields: {}, body: '' }
  let updatedAt = ''
  try {
    parsed = parseFrontmatter(fs.readFileSync(skillFile, 'utf8'))
    updatedAt = fs.statSync(skillFile).mtime.toISOString()
  } catch {
    return null
  }
  let meta = {}
  try {
    meta = JSON.parse(fs.readFileSync(path.join(dir, 'skill.json'), 'utf8'))
  } catch {
    meta = {}
  }
  const confidence = meta !== null && typeof meta === 'object' && meta.confidence && typeof meta.confidence === 'object' ? meta.confidence : {}
  const obstacles = meta !== null && typeof meta === 'object' && meta.obstacles && typeof meta.obstacles === 'object' ? meta.obstacles : {}
  const obstacleValues = Object.values(obstacles)
  const openObstacles = obstacleValues.filter((entry) => entry && (Number(entry.streak) || 0) >= 3).length
  const resolved = meta !== null && typeof meta === 'object' && Array.isArray(meta.resolved) ? meta.resolved : []
  const derivedFrom = meta !== null && typeof meta === 'object' && Array.isArray(meta.derivedFrom) ? meta.derivedFrom : []
  const slug = path.basename(dir)
  return skillRowOf({
    id: slug,
    name: parsed.fields.name || slug,
    description: parsed.fields.description || '',
    body: parsed.body || '',
    typeName: meta !== null && typeof meta === 'object' && meta.typeName ? meta.typeName : '',
    typeNames: meta !== null && typeof meta === 'object' && Array.isArray(meta.typeNames) ? meta.typeNames : [],
    notes: meta !== null && typeof meta === 'object' && Array.isArray(meta.notes) ? meta.notes : [],
    packageFiles: meta !== null && typeof meta === 'object' && meta.package ? Number(meta.package.files) || 0 : 0,
    packageBytes: meta !== null && typeof meta === 'object' && meta.package ? Number(meta.package.bytes) || 0 : 0,
    packageDirs: meta !== null && typeof meta === 'object' && meta.package && Array.isArray(meta.package.dirs) ? meta.package.dirs : [],
    context: meta !== null && typeof meta === 'object' ? meta.context : [],
    triggers: meta !== null && typeof meta === 'object' ? meta.triggers : [],
    files: meta !== null && typeof meta === 'object' && Array.isArray(meta.files) ? meta.files.map((item) => (item && item.path) || '').filter((item) => item !== '') : [],
    uses: confidence.uses,
    helped: confidence.helped,
    hurt: confidence.hurt,
    obstacleCount: obstacleValues.length,
    openObstacles,
    resolvedCount: resolved.length,
    revisions: meta !== null && typeof meta === 'object' ? meta.revisions : 0,
    derivedFrom,
    pendingCommit: meta !== null && typeof meta === 'object' && meta.pendingCommit === true,
    globalRegistered: Boolean(meta && meta.globalRegistered && meta.globalRegistered.path),
    globalPath: meta && meta.globalRegistered && meta.globalRegistered.path ? String(meta.globalRegistered.path) : '',
    lastUsedAt: confidence.lastUsedAt || '',
    updatedAt,
    path: dir,
  })
}

/** 扫 `<dataDir>/skills/*`；目录不存在 / 读坏都返回空数组。 */
export function readSkills(dataDir) {
  if (String(dataDir || '') === '') return []
  const root = path.join(String(dataDir), 'skills')
  let entries = []
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  const rows = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const row = readSkillRow(path.join(root, entry.name))
    if (row !== null) rows.push(row)
  }
  return rows.sort((a, b) => String(b.lastUsedAt).localeCompare(String(a.lastUsedAt)) || a.name.localeCompare(b.name, 'zh'))
}

/** 把 engine.listSkills() 的条目映射成界面 skillRow。 */
function skillRowFromEngine(skill) {
  const meta = skill.meta || {}
  const confidence = meta.confidence && typeof meta.confidence === 'object' ? meta.confidence : {}
  const obstacles = meta.obstacles && typeof meta.obstacles === 'object' ? meta.obstacles : {}
  const obstacleValues = Object.values(obstacles)
  let updatedAt = ''
  try {
    updatedAt = fs.statSync(path.join(skill.dir, 'SKILL.md')).mtime.toISOString()
  } catch {
    // 文件被移走：updatedAt 留空
  }
  return skillRowOf({
    id: skill.id,
    path: skill.id,
    depth: skill.depth,
    parentPath: skill.parentPath,
    name: skill.name,
    description: skill.description,
    body: skill.body,
    typeName: meta.typeName || '',
    typeNames: Array.isArray(meta.typeNames) ? meta.typeNames : [],
    notes: Array.isArray(meta.notes) ? meta.notes : [],
    packageFiles: meta.package ? Number(meta.package.files) || 0 : 0,
    packageBytes: meta.package ? Number(meta.package.bytes) || 0 : 0,
    packageDirs: meta.package && Array.isArray(meta.package.dirs) ? meta.package.dirs : [],
    context: meta.context,
    triggers: meta.triggers,
    order: Number(meta.order) || 0,
    files: Array.isArray(meta.files) ? meta.files.map((item) => (item && item.path) || '').filter((item) => item !== '') : [],
    uses: confidence.uses,
    helped: confidence.helped,
    hurt: confidence.hurt,
    obstacleCount: obstacleValues.length,
    openObstacles: obstacleValues.filter((entry) => entry && (Number(entry.streak) || 0) >= 3).length,
    resolvedCount: Array.isArray(meta.resolved) ? meta.resolved.length : 0,
    revisions: meta.revisions,
    derivedFrom: meta.derivedFrom,
    pendingCommit: meta.pendingCommit === true,
    globalRegistered: Boolean(meta.globalRegistered && meta.globalRegistered.path),
    globalPath: meta.globalRegistered && meta.globalRegistered.path ? String(meta.globalRegistered.path) : '',
    lastUsedAt: confidence.lastUsedAt || '',
    updatedAt,
    dir: skill.dir,
  })
}

/**
 * live data source（走 kernel engine，只经 engine 读写；可反馈）。
 * @param {{dataDir?: string}} config - 插件行 config。
 */
export function createLiveSource(config = {}) {
  const dataDir = resolveLiveDataDir(config)
  const file = dataDir === '' ? '' : path.join(dataDir, 'exp-lib.json')
  const engine = dataDir === '' ? null : createEngine({ dataDir })

  return {
    id: 'live',
    mode: 'live',
    label: '真实数据',
    readOnly: false,

    read() {
      if (file === '') {
        return {
          store: emptyStore(),
          dataDir: '',
          file: '',
          exists: false,
          bytes: 0,
          updatedAt: '',
          notice: 'exp-ui 还没接入真实经验库：config.dataDir 未设置，当前按空库显示。',
        }
      }
      try {
        const snapshot = engine.snapshot()
        return {
          store: normalizeStore(snapshot.store),
          dataDir,
          file,
          exists: snapshot.exists,
          bytes: snapshot.bytes,
          updatedAt: snapshot.updatedAt,
          notice: snapshot.corrupt
            ? `经验库文件读不了：${snapshot.parseError}；已按空库显示。`
            : (snapshot.exists ? '' : `没有找到经验库文件：${file}（先跑一次 exp_record，或确认 dataDir 配置）`),
        }
      } catch (error) {
        const missing = Boolean(error && error.code === 'ENOENT')
        return {
          store: emptyStore(),
          dataDir,
          file,
          exists: false,
          bytes: 0,
          updatedAt: '',
          notice: missing
            ? `没有找到经验库文件：${file}（先跑一次 exp_record，或确认 dataDir 配置）`
            : `经验库文件读不了：${String((error && error.message) || error)}；已按空库显示。`,
        }
      }
    },

    usageRows(limit) {
      const size = Math.max(1, Math.min(500, Math.trunc(Number(limit) || 100)))
      if (dataDir === '') return []
      const rows = []
      for (const name of ['usage.jsonl.1', 'usage.jsonl']) {
        try {
          const lines = fs.readFileSync(path.join(dataDir, name), 'utf8').split('\n').filter((line) => line.trim() !== '')
          for (const line of lines) {
            try {
              rows.push(JSON.parse(line))
            } catch {
              // 跳过损坏行：一行坏掉不影响统计。
            }
          }
        } catch {
          // 文件不存在就跳过。
        }
      }
      return rows.slice(-size)
    },

    skills() {
      if (engine === null) return []
      return engine.listSkills().map(skillRowFromEngine).sort((a, b) => (Number(b.order) || 0) - (Number(a.order) || 0) || String(b.lastUsedAt).localeCompare(String(a.lastUsedAt)) || a.name.localeCompare(b.name, 'zh'))
    },

    pending(limit = 5) {
      if (engine === null) return []
      return engine.pending(limit)
    },

    verdicts(list) {
      if (engine === null) throw codedError('read-only', '没有 dataDir，无法回填判定。')
      return engine.resolveVerdicts(Array.isArray(list) ? list : [])
    },

    usageSummary() {
      const rows = this.usageRows(200)
      const byTool = {}
      let chars = 0
      let withChars = 0
      for (const row of rows) {
        const tool = String(row.tool || 'unknown')
        byTool[tool] = (byTool[tool] || 0) + 1
        const size = Number(row.chars)
        if (Number.isFinite(size) && size > 0) {
          chars += size
          withChars += 1
        }
      }
      return { calls: rows.length, chars, withChars, avgChars: withChars > 0 ? Math.round(chars / withChars) : 0, byTool }
    },

    feedback(id, result) {
      if (engine === null) throw codedError('read-only', '没有 dataDir，无法反馈。')
      const out = engine.feedback({ id: String(id), result: String(result) })
      return { id: String(id), result: String(result), G_before: out.G_before, G_after: out.G_after, at: new Date().toISOString() }
    },

    recall(args = {}) {
      return engine.recall({ intent: String(args.intent || ''), limit: args.limit, context: args.context })
    },
    record(args = {}) {
      return engine.record(args)
    },
    consolidate(args = {}) {
      return engine.consolidate({ intent: String(args.intent || ''), context: args.context })
    },
    validate() {
      return engine.validate()
    },
    typeOp(args = {}) {
      return engine.types(args)
    },
    skillFeedback(slug, result) {
      return engine.feedback({ id: `skill:${slug}`, result })
    },
    settings() {
      return { dataDir, file, currentRoot: String(readSettings().currentRoot || '') }
    },
  }
}
