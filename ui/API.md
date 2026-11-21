# exp-ui 接口文档（当前契约）

> 外显名 **exp-ui**，是经验库的**界面外壳**，与真实经验库（`exp-lib` / `dsh-engram`）分开命名。
>
> 本文按 `ui/shell.js` 的 `handleRequest` **实际路由**逐条重核：路由、方法、错误码与读写能力都以代码为准。版本号统一写作 `<package-version>`，真实值以包根 `package.json` 为准，`/health` 与 `/state` 在运行时回显。

- Base URL：`/exp-ui/api`（前缀路由，挂在 DSH 的 `webServer` 上）
- 编码：UTF-8 JSON，`content-type: application/json; charset=utf-8`，`cache-control: no-store`
- 请求体上限 1MB；坏 JSON 返回 400 `bad-request`
- 成功与失败共用同一层信封（见 §2），HTTP 状态另表语义

## 1. 数据源：mock / live

| 数据源 | config | 读 | 写 |
|---|---|---|---|
| `live`（默认） | `source: live` + `dataDir` | 真实经验库：`manifest.json` + `library/*.jsonl`（旧单文件 `exp-lib.json` 兼容） | **可写**：记录、反馈、复核、判定回填、族管理 / 补族、技能导入 / 元数据 / 注册 / 遗忘、设置与 Git 备份 |
| `mock` | `source: mock` | 内置示例数据（进程内存） | 记录、反馈、复核、判定回填只改这份假数据，不落盘；沉淀、类型管理、技能全局操作、自动分类、族落盘、Git 返回不支持 |

- 不传 `source` 时默认 `live`；`dataDir` 缺省依次取插件行 config、`ENGRAM_DATA_DIR`、设置的「存储位置」当前根，最后是 `$DSH_HOME/engram/data`。
- 两套数据源返回**相同形状**。`data.source.readOnly` 是历史兼容字段，当前 mock 与 live 都是 `false`；界面按具体动作是否支持判断（400/501 `unsupported`），**不再把 live 当只读**。
- 读失败不假装空库：热档读坏给 `storeError` / `store-unreadable`，冷档读坏给 `cold-unreadable`。

## 2. 响应外壳与错误码

成功：

```json
{ "ok": true, "data": {} }
```

失败：

```json
{ "ok": false, "error": { "code": "not-found", "message": "没有这条经验：ex_xxx" } }
```

| code | HTTP | 含义 |
|---|---|---|
| `bad-request` | 400 | 参数格式不对、JSON 解析失败、取值非法 |
| `id-required` | 400 | 缺少 `id` |
| `intent-required` | 400 | 缺少 `intent`（召回 / 记录 / 沉淀） |
| `action-required` | 400 | 缺少 `action`（记录） |
| `bad-outcome` | 400 | `outcome` 不在允许集合 |
| `bad-result` | 400 | `result` 不是 `helped` / `hurt` / `neutral` |
| `bad-action` | 400 | 未知动作 |
| `bad-perf` | 400 | 关系图性能载荷不合法 |
| `body-too-large` | 400 | 请求体 > 1MB |
| `slug-required` | 400 | 缺少技能 `slug` |
| `node-required` | 400 | 缺少技能节点 `path` |
| `no-type` | 400 | 自动分类没有可用的主分类 |
| `no-data-dir` | 400 | 没有数据目录，无法写技能 |
| `source-required` | 400 | 导入技能时既没文件也没正文 |
| `ids-required` | 400 | 存会话时缺少 `messageId` |
| `repo-required` | 400 | `select` 缺少 `repoUrl` |
| `reason-required` | 400 | `revive` 缺少 `note` 理由 |
| `verdict-failed` | 400 | 判定回填整体失败 |
| `skill-global-failed` | 400 | 技能全局注册 / 取消注册失败 |
| `skill-node-failed` | 400 | 技能节点操作失败 |
| `skill-meta-failed` | 400 | 技能元数据修改失败 |
| `skill-forget-failed` | 400 | 技能删除失败 |
| `turn-not-found` | 400 | 会话里找不到该消息 |
| `picker-unavailable` | 400 | 宿主没有系统目录选择器 |
| `not-found` | 404 | 路由、经验或技能不存在 |
| `method-not-allowed` | 405 | 路径存在但方法不对 |
| `read-only` | 409 | 数据源不支持写入（历史兼容码；当前 live 可写，正常不会出现） |
| `not-feedbackable` | 409 | 该条已删除 / 被取代 / 退休，不能反馈或复核 |
| `classify-conflict` | 409 | 自动分类期间目标行的类型或标签上下文被改过，本次结果放弃，可重试 |
| `root-move-failed` | 409 | 切换存储位置失败（目录不可写等） |
| `unsupported` | 400 / 501 | 示例数据或数据源不支持该动作；路由显式拒绝为 400，数据源抛出为 501 |
| `cold-unreadable` | 500 | 冷档文件缺失或坏行（不把「丢了」显示成「没有」） |
| `report-failed` | 500 | 影子报表生成失败 |
| `perf-log-failed` | 500 | 性能样本写本机日志失败 |
| `store-unreadable` | 500 / 503 | 热档读坏；`/experience` 等读接口兜底 503，`/classify` 显式返回 500 |
| `internal` | 500 | 未预期异常（外壳兜底，不把进程带崩） |

