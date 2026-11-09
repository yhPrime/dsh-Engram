/**
 * dsh-Engram core 稳定入口（M1）。
 *
 * 只导出与宿主无关的核心：状态抽象、召回、分簇、存储、技能、工具工厂。
 * 不含 DSH Provider / 插件注册 / systemPrompt——这些在适配层（index/plugin/provider）。
 *
 * 边界由 tests/core-boundary.test.mjs 守护：这里的 import 图不能出现
 * `@deepseek-ai/*`、`provider.js`、`plugin.js`、`index.js`。
 */
export * from './kernel.js'
export * from './retrieval.js'
export * from './cluster.js'
export * from './store.js'
export * from './skills.js'
export * from './tools.js'
