/**
 * exp-ui — 设置 / 数据源同步 / GitHub 登录 / 会话转存相关路由。
 *
 * /settings /sync /github /pick-directory /chat-save /chat-save-probe。
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { defaultDataDir, moveDataRoot, readEngineConfig, readGitConfig, readRuntimeEnv, readUiConfig, resolveEngramDataDir, setCurrentRoot, storageRootFor, writeEngineConfig, writeGitConfig, writeUiConfig } from '../kernel/settings.js'
import { ensureDefaultTypes } from '../kernel/store.js'
import { gitInit, gitPull, gitPush, gitStatus } from '../kernel/git-sync.js'
import { findSessionFile, probeSessions, saveTurnAsExperience } from '../kernel/chat-save.js'
import { githubCreateRepo, githubLogin, githubRepos } from '../kernel/github.js'
import { pollDeviceFlow, startDeviceFlow } from '../kernel/github-device.js'
import { json, fail, readBody, readOf, metaOf, pluginVersion, resetSourceCache, describeDirectoryPicker, pickDirectory } from './api-core.js'

/** 设置页可编辑项（全部都在这里，未知键不落盘）。 */
export const SETTINGS_SPEC = {
  config: [
    { key: 'hint', label: '每轮提示段', type: 'boolean', hint: '关闭后不再向系统提示写经验库用法', tip: '开启时，每轮系统提示里会多一段以「【经验库】」开头的说明（条数/类型目录/用法）。关掉后要重载插件才会撤掉已经注册的那一段——保存后提示段不会立刻消失。' },
    { key: 'hintMode', label: '提示段样式', type: 'enum', values: ['slim', 'full'], labels: { slim: '瘦身（默认，约 150 字符）', full: '完整（含类型/技能目录）' }, tip: '瘦身档只写「该不该记 + 怎么用 + 条数 + 待判定 + 前几个技能」；完整档会列全部类型与技能，每轮固定开销约 1,300 字符。' },
    { key: 'hintSkills', label: '提示段列技能', type: 'boolean', tip: '瘦身档里是否列技能名（按顺序最多 8 个）；关掉后技能只在 exp_recall 命中时出现。' },
    { key: 'recallLimitDefault', label: '召回默认条数', type: 'number', hint: '默认 3', tip: 'exp_recall 不传 limit 时返回几条候选。显式传 limit 时按传的来（上限 8）。' },
    { key: 'pendingTtl', label: '待判定提醒次数', type: 'number', hint: '默认 3', tip: '一条待判定记录随回执出现几次仍未被回填，就自动转 skipped（止损，不再打扰模型）。' },
    { key: 'pendingReceipt', label: '回执带待判定', type: 'boolean', tip: '关闭后 exp_record / exp_recall 的返回里不再附带 pending，判定只能靠控制台查看。' },
    { key: 'autoRecord', label: '自动记录回合', type: 'boolean', default: false, hint: '默认关', tip: '默认关闭。打开后每个回合收尾时，把这一轮的交付动作自动记成一条待判定经验（note 里带工具序列与产物，成败留待回填）；每轮都记会攒下大量没人回填的待判定行。纯问答、寒暄、以及本回合已经手动 exp_record 的不会重复记；关着就完全依赖模型手动记录。' },
    { key: 'tagShadow', label: '标签影子对照', type: 'boolean', default: false, hint: '默认关', tip: '打开后每次召回都额外算一遍「只按标签排序」的结果（不改候选顺序与数量），用于观察标签排序与类型路由的差异；控制台检索页可临时勾选查看，不必长期打开。' },
    { key: 'tagRank', label: '标签进查询', type: 'enum', values: ['shadow', 'on', 'off'], labels: { shadow: '影子（默认，只记录）', on: '生效', off: '关' }, hint: '默认 shadow', tip: 'shadow：从意图自动抽标签，只写 usage 供判据报表，不改召回；on：把抽出的标签并进 context，走既有 contextMatch 加分（复用同一套排序，不新增打分代码）；off：完全不抽。0.30 A/B：同词 Recall 0.7333（on=off），换说法集缺失、未达 +10pp，故默认仍 shadow。' },
    { key: 'skillBodyMode', label: '技能正文模式', type: 'enum', values: ['full', 'clip'], labels: { full: '全文（默认）', clip: '裁剪 6000 字（排障）' }, hint: '默认全文', tip: '全文＝像普通技能一样让模型通读（安全上限 30000 字，超了保留开头与 Resources/脚本节）；裁剪＝只给前 6000 字并保留末尾脚本节，仅用于排障或省 token。' },
    { key: 'skillCatalog', label: '会话技能目录', type: 'boolean', default: true, hint: '默认开', tip: '命中过的技能会发一份会话级技能目录；上下文被压缩遮掉后，下一步自动补发一份替换版，模型据此按 exp_recall({skill, load:true}) 重取正文。关掉就完全退回 0.20.9 行为：每次命中都给全文，不发目录也不补发。目录条数上限 / 描述截断长度只在 settings.json 里改（catalogMaxSkills / catalogDescriptionChars），不在本页。' },
    { key: 'reuseReceipt', label: '复用短回执', type: 'boolean', default: true, hint: '默认开', tip: '同一个技能本会话已给过全文、且那条结果仍在可见上下文里时，只给 ≤400 字短回执（3 条正文二级标题锚点 + 「对不上就重取」提示），不再重发 4–7k token 的全文。关掉后每次都发全文，只用于排障。' },
    { key: 'usageLog', label: '用法日志', type: 'boolean', hint: '记录 exp_* 调用，用于使用记录页', tip: '把每次 exp_record / exp_recall / exp_feedback 的调用写进 <数据目录>/usage.jsonl，零 token 开销；关掉后「使用记录」页就没有新数据。' },
    { key: 'usageLogMaxBytes', label: '日志上限（字节）', type: 'number', tip: 'usage.jsonl 超过这个大小就轮转成 usage.jsonl.1（只保留一份旧文件）。内部有 1024 字节下限：填 1 也按 1024 生效。' },
    { key: 'feedbackEta', label: '反馈学习率 η', type: 'number', hint: '0~1，默认 0.35', tip: '每次「有帮助/没帮上」把 G 往 +1 / -1 拉的幅度。η 越大改得越快；默认 0.35。' },
    { key: 'feedbackDecayDays', label: '反馈衰减（天）', type: 'number', tip: '它不是「G 随时间自然衰减」，而是「超过天数的旧反馈事件折叠进基准 GOutcome」——折叠后 G 值不变，只是日志变短（压缩）。填 0 表示不折叠。' },
    { key: 'routing', label: '簇路由', type: 'enum', values: ['on', 'shadow', 'off'], hint: '默认 off', tip: 'on：召回先用簇路由收窄候选；shadow：只记录路由结果不实际收窄（用来对比效果）；off：全库检索。0.30 A/B：off Recall@5 0.75 ≥ on 0.7333，默认 off；on 只留显式调试。' },
    { key: 'autoAssign', label: '自动记录归族', type: 'boolean', tip: '只对自动记录（回合收尾那条）生效：它没给类型，就按簇路由归族。手动 exp_record 不再自动归族——主分类由模型自己给，没给就落「未分类」并在回执里提示补（0.21.3 计划书 §0.1 D1/D3）。' },
    { key: 'autoRouteMinScore', label: '自动记录归族门槛', type: 'number', hint: '0~1，默认 0.08', tip: '自动记录归族用的分数门槛，比召回路由的 0.17 松：自动记录的意图常是短追问，词面信号弱。调高更保守（更多落「未分类」），调低更激进（更容易归错族）。' },
    { key: 'consolidation', label: '沉淀候选', type: 'boolean', tip: '召回结果里附带一条「候选规则」：同族样本够多、且正负对照都有时才给，用来提示可以沉淀成技能。不写库、不花 token。' },
    { key: 'consolidationMinSamples', label: '沉淀最少样本', type: 'number', tip: '同族至少多少条才给「候选规则」（默认 3，且必须同时有正回报和负回报）。' },
    { key: 'induction', label: '归纳提示', type: 'boolean', tip: '召回到同族多条时，额外给一段「原料」让模型自己归纳共性；它明确写着「别当结论」，只是提示。' },
    { key: 'inductionMinSamples', label: '归纳最少样本', type: 'number', tip: '同族至少多少条才给归纳提示（默认 3）。' },
    { key: 'maxTypes', label: '类型上限', type: 'number', tip: '用户类型最多几个（不含系统「未分类」）。超限后新类型名会归到「未分类」并把原因写进 exp_record 的回执。' },
    { key: 'newTypesPerDay', label: '每日新类型上限', type: 'number', tip: '一天最多新建几个类型，防止类型爆炸；超了同样归「未分类」。' },
    { key: 'mergeThreshold', label: '类型合并阈值', type: 'number', tip: '重记一条「没写类型」的经验时，若同做法的旧经验相似度达到这个阈值，就继承它的类型。注意：类型名互相包含（如「文档写作」/「文档写作文案」）会直接合并，不受这个阈值影响。' },
    { key: 'replaceThreshold', label: '经验取代阈值', type: 'number', tip: '新记录与旧经验意图相似度达到这个阈值时，旧条标记为「被取代」（保留历史但不再参与召回）。' },
    { key: 'typeSimilarity', label: '类型相似度阈值', type: 'number', tip: '新建类型时，名字与已有类型的相似度（二元组 Jaccard）达到这个值就并入已有类型，不新建。' },
    // 运行环境（P1）：用于经验 appliesTo 门控；不填 = 未声明，不会因此拦掉任何经验。
    { key: 'currentModel', label: '当前模型', type: 'string', group: '运行环境', hint: '如 deepseek-flash；留空＝未声明', tip: '只用于判断经验 appliesTo.models 是否匹配：模型不在声明里 → 该经验默认不召回（includeMismatched 可查看）。不会去读宿主内部模型名。' },
    { key: 'currentTool', label: '工具版本', type: 'string', group: '运行环境', hint: '如 dsh-engram@0.19.46', tip: '对应经验 appliesTo.tools。升级插件后记得改这里：旧版本的具体步骤/命令会因此被默认隐藏，而不是被当成命令照做。' },
    { key: 'currentEnvironment', label: '运行环境', type: 'string', group: '运行环境', hint: '如 Windows / WSL / 沙箱', tip: '对应经验 appliesTo.environment，大小写不敏感。只用于范围匹配，不影响 G/Â。' },
  ],
  ui: [
    { key: 'source', label: '数据源', type: 'enum', values: ['live', 'mock'], hint: 'mock 仅用于界面演示', tip: 'live：读真实经验库；mock：读内置示例数据（只用于看界面效果，不写真实库）。' },
    { key: 'dataDir', label: '目录覆盖', type: 'string', hint: '留空则用「存储位置」里的当前根', tip: '只影响「控制台读哪份库」，不影响工具写入。工具始终写到「存储位置」里的当前根；两边可以指向不同目录——看起来「数据不一致」时先来这里检查。' },
    { key: 'graphPalette', label: '关系图配色', type: 'enum', values: ['dsh', 'codex', 'universe', 'cosmos', 'cyberpunk', 'aurora', 'blackgold', 'steampunk', 'qingmo', 'minimal', 'lava'], labels: { dsh: '跟随当前主题', codex: '默认主题', universe: '超能量体', cosmos: '宇宙', cyberpunk: '赛博朋克', aurora: '极光空灵', blackgold: '黑金科幻', steampunk: '蒸汽复古', qingmo: '青墨国风', minimal: '极简冷科技', lava: '熔岩炽热' }, tip: '「默认主题」是蓝紫星辰，首次安装/未选择时使用；之后改过哪个就记住哪个。「跟随当前主题」实时读当前主题的渐变。' },
    { key: 'graphSurface', label: '关系图背景', type: 'enum', values: ['theme', 'light', 'dark'], labels: { theme: '跟随主题', light: '浅色', dark: '深色' }, tip: '关系图画布的背景深浅。跟随主题＝透明，用页面本来的底色；浅色/深色会铺一层固定底色，同时把节点的明暗补偿一起切过去。图左下角的胶囊也能直接切。' },
    { key: 'graphRotation', label: '自动旋转速度', type: 'number', hint: '弧度/秒，0 为关闭', tip: '关系图自动旋转的速度（弧度/秒）；0 = 不转。拖动时暂停，松手继续。' },
    { key: 'graphBloom', label: '泛光 bloom', type: 'boolean', tip: '给亮节点叠一层柔光，暗色主题下更明显；关掉更省绘制。' },
    { key: 'graphGlitch', label: '色散/毛刺', type: 'boolean', tip: '给高亮节点/连线加一点 RGB 分离的故障感；关掉更干净。' },
    { key: 'graphDust', label: '浮尘数量', type: 'number', hint: '0~240', tip: '背景里漂浮的尘埃粒子数量（0~240）；太吃性能就调低。' },
  ],
  git: [
    { key: 'repoUrl', label: '远端仓库', type: 'string', hint: 'https://… 或 git@host:path 或本机绝对路径', tip: '经验库会以这个仓库为备份目标。https 推公开/私有仓库都行；地址里不要写账号密码，token 填在下面。' },
    { key: 'branch', label: '分支', type: 'string', hint: '默认 main', tip: '推送到哪个分支；不存在会自动建。' },
    { key: 'pushStrategy', label: '推送策略', type: 'enum', values: ['ask', 'overwrite', 'fast-forward'], labels: { ask: '检测到远端有新提交时问我（默认）', overwrite: '直接本地覆盖云端', 'fast-forward': '只允许快进' }, tip: '本地覆盖云端：远端有本机没有的提交时直接用本机强推（覆盖前会把旧远端 HEAD 存到本地的 refs/engram/overwritten/*，还能捞回来）。只允许快进：分叉就报错、交回人处理。经验库是本机资产、云端只是备份，所以默认本地赢。' },
    { key: 'token', label: '访问 token（可选）', type: 'string', hint: '设备登录成功后自动填；也可手动贴 PAT', tip: '优先用上面的「用 GitHub 登录」（设备码，免 token）。这里只作后备：手动贴 GitHub PAT（classic 勾 repo），或设备登录后自动写入。它只存在本机 ~/.dsh/engram/settings.json，推送时走 http.extraHeader，错误信息里打码。' },
    { key: 'authorName', label: '提交作者名', type: 'string', hint: '留空用全局 git 身份', tip: '写进 commit 的作者名；留空就用你机器上的 git 全局配置。' },
    { key: 'authorEmail', label: '提交作者邮箱', type: 'string', hint: '留空用全局 git 身份', tip: '写进 commit 的邮箱；留空用全局 git 配置。' },
    { key: 'autoBackupMinutes', label: '自动备份间隔（分钟）', type: 'number', hint: '0 = 关闭；最小 15', tip: '开启后插件会按这个间隔自动 commit + push（没有改动就跳过）。0 表示只手动推送；最小 15 分钟，避免频繁推。' },
  ],
}