## 3. 路由总表

`读` = 不写盘；`写` = 会改数据目录、设置或本机 Git。所有路由都挂在 `/exp-ui/api` 下。

| 方法 | 路由 | 读/写 | 作用 |
|---|---|---|---|
| GET | `/icons` | 读 | 图标画廊 HTML（不是 JSON） |
| GET | `/health` | 读 | 存活探针 + 版本 + 客户端回打探针 |
| GET | `/state` | 读 | 控制台概览（轻量 manifest + 统计） |
| GET | `/experiences` | 读 | 经验列表；带 `query` 时切召回态 |
| GET | `/experience` | 读 | 单条详情 + 历史 + 反馈日志 |
| GET | `/cold` | 读 | 冷档分页列表 |
| GET | `/tag-registry` | 读 | 标签词表（按面分组） |
| GET | `/tag-tree` | 读 | 标签树 |
| GET | `/families` | 读 | 扁平族表 + 类型兼容视图 + 未分族 |
| GET | `/objects` | 读 | 对象链只读视图 |
| POST | `/families/backfill` | 读 / 写 | 补族：默认只预演，`dryRun:false` 才写 |
| POST | `/families/manage` | 写 | 族管理：list / create / rename / merge / assign / delete |
| GET | `/retrieval-policy` | 读 | 当前检索策略与 A/B 报表摘要 |
| GET | `/types` | 读 | 主分类列表 |
| GET | `/skills` | 读 | 固化技能列表 + 目录树 |
| GET | `/usage` | 读 | `exp_*` 调用流水 |
| GET | `/pending` | 读 | 待判定队列 |
| POST | `/verdicts` | 写 | 批量回填判定 |
| GET | `/usage-summary` | 读 | 调用次数与回执字符数汇总 |
| POST | `/recall` | 读 | 跑一次召回 |
| POST | `/record` | 写 | 写一条经验 |
| POST | `/review` | 写 | 经验 / 技能时效复核 |
| POST | `/consolidate` | 写 | 同族经验沉淀成技能 |
| POST | `/skills/import` | 写 | 导入技能或技能套件 |
| POST | `/skill-feedback` | 写 | 技能用后反馈 |
| POST | `/skill-global` | 写 | 注册 / 取消注册到 DSH 全局技能目录 |
| POST | `/skill-node` | 写 | 技能节点 register / unregister / forget / detach |
| POST | `/skill-meta` | 写 | 改技能分类与便签 |
| POST | `/skill-forget` | 写 | 删除技能目录 |
| POST | `/type` | 写 | 主分类管理 |
| GET | `/classify-diag` | 读 | 自动分类能力自检 |
| POST | `/classify` | 写 | 对一条经验跑自动分类（模型调用在锁外，应用在锁内） |
| GET | `/graph` | 读 | 关系图节点与边 |
| GET | `/shadow-report` | 读 | 标签影子判据报表（仅 live） |
| POST | `/graph-perf` | 写 | 关系图性能样本写本机日志 |
| GET | `/validate` | 读 | 技能目录自检 |
| GET | `/pick-directory` | 读 | `?probe=1` 只回答能否弹系统选目录窗口 |
| POST | `/pick-directory` | 读 | 弹系统选目录窗口（模态） |
| GET | `/settings` | 读 | 设置、运行环境与字段说明 |
| POST | `/settings` | 写 | 保存存储位置 / config / ui / git |
| GET | `/sync` | 读 | Git 备份状态 |
| POST | `/sync` | 写 | init / push / pull / status / disconnect |
| GET | `/chat-save-probe` | 读 | 探测会话文件可读性 |
| POST | `/chat-save` | 写 | 把会话里的一轮存成经验 |
| POST | `/github` | 写 | GitHub 登录、仓库列表、建仓、选仓 |
| POST | `/feedback` | 写 | 经验用后反馈 |

`POST /skill-install` 已下线；技能注册到全局改用 `/skill-global`。

> 读写口径的一个细节：`POST /recall` 与带 `query` 的 `GET /experiences` 不修改经验本体，但开着 `usageLog` 时会向 `<dataDir>/usage.jsonl` 追加一行调用记录；这在「读」的语义边界内，不属于经验写入。

## 4. 只读接口

### GET /health

```json
{ "ok": true, "data": { "ok": true, "app": "经验库", "version": "<package-version>", "source": "live", "readOnly": false, "client": [] } }
```

- `?client=1&phase=…&id=…&panels=…&errors=…&note=…` 是客户端半加载后的回打探针：只记在内存（最多保留最近 8 条），用于区分「客户端没加载」与「加载了但没注册」。
- `app` 固定为 `经验库`（`APP_NAME`）。

### GET /state

概览页用的概览读：有 manifest 统计时只取 manifest 与存储用量；没有 manifest / stats 时退回全量行现算（与旧行为一致，不静默改语义）。

