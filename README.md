<div align="center">
  <img src="docs/images/hero.svg" alt="忆痕 Engram：DSH 经验与技能引擎 + 经验库控制台" width="100%">
</div>

<h3 align="center">Engram（记忆痕迹）· 经验与技能引擎 + 经验库控制台，一个标准 DSH 插件</h3>

<p align="center">
  <img alt="version" src="https://img.shields.io/badge/version-0.46.0-6f5bd6">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-3fa46a">
  <img alt="node" src="https://img.shields.io/badge/node-%3E%3D22-339933">
  <img alt="platform" src="https://img.shields.io/badge/DSH-plugin-4f7fc4">
</p>

> 让 agent 记住「这件事上次是怎么做成的」，下次遇到同类任务直接端出来 —— 而不是每轮从零开始。

> **定位**：本插件为基于 JitRL 论文《Just-In-Time Reinforcement Learning: Continual Learning in LLM Agents Without Gradient Updates》（[arXiv:2601.18510](https://arxiv.org/abs/2601.18510)）设想的「无梯度更新的持续学习」在 DSH 上的工程实现——召回以「像不像当前任务」为主序、以用后回报（Â = Q̂ − V̂）为次序；有成败对照时 Â 参与排序，没有对照时退回相似度 × 证据强度。**目前仍在探索阶段**，机制、接口与磁盘格式都可能调整。

一条经验 = **做法 + 结果 + 适用范围 + 标签**。它不像聊天记录那样随会话消失，也不是把文档堆进一个文件夹：写进库里之后，它会被检索、被打分、被复核，攒够了还会长成技能。

| 常见做法 | 忆痕的做法 |
|---|---|
| 记忆存在上下文里，换个会话说没就没 | 落盘成经验库，跨会话、跨项目都还在 |
| 关键词命中就算相关 | 簇路由先收窄，再按相似度 + 回报 + 时效打分 |
| 记完就烂在库里 | 半衰期降权、到期复核、退休或标记被取代 |
| 知识只是一段文字 | 同族经验沉淀成带脚本的技能包 |
| 只有模型自己知道 | 控制台里人能看、能筛、能审、能改 |

---

## 一条闭环

<div align="center">
  <img src="docs/images/loop.svg" alt="经验闭环：记录、召回、反馈、沉淀" width="100%">
</div>

四个动作驱动整条闭环，配套九个内核工具，都挂在同一个插件的工具面上：

| 工具 | 干什么 | 关键点 |
|---|---|---|
| `exp_record` | 把一次做法写成经验 | 同一做法就地更新，近似的新做法会把旧条标成「被取代」；标签凑「对象 + 动作」 |
| `exp_recall` | 按任务意图召回旧经验 | 簇路由 → 打分 → 排序，只回一小段简报，默认 3 条 |
| `exp_feedback` | 回报用后结果 | `helped / hurt / neutral` 按 EMA 修正回报 G，下次排序就按新 G |
| `exp_consolidate` | 同族经验沉淀成技能 | 同族 ≥3 条且正负都有才允许，生成 `SKILL.md` + `skill.json` 账本 |
| `exp_skill_attach` | 给已有技能补正文 / 挂脚本 | 脚本进 `scripts/`，并在 `SKILL.md` 维护「## 脚本」清单 |
| `exp_type` | 管理主分类与标签词表 | list / create / rename / merge / delete / assign / labels |
| `exp_family` | 管理动作族 | list / create / rename / merge / assign / delete；族名 `<动词><对象>`，1–12 字 |
| `exp_object` | 记一件具体工作按什么顺序做完 | 对象名 + 1..n 条链（每条 1..n 步）；某步失败可挂分支换动作，同一步可挂多条；不参与召回排序 |
| `exp_review` | 复核经验时效 | due 到期清单、verify、stale、retire、revive |

---

## 控制台：6 个可见导航 + 12 条保留路由

<div align="center">
  <img src="docs/images/console.svg" alt="经验库控制台结构示意" width="100%">
</div>

左侧栏多出「经验库」入口，打开就是一个独立控制台 —— 既看数据，也发动作，不用回聊天窗口敲命令。

一级导航只留六项：

| 导航 | 看什么 / 做什么 |
|---|---|
| **首页** | 待我处理（待判定 / 到期复核）、库况和快捷动作 |
| **经验** | 列表 / 族 / 对象 / 冷档四个视图；筛选、排序、单条详情与反馈历史 |
| **技能** | 技能包列表、目录树、正文与脚本、导入、注册到全局、遗忘 |
| **关系图** | 三维星海视图：族主星、经验节点、同标签连线 |
| **运行记录** | `exp_*` 调用流水（`usage.jsonl`）与命中统计 |
| **设置** | 存储位置 / 备份与账号 / 内核参数 / 界面与关系图 / 维护 / 分类与标签 |

12 条 hash 路由一条没删，仍可直接深链：`#overview` `#graph` `#experiences` `#families` `#objects` `#cold` `#tags` `#recall` `#record` `#skills` `#usage` `#settings`。其中 `#families` / `#objects` / `#cold` 落到经验页的对应视图，`#types` 这类旧链接折到族视图，`#tags` 落到设置的「分类与标签」；检索与记录不占导航，但 `#recall` / `#record` 路由仍在（记录也是顶栏主按钮，检索可用经验页搜索框的「召回预览」或 `Ctrl/Cmd+K`）。

> 关系图之外的页面都做了「填满高度 + 内部滚动」，窗口窄到 1180px 以下会自动回落整页滚动；表格表头在滚动时吸顶。

---

## 召回：不靠关键词，也不靠热度

<div align="center">
  <img src="docs/images/recall.svg" alt="召回流程：簇路由、打分、排序、输出" width="100%">
</div>

一次 `exp_recall` 走四步，全程确定性计算，不额外调模型：

1. **簇路由**：先按素材类型和产物找「同族」。`routing` 可设 `on / shadow / off` —— `shadow` 只记录路由结果、不实际收窄，用来对比效果；没有同族就老老实实回退全库。手动 `exp_record` **不自动归族**（主分类由模型自己判断，没给就落「未分类」并在回执里提示补）；只有回合收尾的自动记录才走更松的门槛（`autoRouteMinScore`，默认 0.08）归族。
2. **打分**：相似度由四个因子组成，覆盖率占大头，保证短意图也召得回：

   | 因子 | 权重 | 说明 |
   |---|---|---|
   | coverage | 0.40 | 意图里的词被候选覆盖多少 |
   | jaccard | 0.25 | 两边词集的交并比 |
   | artifact | 0.20 | 产物语义组命中（PPT / 文档 / 表格 / 代码 / 网页 / 机器人 / Git …） |
   | bigram | 0.15 | 中文二元组重合 |

   相似度低于 `0.12` 的直接不参与估计。

3. **排序**：先按「像不像当前任务」算平均相似度，有成败对照时再算 JitRL 的 Â = Q̂ − V̂ 与置信度；最终 `base = 0.6 × 相似度 + 0.4 × (Â × 置信度)`，不按「谁用得多」。同类样本回报几乎相同（Â 极差过小）时 Â 区分不出好坏，整段改用「相似度 × 证据强度」。时效也进排序：`rank = base × (0.70 + 0.30 × freshness)`。
4. **输出**：返回 `brief`（简报）+ `route`（路由结果）+ `candidates`（候选做法）。默认瘦身档，`detail: true` 才给全字段。

还有两条防踩坑的设计：

- **适用范围门控**：经验声明了 `appliesTo`（模型 / 工具版本 / 环境）时，当前环境不匹配就默认不召回；要看得传 `includeMismatched: true`，命中会标 `applicability=mismatch`。
- **命中词自查**：返回里带 `matchedTerms`，词面碰巧重合的假匹配（比如「页面动画」撞上「PPT 页面」）模型自己就能看出来，换个更具体的意图重试。

---

## 经验会过时，但不会被悄悄删掉

<div align="center">
  <img src="docs/images/lifecycle.svg" alt="经验生命周期：active、stale、retired、superseded" width="100%">
</div>

| 状态 | 含义 | 对召回的影响 |
|---|---|---|
| `active` | 默认状态 | 正常参与，权重 1.0 |
| `stale` | 到期未复核（半衰期到了） | 仍在库里，排序降权 ×0.55 |
| `retired` | 主动退休 | 不参与召回，可 `revive` 恢复 |
| `superseded` | 被更准的新做法取代 | 只留历史，不参与召回 |

时效是**读的时候现算**的，不写回库：读到缺字段的旧记录就当默认值，所以升级插件不会把老库改坏。

| 易腐层 | 半衰期 |
|---|---|
| `stable`（偏好、硬约束） | 1095 天 |
| `semi`（判断原则，默认） | 180 天 |
| `perishable`（具体步骤、命令、API） | 45 天 |

`freshness = 0.5 ^ (年龄 / 半衰期)`。到期了不是删掉，而是进 `exp_review` 的 `due` 清单，由人或模型决定 `verify`（仍然有效）还是 `retire`（退休）—— 历史一律保留。

---

## 关系图：把库看成一片星海

<div align="center">
  <img src="docs/images/graph.svg" alt="关系图示意：分类主星与经验节点" width="100%">
</div>

真三维透视：拖拽轨道旋转、滚轮推拉、按深度排序遮挡。分类是主星，经验绕着各自的簇转；同标签的经验之间用虚线牵着，可以一键隐藏。

- **配色**：默认直接读当前 DSH 主题的渐变 token（跟随主题），也可以自选 10 套预设 —— 蓝紫星辰（默认）/ 超能量体 / 宇宙 / 赛博朋克 / 极光空灵 / 黑金科幻 / 蒸汽复古 / 青墨国风 / 极简冷科技 / 熔岩炽热。
- **背景**：跟随主题 / 浅色 / 深色三档，画布左下角有胶囊可以直接切（切背景时会同步改节点明暗补偿，不然颜色会算错）。
- **交互**：悬停只亮邻居、其余压暗；越新的经验越亮；拖拽有惯性，空转时有呼吸感，分类主星有差速漂移与深度视差。
- **性能开关**：自动旋转速度、泛光 bloom、色散毛刺、浮尘数量都能单独关，机器吃力就调低。

---

## 技能：沉淀出来的是完整技能包

同族经验攒够（≥3 条，且正负结果都有），`exp_consolidate` 会给出一个技能 —— 不是一篇散文，是能直接用的包：

```
<dataDir>/skills/<slug>/
├── SKILL.md          # frontmatter + 正文（步骤、常见例外、已内化）
├── skill.json        # 账本：分类、便签、置信度、障碍计数、脚本清单
└── scripts/          # 脚本附件，登记在 skill.json 的 files
```

- 沉淀时可带 `body`（手写正文）和 `files`（脚本路径）；已有技能用 `exp_skill_attach` 补料。
- 召回时**技能与经验并列返回**：技能给正文，旁边最多附 3 条同类经验做参照，不会互相遮住。
- 技能**不会**偷偷写进 `$DSH_HOME/skills/`。要它变成 DSH 全局技能，得在控制台技能详情里手动点「注册技能到全局」（junction 到 DSH skills，建不了链接才复制）；注册后经验库不再排序它，按钮变「取消注册」。
- 「忘记技能」是两步确认删目录，注册中的会先取消注册。

---

## 技能命中：首给全文，再命中给短回执，压缩后重取

技能正文不再「每次命中都按原价重发」。同一次会话里命中同一个技能，回执分三态：

| 情形 | 回执 | 体量 |
|---|---|---|
| **首给**：本会话没给过，或正文改过（`bodyHash` 变了） | 全文 + `runtime` + `matchedTerms` | 4–7k token |
| **复用**：给过、且那条结果还在可见上下文里 | ≤400 字短回执：`reused` 元信息 + 3 条正文二级标题锚点 + 重取入口 | 几百字 |
| **重给**：给过、但正文已被压缩遮掉 | 全文 + 「上文版本可能已被压缩，以此为准」 | 4–7k token |

- **正文不复原，只重取**：复用回执里写着 3 条锚点（正文里的二级标题原文）。拿锚点对不上当前任务、或者需要具体步骤和脚本时，调 `exp_recall({ skill: '<slug>', load: true })` 现读文件重取正文 —— 拿到的永远是当前这一版，不是压缩前的旧版。
- **会话技能目录**：本会话命中过的技能会发一条清单（条目名带 `engram:` 前缀，只有名字 + 截断描述，不含正文和路径）。清单被压缩遮掉时，下一步自动补发一份替换版并声明旧清单作废，模型照清单里的名字重新 `exp_recall` 即可，不用凭印象硬做。
- **两个开关**：设置 → 内核参数里有「会话技能目录」（`skillCatalog`）和「复用短回执」（`reuseReceipt`），默认都开。关掉「会话技能目录」就完全退回旧行为（每次命中都给全文、不发清单也不补发）；排障时可关掉「复用短回执」强制每次看全文。目录条数上限（`catalogMaxSkills`，默认 5）与描述截断长度（`catalogDescriptionChars`，默认 300）只在 `~/.dsh/engram/settings.json` 里改，不在设置页。
- **在哪里看**：控制台「使用记录」页的「命中」列直接显示首给 / 复用 / 重给，KPI 有「复用命中 / 重给全文」两格，展开某一行还能看到对应的 `skill` 与 `bodyHash`（正文版本）。

---

## 存储、备份与设置

- **数据目录**：`manifest.json` + `buckets/` 分片存储（老库 `exp-lib.json` 直接兼容）。超出容量上限的老经验下沉到「冷档」，是安全阀，不是删除。
- **Git 备份**：库本身就是一个普通 git 仓库（`<dataDir>/.git`），控制台「设置 → 备份与账号」里填远端即可 init / 提交推送 / 拉取。
  - 推送策略三档：**检测到远端有新提交时问我**（默认）/ 直接本地覆盖云端（覆盖前先把旧远端 HEAD 存进 `refs/engram/overwritten/*`）/ 只允许快进。
  - GitHub 用**设备码登录**，不用手贴 PAT：浏览器打开验证页、输入一次性代码，token 自动存进本机设置，然后「加载我的仓库」点选即可。机器有 TLS 拦截代理时会自动导出系统根证书重试。
  - 可以设自动备份间隔（最小 15 分钟，没有改动就跳过）。
- **设置**：写在 `~/.dsh/engram/settings.json`，控制台分六组 —— 存储位置 / 备份与账号 / 内核参数 / 界面与关系图 / 分类与标签 / 维护。
- **提示段**：每轮系统提示里会多一段「【经验库】」说明。默认瘦身档约 150 字符（什么时候该记 + 怎么用 + 条数 + 前几个技能），可以关掉，也可以换成完整档（列全部类型与技能，约 1300 字符）。
- **会话里随手存**：助手消息下方的「存经验」按钮，直接从会话记录里挑内容写成经验，不用手工复制。

---

## 安装

```bash
npm pack
dsh plugin --profile <profile> add ./dsh-engram-0.46.0.tgz
```

重启 DSH 后只会出现**一个**插件行「dsh-engram」：左侧栏多出「经验库」，工具面 `exp_*` 与控制台 API `/exp-ui/api` 同包同入口。

要求 Node ≥ 22、DSH 客户端模块可用；`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-tools` 都是可选 peer，拿不到会退化成自绘图标。

## 快速上手

```text
① 做完一件事，记下来
   exp_record(intent="给研学课 PPT 插一页", action="用 16:9 母版重排 + 统一字号",
              outcome="accepted", labels=["课件","PPT","布局"])

② 下次同类任务，先翻旧账
   exp_recall(intent="给课件 PPT 加一页过渡页（深蓝色调）")

③ 用过之后回一句实话
   exp_feedback(id="<候选 id>", result="helped")
```

跑几轮之后去控制台「关系图」看，经验会自己聚到分类主星周围；同族攒够了，`exp_consolidate` 就会提示可以沉淀成技能。

**快捷键**：`Ctrl/Cmd+K` 命令面板 · `?` 快捷键表 · `g` + `o/e/r/n/s/t/u/,` 跳页 · `Shift+R` 刷新 · `j/k` 列表上下移动。

---

## 目录结构

| 路径 | 作用 |
|---|---|
| `plugin.js` | 唯一入口：内核工具面 + 控制台 API |
| `cordis.patch.yml` | 只插一条 `engram` 行（裸包名） |
| `kernel/` | 引擎：存储分片、检索、簇路由、沉淀、反馈、技能、时效、Git 同步 |
| `ui/shell.js` | 控制台 API 外壳 |
| `ui/live.js` / `ui/mock.js` | 数据源：真实库 / 内置示例数据（mock 只用于看界面） |
| `client.js` | 控制台界面（DSH 模块加载器 bundle） |
| `docs/images/` | README 配图（SVG） |
| `tools/migrate-tags-v2.mjs` | 标签迁移脚本，默认 dry-run，`--apply` 前整包备份 |

## 版本记录

README 只讲当前能力，不再逐版罗列。当前版本以包根 `package.json` 为准；每个版本具体改了什么，唯一发布记录在发布仓的 `RELEASES.md`（开发仓同级路径 `../dsh-Engram/RELEASES.md`）。开发仓内的 `RELEASES.md` 只是历史快照，不再追加版本记录。

---

## 借鉴与致谢

这个插件是长期迭代出来的，不少设计来自公开项目与 DSH 生态。写清楚借了什么，免得以后当成原创；完整清单（含论文与方法来源）在 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

| 来源 | 借了什么 | 体现在哪 |
|---|---|---|
| [asdfd3/3d-memory-sea](https://github.com/asdfd3/3d-memory-sea) | 星海式关系图：球面簇布局、真三维透视投影、轨道旋转 / 滚轮推拉、按深度遮挡、流光与景深 | 控制台「关系图」页（0.9.0 起） |
| [Yuuyuko-uu/dsh-xingxi](https://github.com/Yuuyuko-uu/dsh-xingxi) | 悬停只亮邻居其余压暗、越新越亮的新近度表达、镜头自动适配 | 关系图交互（0.10.0 起） |
| [DeepSeek Harness](https://github.com/deepseek-ai) | 插件双半结构、`dsh.client` bundle 约定、`sidebar.panellist` 只返回图标本体的契约 | `plugin.js` / `client.js` 的整体形态 |
| [omdsh-dev/dsh-mnemon](https://github.com/omdsh-dev/dsh-mnemon) | 本插件早期是它的记忆空间 Provider；分类型、按簇召回、经验与技能分层都从这套思路长出来 | kernel 的类型 / 簇 / 技能模型（0.11.0 起解耦，不再依赖） |
| [libiwolve/dsh-experience-library](https://github.com/libiwolve/dsh-experience-library) 等 | 「程序性经验」与「陈述性记忆」分层的定位、按证据分级打分、检索到 ≠ 注入的裁决立场 | kernel 的经验模型与反馈口径（详见第三方声明） |
| JitRL：Just-in-Time Reinforcement Learning | `kernel.js` 的数学映射：状态抽象、折扣回报、非参数 critic、Â = Q̂ − V̂ | `exp_recall` 的排序依据 |
| 前身 `dsh-exp-lib-provider`（同作者） | `exp-lib.json` 存储格式、反馈学习率、退休 / 取代语义 | `kernel/store.js` 兼容路径，源码用 `@legacy-provider` 标注 |

关系图的**配色不借任何预设主题**：默认直接读 DSH 运行时的主题 token，跟随当前主题变化；预设配色只在手动选择时接管。

### 历史沿革

1. `dsh-exp-lib-provider`：作为 dsh-mnemon 的记忆空间 Provider，只提供数据面。
2. `dsh-engram` 0.1–0.10：独立成「引擎」+「控制台外壳」两个插件。
3. `dsh-engram` 0.11 起：合并为**一个插件**（工具面 + 控制台同包同入口），与记忆插件彻底解耦。

## 许可

MIT，第三方声明见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
