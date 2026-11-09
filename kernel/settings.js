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
export function resolveEngramDataDir(config = {}, env = process.env) {
  const explicit = String((config && config.dataDir) || (env && env.ENGRAM_DATA_DIR) || '').trim()
  if (explicit !== '') return expand(explicit)
  const currentRoot = String(readSettings(env).currentRoot || '').trim()
  if (currentRoot !== '') return expand(currentRoot)
  return path.join(dshHome(env), APP_DIRNAME, 'data')
}

/** 记住当前数据根（管理页/CLI 用）。 */
export function setCurrentRoot(root, env = process.env) {
  return writeSettings({ currentRoot: expand(root) }, env)
}


/** 内核可调参数（设置页只暴露这些；未知键不落盘）。 */
export function readEngineConfig(env = process.env) {
  const config = readSettings(env).config
  return config !== null && typeof config === 'object' ? config : {}
}

export function writeEngineConfig(patch, env = process.env) {
  const current = readEngineConfig(env)
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