| 字段 | 类型 | 说明 |
|---|---|---|
| `app` / `version` | string | 固定 `经验库` / 包版本 |
| `source` | object | `{ id, mode, label, readOnly }` |
| `dataDir` / `file` | string | 数据目录 / manifest 路径 |
| `exists` / `bytes` | boolean / number | 数据文件是否存在 / 字节数 |
| `updatedAt` | string | 当前 manifest 不写 `updated_at`，通常是空串，不要当时间戳用 |
| `notice` | string | 需要界面显示的提示；无则空串 |
| `storage` | object | 有分片存储时给布局信息（`layout` / `typeDirs` / `familyFiles` / `familyBytes` / `indexFiles` / `indexBytes`） |
| `cold` | object | 冷档摘要（年档 / 条数）；读坏时带 `error` |
| `feedbackEta` | number | 反馈 EMA 系数（0.35） |
| `skillSummary` | object | `{ total, solid, trial, risky, new, blocked }` |
| `usage` | object | `{ total, today, byTool, byDay, lastAt, lastTool }` |
| `totals` | object | `{ all, visible, deleted, superseded, retired, types, skills }` |
| `stats` | object | `{ totalInsights, deletedInsights, supersededInsights, retiredInsights, edgeCount, dbSizeBytes, byCategory, topEntities }` |
| `types` | array | 同 `/types` 的 `types` |

### GET /experiences

查询参数（都可省略）：

| 参数 | 类型 | 说明 |
|---|---|---|
| `query` | string | 非空 → 召回态（走 `source.recall`）；空 → 列表态 |
| `type` | string | 按 `typeId` 过滤（仅列表态） |
| `outcome` | string | success / partial / failed / corrected / aborted / unknown |
| `source` | string | `auto` 只看自动记录；`manual` 看手记 + external；其它不过滤 |
| `verdict` | string | 精确匹配 `verdict`（pending / decided / skipped …） |
| `lifecycle` | string | `active` / `stale` / `retired` / `superseded` / `visible`（默认）/ `all` |
| `family` | string | 按族过滤；`__unfiled__` 表示未分族 |
| `volatility` | string | `stable` / `semi` / `perishable` |
| `due` | `1` | 只看到期 / 已 stale 的行 |
| `sort` | string | `recent`（默认）/ `g` / `hits` / `type` |
| `limit` | number | 列表态默认 100、上限 300；召回态默认 8、上限 50 |
| `offset` | number | 列表态分页偏移，默认 0 |

返回公共字段：`source`、`notice`、`storeError`（读坏时 `{ code, message, file }`）、`mode`、`total`、`rows`、`counts`（仅列表态，按 `typeId` 统计 active/stale）、`note`、`warning`、`brief`、`route`、`advantageSpread`、`neighborCount`（召回态）。带 `query` 时顶层另回显 `query`。

列表行 `rows[]` 的关键字段：

| 字段 | 说明 |
|---|---|
| `id` / `intent` / `action` / `note` | 经验本体 |
| `typeId` / `typeName` / `family` | 主分类与族 |
| `outcome` / `G` / `GOutcome` / `GSource` | 结果与回报（`feedback` 或 `outcome`） |
| `hits` / `retrievals` | 用过次数 / 主动检索次数 |
| `origin` / `kind` / `taskId` / `stepIndex` / `stepTotal` | 来源与任务步骤 |
| `context` / `dimensions` / `expectedG` / `verdict` | 标签、能力维度、预期回报、判定 |
| `stepRewards` / `artifacts` / `sessionId` / `turn` / `cwd` | 分步回报、产物、会话绑定 |
| `createdAt` / `lastSeenAt` | ISO 时间 |
| `feedback` | `{ helped, hurt, neutral, window, lastAt, lastResult }` 或 `null` |
| `lifecycle` | `{ state, supersededBy, retiredAt, retiredReason, deletedAt }` |
| `freshness` / `volatility` / `lastVerifiedAt` / `reviewAfter` / `reviewDue` / `staleAt` / `staleReason` / `reviewNote` / `applicability` / `appliesTo` | 时效与适用范围 |

召回态 `rows[]` 是「候选做法」分组：`action`、`typeName`、`advantage` / `advantageNorm`、`confidence`、`rankScore`、`support`、`meanSimilarity`、`evidenceStrength`、`evidence[]`（`{ id, intent, action, outcome, G, similarity, typeName, note, feedback, lifecycle }`）。

### GET /experience?id=<经验 id>

返回 `{ row, history, feedbackLog }`：`row` 同列表行字段；`history` 最多 20 条生命周期事件；`feedbackLog` 最多 20 条反馈事件。

- 缺 `id` → 400 `id-required`
- 找不到 → 404 `not-found`
- 热档读坏 → 503 `store-unreadable`

### GET /cold

查询参数：`offset`（默认 0）、`limit`（默认 50，上限 500）、`query`（大小写不敏感，匹配 intent/action/id/typeName）、`year`（UTC 年）。

```json
{
  "ok": true,
  "data": {
    "source": { "id": "live", "mode": "live", "label": "真实数据", "readOnly": false },
    "notice": "",
    "exists": true,
    "total": 2,
    "offset": 0,
    "limit": 50,
    "years": [{ "year": 2026, "count": 2, "bytes": 4096 }],
    "rows": [{ "id": "ex_...", "intent": "...", "action": "...", "typeName": "PPT / 课件", "G": -0.6, "outcome": "failed", "lastSeenAt": "2026-01-08T09:30:00.000Z" }],
    "error": null
  }
}
```