function sanitizeSettings(input, fields) {
  const out = {}
  for (const field of fields) {
    if (input === null || typeof input !== 'object' || !Object.prototype.hasOwnProperty.call(input, field.key)) continue
    const value = input[field.key]
    if (field.type === 'boolean') out[field.key] = value === true
    else if (field.type === 'number') {
      const number = Number(value)
      out[field.key] = Number.isFinite(number) && value !== '' && value !== null ? number : null
    } else if (field.type === 'enum') {
      out[field.key] = field.values.includes(String(value)) ? String(value) : null
    } else {
      out[field.key] = value !== null && value !== undefined && String(value).trim() !== '' ? String(value).trim() : null
    }
  }
  return out
}

/** 设备码登录的临时会话（只存在内存，不落盘；成功换到 token 才写 settings）。 */
let deviceSession = null

/** 打开系统浏览器（尽力而为，失败不影响登录流程）。 */
function openExternal(url) {
  try {
    const command = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open'
    const child = spawn(command, [url], { detached: true, stdio: 'ignore', windowsHide: true })
    child.unref()
    return true
  } catch {
    return false
  }
}

/** 把验证码写进系统剪贴板（Windows 用 clip.exe；其他平台尽力而为）。 */
function copyToClipboard(text) {
  return new Promise((resolve) => {
    try {
      const command = process.platform === 'win32' ? 'clip' : process.platform === 'darwin' ? 'pbcopy' : 'xclip'
      const args = process.platform === 'linux' ? ['-selection', 'clipboard'] : []
      const child = spawn(command, args, { windowsHide: true })
      child.on('error', () => resolve(false))
      child.on('close', (code) => resolve(code === 0))
      child.stdin.end(text)
    } catch {
      resolve(false)
    }
  })
}

