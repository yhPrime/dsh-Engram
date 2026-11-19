/**
 * 0.32：把经验拆成「纯动作」记录（一条原始经验按每个动作一条）。
 *
 * 口径（2026-11-19 用户拍板）：
 *  - 只保留动作与命令/操作顺序，不保留项目/任务过程；
 *  - 命令统一占位符（<path>/<repo>/<version>/<url>/<name>/<id>）；
 *  - 原因/坑单独记为「失败动作 + 原因」的负面经验，和正向动作一起给模型；
 *  - 对象面不再参与标签/排序/分族。
 *
 * 纯函数：不读写盘；迁移工具负责备份与 writeStore。
 */
import { createHash } from 'node:crypto'

export const ACTION_TYPE = { id: 'ty_action', name: '动作经验' }

export const ACTION_FAMILIES = Object.freeze([
  '提交', '推送', '校验', '修复', '编写', '验收', '恢复', '注册', '沉淀', '分类', '部署', '分析', '整理', '配置', '执行', '其它动作',
])

export const ACTION_FAMILY_LABELS = Object.freeze({
  提交: '提交', 推送: '推送', 校验: '校验', 修复: '修复', 编写: '编写', 验收: '验收',
  恢复: '恢复', 注册: '注册', 沉淀: '沉淀', 分类: '分类', 执行: '执行', 其它动作: '其它动作',
})

const NEGATIVE_OUTCOMES = new Set(['failed', 'corrected', 'partial', 'aborted'])
const NEGATIVE_NOTE_RE = /(失败|报错|不可用|被拒|被拒|error|failed|exception|超时|中斷|中断)/iu
const FAILURE_WORDS_RE = /(失败|报错|不可用|被拒|error|failed|exception|超时|中断)/iu

/** 动作族关键词表（按优先级从具体到宽泛；先匹配先得）。 */
const FAMILY_RULES = [
  ['提交', /(git\s+commit|git\s+add|\bcommit\b|提交)/iu],
  ['推送', /(git\s+push|git\s+tag|\bpush\b|推送|上传)/iu],
  ['校验', /(npm\s+(run\s+)?test|node\s+--test|\btest\b|校验|验证|对拍|回归|检查|断言)/iu],
  ['修复', /(修复|修\s*bug|fix|解决.*(报错|问题)|hotfix|回滚.*修复)/iu],
  ['编写', /(编写|撰写|写文档|生成|创建|改文档|排版|插页)/iu],
  ['验收', /(验收|判据|accept)/iu],
  ['恢复', /(恢复|回滚|还原|restore|rollback)/iu],
  ['注册', /(注册|安装|\binstall\b|\badd\b|挂载)/iu],
  ['沉淀', /(沉淀|consolidat|技能)/iu],
  ['分类', /(分类|归类|打标签|assign|merge)/iu],
  ['部署', /(部署|发布|上线|打包|构建|\bbuild\b|\bdeploy\b)/iu],
  ['分析', /(复现|定位|分析|排查|诊断|看日志|根因|\bdebug\b)/iu],
  ['整理', /(整理|清理|归档|目录|文件整理|\btidy\b)/iu],
  ['配置', /(配置|设置|环境变量|权限|\bconfig\b|\bsettings\b)/iu],
  ['执行', /(跑|执行|\brun\b|\bcd\b|\bnode\b|\bgit\b|\bnpm\b|powershell|pwsh)/iu],
]