- `exists` = manifest 里登记了冷档年档（`years.length > 0`）。
- 冷档文件缺失 / 坏行 → 500 `cold-unreadable`。
- 冷档只读：没有反馈 / 编辑 / 删除接口。

### GET /tag-registry

标签词表：core 种子词 + 已复用（≥2 条经验）+ 用户登记，按面分组；标签选择器直接照这份渲染。

```json
{
  "ok": true,
  "data": {
    "facets": ["action", "direction", "topic", "quality"],
    "labels": { "action": "动作/任务", "direction": "方向/场景", "topic": "主题/场景", "quality": "质量/异常", "other": "其他已用标签" },
    "hints": { "action": "再补一个动作标签，例如 提交/推送/校验/验收" },
    "required": [],
    "emptyFacets": [],
    "groups": {
      "action": [{ "name": "提交", "facet": "action", "core": true, "count": 0, "description": "git commit、表单提交…", "status": "active", "source": "core" }],
      "direction": [{ "name": "契约断言", "facet": "direction", "family": "写断言", "core": false, "count": 3, "description": "按宿主契约写断言", "status": "active", "source": "user" }],
      "topic": [], "quality": [], "other": []
    },
    "total": 47,
    "maxCount": 8
  }
}
```

- `core: true` 的种子词 0 次使用也返回；用户标签使用 <2 次不返回。
- `other` 是词表里没有面的历史一次性标签（读得到，但不参与「对象 / 动作」判断）。
- 别名归一在服务端完成（如 `DSH-Engram` 读成 `DSH插件`）。
- `direction` 是族内场景方向（如 `写断言` 下的 `契约断言`），条目带 `family` 归属；方向只能按族登记，没有内建 core。

### GET /tag-tree

返回标签树（按当前可见经验统计）。示例数据走内建词表；live 读取数据目录的词表覆盖文件。

### GET /families

`families` 是扁平事实族表（含「未分族」这个真实族）；`types` 保留一版兼容视图。

```json
{
  "ok": true,
  "data": {
    "types": [{ "typeId": "ty_ppt", "name": "PPT / 课件", "count": 4, "families": [{ "family": "改 PPT 页面", "count": 3, "representative": { "id": "ex_...", "intent": "...", "G": 0.8, "hits": 4, "lastSeenAt": "..." } }] }],
    "families": [{ "family": "改 PPT 页面", "count": 3, "representative": { "id": "ex_..." } }],
    "unfiled": 0,
    "unfiledRows": []
  }
}
```

- `families` 按条数降序；显式创建但还没有行的空族也会出现（`count: 0`）。
- `unfiled` 只统计「推导不出族」的行（通常为 0），不是「未分族」的条数；`unfiledRows` 是这类行的前 50 条。
- 族代表取该（类型, 族）内 G 最高者，G 相同取最近使用。

### GET /objects

对象链只读视图：`<dataDir>/objects.jsonl` 的每一行 = 一件具体工作的实际过程。写入口只有工具 `exp_object`，控制台不做第二套写路径。

```json
{
  "ok": true,
  "data": {
    "available": true,
    "total": 1,
    "objects": [
      {
        "id": "ob_1a2b3c4d",
        "object": "改标签系统",
        "at": "2026-11-19T09:00:00.000Z",
        "chains": [
          {
            "at": "2026-11-19T09:00:00.000Z",
            "note": "可选",
            "steps": [
              { "family": "改标签页", "direction": "契约断言", "note": "可选" },
              { "family": "跑 npm 测试", "outcome": "failed", "branches": [{ "when": "Node 版本不对，报 ERR_UNKNOWN_FILE_EXTENSION", "steps": [{ "family": "安装依赖" }, { "family": "跑 npm 测试" }] }] }
            ]
          }
        ],
        "hints": [{ "reason": "steps", "when": "Node 版本不对", "steps": ["fm_ab12cd34"], "count": 3, "window": 5, "places": [{ "chainIndex": 1, "stepPath": [2] }] }]
      }
    ]
  }
}
```

- `available=false` 分两种：mock / 未配置数据目录时**不带 `error`**；`objects.jsonl` 读坏时带 `error`（含原因），此时 `total=0`、`objects=[]`。
- `chains` 1..n 条；`steps` 1..n 步；`steps[].outcome` 只写 `failed` / `skipped`（缺省 = ok）；`branches` 只挂 failed 步，可嵌套（深度上限 3）。
- `hints[].steps` 是**族 id 列表**，渲染时按族注册表解析成当前族名。
- 不参与召回与排序；文件不存在时不建文件。

### GET /retrieval-policy

```json
{ "ok": true, "data": { "tagRank": "shadow", "routing": "on", "visible": 120, "families": 18, "unfiled": 0, "ab": null } }
```

`ab` 读 `<dataDir>/.cache/ab-report.json`；没有就是 `null`。`families` 是（类型 × 族）代表键数，不是去重后的族名数。

### GET /types

```json
{ "ok": true, "data": { "types": [{ "id": "ty_ppt", "name": "PPT / 课件", "description": "…", "system": false, "count": 4 }] } }
```

