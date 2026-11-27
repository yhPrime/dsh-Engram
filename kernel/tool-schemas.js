/**
 * 工具名称 / 描述 / 参数 schema（对外契约）：从 buildTools 内联字面量原样抽出（0.45.0-D4b）。
 * 顺序、工具名、描述文案、参数 schema 必须与拆分前逐字一致；这里只放静态契约，
 * 不引用 tools.js，也不含任何 execute 逻辑。
 */
import { TAG_FACET_LABELS, TAG_VISIBLE_FACETS } from './tag-registry.js'

export const RECORD_TOOL = {
  name: 'exp_record',
  description: '记录一条可复用的工作经验（做法 + 结果）。只记这套环境特有的东西：① 在这里能成、换个环境未必成的做法；② 在这里会挂的做法（报错原文 + 触发条件 + 绕过）；③ 这里特有的约束与口径。判断标准只有一条：下次在这台机器上遇到同类任务，这条能不能让我少踩一次坑。写清命令/参数/路径/版本/报错原文，通用步骤不记。族=可复用动作（如 跑测试/写断言/git 推送），用 family 指定；方向标签=族内场景（如 写断言下的 契约断言/回归断言/探针先行），放 context/labels。同一做法就地更新 hits，近似替换写新条并标记旧条被取代。裸命令/裸工具名/单文件无技法编辑会被拒记——那是具体任务流水，改用 exp_object 记。标签只写类型不写实例名（仓库名等会被丢弃并记 tagsRejected）。',
  parameters: {
    intent: { type: 'string', required: true, description: '要做的任务/意图。' },
    action: { type: 'string', required: true, description: '采取的做法或方案名。' },
    outcome: { type: 'string', enum: ['accepted', 'success', 'partial', 'unknown', 'failed', 'corrected', 'aborted'], description: '结果；影响回报 G。' },
    // 不叫 type：与 JSON Schema 的 type 关键字同名时，provider 严格校验会把参数当关键字读。
    typeName: { type: 'string', description: '这条经验该归哪个主分类。先自己判断；实在判断不出来才留空，留空即落「未分类」。填了新名字会按需新建类型（受上限与近似合并限制）。' },
    typeDescription: { type: 'string', description: '新建类型时的描述（≤120 字）：这个类型收什么、召回时怎么用。复用已有类型时忽略。' },
    note: { type: 'string', description: '关键步骤、为什么有效、踩了什么坑。' },
    taskId: { type: 'string', description: '可选：多步任务的任务 id。同 taskId 的步骤会归到同一任务，统计按任务算一次。' },
    kind: { type: 'string', enum: ['task', 'step'], description: '可选：这条是整条任务（默认）还是任务里的一步。' },
    stepIndex: { type: 'number', description: 'kind=step 时的步骤序号（1 起）。' },
    stepTotal: { type: 'number', description: '该任务共几步。' },
    failedStep: { type: 'number', description: '整条记录时，失败发生在第几步（1 起）。' },
    stepRewards: { type: 'array', description: '分步回报（数字数组）；整条记录时可用它代替单一 G。' },
    expectedOutcome: { type: 'string', enum: ['accepted', 'success', 'partial', 'unknown', 'failed', 'corrected', 'aborted'], description: '可选：做之前预期会怎样（结果词）。用于算预测误差。' },
    expectedG: { type: 'number', description: '可选：预期回报（-1..1），优先于 expectedOutcome。' },
    context: { type: 'array', description: '可选：方向/主题标签（≤8）。方向=族内场景（须是该族已登记方向，如 写断言→契约断言）；主题=场景/产物类型。召回时用于编码特异性匹配。' },
    labels: { type: 'array', description: '可选：次级分类标签（≤8），与 context 合并；优先用 exp_type action=labels 列出的已有标签，已有无法满足才新建（方向标签新建须 facet=direction + family）。' },
    artifacts: { type: 'array', description: '可选：本次产物的路径（工作区相对路径，≤5）。给用户手改学习留锚点。' },
    dimensions: { type: 'array', description: '可选：能力维度（≤3 个短标签，如「布局」「语义理解」）；只存不校验。' },
    family: { type: 'string', description: '可选：动作族=可复用动作（如 git 推送/跑测试/写断言）。不填则按动作标签/动作文本推导；对象词/裸泛词（执行/校验/代码）会被拒。建族前先 exp_family list 看有无近义族。' },
    force: { type: 'boolean', description: '可选：强制记录（覆盖记录门槛）。只在你确认这条经验重学成本高、但门槛误判时用。' },
    // 时效治理（0.20 P0）：全部可选；不填就是旧行为（读时按 semi 解释）。
    volatility: { type: 'string', enum: ['stable', 'semi', 'perishable'], description: '可选：易腐层。stable=偏好/硬约束，semi=判断原则（默认），perishable=具体步骤/命令/API。只影响召回降权与复核，不改 G。' },
    appliesTo: { type: 'object', description: '可选：适用范围 { models?: string[], tools?: string[], environment?: string }；不声明=unscoped（不硬拦）。', properties: { models: { type: 'array', items: { type: 'string' } }, tools: { type: 'array', items: { type: 'string' } }, environment: { type: 'string' } }, additionalProperties: false },
    reviewAfter: { type: 'string', description: '可选：建议下次复核时间（ISO）；不填则按 lastVerifiedAt/创建时间 + 半衰期推算。' },
    reviewNote: { type: 'string', description: '可选：复核结论（≤240 字）。' },
    verdicts: { type: 'array', description: '可选：回填回执里的 pending，[{id,outcome,dimensions?}]；一次可回填多条。' },
    cwd: { type: 'string', description: '可选：工作区路径（headless/脚本调用时给；给了才能对手改产物做 diff）。' },
    skillId: { type: 'string', description: '可选：本次使用的技能（技能 id 或 skill:<slug>）；记录后更新技能 confidence/障碍并提交。' },
    blockedBy: { type: 'string', description: '可选：本次撞到的障碍原文；给了就按签名计数，连续 3 次覆盖技能。' },
    blockedByList: { type: 'array', description: '可选：一次撞到多个障碍时传数组，各签名分别计数（与 blockedBy 二选一）。' },
  },
}

