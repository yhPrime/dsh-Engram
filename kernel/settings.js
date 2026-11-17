/**
 * Engram 自己的数据位置与设置（不再依赖记忆插件的 Provider 状态）。
 *
 * 抄记忆系统的做法：设置文件放 `$DSH_HOME/engram/settings.json`，
 * 用 `currentRoot` 记住「当前数据根」，换根不需要改插件配置。
 *
 * 解析优先级：config.dataDir > ENGRAM_DATA_DIR > settings.currentRoot > 默认数据目录。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const APP_DIRNAME = 'engram'

export function dshHome(env = process.env) {
  const home = String((env && env.DSH_HOME) || '').trim()
  return home === '' ? path.join(os.homedir(), '.dsh') : home
}

export function settingsFile(env = process.env) {
  return path.join(dshHome(env), APP_DIRNAME, 'settings.json')
}

export function readSettings(env = process.env) {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(env), 'utf8'))
    return raw !== null && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

export function writeSettings(patch, env = process.env) {
  const next = { ...readSettings(env), ...(patch && typeof patch === 'object' ? patch : {}) }
  const file = settingsFile(env)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return next
}

function expand(value) {
  const raw = String(value || '').trim()
  if (raw === '') return ''
  return path.resolve(raw.replace(/^~(?=$|[\\/])/, os.homedir()))
}

/** 唯一的数据目录解析入口；插件、工具、审计、外壳都走这里。 */
export function defaultDataDir(env = process.env) {
  return path.join(dshHome(env), '.exp')
}

/**
 * 用户在设置里选的是父目录：默认在下面建 .exp。
 * 已经是 .exp，或本身就是一个旧的经验库根（有 manifest/exp-lib），保持原样。
 */
export function storageRootFor(selected) {
  const raw = String(selected || '').trim()
  if (raw === '') return defaultDataDir()
  const base = expand(raw)
  if (path.basename(base).toLowerCase() === '.exp') return base
  if (fs.existsSync(path.join(base, 'manifest.json')) || fs.existsSync(path.join(base, 'exp-lib.json'))) return base
  return path.join(base, '.exp')
}

export function resolveEngramDataDir(config = {}, env = process.env) {
  const explicit = String((config && config.dataDir) || (env && env.ENGRAM_DATA_DIR) || '').trim()
  if (explicit !== '') return expand(explicit)
  const currentRoot = String(readSettings(env).currentRoot || '').trim()
  if (currentRoot !== '') return expand(currentRoot)
  return defaultDataDir(env)
}

/**
 * 把整个数据根挪到新位置（用户切换存储位置时用）。
 * 目标必须不存在或为空；跨盘 rename 失败时退回复制，校验后再删源。
 */
export function moveDataRoot(from, to) {
  const source = expand(from)
  const target = expand(to)
  if (source === '' || target === '' || source === target) return { moved: false, same: true }
  const sourceWithSep = source + path.sep
  const targetWithSep = target + path.sep
  if (target.startsWith(sourceWithSep) || source.startsWith(targetWithSep)) {
    throw new Error('新存储位置不能嵌套在旧位置里')
  }
  if (!fs.existsSync(source)) return { moved: false, missing: true }
  if (fs.existsSync(target)) {
    const entries = fs.readdirSync(target)
    if (entries.length > 0) throw new Error('新存储位置里已经有数据，拒绝覆盖')
    fs.rmdirSync(target)
  }
  fs.mkdirSync(path.dirname(target), { recursive: true })
  try {
    fs.renameSync(source, target)
    return { moved: true, copied: false }
  } catch (error) {
    if (error && error.code !== 'EXDEV') throw error
    fs.cpSync(source, target, { recursive: true, preserveTimestamps: true })
    if (!fs.existsSync(target)) throw new Error('复制后目标目录不存在')
    fs.rmSync(source, { recursive: true, force: true })
    return { moved: true, copied: true }
  }
}

/** 记住当前数据根（管理页/CLI 用）。 */
export function setCurrentRoot(root, env = process.env) {
  return writeSettings({ currentRoot: expand(root) }, env)
}


/**
 * 内核参数缺省值（0.21.x 技能目录）：读取时用这个口径补默认，不写回磁盘。
 * - skillCatalog：总开关，false 完全退回 0.20.9 行为（命中只给全文、不发目录）；
 * - catalogMaxSkills：单会话目录条数上限（同时是注册表淘汰上限）；
 * - catalogDescriptionChars：目录里每条描述的截断长度；
 * - reuseReceipt：复用命中是否给短回执（false 每次全文，排障用）。
 */
export const ENGINE_CONFIG_DEFAULTS = Object.freeze({
  skillCatalog: true,
  catalogMaxSkills: 5,
  catalogDescriptionChars: 300,
  reuseReceipt: true,
})

