/**
 * exp-ui — Host 半（HTTP 外壳）的对外面。
 *
 * 一个前缀路由 `/exp-ui/api`，客户端半只认这里的返回值；data source 可换
 * （mock = 内置示例数据，live = 读真实经验库文件），路由与返回形状不变。
 * 这样「外壳测试通过 → 接真实经验库」只是换 config，不是改界面。
 *
 * 实现按领域拆在 ui/api-*.js（扁平，不建子目录）：
 *   api-core.js     公共件（json/fail/readBody、storeOf/storeReadOf/readOf、safeSkills、
 *                   空库回退）+ 通用路由 + 唯一的按原顺序分派表（createRequestHandler）
 *   api-family.js   族 / 类型 / 标签 / 自动分类
 *   api-skill.js    固化技能（列表 / 导入 / 反馈 / 全局注册 / 节点 / 元数据 / 删除）
 *   api-settings.js 设置 / 同步 / GitHub 登录 / 选目录 / 会话转存
 *   api-graph.js    关系图 / 影子报表 / 对象链 / 冷档
 *
 * 本文件只做装配与再导出：外部导入路径（plugin.js、ui/tests）一律不变，
 * 导出名与拆分前逐字相同。分派顺序由 api-core.js 的 createRequestHandler 保证。
 *
 * 响应envelope：
 *   成功 { ok: true, data: … }
 *   失败 { ok: false, error: { code, message } }
 */

import { createRequestHandler, createSource } from './api-core.js'
import * as familyDomain from './api-family.js'
import * as graphDomain from './api-graph.js'
import * as settingsDomain from './api-settings.js'
import * as skillDomain from './api-skill.js'

/**
 * 单一请求入口：分派表在 api-core.js，顺序与原实现逐条一致。
 * 领域路由在这里注入（领域模块反过来用 core 的公共件，注入可避免循环 import）。
 */
export const handleRequest = createRequestHandler({
  family: familyDomain,
  skill: skillDomain,
  settings: settingsDomain,
  graph: graphDomain,
})

/**
 * 造一个绑定 config 的请求处理器（index.js 用它挂到 webServer）。
 * @param {object} config - 插件行 config（`source` / `dataDir`）。
 * @returns {(req: any, res: any) => Promise<void>}
 */
export function createApi(config = {}, deps = {}) {
  return (req, res) => handleRequest(req, res, createSource(config), deps)
}

export {
  API_PREFIX,
  APP_NAME,
  buildConsolidate,
  buildExperience,
  buildExperiences,
  buildFeedback,
  buildPending,
  buildRecall,
  buildRecord,
  buildReview,
  buildState,
  buildUsageSummary,
  buildValidate,
  buildVerdicts,
  createSource,
  describeDirectoryPicker,
  pickDirectory,
  pluginVersion,
  resetSourceCache,
  resolvePickedDirectory,
  sourceKeyOf,
} from './api-core.js'

export { buildTypeOp } from './api-family.js'
export { buildImportSkill, buildSkillFeedback, buildSkills } from './api-skill.js'
export { SETTINGS_SPEC, buildSettings } from './api-settings.js'
export { GRAPH_SUMMARY_LIMIT, GRAPH_SUMMARY_LIMIT_MAX, buildGraph, graphFamilyId } from './api-graph.js'