export const RECALL_TOOL = {
  name: 'exp_recall',
  description: '按任务意图召回历史经验。【怎么搜】intent 写「对象+任务+关键约束」（如「给研学课 PPT 插页（深蓝）」），别写「再来一页」这类省略句；已知族就用 family=<族名> 只读该族分片；技能用 skill=<slug> 取正文、group=<组名> 只列组内名字；不知道族名先 exp_family list query=<关键词/任务描述> 模糊搜族，或直接给 intent 让引擎路由。【怎么读结果】routes[].family 是本次命中的族名（≤3），candidates[].evidence[].family 是每条所属族，brief 是记忆简报；搜不到就把 intent 写具体些或换关键词再搜，不要凭空造族名。默认先做簇路由（确定性簇内检索，无同族回退全库）。mode=advantage：有成败对照，Â 参与排序（默认 rankMode=auto/blend，相似度主序、Â 次序；rankMode=advantage 才完全按 Â×置信度）；mode=evidence：无成败对照，Â 不具区分度，改按相似度×证据强度排序。',
  parameters: {
    intent: { type: 'string', description: '当前任务意图。写「对象+任务+关键约束」（如「给研学课 PPT 插一页（深蓝色调）」）；只写「再来一页」这种省略句会因相似度不足召回不到。用 skill 直接取技能时可省略。' },
    skill: { type: 'string', description: '可选：直接取这个技能（slug 或 id；可带 skill: 前缀，也可原样用目录条目名 engram:<slug>，两种前缀都剥）。给了就跳过检索，按本会话三态决定给全文还是复用回执；找不到返回 no-such-skill，不退回普通召回。' },
    group: { type: 'string', description: '可选：按技能组取名字（组名 = skills/ 顶层目录名，如「动画」「ai-base-tools」；根下独立技能组名「未分组」）。返回组内技能名 + 一句话描述，不含正文；组不存在明确报错。' },
    family: { type: 'string', description: '可选：按动作族取经验（族名见提示段「经验族」行，如「写断言」「未分族」）。只读该族分片、不扫全库；族内 >8 条按相似度排，否则按最近使用倒序直接给；族不存在明确报错。' },
    load: { type: 'boolean', description: '可选：true 时强制给全文（忽略复用态）。配合 skill 做「对不上锚点/压缩后重取」。' },
    limit: { type: 'number', description: '返回几条候选做法，默认 3；显式给就按给的值（≤8，簇内也不截到 4）。改稿/纠错要看「上次那条」时给 5~6。' },
    cluster: { type: 'string', description: '可选：直接指定簇（类型名或 id），跳过路由。' },
    context: { type: 'array', description: '可选：当前任务的情境线索；给了就优先召回情境匹配的经验。' },
    mark: { type: 'boolean', description: '可选：把这次召回记为一次「主动提取」（累加 retrievals，用于证据展示，不改排序）。' },
    all: { type: 'boolean', description: '可选：强制全库检索，忽略路由。' },
    cold: { type: 'boolean', description: '可选：查冷档（超出容量上限被下沉的老经验，默认不参与召回）。只读，不写盘。' },
    detail: { type: 'boolean', description: '可选：返回完整回执（含全部字段与长 note）；默认瘦身档省 token。' },
    includeMismatched: { type: 'boolean', description: '可选：appliesTo 明确不匹配当前环境的经验默认不返回；传 true 时返回并标注 applicability=mismatch。' },
    currentEnv: { type: 'object', description: '可选：本次调用覆盖设置里的运行环境 { models?: string[], tools?: string[], environment?: string }；未给的字段沿用设置。', properties: { models: { type: 'array', items: { type: 'string' } }, tools: { type: 'array', items: { type: 'string' } }, environment: { type: 'string' }, model: { type: 'string' }, tool: { type: 'string' } }, additionalProperties: false },
    tagShadow: { type: 'boolean', description: '可选：只计算标签排序的影子对照（tagShadow 元数据：queryTags / tagTop 前 5 / 当前候选前 5 / overlapAt5），不改变 candidates 的顺序与数量；默认关闭，也可由 config.tagShadow 打开。' },
    verdicts: { type: 'array', description: '可选：顺手回填回执里的 pending，[{id,outcome,dimensions?}]。' },
  },
}