空业务类型时会先补默认主分类再返回。

### GET /skills

固化技能列表 + 状态分布 + 目录树。来源是 `<dataDir>/skills/`（`SKILL.md` + `skill.json`）；mock 给内置示例技能。

返回 `{ source, notice, total, summary, skills, tree }`：

- `summary`：`{ total, solid, trial, risky, new, blocked }`
- `skills[]`：`id / path / name / description / body / typeName / context / triggers / uses / helped / hurt / attempts / ratio / confident / status / revisions / obstacleCount / openObstacleCount / resolvedCount / derivedFrom / pendingCommit / lastUsedAt / updatedAt / depth / parentPath / rootName / childCount / runtime / bodyHash` 以及生命周期字段（`lifecycle` / `freshness` / `volatility` / `lastVerifiedAt` / `reviewAfter` / `reviewDue` / `appliesTo` / `staleAt` / `staleReason` / `reviewNote` / `retiredAt` / `retiredReason`）。
- `status` 只会是 `solid` / `trial` / `risky` / `new` / `blocked`。
- `runtime` 是召回时交给模型的运行时清单（`dir` / `skillFile` / `scripts[].run` / `references` / `usage`），控制台截到 12 条附件；mock 没有真实目录时为 `null`。
- `tree[]`：`{ id, path, name, kind: 'skill'|'group', depth, rootName, parentPath, skillCount, registeredCount, childCount, children }`。

### GET /usage?limit=<1..500>

按新→旧返回 `rows[]`：`at / tool / ok / op / intent / action / feedback / id / error / limit / routeScore / ids / chars / skill / reused / bodyHash`。`limit` 默认 100、上限 500。

### GET /pending

待判定队列，最多 5 条：`{ id, intent, action, verdict, registeredAt, brief, origin, kind, stepRewards }`。

### GET /usage-summary

调用次数与回执字符数汇总：`{ calls, chars, avgChars, byTool }`（部分数据源另给 `withChars`）。

### GET /graph

节点 `kind`：`root` / `family` / `experience` / `skill` / `suite`。边 `kind`：`root` / `family` / `label` / `suite` / `derived`。

返回 `{ notice, storeError, nodes, edges, total, truncated, byKind, summary, updatedAt }`：

- `family` 节点带 `family`（名）、`count`、`system`（「未分族」为 true）；id 统一 `family:` 前缀，名字里的 `%` / `:` / `/` 分别转义为 `%25` / `%3A` / `%2F`。
- `summary` = `{ families, experiences, skills, suites }`。
- 每个节点带 `degree`（本次 edges 里出现次数，按边计数）。
- 查询参数：`scope=summary` 只裁经验节点；`limit` 只在 summary 下生效（默认 300、夹在 1..1200），不带 `scope` 时全量、忽略 `limit`。
- `total` 是截断前可见经验数；`truncated` 表示经验节点是否被裁；被裁掉的 experience 不留下残边。读坏时 200 + `storeError`，节点/边为空但不 500。

### GET /validate

```json
{ "ok": true, "data": { "problems": [{ "slug": "ppt-export-pdf", "problems": ["SKILL.md 缺 frontmatter"] }] } }
```

### GET /settings

`{ source, dataDir, file, exists, bytes, updatedAt, storage?, currentRoot, version, config, ui, git, runtime, spec }`。

- `config` / `ui` / `git`：已保存的覆盖值（没存过的键不出现，界面显示默认）。
- `runtime`：`{ currentModel, currentTool, currentEnvironment, models, tools, environment }`，用于解释 `appliesTo`。
- `spec`：三组设置项字段说明 `{ config[], ui[], git[] }`，每项 `{ key, label, type, values?, labels?, hint?, tip?, default?, group? }`。

### GET /sync

Git 备份状态：

```json
{
  "available": true,
  "dataDir": "C:/Users/<用户>/WorkDeepSeek/.exp",
  "isRepo": true,
  "branch": "main",
  "remote": "https://github.com/<用户>/<仓库>.git",
  "dirtyCount": 0,
  "ahead": 0,
  "behind": 0,
  "lastCommitAt": "2026-11-09T16:00:00.000Z",
  "lastCommitSubject": "经验库备份 2026-11-09 16:00:00",
  "configured": true,
  "targetBranch": "main",
  "autoBackupMinutes": 0,
  "error": ""
}
```

### GET /classify-diag

自动分类能力自检：`{ mode, hasLlm, hasStream, hasRoute, provider, model }`。

### GET /shadow-report

标签影子判据只读报表（数据来自 `usage.shadow`）。仅 live；mock 返回 400 `unsupported`；失败 500 `report-failed`。

### GET /chat-save-probe

只读探测会话文件：`?mid=<messageId>`，返回可读性信息。不写盘。

### GET /pick-directory?probe=1

只回答「这个宿主能不能弹系统选目录窗口」，不弹：`{ available, kind, message }`。

### GET /icons

返回图标画廊 HTML（`text/html`），不是 JSON 信封；只用 GET。

## 5. 写入与动作接口

### POST /feedback

