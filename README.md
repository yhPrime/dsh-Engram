# dsh-engram

Engram（记忆痕迹）：经验与技能引擎 + **经验库控制台**，一个标准 DSH 插件。

## 安装

```bash
npm pack
dsh plugin --profile <profile> add ./dsh-engram-0.14.0.tgz
```

重启 DSH 后只出现**一个**插件行「dsh-engram」：左侧栏多出「经验库」，控制台含概览 / 关系图 / 经验 / 检索 / 记录 / 技能 / 类型 / 使用记录 / 设置；工具面 `exp_record / exp_recall / exp_feedback / exp_consolidate / exp_type` 同包内的 `/exp-ui/api` 一并生效。

## 结构

| 路径 | 作用 |
|---|---|
| `plugin.js` | 唯一入口：kernel 工具面 + 控制台 API |
| `cordis.patch.yml` | 只插一条 `engram` 行 |
| `kernel/` | 引擎：存储、检索、簇路由、沉淀、反馈、技能 |
| `ui/` | 控制台：`client.js`（界面）、`shell.js`（API）、`live.js`/`mock.js`（数据源） |
| `icon.svg` | 插件图标（经验库自有标记） |

## 配置

在 DSH 插件行或 `~/.dsh/engram/settings.json`：

- `dataDir` / `currentRoot`：经验库目录（含 `exp-lib.json`）
- `source`：`live`（默认）或 `mock`（仅演示）
- 内核参数：`hint`、`usageLog`、`feedbackEta`、`routing`、`maxTypes` 等，全部可在控制台「设置」页修改。

## Git 备份

控制台「设置 → Git 仓库备份」里填远端，库就是一个普通 git 仓库（`<dataDir>/.git`）：

- **远端**：`https://…` / `ssh://…` / `git@host:path` / 本机绝对路径；地址里不要写账号密码，https 用单独的 **token** 字段（只存在本机 `settings.json`，推送时走 `http.extraHeader`，错误信息里打码）。
- **网络**：GitHub 请求先走 Node fetch；如果机器装了 TLS 拦截代理（Node 自带 CA 验不过，界面会显示 etch failed），会自动导出 Windows 根证书并按需缓存到 ~/.dsh/engram/system-ca.pem 后重试。
- **GitHub 账号**：直接「用 GitHub 登录（免 token）」走 OAuth 设备码——浏览器打开验证页、输入一次性代码即可，token 自动存进本机设置（**不用手贴 PAT**；token 字段只作后备）→「加载我的仓库」→ 列表里点「用这个」，自动保存地址、初始化并推送；列表里没有合适的，就填个新仓库名，「新建仓库并推送」（GitHub 上建**空**仓库，不会撞初始提交）。
- **动作**：初始化仓库（`git init` + 设 `origin`）、提交并推送（`add -A -- .` → commit → push）、拉取（只做 `--ff-only`，有分叉不自动合并）。
- **自动备份**：`autoBackupMinutes` 大于 0 时按间隔自动提交推送（最小 15 分钟；没有改动会跳过）。
- API：`GET /exp-ui/api/sync` 看状态，`POST /exp-ui/api/sync` 带 `{action:"init"|"push"|"pull"|"status"}`；GitHub 相关用 `POST /exp-ui/api/github`。

## 技能与脚本

经验沉淀出来的技能是**完整技能包**，不是一段散文：

- `<dataDir>/skills/<slug>/SKILL.md`（frontmatter name/description + 正文）
- `<dataDir>/skills/<slug>/scripts/`（脚本附件，登记在 `skill.json` 的 `files`，并在 `SKILL.md` 维护「## 脚本」清单）
- 沉淀时可带：`exp_consolidate` 的 `body`（手写正文）/ `files`（脚本路径）/ `install`（同时装成 DSH 可加载技能）
- 已有技能补料：`exp_skill_attach`（files / body / install）
- 控制台「技能」页显示文件数，选中技能可「装到 DSH」（复制到 `$DSH_HOME/skills/<slug>/`，之后 `skill` 工具就能加载）

## 借鉴与致谢

这个插件是长期迭代出来的，不少设计来自公开项目与 DSH 生态。写清楚借了什么，免得以后当成原创：

| 来源 | 借了什么 | 体现在哪 |
|---|---|---|
| [asdfd3/3d-memory-sea](https://github.com/asdfd3/3d-memory-sea) | 星海式关系图：球面簇布局、真三维透视投影、左键轨道旋转 / 滚轮推拉、按深度排序遮挡、流光与景深 | 控制台「关系图」页（0.9.0 起） |
| [Yuuyuko-uu/dsh-xingxi](https://github.com/Yuuyuko-uu/dsh-xingxi) | 悬停只亮邻居、其余压暗；越新越亮的新近度表达；镜头自动适配 | 关系图交互（0.10.0 起） |
| [DeepSeek Harness](https://github.com/deepseek-ai)（`@deepseek-ai/dsh-client-modules` 与 sidebar/slot 契约） | 插件双半结构、`dsh.client` 客户端 bundle 约定、`sidebar.panellist` 只返回图标本体的契约 | `plugin.js` / `client.js` 的整体形态 |
| [omdsh-dev/dsh-mnemon](https://github.com/omdsh-dev/dsh-mnemon) | 本插件早期是它的记忆空间 Provider；分类型、按簇召回、经验与技能分层都从这套思路长出来 | kernel 的类型 / 簇 / 技能模型（0.11.0 起已解耦，不再依赖） |
| 本仓库前身 `dsh-exp-lib-provider`（同作者） | `exp-lib.json` 存储格式、反馈学习率、退休 / 取代语义 | `kernel/store.js` 的兼容路径，源码里用 `@legacy-provider` 标注 |

关系图的**配色不借任何预设主题**：默认直接读 DSH 运行时的主题 token（`--dsw-alias-brand-primary` 等），跟随你当前主题变化；预设配色只在手动选择时接管。

### 历史沿革

1. `dsh-exp-lib-provider`：作为 dsh-mnemon 的记忆空间 Provider，只提供数据面。
2. `dsh-engram` 0.1–0.10：独立成「引擎」+「控制台外壳」两个插件。
3. `dsh-engram` 0.11：合并为**一个插件**（工具面 + 控制台同包同入口），与记忆插件彻底解耦。

## 许可

MIT，第三方声明见 `THIRD-PARTY-NOTICES.md`。