export const FEEDBACK_TOOL = {
  name: 'exp_feedback',
  description: '用过一条召回的经验之后回报结果：helped（靠它做成了）/ hurt（用了反而返工、被纠正或没帮上）/ neutral（用了但没影响）。反馈按 EMA 修正该条的回报 G（排序依据），不动 hits、不新建条目、不改 outcome；下次召回按新回报排序。',
  parameters: {
    id: { type: 'string', required: true, description: '经验 id（取本轮 exp_recall 返回的 evidence[].id，别拍脑袋给旧条）' },
    result: { type: 'string', enum: ['helped', 'hurt', 'neutral'], required: true, description: '用后结果：helped / hurt / neutral。' },
    intent: { type: 'string', description: '可选：当时任务的意图（只进审计日志，不动经验内容）。' },
    note: { type: 'string', description: '可选：怎么用的、结果如何（≤200 字，只进审计日志）。' },
  },
}

export const CONSOLIDATE_TOOL = {
  name: 'exp_consolidate',
  description: '把同族经验沉淀成技能：同族 ≥3 条且 ≥2 正 1 负时，生成 .exp/skills/<slug>/（SKILL.md 标准模板 + skill.json 账本）；相同 slug 再次沉淀会更新定义。可传 body 写正文、files 挂脚本（复制进 scripts/ 并在 SKILL.md 生成「## 脚本」清单）。技能归经验库自己管：不复制到 DSH skills 目录，召回时按需以技能形态返回。技能仍由 Â/障碍计数管理。',
  parameters: {
    intent: { type: 'string', required: true, description: '要沉淀的技能对应的任务意图（与 exp_recall 同一口径）。' },
    // 参数名不能叫 type：它和 JSON Schema 的 type 关键字同名，provider 严格校验会把它
    // 当成 schema 关键字读，报 "is not valid under any of the schemas listed in the anyOf"。
    skillName: { type: 'string', description: '可选：技能名（默认「类型：共同词」）。' },
    context: { type: 'array', description: '可选：技能的情境线索（写入 skill.json 与匹配）。' },
    minSamples: { type: 'number', description: '可选：最少同族条数，默认 3。' },
    body: { type: 'string', description: '可选：手写 SKILL.md 正文（覆盖自动生成模板；脚本用法/步骤写这里）。' },
    files: { type: 'array', description: '可选：附件路径列表（脚本等），复制进 <skill>/scripts/ 并登记到 skill.json。' },
  },
}