请求体：`{ "id": "ex_mock_01", "result": "helped" }`。`result` 只能是 `helped` / `hurt` / `neutral`。

语义：EMA（η=0.35）从 `GOutcome` 重放反馈日志得到新 `G`；不动 `hits`、不改 `outcome`。成功返回回执：

```json
{ "ok": true, "data": { "id": "ex_mock_01", "result": "helped", "G_before": 0.8, "G_after": 0.93, "changed": true, "outcome": "success", "typeName": "PPT / 课件", "feedback": { "helped": 3, "hurt": 0, "neutral": 0, "lastAt": "2026-11-09T08:00:00.000Z", "lastResult": "helped" }, "source": "feedback" } }
```

| 情况 | 返回 |
|---|---|
| 成功（live 写真实库，mock 写内存） | 200 |
| 该条已删除 / 被取代 / 退休 | 409 `not-feedbackable` |
| `result` 非法 | 400 `bad-result` |
| `id` 不存在 | 404 `not-found` |

### POST /recall

请求体：`{ intent, context?, limit? }`；`limit` 夹在 1..50，默认 8。透传高级参数：`all`、`cold`、`cluster`、`detail`、`mark`、`verdicts`、`includeMismatched`、`currentEnv`（未传的不覆盖内核默认值）。

返回 `{ mode, candidates, skill?, pendingSkills?, note? }`；live 走 `engine.recall`，mock 是简化召回。缺 `intent` → 400 `intent-required`。冷档查询用 `{ intent, cold: true }`，只读、不写盘。

### POST /record

请求体字段：`intent`（必填）、`action`（必填）、`outcome`、`typeName`、`typeDescription`、`family`、`force`、`context` / `labels`、`note`、`taskId`、`kind`、`stepIndex`、`stepTotal`、`failedStep`、`stepRewards`、`expectedOutcome` / `expectedG`、`skillId`、`blockedBy` / `blockedByList`、`origin`、`artifacts`、`dimensions`、`verdicts`、`cwd`、`volatility`、`appliesTo`、`reviewAfter`、`reviewNote`。

> 注意：分类参数叫 `typeName`（不叫 `type`——`type` 是 JSON Schema 关键字，宿主严格校验会误读）。

- `outcome` 允许 accepted / success / partial / unknown / failed / corrected / aborted。
- `stepRewards` 必须是数字数组；越界夹到 [-1,1]，非法值 400 `bad-request`。
- 回执由内核生成：`action` / `id` / `G` / `skill?`，另可能带 `tags` / `tagsRejected` / `tagWarning` / `signWarning`。
- **门槛拒记**：被记录门槛拦下时仍是 HTTP 200，但 `data` 是 `{ skipped: true, reason, suggestion }`，表示**没有落库**（不产生 id / hits / verdict / typeName）。界面按提示展示，不要当写入失败。模型确认误判时传 `force: true` 重试。
- 缺 `intent` / `action` → 400 `intent-required` / `action-required`；坏 `outcome` → 400 `bad-outcome`。

### POST /review

经验与技能同一入口：

```json
{ "action": "verify", "id": "ex_… 或 skill:<slug>", "note": "复核结论", "volatility": "semi", "reviewAfter": "2027-01-01T00:00:00.000Z", "appliesTo": { "models": [], "tools": [], "environment": "" }, "reason": "manual", "limit": 20 }
```

| action | 行为 |
|---|---|
| `due` | 只读：列出到期 / 待复核的经验（`rows`）与技能（`skills`）；`limit` 默认 20（≤50） |
| `verify` | 刷新 `lastVerifiedAt` / `reviewAfter`，清 `stale_*`；不改 G / outcome |
| `stale` | 标 `stale_at` + `stale_reason`；不删除、不退休 |
| `retire` | 标 `retired_at`（保留正文与历史，可 `revive`） |
| `revive` | 恢复 active，清 `stale_*` / `retired_*`；**必须带 `note`**，否则 400 `reason-required` |

- 成功回执：`{ action, id, lifecycle, volatility, freshness, lastVerifiedAt, reviewAfter, reviewDue, staleAt?, retiredAt? }`（技能为 `<slug>` + 同名字段）。
- 缺 id → 400 `id-required`；未知 action → 400 `bad-action`；已取代的经验 → 409 `not-feedbackable`；mock 同样支持（只改内存）。
- 只改时效字段，`G` / `outcome` / `GOutcome` / `feedback_log` 一律不动。

### POST /verdicts

请求体：`{ "verdicts": [{ "id": "ex_…", "outcome": "success" }] }`。逐条回执 `{ id, ok, outcome? , error? }`，不整批回滚。数据源不支持时 400 `verdict-failed`。

### POST /consolidate

请求体：`{ intent, context? }` → `{ action, slug?, derivedFromCount? }`。缺 `intent` → 400 `intent-required`；mock → 501 `unsupported`。

### POST /skills/import

请求体：

```json
{
  "path": "C:/…/SKILL.md 或文件夹",
  "content": "单条技能正文",
  "contents": [{ "text": "…", "suiteRoot": "套件名", "relPath": "子技能/SKILL.md" }],
  "suiteRoot": "…",
  "relPath": "…",
  "categories": ["…"],
  "notes": ["…"]
}
```