export function buildSettings(source) {
  const read = readOf(source)
  const extra = source && typeof source.settings === 'function' ? source.settings() : {}
  const storage = read.storage !== null && typeof read.storage === 'object' ? read.storage : null
  return {
    source: metaOf(source),
    dataDir: String(read.dataDir || ''),
    file: String(read.file || ''),
    exists: Boolean(read.exists),
    bytes: Number(read.bytes) || (storage === null ? 0 : Number(storage.totalBytes) || 0),
    updatedAt: read.updatedAt === null || read.updatedAt === undefined ? '' : String(read.updatedAt),
    ...(storage !== null ? { storage } : {}),
    currentRoot: String(extra.currentRoot || ''),
    version: pluginVersion(),
  }
}

export async function handlePickDirectory(ctx) {
  const { req, res, active, url, method, deps } = ctx
  // 只读探针：GET ?probe=1 只回答「能不能弹窗口」，不弹。
  if (url.searchParams.get('probe') === '1') {
    if (method !== 'GET') return fail(res, 405, 'method-not-allowed', '探针只用 GET')
    return json(res, 200, { ok: true, data: describeDirectoryPicker(deps) })
  }
  if (method !== 'POST') return fail(res, 405, 'method-not-allowed', '只用 POST')
  // 窗口是模态的：请求挂着等人选完；页面关了就把窗口一起收掉。
  // 听的是 res 的 close，不是 req 的——Node 16 起 req 的 close 在请求体收完就会发，
  // 那会立刻把窗口关掉。
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  if (controller !== null && typeof res.on === 'function') {
    res.on('close', () => { if (res.writableEnded !== true) controller.abort() })
  }
  return json(res, 200, { ok: true, data: await pickDirectory(deps, controller === null ? undefined : controller.signal) })
}

