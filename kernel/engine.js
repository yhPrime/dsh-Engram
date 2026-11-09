/**
 * dsh-Engram engine 门面（M2）
 *
 * 给非 DSH 宿主（外壳、CLI、脚本）的稳定入口：一个 dataDir，一套方法，
 * 不需要 DSH 运行时、不注册 Provider、不依赖 tools 协议。
 *
 *   const engine = createEngine({ dataDir: 'D:/proj/.exp' })
 *   engine.record(...) / engine.recall(...) / engine.feedback(...)
 *   engine.consolidate(...) / engine.listSkills() / engine.validate()
 */
import fs from 'node:fs'

import { buildTools } from './tools.js'
import { listSkills, readSkillBySlug, validateAllSkills } from './skills.js'
import { readStore, renderHint, storeFile } from './store.js'

/** 构建工具面（适配器与 headless 共用同一套配置解析）。 */
export function createTools(config = {}, defineTool = (definition) => definition) {
  return buildTools(defineTool, config)
}

export function createEngine(options = {}) {
  const dataDir = String(options.dataDir || '').trim()
  if (dataDir === '') throw new Error('createEngine 需要 dataDir（.exp 根目录）')
  const config = {
    ...(options.config || {}),
    dataDir,
    // 独立运行时没有 DSH Provider 状态文件，显式清空，避免误读 ~/.dsh。
    providerStateFile: '',
  }
  const tools = createTools(config, options.defineTool)
  const call = (name, args = {}) => {
    const tool = tools.find((item) => item.name === name)
    if (tool === undefined) throw new Error(`未知工具：${name}`)
    return tool.execute(args)
  }
  return {
    dataDir,
    config,
    record: (input = {}) => call('exp_record', input),
    recall: (input = {}) => call('exp_recall', input),
    feedback: (input = {}) => call('exp_feedback', input),
    consolidate: (input = {}) => call('exp_consolidate', input),
    types: (input = { action: 'list' }) => call('exp_type', input),
    tools: () => tools.map((tool) => tool.name),
    listSkills: () => listSkills(dataDir),
    readSkill: (slug) => readSkillBySlug(dataDir, slug),
    validate: () => validateAllSkills(dataDir),
    hint: (maxCharacters) => renderHint(config, maxCharacters),
    snapshot: () => {
      const file = storeFile(dataDir)
      let exists = false
      let bytes = 0
      let updatedAt = ''
      try {
        const stat = fs.statSync(file)
        exists = true
        bytes = stat.size
        updatedAt = stat.mtime.toISOString()
      } catch {
        // 文件不存在：按空库返回
      }
      let corrupt = false
      let parseError = ''
      if (exists) {
        try {
          JSON.parse(fs.readFileSync(file, 'utf8'))
        } catch (error) {
          corrupt = true
          parseError = String((error && error.message) || error)
        }
      }
      const store = corrupt ? { version: 1, types: [], experiences: [] } : readStore(dataDir)
      return { dataDir, file, exists, bytes, updatedAt, corrupt, parseError, store }
    },
  }
}