→ `{ suite, rootName?, count, items: [{ slug, id, path, name, category, tags, order, classifier, note, package? }] }`。

- `path` 指向文件夹时：根上只有 `SKILL.md` → 单条；根上有总入口 + 子目录技能，或子目录各带 `SKILL.md` → 按**技能套件**整棵导入（`suite: true`），子技能保留相对路径、不摊平。
- 根名默认取来源文件夹名；`skills` / `skill` 这类泛名取上一级，客户端可传改后的套件名。
- 每条技能都会走一次分类（临时模型会话或本地关键词），`classifier` 如实标 `session` 或 `local`。
- mock → 501 `unsupported`；没有数据目录 → 400 `no-data-dir`；无文件也无正文 → 400 `source-required`。

### POST /skill-feedback

请求体：`{ slug, result: helped|hurt|neutral }` → `{ id, result, G_before?, G_after? }`。缺 slug → 400 `slug-required`；坏 result → 400 `bad-result`。

### POST /skill-global

请求体：`{ slug, action: register|unregister }` → `{ slug, targetDir, mode, registered, action }`。

`slug` 也接受套件子技能的相对路径（`套件/子技能`）。`register` 把技能目录链接（优先 junction，建不了才复制）到 `$DSH_HOME/skills/<叶子名>/`，之后按普通 DSH 技能加载；注册后经验库不再排序 / 召回它。`unregister` 删链接并清记录。目标被占用时 400 `skill-global-failed`，绝不覆盖。mock → 400 `unsupported`；缺 slug → 400 `slug-required`；坏 action → 400 `bad-action`。

### POST /skill-node

请求体：`{ path, action: register|unregister|forget|detach, expect? }` → `{ action, path, total, ok, failed: [{ path, message }], results, deleted? }`。

- `path` 是相对 skillsRoot 的节点路径（组节点或技能节点都行）。
- `register` / `unregister` 对子树内所有技能逐个执行，失败项进 `failed`，不中断。
- `forget` 必须带 `expect` = 子树技能数；不匹配返回 400（列表过期，刷新再试）。先逐个取消注册，再删目录；节点是链接时拒绝删除。
- `detach` 仅子技能；移到顶层同名目录，重名 400，不覆盖。
- mock → 400 `unsupported`；缺 path → 400 `node-required`；坏 action → 400 `bad-action`；执行失败 → 400 `skill-node-failed`。

### POST /skill-meta

请求体：`{ slug, typeNames?: string[], notes?: string[] }` → `{ slug, typeName, typeNames, notes }`。mock → 400 `unsupported`；缺 slug → 400 `slug-required`；失败 → 400 `skill-meta-failed`。

### POST /skill-forget

请求体：`{ slug }` → `{ slug, deleted, unregistered }`。注册中的会先取消注册；删整个套件用 `/skill-node` 的 `forget`（带 `expect`）。mock → 400 `unsupported`；缺 slug → 400 `slug-required`；失败 → 400 `skill-forget-failed`。

### POST /type

请求体：`{ action: create|rename|merge|delete|assign, … }` → 类型管理回执。mock → 501 `unsupported`。

### POST /families/backfill

请求体：`{ "dryRun": true | false }`。

- **默认预演**：`dryRun` 缺省、`null` 或任何不等于 `false` 的值都按 `true` 处理；mock 也按预演处理。预演只基于当前页面级热档快照计算，**不写盘**。
- 只有显式传 `"dryRun": false` 且数据源是 live 时才写：整段在存储锁内执行，锁内用**无缓存**快照重读，按计划改完再一次性落盘（避免拿旧快照覆盖并发写入）。
- 回执：`{ dryRun, scanned, filled, changes: [{ id, from, to }], skipped }`。`dryRun: true` 时 `changes` 只是预览；`dryRun: false` 时回执与落盘基于同一快照。

### POST /families/manage

请求体：`{ action, … }`，`action` 必填：`list` / `create` / `rename` / `merge` / `assign` / `delete`。

- `list`：可带 `query`（按族名 + 族内方向标签模糊搜，返回 top-5）；不带则全量列 `{ families: [{ family, count }], total? , query? }`。
- `create`：`{ family }` → `{ family, created, materialized, note }`；已存在返回 `created: false`，不新建。
- `rename`：`{ family, newName }` → `{ action, target, sources, changed, merged }`；新旧规范化后相同是空操作。
- `merge`：`{ names: [], newName? }` → 同上；撞名自动合并并标 `merged: true`。
- `assign`：`{ family, ids? / sourceId? }` → `{ action, target, changed, droppedDirections }`；指派到新族时不属于该族的方向标签会被摘掉。
- `delete`：`{ family }` → `{ family, deleted, note }`；只能删空族，族里还有经验时失败。
- 缺 action → 400 `bad-request`。live 写路径在锁内无缓存重读后执行，空族登记与族操作同一把锁；mock 只在内存演一遍，回执带 `dryRun` 标记。
- 已知粗糙面：族名 / 动作校验失败时内核抛的是**普通 Error**（没有业务 `code`），外壳兜底按 500 `internal` 返回，具体原因在 `error.message`；这一条按当前实现记录，不是 400。

