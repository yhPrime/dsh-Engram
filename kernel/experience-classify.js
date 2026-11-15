/**
 * 一键分类的临时会话：只做「主分类 + 标签」判断。
 *
 * 约束（所有临时会话统一遵守）：
 *  - 不注入工具、不注入技能、不注入会话历史；只发分类所需的最小文本；
 *  - 低 maxTokens、短超时；失败一律退回本地规则，不让 UI 卡住；
 *  - 返回值明确 classifier='session' 或 'local'，调用方要如实告诉用户。
 */
import { isValidTag } from './store.js'
// 0.20.0 P0：自动分类只能从「core 种子 + 已复用」的词表里选，不许自己造实例标签（计划书 §5.2 / §12）。
import { canonicalRegisteredName, isCoreTag } from './tag-registry.js'

export const EXPERIENCE_SESSION_MAX_TOKENS = 120
export const EXPERIENCE_SESSION_TIMEOUT_MS = 15_000
export const EXPERIENCE_TEXT_LIMIT = 600
export const EXPERIENCE_TAG_LIMIT = 4

const SYSTEM = [
  '你是经验归档器。只输出一个 JSON 对象，不要解释、不要代码块、不要调用任何工具。',
  '字段：category（必须是给定主分类之一；都不合适就给空字符串）、tags（1-4 个短标签，只能从给定已有标签里选，不得新建；没有合适就给空数组）。',
  '标签要能拼出任务：至少 1 个「对象/项目类型」（如 代码/PPT/课件/DSH插件）+ 1 个「动作」（如 提交/推送/校验/验收）。只给大类会被要求补动作。',
  '不要用具体项目名/仓库名/版本号当标签。',
  '例：{"category":"办公","tags":["PPT","版式","校验"]}',
].join('\n')

function collect(chunks) {
  const pieces = []
  for (const chunk of chunks) {
    if (typeof chunk === 'string') pieces.push(chunk)
    else if (chunk && typeof chunk.text === 'string') pieces.push(chunk.text)
    else if (chunk && typeof chunk.delta === 'string') pieces.push(chunk.delta)
    else if (chunk && chunk.delta && typeof chunk.delta.text === 'string') pieces.push(chunk.delta.text)
  }
  return pieces.join('')
}

function parseJson(text) {
  const source = String(text || '').replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim()
  const start = source.indexOf('{')
  const end = source.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try { return JSON.parse(source.slice(start, end + 1)) } catch { return null }
}

/**
 * 只保留词表内、且在白名单里的标签；别名先归一。
 * `allowed` 为 null 表示「词表内即可」（会话分类给的是 tagNames，本身就是白名单）。
 */
function cleanTags(value, allowed = null) {
  const list = Array.isArray(value) ? value : []
  const allow = allowed === null ? null : new Set(allowed.map((item) => String(item || '').trim()))
  const out = []
  for (const item of list) {
    const raw = String(item || '').trim()
    if (raw === '') continue
    const name = canonicalRegisteredName(raw) || raw
    if (!isValidTag(name)) continue
    if (allow !== null && !allow.has(name)) continue
    if (out.some((existing) => existing.toLowerCase() === name.toLowerCase())) continue
    out.push(name)
  }
  return out.slice(0, EXPERIENCE_TAG_LIMIT)
}

/**
 * 本地兜底分类：只用**词表内**标签（core 或已被复用的），不自己造词。
 * 0.20.0 之前这里会把正则命中的任意技术词大写后当标签（`WORD`/`PYTHON`），违反「自动分类不得造实例/新标签」。
 */
export function localClassifyExperience({ text = '', typeNames = [], tagNames = [], allowedTags = null } = {}) {
  const rules = [
    ['办公', /ppt|pptx|docx|word|xlsx|excel|课件|教案|表格|wps|版式/i],
    ['运维', /部署|环境|网络|心跳|ssh|git|服务|端口|代理/i],
    ['项目', /验收|判据|计划|发布|流程|协作|里程碑/i],
    ['系统', /标识|上下文|运行时|幂等|状态|权限/i],
    ['内容', /文案|图片|网页|调研|资料|写作|素材/i],
  ]
  const found = rules.find(([, pattern]) => pattern.test(String(text || '')))
  const category = found && typeNames.includes(found[0]) ? found[0] : (typeNames.includes('开发') ? '开发' : (typeNames[0] || ''))
  const lower = String(text || '').toLowerCase()
  const allow = Array.isArray(allowedTags) && allowedTags.length > 0 ? allowedTags.map(String) : tagNames.map(String)
  const allowSet = new Set(allow)
  // 1) 文本里直接出现的白名单标签（长词优先，避免「PPT」吃掉「PPTX」这类包含关系）。
  const known = [...allowSet]
    .filter((tag) => isValidTag(tag) && tag.length >= 2 && lower.includes(String(tag).toLowerCase()))
    .sort((left, right) => right.length - left.length)
  // 2) 技术词走别名归一，并且必须已在白名单里（不新造）。
  const tech = String(text || '').match(/\b(?:ppt|pptx|word|docx|excel|xlsx|wps|python|typescript|javascript|git|ssh|dsh)\b/gi) || []
  const techTags = tech
    .map((item) => canonicalRegisteredName(item))
    .filter((name) => name !== null && allowSet.has(name))
  const picked = []
  for (const name of [...known, ...techTags]) {
    if (picked.some((existing) => existing.toLowerCase() === name.toLowerCase())) continue
    picked.push(name)
    if (picked.length >= EXPERIENCE_TAG_LIMIT) break
  }
  return {
    category,
    tags: picked,
    classifier: 'local',
    note: '没有可用模型会话，已用本地关键词兜底（只从词表里选，不额外消耗 Token）',
  }
}

/**
 * 一次最小临时会话分类。拿不到结果返回 null，调用方退回本地规则。
 */
export async function classifyExperienceWithSession({ llm, route, text = '', typeNames = [], tagNames = [] } = {}) {
  if (llm === null || llm === undefined || typeof llm.stream !== 'function') return null
  if (route === null || route === undefined) return null
  const names = typeNames.map((name) => String(name || '').trim()).filter(Boolean).slice(0, 6)
  if (names.length === 0) return null
  const body = String(text || '').slice(0, EXPERIENCE_TEXT_LIMIT)
  const user = [`主分类：${names.join('、')}`, `已有标签：${tagNames.slice(0, 20).join('、') || '（无）'}`, '', '经验：', body].join('\n')
  try {
    const stream = llm.stream({
      provider: route.provider,
      model: route.model,
      messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
      system: SYSTEM,
      maxTokens: EXPERIENCE_SESSION_MAX_TOKENS,
      reasoningEffort: 'off',
      temperature: 0,
      signal: AbortSignal.timeout(EXPERIENCE_SESSION_TIMEOUT_MS),
    })
    const pieces = []
    for await (const chunk of stream) pieces.push(chunk)
    const parsed = parseJson(collect(pieces))
    if (parsed === null) return null
    const category = String(parsed.category || '').trim()
    if (!names.includes(category)) return null
    return {
      category,
      tags: cleanTags(parsed.tags, tagNames),
      classifier: 'session',
      model: route.model,
      provider: route.provider,
      note: '分类由一次性临时会话完成（无工具、无历史，最小上下文）',
    }
  } catch {
    return null
  }
}
