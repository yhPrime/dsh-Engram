/**
 * dsh-engram — 独立入口。
 *
 * 这里不再导出记忆插件 Provider：Engram 是独立插件/库，
 * 记忆方式抄记忆系统（自有 settings/currentRoot），但不是它的扩展。
 */

export { createEngine, createTools } from './engine.js'
export { buildTools } from './tools.js'
export { resolveEngramDataDir, readSettings, writeSettings, setCurrentRoot, settingsFile } from './settings.js'
export { SPACE_DESCRIPTION, SPACE_NAME } from './store.js'
