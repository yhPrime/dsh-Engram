/**
 * exp-ui — 内置示例数据（mock data source）。
 *
 * 目的：没有真实经验库时，界面也能完整跑起来——列表、类型、使用记录、检索、
 * 详情、用后反馈都有东西可点，且不会因为字段缺失而报错。
 *
 * 约定：
 *   - 数据只存在进程内存里；反馈写的是这份假数据，不会落盘、不碰真实经验库。
 *   - 覆盖各种形态：成功/部分/失败/被纠正/中止、负回报、退休、被取代、已删除、
 *     超长备注、任务步骤、没有反馈、没有备注、未知结果。
 */

import { applyFeedbackTo, codedError, recallOf, scoreOf, skillRowOf } from './data-source.js'

/** 相对现在的时间，读起来像"最近用过"。 */
function daysAgo(days, hour = 10, minute = 0) {
  const date = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  date.setHours(hour, minute, 0, 0)
  return date.toISOString()
}

function minutesAgo(minutes) {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString()
}

/** 示例类型目录。 */
export function createMockTypes() {
  return [
    { id: 'ty_ppt', name: 'PPT / 课件', description: '做或改课件：研学课、常规课、插页、版式与动画。' },
    { id: 'ty_code', name: '代码 / 插件', description: '写代码、改插件、修 bug、跑测试。' },
    { id: 'ty_doc', name: '文档 / 教案', description: '写或改 Word、教案、讲义、学习任务单。' },
    { id: 'ty_data', name: '表格 / 数据', description: 'Excel、CSV、表格整理与报表。' },
    { id: 'ty_research', name: '调研 / 资料', description: '查资料、读文档、做调研与总结。' },
    { id: 'ty_other', name: '未分类', description: '暂时没有合适类型时落在这一类，之后可改派。', system: true },
  ]
}

const LONG_NOTE = [
  '先量准参考件的纸张与版心，再把内容按「问题 → 活动 → 落点」三段拆开。',
  '每条结论都要能指回资料页，截图统一放在与正文同一页的右下角，避免跨页引用。',
  '遇到需要学生先猜再看的内容，把参考答案放进演讲者备注，屏幕上只留问题和判断标准。',
  '最后逐页核对：标题层级、页码、图片来源、是否还有模板占位文字。',
  '返工点通常是「版式先于内容」——先定内容骨架，再套主题，能少改两轮。',
  '如果这一页要打印，注意浅色底在大屏上会发灰，验收时用投影模拟一遍。',
  '如果这份调研要给别人复用，最后再补一段「哪些做法我们没采用、为什么」，比只列优点更有用。',
  '引用页码统一写在句子末尾，不写在图注里；图注只留一句说明这张图证明了什么。',
  '同一主题的资料放同一页，超过三条就拆成两页，避免一页塞满读不下去。',
  '最后通读一遍，删掉「众所周知」「显而易见」这类不提供信息的句子。',
  '需要给别人讲的时候，先讲结论再讲证据，别按资料顺序复述。',
  '篇幅允许的话，把「这一步为什么这么做」单独写一行，读者比你自己更需要这个理由。',
].join('')