export async function handleSettings(ctx) {
  const { req, res, active, url, method, deps } = ctx
  if (method === 'POST') {
    const body = await readBody(req)
    if (body && Object.prototype.hasOwnProperty.call(body, 'currentRoot')) {
      const rawRoot = String(body.currentRoot || '').trim()
      const oldRoot = resolveEngramDataDir()
      const newRoot = rawRoot === '' ? defaultDataDir() : storageRootFor(rawRoot)
      try {
        if (path.resolve(oldRoot) !== path.resolve(newRoot)) moveDataRoot(oldRoot, newRoot)
        // 存实际数据根（.exp），不是用户选的父目录；下次切根才不会再套一层。
        setCurrentRoot(newRoot)
        // 用户第一次选择存储位置（或走默认根）：先保证目录存在，再种默认主分类；已有数据不动。
        const activeRoot = resolveEngramDataDir()
        fs.mkdirSync(activeRoot, { recursive: true })
        ensureDefaultTypes(activeRoot)
      } catch (error) {
        return fail(res, 409, 'root-move-failed', error && error.message ? error.message : '切换存储位置失败')
      }
    }
    if (body && body.config !== undefined) writeEngineConfig(sanitizeSettings(body.config, SETTINGS_SPEC.config))
    if (body && body.ui !== undefined) writeUiConfig(sanitizeSettings(body.ui, SETTINGS_SPEC.ui))
    if (body && body.git !== undefined) writeGitConfig(sanitizeSettings(body.git, SETTINGS_SPEC.git))
    resetSourceCache()
    return json(res, 200, { ok: true, data: { action: 'saved' } })
  }
  if (method !== 'GET') return fail(res, 405, 'method-not-allowed', '只用 GET/POST')
  return json(res, 200, { ok: true, data: { ...buildSettings(active), config: readEngineConfig(), ui: readUiConfig(), git: readGitConfig(), runtime: readRuntimeEnv(), spec: SETTINGS_SPEC } })
}