/** 占位符替换：路径、URL、版本、日期、ID、引号内容。 */
export function placeholderize(text) {
  let out = String(text === undefined || text === null ? '' : text)
  out = out.replace(/https?:\/\/[^\s"'）)】]+/gu, '<url>')
  out = out.replace(/[A-Za-z]:\\[^\s"'，；;）)】]+/gu, '<path>')
  out = out.replace(/(?<![\w<])\/(?:[^\s"'，；;）)】/]+\/)+[^\s"'，；;）)】/]*/gu, '<path>')
  out = out.replace(/\b\d{4}-\d{2}-\d{2}(?:[T ][\d:.+-]+Z?)?\b/gu, '<date>')
  out = out.replace(/\bv(\d+\.\d+(?:\.\d+)?(?:-[\w.]+)?)\b/gu, 'v<version>')
  out = out.replace(/\b\d+\.\d+(?:\.\d+)?(?:-[\w.]+)?\b/gu, '<version>')
  out = out.replace(/\b(?:ex|act|neg|smoke|sess)_[A-Za-z0-9_-]{4,}\b/gu, '<id>')
  out = out.replace(/\b[0-9a-f]{12,}\b/giu, '<id>')
  out = out.replace(/"[^"]{1,80}"/gu, '<name>')
  out = out.replace(/'[^']{1,80}'/gu, '<name>')
  return out.replace(/\s+/gu, ' ').trim()
}

/** 单步动作归类。 */
export function classifyStep(step) {
  const text = String(step || '')
  for (const [family, pattern] of FAMILY_RULES) {
    if (pattern.test(text)) return family
  }
  // 命令/脚本片段（$var、Get-*、路径、cd、copy 等）统一归「执行」，避免把一条脚本拆成十几个动作。
  if (/^\s*(?:跑|\$|Get-|Set-|New-|Remove-|Select-|Copy-|Move-|cd\b|node\b|npm\b|git\b|pwsh\b|powershell\b|del\b|dir\b|ls\b)/iu.test(text)) return '执行'
  return '其它动作'
}

/** 把 action 文本切成有序步骤（去空、保序、占位符化）。 */
export function splitSteps(actionText) {
  const raw = String(actionText === undefined || actionText === null ? '' : actionText)
  if (raw.trim() === '') return []
  // 先保护命令里的分号？这里按用户口径「命令的执行顺序」拆，分号/箭头/换行都算步骤边界。
  const parts = raw
    .split(/\s*(?:→|->|=>|；|;|\n|\r|然后|接着|随后)\s*/u)
    .map((part) => placeholderize(part))
    .filter((part) => part !== '')
  if (parts.length === 0) {
    const single = placeholderize(raw)
    return single === '' ? [] : [single]
  }
  return parts
}

/** 连续同族步骤合并为一个动作记录（保持顺序）。 */
function groupByFamily(steps) {
  // 同一动作族的步骤合并成一条（保持首次出现顺序）；不要求相邻，
  // 否则一条脚本里的零散命令会被拆成十几个动作。
  const order = []
  const byFamily = new Map()
  for (const step of steps) {
    const family = classifyStep(step)
    if (!byFamily.has(family)) { byFamily.set(family, []); order.push(family) }
    byFamily.get(family).push(step)
  }
  return order.map((family) => ({ family, steps: byFamily.get(family) }))
}

function hashOf(text) {
  return createHash('sha1').update(String(text)).digest('hex').slice(0, 12)
}

/**
 * 拆分一条原始经验。
 * @returns {{actions: object[], negatives: object[], unparsed: string}}
 */
export function splitExperience(row) {
  const source = row !== null && typeof row === 'object' ? row : {}
  const sourceId = String(source.id || '')
  const steps = splitSteps(source.action)
  if (steps.length === 0) {
    return { actions: [], negatives: [], unparsed: sourceId || '(no-id)' }
  }
  const note = String(source.note || '')
  const outcome = String(source.outcome || 'unknown').toLowerCase()
  const negative = NEGATIVE_OUTCOMES.has(outcome) || NEGATIVE_NOTE_RE.test(note)
  const groups = groupByFamily(steps)
  const ts = String(source.ts || source.createdAt || new Date().toISOString())
  const actions = []
  const negatives = []
  const failingGroup = negative
    ? (groups.find((group) => group.steps.some((step) => FAILURE_WORDS_RE.test(step))) || groups[0])
    : null
  const emitGroups = negative && failingGroup !== null ? [failingGroup] : groups
  const negativeSteps = negative ? steps.slice() : []
  emitGroups.forEach((group, index) => {
    const base = {
      id: `${negative ? 'neg' : 'act'}_${hashOf(`${sourceId}|${index}|${group.family}`)}`,
      sourceId,
      typeId: ACTION_TYPE.id,
      typeName: ACTION_TYPE.name,
      family: group.family,
      actionFamily: group.family,
      order: index + 1,
      steps: negative ? negativeSteps : group.steps.slice(),
      intent: `${group.family}：${group.steps[0]}`.slice(0, 120),
      action: group.steps[0],
      context: negative ? [group.family, '失败'] : [group.family],
      outcome: negative ? (outcome === 'unknown' ? 'failed' : outcome) : 'success',
      GOutcome: negative ? -0.6 : 0.8,
      G: negative ? -0.6 : 0.8,
      hits: 1,
      ts,
      lastSeenAt: ts,
      kind: negative ? 'action-negative' : 'action',
    }
    if (negative) {
      const failureLine = group.steps.find((step) => FAILURE_WORDS_RE.test(step)) || ''
      const reason = (note.trim() !== '' ? note.trim() : failureLine).slice(0, 240) || '原因未记录'
      base.failure = { step: index + 1, reason: placeholderize(reason) }
      base.intent = `${group.family}失败：${base.failure.reason}`.slice(0, 120)
      negatives.push(base)
    } else {
      actions.push(base)
    }
  })
  return { actions, negatives, unparsed: '' }
}

/**
 * 把整个 store 拆成动作库。
 * @returns {{store: object, report: object}}
 */
export function splitStore(store) {
  const rows = Array.isArray(store && store.experiences) ? store.experiences : []
  const actions = []
  const negatives = []
  const unparsed = []
  let negativeSources = 0
  for (const row of rows) {
    if (row === null || typeof row !== 'object' || row.deleted_at || row.superseded_by) continue
    const split = splitExperience(row)
    if (split.unparsed !== '') {
      unparsed.push(split.unparsed)
      continue
    }
    if (split.negatives.length > 0) negativeSources += 1
    actions.push(...split.actions)
    negatives.push(...split.negatives)
  }
  const nextStore = {
    version: Number(store && store.version) || 1,
    types: [{ ...ACTION_TYPE }],
    experiences: [...actions, ...negatives],
    stats: null,
    recent: null,
  }
  return {
    store: nextStore,
    report: {
      sourceRows: rows.length,
      actionRows: actions.length,
      negativeRows: negatives.length,
      negativeSources,
      unparsed,
    },
  }
}