/** 示例经验（15 条，含可见/退休/被取代/已删除）。 */
export function createMockExperiences() {
  return [
    {
      id: 'ex_mock_01',
      ts: daysAgo(9, 9, 12),
      lastSeenAt: daysAgo(1, 16, 5),
      hits: 4,
      intent: '把 PPT 导出成 PDF，检查字体和分页',
      action: '用 soffice 转 PDF 后逐页看字体与分页',
      typeId: 'ty_ppt',
      typeName: 'PPT / 课件',
      outcome: 'success',
      G: 1,
      GOutcome: 1,
      GSource: 'feedback',
      note: '先导出再逐页看字体；中文标题用了思源黑体，导出后没掉字。分页问题集中在图片跨页，把图片和说明压到同一页就正常了。',
      origin: 'manual',
      kind: 'task',
      feedback: { helped: 2, hurt: 0, neutral: 0, lastAt: daysAgo(1, 16, 5), lastResult: 'helped' },
      feedback_log: [
        { at: daysAgo(5, 11, 0), result: 'helped', eta: 0.35 },
        { at: daysAgo(1, 16, 5), result: 'helped', eta: 0.35 },
      ],
      history: [{ type: 'feedback', at: daysAgo(1, 16, 5), result: 'helped' }],
    },
    {
      id: 'ex_mock_02',
      ts: daysAgo(6, 14, 30),
      lastSeenAt: daysAgo(2, 10, 20),
      hits: 3,
      intent: '给研学课做一套 20 页的 PPT',
      action: '先定主题色和版式骨架，再逐页填内容',
      typeId: 'ty_ppt',
      typeName: 'PPT / 课件',
      outcome: 'success',
      G: 0.8,
      GOutcome: 0.8,
      GSource: 'outcome',
      note: '先把母版、标题层级、页脚页码定死，后面填内容不容易返工。',
      origin: 'manual',
      kind: 'task',
      feedback: null,
    },
    {
      id: 'ex_mock_03',
      ts: daysAgo(4, 9, 0),
      lastSeenAt: daysAgo(4, 9, 0),
      hits: 1,
      intent: '改一节课的教案，把活动时间写清楚',
      action: '按分钟给每个环节标时长，再回填到教案表格',
      typeId: 'ty_doc',
      typeName: '文档 / 教案',
      outcome: 'partial',
      G: 0.5,
      GOutcome: 0.5,
      GSource: 'outcome',
      note: '时间标了，但导入活动写得还是太满，试讲时被压缩了一半。下次先按 0.8 倍预留。',
      origin: 'manual',
      kind: 'task',
      feedback: { helped: 0, hurt: 0, neutral: 1, lastAt: daysAgo(3, 15, 0), lastResult: 'neutral' },
      feedback_log: [{ at: daysAgo(3, 15, 0), result: 'neutral', eta: 0.35 }],
    },
    {
      id: 'ex_mock_04',
      ts: daysAgo(8, 20, 10),
      lastSeenAt: daysAgo(7, 9, 40),
      hits: 2,
      intent: '修插件启动报错：provider 方法不是函数',
      action: '在 profile 里 grep providerFor，改回 async 方法',
      typeId: 'ty_code',
      typeName: '代码 / 插件',
      outcome: 'failed',
      G: -1,
      GOutcome: -1,
      GSource: 'feedback',
      note: '第一次只改了调用处，没改实现；报错换了个位置继续炸。根因是数据面方法返回同步值，宿主按 Promise 用。',
      origin: 'manual',
      kind: 'task',
      feedback: { helped: 0, hurt: 1, neutral: 0, lastAt: daysAgo(7, 9, 40), lastResult: 'hurt' },
      feedback_log: [{ at: daysAgo(7, 9, 40), result: 'hurt', eta: 0.35 }],
      history: [{ type: 'feedback', at: daysAgo(7, 9, 40), result: 'hurt' }],
    },
    {
      id: 'ex_mock_05',
      ts: daysAgo(3, 11, 25),
      lastSeenAt: daysAgo(3, 11, 25),
      hits: 1,
      intent: '给侧边栏加一个自定义图标',
      action: '用 24 栅格实心图标直接放大',
      typeId: 'ty_code',
      typeName: '代码 / 插件',
      outcome: 'corrected',
      G: -1,
      GOutcome: -1,
      GSource: 'outcome',
      note: '用户纠正：必须用 16 栅格、stroke 线宽 1 的图标族，实心色块跟左侧栏不是一套。已重画。',
      origin: 'manual',
      kind: 'task',
      feedback: null,
    },
    {
      id: 'ex_mock_06',
      ts: daysAgo(20, 10, 0),
      lastSeenAt: daysAgo(12, 10, 0),
      hits: 2,
      intent: '给经验库做一个右侧抽屉面板',
      action: '用右侧栏 tab 承载列表',
      typeId: 'ty_code',
      typeName: '代码 / 插件',
      outcome: 'success',
      G: 0.8,
      GOutcome: 0.8,
      GSource: 'outcome',
      note: '方案后来被左侧栏主面板取代，保留作历史。',
      origin: 'manual',
      kind: 'task',
      retired_at: daysAgo(10, 9, 0),
      retired_reason: 'superseded-by-main-panel',
      feedback: null,
    },
    {
      id: 'ex_mock_07',
      ts: daysAgo(15, 9, 0),
      lastSeenAt: daysAgo(11, 9, 0),
      hits: 1,
      intent: '把经验库挂成记忆空间的一个 Provider',
      action: '写 provider.js 适配 search/list/graph',
      typeId: 'ty_code',
      typeName: '代码 / 插件',
      outcome: 'success',
      G: 0.8,
      GOutcome: 0.8,
      GSource: 'outcome',
      note: '这条被「独立外壳 + 自己的面板」取代，保留可追溯。',
      origin: 'manual',
      kind: 'task',
      superseded_by: 'ex_mock_01',
      feedback: null,
    },
    {
      id: 'ex_mock_08',
      ts: daysAgo(5, 15, 0),
      lastSeenAt: daysAgo(5, 15, 0),
      hits: 1,
      intent: '调研同类经验库插件，找可借鉴的机制',
      action: '逐个读 README 与仓库结构，记录机制与许可',
      typeId: 'ty_research',
      typeName: '调研 / 资料',
      outcome: 'success',
      G: 1,
      GOutcome: 1,
      GSource: 'outcome',
      note: LONG_NOTE,
      origin: 'manual',
      kind: 'task',
      feedback: null,
    },
    {
      id: 'ex_mock_09',
      ts: daysAgo(2, 13, 0),
      lastSeenAt: daysAgo(2, 13, 30),
      hits: 1,
      intent: '给面板加检索框并接入召回',
      action: '前端提交 query，后端走召回接口，展示候选与证据',
      typeId: 'ty_code',
      typeName: '代码 / 插件',
      outcome: 'success',
      G: 0.8,
      GOutcome: 0.8,
      GSource: 'outcome',
      note: '第 1 步：先定接口；第 2 步：前端接上；第 3 步：补空态与错误态。',
      origin: 'manual',
      kind: 'step',
      taskId: 'task_mock_recall_ui',
      stepIndex: 2,
      stepTotal: 3,
      feedback: null,
    },
    {
      id: 'ex_mock_10',
      ts: daysAgo(1, 9, 0),
      lastSeenAt: daysAgo(1, 9, 0),
      hits: 1,
      intent: '整理一份表格里重复的行',
      action: '按关键列去重并保留最新一条',
      typeId: 'ty_other',
      typeName: '未分类',
      outcome: 'unknown',
      G: 0,
      GOutcome: 0,
      GSource: 'outcome',
      note: '',
      origin: 'auto',
      kind: 'task',
      feedback: null,
    },
    {
      id: 'ex_mock_11',
      ts: daysAgo(12, 17, 0),
      lastSeenAt: daysAgo(9, 8, 0),
      hits: 2,
      intent: '导出表格前先冻结表头',
      action: '用 Excel 冻结首行再另存',
      typeId: 'ty_data',
      typeName: '表格 / 数据',
      outcome: 'success',
      G: 1,
      GOutcome: 1,
      GSource: 'outcome',
      note: '顺手把列宽按内容自适应，打印时不会截断。',
      origin: 'manual',
      kind: 'task',
      feedback: { helped: 1, hurt: 0, neutral: 0, lastAt: daysAgo(9, 8, 0), lastResult: 'helped' },
      feedback_log: [{ at: daysAgo(9, 8, 0), result: 'helped', eta: 0.35 }],
    },
    {
      id: 'ex_mock_12',
      ts: daysAgo(17, 10, 0),
      lastSeenAt: daysAgo(16, 10, 0),
      hits: 1,
      intent: '一次把 PPT 和讲义都生成出来',
      action: '先写讲义再倒推成 PPT',
      typeId: 'ty_ppt',
      typeName: 'PPT / 课件',
      outcome: 'aborted',
      G: 0,
      GOutcome: 0,
      GSource: 'outcome',
      note: '做到一半发现两条线的内容粒度不一样，停手改成先定 PPT 骨架。',
      origin: 'manual',
      kind: 'task',
      feedback: null,
    },
    {
      id: 'ex_mock_13',
      ts: daysAgo(0, 9, 30),
      lastSeenAt: daysAgo(0, 9, 30),
      hits: 1,
      intent: '批量改文件名前缀时把顺序改乱了',
      action: '用通配符一次性重命名全部文件',
      typeId: 'ty_data',
      typeName: '表格 / 数据',
      outcome: 'failed',
      G: -1,
      GOutcome: -1,
      GSource: 'outcome',
      note: '没有先备份，也没有先拿两个文件试跑；前缀改完排序全乱。下次先 dry-run 打印新旧名对照。',
      origin: 'manual',
      kind: 'task',
      feedback: null,
    },
    {
      id: 'ex_mock_14',
      ts: daysAgo(10, 14, 0),
      lastSeenAt: daysAgo(10, 14, 0),
      hits: 1,
      intent: '给一个很长的多步任务写清每一步的验收标准，避免做到最后才发现方向错了',
      action: '先列验收点再开工，每一步结束都回来对照',
      typeId: 'ty_doc',
      typeName: '文档 / 教案',
      outcome: 'success',
      G: 0.8,
      GOutcome: 0.8,
      GSource: 'outcome',
      note: '验收点要写成能被检查的句子，不写"做好一点"这种。',
      origin: 'manual',
      kind: 'task',
      feedback: null,
    },
    {
      id: 'ex_mock_15',
      ts: daysAgo(25, 8, 0),
      lastSeenAt: daysAgo(25, 8, 0),
      hits: 1,
      intent: '临时记一条：不要改用户手改过的文件',
      action: '先复制备份再改',
      typeId: 'ty_other',
      typeName: '未分类',
      outcome: 'success',
      G: 1,
      GOutcome: 1,
      GSource: 'outcome',
      note: '这条已删除，用来验证"删除不进列表、但仍计数"。',
      origin: 'manual',
      kind: 'task',
      deleted_at: daysAgo(24, 8, 0),
      feedback: null,
    },
  ]
}