export const SKILL_ATTACH_TOOL = {
  name: 'exp_skill_attach',
  description: '给已有技能挂附件/补正文：files 里的文件复制进 <skill>/scripts/ 并在 SKILL.md 维护「## 脚本」清单；body 会并进正文（保留已有「常见例外/已内化」）。技能留在经验库，不复制到 DSH skills 目录。',
  parameters: {
    slug: { type: 'string', required: true, description: '技能 slug（.exp/skills/ 下的目录名）。' },
    files: { type: 'array', description: '可选：要挂的文件路径列表（脚本/参考材料）；单文件 ≤2MB、总量 ≤8MB。' },
    body: { type: 'string', description: '可选：补进 SKILL.md 的正文（markdown）。' },
  },
}

export const TYPE_TOOL = {
  name: 'exp_type',
  description: '管理经验主分类：list 列表（含条数）/ labels 列出已有次级分类（写 labels 前先复用）/ create 新建 / rename 改名 / merge 合并（经验批量改挂，源类型删除）/ delete 删除（经验归「未分类」）/ assign 把单条经验改挂到指定类型（定点修脏数据，不动 hits）。主分类唯一；次级分类用 exp_record.labels 多标签。',
  parameters: {
    action: { type: 'string', enum: ['list', 'create', 'rename', 'merge', 'delete', 'assign', 'labels', 'label'], required: true, description: '要执行的动作。' },
    name: { type: 'string', description: 'create/rename/delete 时的类型名或 id（rename 时是旧名）；assign 时的目标类型名。' },
    newName: { type: 'string', description: 'rename 的新名；merge 的目标类型名（不存在会新建）。' },
    names: { type: 'array', description: 'merge 时的来源类型名/id 列表。' },
    id: { type: 'string', description: 'assign 时的经验 id（exp_recall 证据里的 id）。' },
    // 不叫 description：与 JSON Schema 的 description 关键字同名，provider 严格校验会误读。
    typeDescription: { type: 'string', description: 'create/rename 时可选写描述（≤120 字）。' },
    facet: { type: 'string', enum: [...TAG_VISIBLE_FACETS], description: `label 时给**新标签**指定面（已登记标签不用给）：${TAG_VISIBLE_FACETS.map((key) => `${key}=${TAG_FACET_LABELS[key]}`).join('、')}。新标签会登记进 .exp/tag-registry.json。direction=族内场景方向，必须配 family；action 面已收敛（族即动作）。` },
    family: { type: 'string', description: 'label 登记 direction（方向）标签时必填：这个方向属于哪个动作族（族须已存在）。方向是族内场景短名词（如 写断言→契约断言/回归断言/探针先行），不收自由文本。' },
    labels: { type: 'array', description: 'label 时要加到该经验上的标签名（数组）：已登记的直接用；未登记的须配 facet（登记新标签）。' },
    tagDescription: { type: 'string', description: 'label 登记新标签时的说明（≤120 字，给人看，不是标签本身）。' },
  },
}

export const FAMILY_TOOL = {
  name: 'exp_family',
  description: '管理动作族（族=可复用动作）：list 列出真实存在的族（可带 query 按关键词/任务描述模糊搜族，返回最像的 top 5）/ create 校验并登记新族 / rename 改名 / merge 合并 / assign 把经验指派到族 / delete 仅允许空族。建族前先 list 或 list query 看有无近义族，有就复用或 merge，别重复造。对象词（代码/课件）与裸泛词（执行/校验）不能当族名。具体任务怎么做用 exp_object，不进族。',
  parameters: {
    action: { type: 'string', enum: ['list', 'create', 'rename', 'merge', 'assign', 'delete'], required: true, description: '要执行的动作。' },
    query: { type: 'string', description: '可选：仅 list 用。按关键词/任务描述模糊搜族（族名 + 方向标签，bigram/词双信号），返回最像的 top 5；不传则全量列。' },
    family: { type: 'string', description: 'create 的族名；rename/delete 的旧族名；assign 的目标族名。' },
    newName: { type: 'string', description: 'rename 的新族名；merge 的目标族名。' },
    names: { type: 'array', description: 'merge 的来源族名列表。' },
    ids: { type: 'array', description: 'assign 的经验 id 列表（与 sourceId 二选一）。' },
    sourceId: { type: 'string', description: 'assign 时按 sourceId 批量指派。' },
  },
}