### POST /classify

请求体：`{ "id": "ex_…" }`。仅 live；mock → 400 `unsupported`。

1. 先读一次快照，记下目标行的 `typeId` 与规范化 `context` 作为冲突判据。
2. 模型分类（可能很慢）在**锁外**执行；宿主没有模型时退回本地关键词分类。
3. 返回后进存储锁，**无缓存重读**最新库：
   - 目标行不存在 → 404 `not-found`；
   - `typeId` 或规范化 `context` 与判据不同 → **409 `classify-conflict`**，放弃本次分类结果，不覆盖别人的新决定，可重试；
   - 其余字段 / 其他记录的并发更新不算冲突，在最新库上应用。
4. 没有可用主分类 → 400 `no-type`；首次快照读失败 → 500 `store-unreadable`。

成功回执：`{ id, typeName, tags, addedTags, classifier, note, model, tagWarning? }`。分类只补标签，不替用户凑面；补完仍缺对象 / 动作时给 `tagWarning`。

### POST /settings

请求体可带 `currentRoot` / `config` / `ui` / `git` 任意组合：

- `currentRoot`：切换存储位置并迁移数据；失败 → 409 `root-move-failed`。
- `config` / `ui` / `git`：按 `spec` 声明过的键写入；`null` 或空串等于「恢复默认」（删键），未声明的键不落盘、不误删。
- 保存后下一次请求即生效（无需重启）；成功返回 `{ action: "saved" }`。

### POST /sync

请求体：`{ action: "init" | "push" | "pull" | "status" | "disconnect", message?, force?, branch? }`。

- `init`：在数据目录 `git init` 并设置 `origin`（已存在则只更新 origin）。
- `push`：`git add -A -- .` → 有改动就 commit → `git push -u origin <branch>`；`force: true` 按设置的推送策略强推（覆盖前把旧远端 HEAD 存进 `refs/engram/overwritten/*`）。
- `pull`：`fetch` + `merge --ff-only`；分叉不自动合并，返回原因。
- `disconnect`：只清 `repoUrl`，本地提交历史与 GitHub 登录令牌保留。
- 失败不抛 500，用 `ok:false + reason` 表达；未知 action → 400 `bad-action`。

### POST /github

请求体：`{ action, token?, name?, private?, repoUrl?, message?, noOpen? }`。

- `device-start` → `{ userCode, verificationUri, expiresIn, interval, opened, copied }`：GitHub OAuth 设备码登录；`noOpen: true` 时不抢浏览器与剪贴板。
- `device-poll` → `{ status: pending | slow-down | authorized | expired | denied, interval?, user? }`；`authorized` 时 token 已写入设置，无需再传。节奏由宿主掌握，轮询过快只会得到 `pending` + `waitMs`。
- `device-cancel` → `{ status: "cancelled" }`。
- `login` → `{ ok, login, name, avatarUrl }`；`repos` → `{ ok, total, repos: [...] }`（owner + collaborator，最多 100）。
- `create` → 建空仓库（`auto_init: false`）、存地址、`git init` + 推送；`select` → 选中已有仓库，存地址后初始化并推送。
- `token` 可随请求临时传入，传了就写进设置的 `git.token`；之后无需再贴。
- 错误码：`bad-action`、`repo-required`（select 缺 repoUrl）、`github`（GitHub 返回错误 / 没 token / 仓库名校验）。

### POST /chat-save

请求体：`{ messageId, sessionId?, outcome?, type?, note?, debug? }` → `{ id, intent, action, outcome }`。

按 `messageId` 读 `$DSH_HOME/sessions/**/session-<id>/session.v4.jsonl.zstd`（只读），取该条助手回复作为「做法」、往前最近的用户输入作为「意图」，落一条 `outcome=unknown` 的经验。缺 `messageId` → 400 `ids-required`；会话里找不到 → 400 `turn-not-found`（`debug: true` 时回执附排查路径）。

### POST /graph-perf

请求体：性能样本（`nodes` / `edges` / `fps` / `p50` / `p95` / `frame` / `tier` / `size` / `phases` / `counts`）。只写本机 `~/.dsh/engram/graph-perf.jsonl`，不进经验库仓、不暴露到 UI；单文件 >256KB 时只保留最后 500 条。载荷不合法 → 400 `bad-perf`；写失败 → 500 `perf-log-failed`。

### POST /pick-directory

弹系统目录选择窗口（模态，等用户选完）。返回 `{ canceled, path, note }`：`canceled: true` 时 `path: null`；选中父目录时自动使用其中的 `.exp` 并给 `note`。宿主没有原生选择器 → 400 `picker-unavailable`。

## 6. 兼容承诺

- 字段**只增不删**；新增字段允许客户端忽略。
- 错误 `code` 只增不删；客户端遇到未知 `code` 按普通失败处理并显示。
- `/experiences` 的 `mode` 只会是 `list` / `advantage` / `evidence`。
- `/skills` 的 `status` 只会是 `solid` / `trial` / `risky` / `new` / `blocked`。
- 读写能力以本条路由的实际实现为准：同一个 `/exp-ui/api` 下既有只读查询，也有写真实库的动作；不再用 `readOnly` 统一代表 live。