/** 一套完整的示例库。 */
export function createMockStore() {
  return { version: 1, types: createMockTypes(), experiences: createMockExperiences() }
}

/** 示例用法日志（新→旧；外壳会 reverse）。 */
export function createMockUsage() {
  const rows = [
    { at: minutesAgo(2), tool: 'exp_recall', ok: true, intent: '把 PPT 导出成 PDF', limit: 4, route_score: 0.21, ids: ['ex_mock_01', 'ex_mock_02'] },
    { at: minutesAgo(9), tool: 'exp_record', ok: true, intent: '给面板加检索框并接入召回', action: '前端提交 query，后端走召回接口', op: 'added' },
    { at: minutesAgo(21), tool: 'exp_feedback', ok: true, id: 'ex_mock_01', feedback: 'helped' },
    { at: minutesAgo(35), tool: 'exp_recall', ok: true, intent: '修插件启动报错', limit: 4, route_score: 0.18, ids: ['ex_mock_04'] },
    { at: minutesAgo(52), tool: 'exp_type', ok: true, op: 'list' },
    { at: minutesAgo(70), tool: 'exp_recall', ok: false, intent: '给一个不存在的任务找做法', error: '经验库没有可见条目。' },
    { at: minutesAgo(95), tool: 'exp_record', ok: true, intent: '批量改文件名前缀时把顺序改乱了', action: '用通配符一次性重命名全部文件', op: 'added' },
    { at: minutesAgo(140), tool: 'exp_feedback', ok: true, id: 'ex_mock_03', feedback: 'neutral' },
    { at: minutesAgo(180), tool: 'exp_recall', ok: true, intent: '导出表格前先冻结表头', limit: 3, route_score: 0.24, ids: ['ex_mock_11'] },
    { at: minutesAgo(260), tool: 'exp_record', ok: true, intent: '给研学课做一套 20 页的 PPT', action: '先定主题色和版式骨架', op: 'updated' },
  ]
  return rows.sort((a, b) => String(a.at).localeCompare(String(b.at)))
}