export async function handleSync(ctx) {
  const { req, res, active, url, method, deps } = ctx
  const dataDir = String((active.read && active.read().dataDir) || '').trim() || resolveEngramDataDir()
  const config = readGitConfig()
  if (method === 'GET') return json(res, 200, { ok: true, data: await gitStatus(dataDir, config) })
  if (method !== 'POST') return fail(res, 405, 'method-not-allowed', '只用 GET/POST')
  const body = await readBody(req)
  const action = String((body && body.action) || 'push').trim().toLowerCase()
  if (!['init', 'push', 'pull', 'status', 'disconnect'].includes(action)) return fail(res, 400, 'bad-action', `未知动作：${action}`)
  if (action === 'status') return json(res, 200, { ok: true, data: await gitStatus(dataDir, config) })
  if (action === 'init') return json(res, 200, { ok: true, data: await gitInit(dataDir, config) })
  if (action === 'pull') return json(res, 200, { ok: true, data: await gitPull(dataDir, config) })
  if (action === 'disconnect') {
    // 只断开「备份到哪个仓库」：清掉 repoUrl，本地提交历史与 GitHub 登录令牌都留着。
    writeGitConfig({ repoUrl: '' })
    return json(res, 200, { ok: true, data: { ok: true, action: 'disconnect', disconnected: true } })
  }
  return json(res, 200, {
    ok: true,
    data: await gitPush(dataDir, config, { message: body && body.message, force: body && body.force === true, branch: body && body.branch }),
  })
}

