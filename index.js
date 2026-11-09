/**
 * dsh-engram 包入口：插件 + 控制台 API + 引擎，一个包对外。
 */

export { name, inject, apply } from './plugin.js'
export { API_PREFIX, APP_NAME } from './ui/shell.js'
export { createSource, buildState, buildExperiences, buildExperience, buildSkills } from './ui/shell.js'
export { createEngine } from './kernel/engine.js'