/**
 * 示例固化技能（5 条，覆盖已固化 / 试用中 / 不稳定 / 待验证 / 有未解障碍）。
 * 字段与 exp-lib 的 `.exp/skills/<slug>/`（SKILL.md + skill.json）对齐。
 */
export function createMockSkills() {
  const rows = [
    {
      id: 'ppt-export-pdf',
      name: 'PPT 导出 PDF 前先查字体',
      description: '导出前确认字体可用，导出后逐页看分页与图片跨页。',
      body: [
        '## 适用',
        '需要把课件或讲义导成 PDF 交付时。',
        '',
        '## 做法',
        '1. 先看字体是否都是本机有的（思源黑体 / 微软雅黑），缺字先替换。',
        '2. 导出后逐页检查：标题层级、页码、图片是否跨页。',
        '3. 图片跨页时把图与图注压到同一页，再重导。',
        '',
        '## 常见例外',
        '- 有动画的页导出后只保留最后一帧，需要单独确认。',
        '',
        '## 已内化',
        '- 导出前备份原文件。',
      ].join('\n'),
      typeName: 'PPT / 课件',
      context: ['Windows / Office 2019', '课件交付'],
      triggers: ['导出 PDF', '字体缺失', '图片跨页'],
      uses: 6,
      helped: 5,
      hurt: 1,
      openObstacles: 0,
      obstacleCount: 1,
      resolvedCount: 3,
      revisions: 2,
      derivedFrom: ['ex_mock_01', 'ex_mock_02', 'ex_mock_12'],
      pendingCommit: false,
      lastUsedAt: minutesAgo(35),
      updatedAt: daysAgo(1, 18, 20),
      path: '（示例）skills/ppt-export-pdf',
    },
    {
      id: 'plugin-async-contract',
      name: '插件数据面方法一律写成 async',
      description: '宿主按 Promise 用返回值，同步实现会在 `.then` / `.catch` 上炸。',
      body: [
        '## 适用',
        '给 DSH 写 Provider / 适配器，或改别人的插件数据面方法时。',
        '',
        '## 做法',
        '1. 数据面方法统一加 `async`，哪怕内部是同步读文件。',
        '2. 用宿主原样写法测一遍：`.catch(...)` 与 `untilAborted(...)`。',
        '3. 回归测试里断言返回值有 `.then`。',
      ].join('\n'),
      typeName: '代码 / 插件',
      context: ['DSH 插件开发'],
      triggers: ['xx is not a function', 'provider 报错'],
      uses: 3,
      helped: 2,
      hurt: 0,
      openObstacles: 0,
      obstacleCount: 0,
      resolvedCount: 1,
      revisions: 1,
      derivedFrom: ['ex_mock_04', 'ex_mock_05', 'ex_mock_09', 'ex_mock_10'],
      pendingCommit: true,
      lastUsedAt: minutesAgo(120),
      updatedAt: daysAgo(2, 10, 5),
      path: '（示例）skills/plugin-async-contract',
    },
    {
      id: 'rename-dry-run',
      name: '批量重命名先 dry-run 打印对照',
      description: '先输出旧名→新名对照，确认顺序再执行；不要一把通配符改完。',
      body: [
        '## 做法',
        '1. 先生成旧名 → 新名对照表，人工看一遍。',
        '2. 只改一批 2 个文件试跑，确认顺序没乱。',
        '3. 再全量执行，执行前留备份。',
      ].join('\n'),
      typeName: '表格 / 数据',
      context: ['Windows 文件操作'],
      triggers: ['批量改名', '顺序错乱'],
      uses: 4,
      helped: 1,
      hurt: 3,
      openObstacles: 0,
      obstacleCount: 2,
      resolvedCount: 1,
      revisions: 1,
      derivedFrom: ['ex_mock_13', 'ex_mock_11', 'ex_mock_10'],
      pendingCommit: false,
      lastUsedAt: daysAgo(3, 9, 40),
      updatedAt: daysAgo(3, 9, 40),
      path: '（示例）skills/rename-dry-run',
    },
    {
      id: 'research-note-skeleton',
      name: '调研笔记先搭三段骨架',
      description: '「结论 → 证据 → 未采用」三段先写标题，再填内容，避免越写越散。',
      body: [
        '## 做法',
        '1. 先写结论段：一句话说清这次要回答什么。',
        '2. 证据段按来源分组，每条都能指回页面。',
        '3. 未采用段写清「没选什么、为什么」，比只列优点有用。',
      ].join('\n'),
      typeName: '调研 / 资料',
      context: ['资料整理'],
      triggers: ['调研', '写总结'],
      uses: 0,
      helped: 0,
      hurt: 0,
      openObstacles: 0,
      obstacleCount: 0,
      resolvedCount: 0,
      revisions: 0,
      derivedFrom: ['ex_mock_08', 'ex_mock_03', 'ex_mock_14'],
      pendingCommit: false,
      lastUsedAt: '',
      updatedAt: daysAgo(1, 9, 10),
      path: '（示例）skills/research-note-skeleton',
    },
    {
      id: 'sidebar-icon-contract',
      name: '侧栏图标只放图标本体',
      description: '宿主那一行自己渲染按钮、容器和 label；插件只返回图标，尺寸用传入的 size。',
      body: [
        '## 做法',
        '1. `sidebar.panellist` 注册的组件只返回图标（16 栅格、currentColor）。',
        '2. 不要套 `<button>`、固定宽高或 margin——会偏小、错位、形成嵌套按钮。',
        '3. 优先用宿主图标族（`@deepseek-ai/dsh-client-ui-primitives`），拿不到再自绘。',
      ].join('\n'),
      typeName: '代码 / 插件',
      context: ['DSH 插件开发'],
      triggers: ['侧栏图标', '图标偏小'],
      uses: 5,
      helped: 4,
      hurt: 1,
      openObstacles: 1,
      obstacleCount: 2,
      resolvedCount: 2,
      revisions: 3,
      derivedFrom: ['ex_mock_09', 'ex_mock_05', 'ex_mock_04', 'ex_mock_01', 'ex_mock_02'],
      pendingCommit: false,
      lastUsedAt: minutesAgo(12),
      updatedAt: daysAgo(0, 16, 48),
      path: '（示例）skills/sidebar-icon-contract',
    },
  ]
  return rows.map(skillRowOf)
}