export function handleChatSaveProbe(ctx) {
  const { req, res, active, url, method, deps } = ctx
  const mid = String((req.url || '').split('mid=')[1] || '').split('&')[0]
  return json(res, 200, { ok: true, data: probeSessions(mid === '' ? '' : decodeURIComponent(mid)) })
}

export async function handleChatSave(ctx) {
  const { req, res, active, url, method, deps } = ctx
  if (method !== 'POST') return fail(res, 405, 'method-not-allowed', '只用 POST')
  const body = await readBody(req)
  const sessionId = String((body && body.sessionId) || '').trim()
  const messageId = String((body && body.messageId) || '').trim()
  if (messageId === '') return fail(res, 400, 'ids-required', '缺少 messageId')
  const dataDir = String((active.read && active.read().dataDir) || '').trim() || resolveEngramDataDir()
  try {
    const logFile = path.join(String(process.env.DSH_HOME || '').trim() === '' ? path.join(process.env.USERPROFILE || '', '.dsh') : String(process.env.DSH_HOME), 'engram', 'chat-save.log')
    fs.mkdirSync(path.dirname(logFile), { recursive: true })
    fs.appendFileSync(logFile, `${new Date().toISOString()} sessionId=${sessionId || '(空)'} messageId=${messageId}\n`)
  } catch {
    // 日志失败不影响保存
  }
  let saved
  try {
    saved = saveTurnAsExperience(dataDir, {
      sessionId,
      messageId,
      outcome: body && body.outcome,
      type: body && body.type,
      note: body && body.note,
    })
  } catch (error) {
    const debug = body && body.debug === true
      ? { dshHome: process.env.DSH_HOME || '(unset)', file: findSessionFile(sessionId), dataDir, sessionsRoot: path.join(String(process.env.DSH_HOME || '').trim() === '' ? path.join(process.env.USERPROFILE || '', '.dsh') : String(process.env.DSH_HOME), 'sessions') }
      : undefined
    return fail(res, 400, 'turn-not-found', error && error.message ? error.message : '读不到这条消息', debug)
  }
  return json(res, 200, { ok: true, data: saved })
}