/** 磁盘上真实保存的内核参数（不含默认值）。插件行配置的覆盖判断走这里，避免默认值压掉插件行。 */
export function readSavedEngineConfig(env = process.env) {
  const config = readSettings(env).config
  return config !== null && typeof config === 'object' ? config : {}
}

/** 内核可调参数（设置页只暴露这些；未知键不落盘）：已保存值 + 缺省值。 */
export function readEngineConfig(env = process.env) {
  return { ...ENGINE_CONFIG_DEFAULTS, ...readSavedEngineConfig(env) }
}

/** 显式命名的同义入口（读代码时一眼看出「带缺省值」）。 */
export function readEngineConfigWithDefaults(env = process.env) {
  return readEngineConfig(env)
}

export function writeEngineConfig(patch, env = process.env) {
  const current = readSavedEngineConfig(env)
  const next = { ...current }
  for (const [key, value] of Object.entries(patch && typeof patch === 'object' ? patch : {})) {
    if (value === null || value === undefined) delete next[key]
    else next[key] = value
  }
  writeSettings({ config: next }, env)
  return next
}

/** 界面层配置（数据源/目录覆盖）。 */
export function readUiConfig(env = process.env) {
  const ui = readSettings(env).ui
  return ui !== null && typeof ui === 'object' ? ui : {}
}

/* -------------------------------------------------------------------------- */
/* 运行环境（P1）：当前模型 / 工具版本 / 环境，用于 appliesTo 门控              */
/* -------------------------------------------------------------------------- */

/** 运行环境在设置里的三个键（都存 settings.config，空串=未声明）。 */
export const RUNTIME_ENV_KEYS = Object.freeze(['currentModel', 'currentTool', 'currentEnvironment'])

/** 读运行环境：插件 config 覆盖设置（与其它内核参数同一套优先级），只做字符串归一。 */
export function readRuntimeEnv(config = {}, env = process.env) {
  const saved = readEngineConfig(env)
  const pick = (key) => {
    const fromConfig = config !== null && config !== undefined && typeof config === 'object' ? config[key] : undefined
    const value = fromConfig === undefined || fromConfig === null ? saved[key] : fromConfig
    return String(value === undefined || value === null ? '' : value).trim()
  }
  const currentModel = pick('currentModel')
  const currentTool = pick('currentTool')
  const currentEnvironment = pick('currentEnvironment')
  return {
    currentModel,
    currentTool,
    currentEnvironment,
    // applicabilityOf 的形状：单值包成数组；全空 → 空对象（unscoped）。
    models: currentModel === '' ? [] : [currentModel],
    tools: currentTool === '' ? [] : [currentTool],
    environment: currentEnvironment,
  }
}

/** 把 exp_recall 的 currentEnv 覆盖合并到设置里的默认环境（字段级，未给的不覆盖）。 */
export function mergeRuntimeEnv(base = {}, override = null) {
  if (override === null || override === undefined || typeof override !== 'object') return base
  const listOf = (value) => {
    if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter((item) => item !== '')
    const text = String(value === undefined || value === null ? '' : value).trim()
    return text === '' ? [] : [text]
  }
  const models = override.models !== undefined
    ? listOf(override.models)
    : (override.model !== undefined ? listOf(override.model) : (Array.isArray(base.models) ? base.models : []))
  const tools = override.tools !== undefined
    ? listOf(override.tools)
    : (override.tool !== undefined ? listOf(override.tool) : (Array.isArray(base.tools) ? base.tools : []))
  const environment = override.environment !== undefined
    ? String(override.environment || '').trim()
    : String(base.environment || '').trim()
  return {
    models,
    tools,
    environment,
    currentModel: models[0] || '',
    currentTool: tools[0] || '',
    currentEnvironment: environment,
  }
}


export function writeUiConfig(patch, env = process.env) {
  const current = readUiConfig(env)
  const next = { ...current }
  for (const [key, value] of Object.entries(patch && typeof patch === 'object' ? patch : {})) {
    if (value === null || value === undefined || value === '') delete next[key]
    else next[key] = value
  }
  writeSettings({ ui: next }, env)
  return next
}

/**
 * Git 备份配置（像记忆插件那样把库推到远端仓库）。
 * 存在同一个 settings.json 的 `git` 键下；token 也在这里（本机文件，README 有安全提示）。
 */
export const GIT_DEFAULTS = { branch: 'main', autoBackupMinutes: 0, pushStrategy: 'ask' }

export function readGitConfig(env = process.env) {
  const raw = readSettings(env).git
  const git = raw !== null && typeof raw === 'object' ? raw : {}
  return { ...GIT_DEFAULTS, ...git }
}

export function writeGitConfig(patch, env = process.env) {
  const current = readGitConfig(env)
  const next = { ...current }
  for (const [key, value] of Object.entries(patch && typeof patch === 'object' ? patch : {})) {
    if (value === null || value === undefined || value === '') delete next[key]
    else next[key] = value
  }
  writeSettings({ git: next }, env)
  return next
}