/**
 * mock data source：与 live 同一套接口。
 * 反馈只改内存里的假数据（进程重启即恢复），不会落盘、不触碰真实经验库。
 */
export function createMockSource() {
  const store = createMockStore()
  const usage = createMockUsage()
  const skills = createMockSkills()
  const bootAt = new Date().toISOString()
  return {
    id: 'mock',
    mode: 'mock',
    label: '示例数据',
    readOnly: false,
    notice: '当前是示例数据（exp-ui 内置）：可以放心点，反馈只改这份假数据，不会写入真实经验库。',
    read() {
      return {
        store,
        dataDir: '（exp-ui 内置示例数据）',
        file: '',
        exists: true,
        bytes: Buffer.byteLength(JSON.stringify(store), 'utf8'),
        updatedAt: bootAt,
        notice: this.notice,
      }
    },
    usageRows(limit) {
      const size = Math.max(1, Math.min(500, Math.trunc(Number(limit) || 100)))
      return usage.slice(-size)
    },
    skills() {
      return skills
    },
    pending(limit = 5) {
      return [
        { id: 'ex_mock_p1', intent: '给研学课 PPT 插一页过渡页', action: '新建一页：居中大标题 + 副标题', verdict: 'pending', registeredAt: new Date().toISOString(), brief: '上一轮：给研学课 PPT 插一页过渡页' },
        { id: 'ex_mock_p2', intent: '把课件导出成 PDF', action: 'LibreOffice 无头转换', verdict: 'pending', registeredAt: new Date().toISOString(), brief: '上一轮：导出 PDF' },
      ].slice(0, limit)
    },

    verdicts(list) {
      return (Array.isArray(list) ? list : []).map((item) => ({ id: String((item && item.id) || ''), ok: true, outcome: String((item && item.outcome) || 'success') }))
    },

    usageSummary() {
      const rows = this.usageRows(200)
      const byTool = {}
      let chars = 0
      let withChars = 0
      for (const row of rows) {
        const tool = String(row.tool || 'unknown')
        byTool[tool] = (byTool[tool] || 0) + 1
        const size = Number(row.chars)
        if (Number.isFinite(size) && size > 0) {
          chars += size
          withChars += 1
        }
      }
      return { calls: rows.length, chars, avgChars: withChars > 0 ? Math.round(chars / withChars) : 0, byTool }
    },

    feedback(id, result) {
      return applyFeedbackTo(store, id, result)
    },

    record(input = {}) {
      const outcome = String(input.outcome || 'success')
      const at = new Date().toISOString()
      const id = `ex_mock_${Date.now().toString(36)}`
      const G = scoreOf(outcome)
      store.experiences.unshift({
        id,
        intent: String(input.intent || ''),
        action: String(input.action || ''),
        typeId: String(input.type || 'ty_other'),
        typeName: String(input.type || '未分类'),
        outcome,
        G,
        GOutcome: G,
        GSource: 'outcome',
        ts: at,
        lastSeenAt: at,
        note: String(input.note || ''),
      })
      return { action: 'added', id, G, mode: 'mock' }
    },
    recall(args = {}) {
      return recallOf(store, String(args.intent || ''), Math.max(1, Math.min(50, Math.trunc(Number(args.limit) || 8))))
    },
    consolidate() {
      throw codedError('unsupported', '示例数据不支持沉淀；切到真实数据后再用。')
    },
    validate() {
      return []
    },
    typeOp() {
      throw codedError('unsupported', '示例数据不支持类型管理。')
    },
    skillFeedback(slug, result) {
      return { id: `skill:${slug}`, result: String(result), G_before: 0, G_after: 0 }
    },
    settings() {
      return { dataDir: '', file: '', currentRoot: '' }
    },
  }
}