export async function handleGithub(ctx) {
  const { req, res, active, url, method, deps } = ctx
  if (method !== 'POST') return fail(res, 405, 'method-not-allowed', '只用 POST')
  const body = await readBody(req)
  const action = String((body && body.action) || 'login').trim().toLowerCase()
  // 设备码登录：不需要用户先贴 token。
  if (action === 'device-start') {
    const flow = await startDeviceFlow({ clientId: readGitConfig().oauthClientId })
    deviceSession = {
      deviceCode: flow.deviceCode,
      expiresAt: Date.now() + flow.expiresIn * 1000,
      interval: flow.interval,
      nextPollAt: Date.now() + flow.interval * 1000,
    }
    // 自动打开浏览器 + 自动复制验证码（都尽力而为，失败不阻断）。
    // 自动化验证时传 noOpen:true，避免抢用户的浏览器和剪贴板。
    const quiet = body && body.noOpen === true
    const opened = quiet ? false : openExternal(flow.verificationUri)
    const copied = quiet ? false : await copyToClipboard(flow.userCode)
    return json(res, 200, {
      ok: true,
      data: {
        userCode: flow.userCode,
        verificationUri: flow.verificationUri,
        expiresIn: flow.expiresIn,
        interval: flow.interval,
        opened,
        copied,
      },
    })
  }
  if (action === 'device-poll') {
    if (deviceSession === null) return fail(res, 400, 'github', '没有正在进行的登录：先点「用 GitHub 登录」')
    if (Date.now() > deviceSession.expiresAt) {
      deviceSession = null
      return json(res, 200, { ok: true, data: { status: 'expired' } })
    }
    // 节奏由 host 掌握：客户端点得再快，也不会提前打 GitHub（否则必吃 slow_down）
    if (Date.now() < deviceSession.nextPollAt) {
      return json(res, 200, {
        ok: true,
        data: {
          status: 'pending',
          interval: deviceSession.interval,
          waitMs: Math.max(0, deviceSession.nextPollAt - Date.now()),
        },
      })
    }
    let polled
    try {
      polled = await pollDeviceFlow({ deviceCode: deviceSession.deviceCode, clientId: readGitConfig().oauthClientId })
    } catch (error) {
      if (deviceSession !== null) deviceSession.nextPollAt = Date.now() + deviceSession.interval * 1000
      throw error
    }
    if (deviceSession !== null) deviceSession.nextPollAt = Date.now() + deviceSession.interval * 1000
    if (polled.status === 'authorized') {
      writeGitConfig({ token: polled.token })
      deviceSession = null
      let user = null
      try {
        user = await githubLogin(polled.token)
        if (user && user.login) writeGitConfig({ login: user.login })
      } catch {
        user = null
      }
      return json(res, 200, { ok: true, data: { status: 'authorized', user } })
    }
    if (polled.status === 'expired' || polled.status === 'denied') deviceSession = null
    if (polled.status === 'slow-down' && deviceSession !== null) {
      deviceSession.interval += 5
      deviceSession.nextPollAt = Date.now() + deviceSession.interval * 1000
    }
    return json(res, 200, { ok: true, data: { status: polled.status, interval: deviceSession === null ? 0 : deviceSession.interval } })
  }
  if (action === 'device-cancel') {
    deviceSession = null
    return json(res, 200, { ok: true, data: { status: 'cancelled' } })
  }
  // 允许临时传 token（第一次登录），传了就顺手存下来，后面不用再贴。
  const provided = String((body && body.token) || '').trim()
  if (provided !== '') writeGitConfig({ token: provided })
  const git = readGitConfig()
  const token = provided !== '' ? provided : git.token
  if (!['login', 'repos', 'create', 'select'].includes(action)) return fail(res, 400, 'bad-action', `未知动作：${action}`)
  const dataDir = String((active.read && active.read().dataDir) || '').trim() || resolveEngramDataDir()
  if (action === 'login') {
    const user = await githubLogin(token)
    if (user.login !== '') writeGitConfig({ login: user.login })
    return json(res, 200, { ok: true, data: user })
  }
  if (action === 'repos') return json(res, 200, { ok: true, data: await githubRepos(token) })
  if (action === 'create') {
    const created = await githubCreateRepo(token, { name: body && body.name, private: body ? body.private !== false : true })
    writeGitConfig({ repoUrl: created.repo.cloneUrl, branch: created.repo.defaultBranch || git.branch })
    const nextConfig = readGitConfig()
    const init = await gitInit(dataDir, nextConfig)
    if (!init.ok) return json(res, 200, { ok: true, data: { action: 'create', repo: created.repo, init, sync: null } })
    const sync = await gitPush(dataDir, nextConfig, { message: body && body.message })
    return json(res, 200, { ok: true, data: { action: 'create', repo: created.repo, init, sync } })
  }
  // select：选中已有仓库 → 存地址 + 初始化 + 推送
  const repoUrl = String((body && body.repoUrl) || '').trim()
  if (repoUrl === '') return fail(res, 400, 'repo-required', '缺少 repoUrl')
  writeGitConfig({ repoUrl })
  const nextConfig = readGitConfig()
  const init = await gitInit(dataDir, nextConfig)
  const sync = init.ok ? await gitPush(dataDir, nextConfig, { message: body && body.message }) : null
  return json(res, 200, { ok: true, data: { action: 'select', repoUrl, init, sync } })
}