export const OBJECT_TOOL = {
  name: 'exp_object',
  description: '对象链：记录「这一件具体任务按什么顺序做完」。【什么时候写】一件具体任务做完、按步骤走过来了就用它记分步链（对象名=任务、一条链=一次做法、一步=族+方向）；只记任务流水，可复用做法仍走 exp_record。【怎么找】list 可带 query 按关键词/任务描述模糊搜（对象名+链的步），返回最像的 top 5；show 按名/id 读。【结构】对象名 + 1..n 条链，每条 1..n 步，每步=方向标签+动作族（family 必填且须已登记；direction 可选但给了必须是该族已登记方向）；某步失败可在该步下挂分支换一组动作。create 建对象+首条链 / append 追链或补步 / branch 给 failed 步骤挂分支 / show 读对象 / list 清单（可带 query）/ delete 删对象。不参与召回与排序。',
  parameters: {
    action: { type: 'string', enum: ['create', 'append', 'branch', 'show', 'list', 'delete'], required: true, description: '要执行的动作。' },
    query: { type: 'string', description: '可选：仅 list 用。按关键词/任务描述模糊搜对象（对象名 + 链的步：族名/方向/note），返回最像的 top 5；不传则全量列。' },
    object: { type: 'string', description: 'create 的对象名（1–40 字）；其余动作传对象名或 ob_ id。' },
    chain: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'create/append 的步骤数组：[{ family: "跑测试", direction: "回归断言", note: "可选", outcome: "failed" }]；family 必填（须已登记族），direction 可选（给了须是该族已登记方向），note 可选。' },
    steps: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'branch 的动作组，与 chain 同形状（family 必填、direction 可选受控）。' },
    chainIndex: { type: 'number', description: '从 1 起。append 指向已有链；branch 必填（要用作补步时对象+链一次写）。' },
    stepPath: { type: 'array', items: { type: 'number' }, description: '从 1 起：[步骤] 定位主干步骤；[步骤, 分支, 步骤] 定位分支里的步骤。branch 必填；append 补进分支时给偶数路径 [步骤, 分支]。' },
    when: { type: 'string', description: 'branch 必填：撞上什么具体意外（报错信息 / 环境不对），不要只写「失败」。' },
    result: { type: 'string', enum: ['recovered', 'aborted'], description: 'branch 可选：默认 recovered（分支走完接回主干）；aborted 表示这条分支放弃收工。' },
    note: { type: 'string', description: 'create/append 的链说明。' },
  },
}

export const REVIEW_TOOL = {
  name: 'exp_review',
  description: '经验/技能的时效复核：due 列到期/待复核清单（只读）；verify 确认仍有效（刷新 lastVerifiedAt / reviewAfter，清 stale）；stale 标待复核（不删除、不退休）；retire 退休（保留正文与历史，可 revive）；revive 恢复 active（需要 note 说明理由）。只改时效字段，不改 G / outcome / 反馈账本。',
  parameters: {
    action: { type: 'string', enum: ['due', 'verify', 'stale', 'retire', 'revive'], required: true, description: '要执行的复核动作。' },
    id: { type: 'string', description: '经验 id；技能用 skill:<slug>。verify/stale/retire/revive 必填。' },
    note: { type: 'string', description: '复核结论或理由（≤240 字）；revive 必填。' },
    volatility: { type: 'string', enum: ['stable', 'semi', 'perishable'], description: '可选：修正易腐层。' },
    reviewAfter: { type: 'string', description: '可选：指定下一次复核时间（ISO）；不填按半衰期推算。' },
    appliesTo: { type: 'object', description: '可选：修正适用范围 { models?, tools?, environment? }。', properties: { models: { type: 'array', items: { type: 'string' } }, tools: { type: 'array', items: { type: 'string' } }, environment: { type: 'string' } }, additionalProperties: false },
    reason: { type: 'string', enum: ['manual', 'review-due', 'negative-feedback', 'model-upgrade'], description: '可选：stale / retire 的原因，默认 manual。' },
    limit: { type: 'number', description: 'due 时返回条数，默认 20（≤50）。' },
  },
}
