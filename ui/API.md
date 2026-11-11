# exp-ui 接口文档（v1）

> 外显名 **exp-ui**，是经验库的**界面外壳**，与真实经验库（`exp-lib` / `dsh-engram`）分开命名。
> 本包不带工具、不写真实数据：默认用内置示例数据把界面跑通；真实经验库接入时只换数据源，接口与返回形状不变。

- Base URL：`/exp-ui/api`（前缀路由，挂在 DSH 的 `webServer` 上）
- 编码：UTF-8 JSON，`content-type: application/json; charset=utf-8`，`cache-control: no-store`
- 版本：`0.4.0`（`package.json` 的 version，`/health` 与 `/state` 会回）

## 1. 数据源

| 数据源 | config | 行为 |
|---|---|---|
| `mock`（默认） | `source: mock` | 内置示例数据，进程内存；反馈只改这份假数据，**不落盘**、不碰真实经验库 |
| `live` | `source: live` + `dataDir: <路径>` | 只读真实库文件 `<dataDir>/exp-lib.json`；读不到/读坏按空库显示并给 `notice`；反馈返回 `read-only` |

两套数据源返回**完全相同的形状**，客户端不按数据源分支；只读 `data.source.readOnly` 决定反馈按钮是否可点。

`mock` 示例库：6 个类型、15 条经验（12 条可见 + 1 条退休 + 1 条被取代 + 1 条已删除），覆盖成功/部分/失败/被纠正/中止/未知、负回报、超长备注、任务步骤、有反馈/无反馈；另有 10 条示例调用日志、5 个示例固化技能（已固化 / 试用中 / 不稳定 / 待验证 / 有未解障碍各 1）。

## 2. 响应外壳（envelope）

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
| `bad-request` | 400 | 请求参数格式不对（JSON 解析失败等） |
| `id-required` | 400 | 缺少 `id` |
| `bad-result` | 400 | `result` 不是 `helped` / `hurt` / `neutral` |
| `body-too-large` | 400 | 请求体 > 1MB |
| `not-found` | 404 | 路由或经验不存在 |
| `method-not-allowed` | 405 | 路径存在但方法不对 |
| `read-only` | 409 | live 数据源拒绝写入（反馈） |
| `not-feedbackable` | 409 | 这条已删除/被取代/退休，不能反馈 |
| `internal` | 500 | 未预期异常（外壳兜底，不会把进程带崩） |

## 3. 接口

### `GET /health`

```json
{ "ok": true, "data": { "ok": true, "app": "exp-ui", "version": "0.4.0", "source": "mock", "readOnly": false } }
```

### `GET /state`

面板顶部用的概览。

字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `app` | string | 固定 `exp-ui` |
| `version` | string | 包版本 |
| `source` | object | `{ id: 'mock'\|'live', mode, label, readOnly }` |
| `source.label` | string | `示例数据` / `真实数据`（界面据此显示徽标） |
| `dataDir` / `file` | string | 数据目录 / 经验库文件；mock 时是 `（exp-ui 内置示例数据）` |
| `exists` | boolean | 数据文件是否存在 |
| `bytes` | number | 文件字节数（mock 为示例库序列化大小） |
| `updatedAt` | string | ISO 时间；mock 为进程启动时间 |
| `notice` | string | 需要界面显示的提示（mock 的「示例数据」说明、live 的读不到原因）；无则空串 |
| `totals` | object | `{ all, visible, deleted, superseded, retired, types, skills }` |
| `stats` | object | `{ totalInsights, deletedInsights, supersededInsights, retiredInsights, edgeCount, dbSizeBytes, byCategory, topEntities }` |
| `types` | array | 同 `/types` 的 `types` |
| `skillSummary` | object | `{ total, solid, trial, risky, new, blocked }`（固化技能状态分布） |
| `usage` | object | `{ total, today, byTool, lastAt, lastTool }` |

示例（mock，节选）：

```json
{
  "ok": true,
  "data": {
    "app": "exp-ui",
    "version": "0.4.0",
    "source": { "id": "mock", "mode": "mock", "label": "示例数据", "readOnly": false },
    "dataDir": "（exp-ui 内置示例数据）",
    "file": "",
    "exists": true,
    "bytes": 12345,
    "updatedAt": "2026-11-09T07:58:00.000Z",
    "notice": "当前是示例数据（exp-ui 内置）：可以放心点，反馈只改这份假数据，不会写入真实经验库。",
    "totals": { "all": 15, "visible": 12, "deleted": 1, "superseded": 1, "retired": 1, "types": 6, "skills": 5 },
    "skillSummary": { "total": 5, "solid": 1, "trial": 1, "risky": 1, "new": 1, "blocked": 1 },
    "usage": { "total": 10, "today": 10, "byTool": { "exp_recall": 4 }, "lastAt": "2026-11-09T07:56:00.000Z", "lastTool": "exp_recall" }
  }
}
```

### `GET /experiences`

查询参数（均可省略）：

| 参数 | 类型 | 说明 |
|---|---|---|
| `query` | string | 非空 → 检索态（`mode: advantage \| evidence`）；空 → 列表态 |
| `type` | string | 按 `typeId` 过滤（列表态） |
| `outcome` | string | 按结果过滤：success / partial / failed / corrected / aborted / unknown |
| `sort` | string | `recent`（默认）/ `g` / `hits` / `type` |
| `limit` | number | 列表态默认 100、上限 300；检索态默认 20、上限 50 |
| `offset` | number | 列表态分页偏移，默认 0 |

返回公共字段：`source`（同 `/state`）、`notice`、`mode`、`total`、`rows`、`counts`（仅列表态）、`note`（检索态说明）、`warning`（检索态，可能为 `null`）、`advantageSpread`、`neighborCount`。

列表态 `rows[]` 的行字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 经验 id |
| `intent` / `action` | string | 意图 / 做法 |
| `typeId` / `typeName` | string | 类型 |
| `outcome` | string | 结果 |
| `G` / `GOutcome` / `GSource` | number / number / string | 当前回报 / 基准回报 / `feedback` 或 `outcome` |
| `hits` | number | 用过次数 |
| `note` | string | 备注 |
| `origin` | string | manual / auto / external |
| `kind` / `taskId` / `stepIndex` / `stepTotal` | string / string / number\|null / number\|null | 任务与步骤 |
| `createdAt` / `lastSeenAt` | string | ISO 时间 |
| `feedback` | object\|null | `{ helped, hurt, neutral, window, lastAt, lastResult }` |
| `lifecycle` | object | `{ supersededBy, retiredAt, retiredReason, deletedAt }` |

检索态 `rows[]` 是「候选做法」分组：

| 字段 | 类型 | 说明 |
|---|---|---|
| `action` | string | 候选做法 |
| `typeName` | string | 类型 |
| `advantage` / `advantageNorm` | number | Â / 归一化 Â |
| `confidence` | number | 置信度 |
| `rankScore` | number | 排序分 |
| `support` | number | 证据条数 |
| `meanSimilarity` | number | 平均相似度 |
| `evidenceStrength` | number | `evidence` 模式下作为排序分 |
| `evidence[]` | array | `{ id, intent, action, outcome, G, similarity, typeName, note, feedback, lifecycle }` |

示例（检索态，节选）：

```json
{
  "ok": true,
  "data": {
    "source": { "id": "mock", "mode": "mock", "label": "示例数据", "readOnly": false },
    "mode": "evidence",
    "query": "把 PPT 转成 PDF",
    "total": 2,
    "note": "无成败对照（advantage 极差 0），Â 不具区分度；按「相似度 × 支持度 × 证据质量」排序。",
    "warning": null,
    "advantageSpread": 0,
    "neighborCount": 3,
    "rows": [
      {
        "action": "用 soffice 转 PDF 后逐页看字体与分页",
        "typeName": "PPT / 课件",
        "advantage": 0,
        "confidence": 0.3333,
        "rankScore": 0.09,
        "support": 1,
        "meanSimilarity": 0.31,
        "evidenceStrength": 0.09,
        "evidence": [
          { "id": "ex_mock_01", "intent": "把 PPT 导出成 PDF，检查字体和分页", "outcome": "success", "G": 1, "similarity": 0.31 }
        ]
      }
    ]
  }
}
```

### `GET /experience?id=<经验 id>`

返回 `{ row, history, feedbackLog }`：`row` 同列表行字段；`history` 是最多 20 条生命周期事件；`feedbackLog` 是最多 20 条反馈事件。

- 缺 `id` → 400 `id-required`
- 找不到 → 404 `not-found`

### `POST /feedback`

请求体：

```json
{ "id": "ex_mock_01", "result": "helped" }
```

`result` 只能是 `helped` / `hurt` / `neutral`。成功返回回执：

```json
{
  "ok": true,
  "data": {
    "id": "ex_mock_01",
    "result": "helped",
    "G_before": 0.8,
    "G_after": 0.93,
    "changed": true,
    "outcome": "success",
    "typeName": "PPT / 课件",
    "feedback": { "helped": 3, "hurt": 0, "neutral": 0, "lastAt": "2026-11-09T08:00:00.000Z", "lastResult": "helped" },
    "source": "feedback"
  }
}
```

语义：EMA（η=0.35）从 `GOutcome` 重放反馈日志后得到新 `G`；不动 `hits`、不改 `outcome`。

| 情况 | 返回 |
|---|---|
| mock 数据源 | 200，改内存里的假数据 |
| live 数据源 | 409 `read-only` |
| 该条已删除/被取代/退休 | 409 `not-feedbackable` |
| `result` 非法 | 400 `bad-result` |
| `id` 不存在 | 404 `not-found` |

### `GET /types`

```json
{ "ok": true, "data": { "types": [ { "id": "ty_ppt", "name": "PPT / 课件", "description": "…", "system": false, "count": 4 } ] } }
```

### `GET /skills`

固化技能列表。来源是 exp-lib 的 `exp_consolidate` 写出的 `.exp/skills/<slug>/`（`SKILL.md` + `skill.json`）；mock 模式给 5 条示例技能。

- `mock`：内置 5 条，覆盖已固化 / 试用中 / 不稳定 / 待验证 / 有未解障碍
- `live`：递归扫 `<dataDir>/skills/`；任何含 `SKILL.md` 的目录都是技能，中间目录是组节点。`id` 是相对路径（`套件/子技能`），顶层技能 id 与目录名相同；`skill.json` 读坏仍按 `SKILL.md` 出一条。
- 返回新增 `tree`：`[{ id, path, name, kind: 'skill'|'group', depth, rootName, parentPath, skillCount, registeredCount, childCount, children: [...] }]`。`skills` 行同时补 `path/depth/parentPath/rootName/childCount`。

```json
{
  "ok": true,
  "data": {
    "source": { "id": "mock", "mode": "mock", "label": "示例数据", "readOnly": false },
    "notice": "",
    "total": 5,
    "summary": { "total": 5, "solid": 1, "trial": 1, "risky": 1, "new": 1, "blocked": 1 },
    "skills": [
      {
        "id": "ppt-export-pdf",
        "name": "PPT 导出 PDF 前先查字体",
        "description": "导出前确认字体可用，导出后逐页看分页与图片跨页。",
        "body": "## 适用…\n## 做法…",
        "typeName": "PPT / 课件",
        "context": ["Windows / Office 2019", "课件交付"],
        "triggers": ["导出 PDF", "字体缺失"],
        "uses": 6,
        "helped": 5,
        "hurt": 1,
        "attempts": 6,
        "ratio": 0.8333,
        "confident": true,
        "status": "solid",
        "revisions": 2,
        "obstacleCount": 1,
        "openObstacleCount": 0,
        "resolvedCount": 3,
        "derivedFrom": ["ex_mock_01", "ex_mock_02", "ex_mock_12"],
        "pendingCommit": false,
        "lastUsedAt": "2026-11-09T08:25:00.000Z",
        "updatedAt": "2026-11-08T10:20:00.000Z",
        "path": "（示例）skills/ppt-export-pdf"
      }
    ]
  }
}
```

技能行字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` / `path` | string | 技能 slug（目录名）/ 技能目录 |
| `name` / `description` | string | `SKILL.md` frontmatter 的 name / description |
| `body` | string | `SKILL.md` 正文 |
| `typeName` | string | 所属类型 |
| `context` / `triggers` | string[] | 情境标签 / 触发词 |
| `uses` | number | 真实调用次数 |
| `helped` / `hurt` | number | 用后反馈计数 |
| `attempts` | number | `helped + hurt`（自信度分母） |
| `ratio` | number | 有帮助占比（0–1） |
| `confident` | boolean | 与 exp-lib `highConfidence` 同规则：`attempts ≥ 3 && ratio ≥ 0.8 && 无未解障碍` |
| `status` | string | `solid` 已固化 / `trial` 试用中 / `risky` 不稳定 / `new` 待验证 / `blocked` 有未解障碍 |
| `revisions` | number | 技能被覆盖修订的次数 |
| `obstacleCount` / `openObstacleCount` | number | 障碍签名数 / 连续 3 次复发的未解障碍数 |
| `resolvedCount` | number | 已内化条目数 |
| `derivedFrom` | string[] | 来源经验 id |
| `pendingCommit` | boolean | 上次 git 提交失败、待补提交 |
| `lastUsedAt` / `updatedAt` | string | ISO 时间（最近使用 / `SKILL.md` 修改时间） |

### `GET /usage?limit=<1..500>`

`rows[]`（新→旧）：

```json
{
  "at": "2026-11-09T07:56:00.000Z",
  "tool": "exp_recall",
  "ok": true,
  "op": "",
  "intent": "把 PPT 导出成 PDF",
  "action": "",
  "feedback": null,
  "id": "",
  "error": "",
  "limit": 4,
  "routeScore": 0.21,
  "ids": ["ex_mock_01", "ex_mock_02"]
}
```

## 4. 接入真实经验库（后续步骤）

1. 确认真实库文件：`<dataDir>/exp-lib.json`（`{ version, types[], experiences[] }`，与 `dsh-engram` 同结构）。
2. 把插件行 config 改为：

```yaml
    - id: exp-ui
      name: dsh-exp-ui
      config:
        source: live
        dataDir: C:/Users/<用户>/WorkDeepSeek/.exp
```

3. 重启 DSH，面板徽标会变成「真实数据」，标题旁出现「只读」。
4. 写入/反馈仍由正式经验库引擎负责；等引擎提供写接口后，再给 `live` 数据源补 `feedback()` 实现（接口形状已固定：`feedback(id, result) → 回执`，见 `/feedback` 一节）。

## 5. 兼容承诺

- 字段**只增不删**；新增字段允许客户端忽略。
- 错误 `code` 只增不删；客户端遇到未知 `code` 按普通失败处理并显示。
- `/experiences` 的 `mode` 只会是 `list` / `advantage` / `evidence`。
- `/skills` 的 `status` 只会是 `solid` / `trial` / `risky` / `new` / `blocked`。

## 6. 示例数据与真实数据的分界

- mock：`data.source.mode === 'mock'`，`notice` 以「当前是示例数据」开头；反馈写内存，进程重启即恢复。
- live：`data.source.mode === 'live'`，`readOnly === true`；读不到文件时 `exists === false` 且 `notice` 说明原因，界面显示空态而不是报错。
- 固化技能同样分界：mock 是内置 5 条；live 递归读 `<dataDir>/skills/`（含套件子目录），没有技能时返回空数组（界面空态）。


## 数据源默认值（0.6.0）

不传 `source` 时默认 `live`：读 `dataDir`（插件配置 / ENGRAM_DATA_DIR / settings.currentRoot / 默认 `$DSH_HOME/engram/data`）。只有显式 `source: "mock"` 才用内置示例数据（仅测试）。

`GET /experiences?query=...` 在 live 下走 `engine.recall`（返回 candidates/evidence），不再用界面里的简化排序。

## 控制台动作（0.5.0）

### `POST /recall`
body: `{ intent, context?: string[], limit?: 1..50 }`
→ `{ mode, candidates, skill?, pendingSkills?, note? }`（live 走 engine.recall；mock 是简化召回）

### `POST /record`
body: exp_record 的字段（intent/action/outcome/type/context/note/taskId/kind/stepIndex/stepTotal/expectedG/skillId/blockedBy/blockedByList）
→ `{ action, id, G, skill? }`；mock 只写内存示例库，live 走 engine.record

### `POST /consolidate`
body: `{ intent, context? }` → `{ action, slug?, derivedFromCount? }`；mock 返回 501 unsupported

### `POST /skill-feedback`
body: `{ slug, result: helped|hurt|neutral }` → `{ id, result, G_before?, G_after? }`

### `POST /skills/import`
body: `{ path?, content?, contents?: (string | { text, suiteRoot?, relPath? })[], suiteRoot?, relPath?, categories?: string[], notes?: string[] }` → `{ suite, rootName?, count, items: [{ slug, id, path, name, category, tags, order, classifier, note, package? }] }`

- `path` 指向文件夹时：根上只有 SKILL.md、没有子技能 → 单条；根上有总入口 + 子目录技能，或子目录各带 SKILL.md → 按**技能套件**整棵导入（`suite:true`）。整棵目录只复制一次到 `<dataDir>/skills/<根名>/`，子技能保留相对路径，**不再摊平**。
- `contents` 是浏览器通道：字符串按单条导入；`{text, suiteRoot, relPath}` 按 `suiteRoot/relPath` 还原目录层级。也接受顶层 `suiteRoot` + `relPath` + 单条 `content`。
- 根名默认取来源文件夹名；`skills`、`skill` 这类泛名取上一级，客户端可传改后的套件名。
- `categories` / `notes` 会写到每条导入技能的 `skill.json`（一个技能可挂多个分类、多条便签）。
- 套件导入时每个技能各走一次分类调用；`classifier` 如实标 `session` 或 `local`。
- 每条都会走一次分类（临时模型会话或本地关键词），套件是 N 次分类调用。

### `POST /skill-global`
body: `{ slug, action: register|unregister }` → `{ slug, targetDir, mode, registered }`

`slug` 也接受套件子技能的相对路径（`套件/子技能`）。`register`：把技能目录**链接**（优先 junction，建不了才复制）到 `$DSH_HOME/skills/<叶子名>/`，之后按普通 DSH 技能加载。
注册后**经验库不再排序/召回这个技能**（`listSkills({onlyLocal:true})` 会过滤掉它），避免两个引擎同时抢着用；`unregister` 删掉这条链接并清掉记录，技能回到经验库排序池。
目标已被别人占用时返回 400 `skill-global-failed`，绝不覆盖。错误码：`slug-required` / `bad-action` / `unsupported`。

### `POST /skill-node`
body: `{ path, action: register|unregister|forget|detach, expect? }` → `{ action, path, total, ok, failed: [{ path, message }], results, deleted? }`

- `path` 是相对 skillsRoot 的节点路径（组节点或技能节点都行，如 `ai-base-tools`、`动画/gestures`）。
- `register` / `unregister`：对**子树内所有技能**逐个执行，单项失败不中断，失败项进 `failed`；注册目标仍是 `$DSH_HOME/skills/<叶子名>`，被占用时该条失败、不覆盖。
- `forget`：必须带 `expect` = 子树技能数；不匹配返回 400（列表过期，刷新再试）。先逐个取消注册，再删节点目录；节点是链接时拒绝删除。
- `detach`：仅子技能；移到顶层同名目录，重名返回 400，不覆盖。
- 错误码：`node-required` / `bad-action` / `unsupported` / `skill-node-failed`。

### `POST /skill-meta`
body: `{ slug, typeNames?: string[], notes?: string[] }` → `{ slug, typeName, typeNames, notes }`：改技能的分类（可多个）与便签（可多条）。错误码：`slug-required` / `skill-meta-failed`。

### `POST /skill-forget`
body: `{ slug }` → `{ slug, deleted, unregistered }`：删除技能目录（注册着的会先取消注册）。`slug` 也接受套件子技能的相对路径；删整个套件请用 `/skill-node` 的 `forget`（带 `expect`）。错误码：`slug-required` / `skill-forget-failed`。

### `POST /type`
body: `{ action: create|rename|merge|delete|assign, ... }` → 类型管理结果；mock 返回 501 unsupported

### `GET /validate`
→ `{ problems: [{ slug, problems: string[] }] }`

### `GET /settings`
→ `{ source, dataDir, file, exists, bytes, updatedAt, currentRoot, version, config, ui, git, spec }`

- `config` / `ui` / `git`：已保存的覆盖值（没存过的键不出现，界面显示「默认」）。
- `spec`：三组设置项的字段说明 `{ config[], ui[], git[] }`，每项 `{ key, label, type, values?, labels?, hint?, tip? }`；
  `tip` 是给鼠标悬停提示框用的长说明（有歧义的项才有）。
- 设置项保存：`POST /settings` body 可带 `currentRoot` / `config` / `ui` / `git` 任意组合；传 `null` 或空串等于「恢复默认」（删键）。

### `POST /chat-save`
body: `{ messageId, sessionId?, outcome?, type?, note? }` → `{ id, intent, action, outcome }`

把会话里的一轮对话存成经验：按 `messageId` 读 `$DSH_HOME/sessions/**/session-<id>/session.v4.jsonl.zstd`（只读），取该条助手回复的正文作为「做法」、往前最近的用户输入作为「意图」，落一条 `outcome=unknown` 的经验（之后用 `exp_feedback` 回填）。只给 `messageId` 时会按最近修改的前 8 个会话反查。错误码：`ids-required`（缺 messageId）、`turn-not-found`（会话里找不到该消息 id）。

### 技能不写进 DSH skills 目录（边界）

`<dataDir>/skills/<路径>/` 只归经验库自己管（顶层技能是 `<slug>/`，套件子技能是 `<套件>/<子技能>/`）：**不**复制到 `$DSH_HOME/skills/`，也不交给宿主的技能管理插件当「已安装技能」。
召回时由 `exp_recall` 按需把技能正文作为结果返回——用到它的时候它才是技能，平时它只是经验库里的一份资产。
因此没有 `POST /skill-install`（已下线），工具的 `exp_consolidate` / `exp_skill_attach` 也不再有 `install` 参数。缺 slug 的报错码 `slug-required` 现在只由 `/skill-feedback` 使用。

> 技能可以带脚本：`<skill>/scripts/` 下的附件会登记在 `skill.json` 的 `files`，并在 `SKILL.md` 里维护「## 脚本」清单；用 `exp_consolidate` 的 `body`/`files` 或 `exp_skill_attach` 补齐。

### `GET /sync`
→ Git 备份状态：

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

### `POST /sync`
body: `{ action: "init" | "push" | "pull" | "status", message? }`

- `init`：在数据目录里 `git init` 并设置 `origin`（已存在则只更新 origin）。
- `push`：`git add -A -- .` → 有改动就 commit → `git push -u origin <branch>`。
- `pull`：`fetch` + `merge --ff-only`；有分叉不自动合并，返回原因。
- 返回 `{ ok, action, committed?, pushed?, commit?, reason? }`；失败不抛 500，用 `ok:false + reason` 表达。
- 错误码：`bad-action`（未知动作）。

### `POST /github`
body: `{ action: "login" | "repos" | "create" | "select" | "device-start" | "device-poll" | "device-cancel", token?, name?, private?, repoUrl?, message? }`

- `device-start` → `{ userCode, verificationUri, expiresIn, interval }`：GitHub OAuth 设备码登录（免 token），用户去 `verificationUri` 输入 `userCode` 授权。
- `device-poll` → `{ status: "pending" | "slow-down" | "authorized" | "expired" | "denied", interval?, user? }`；`authorized` 时 token 已写入设置，无需再传。
- `device-cancel` → 清掉服务端临时会话。
- `login` → `{ ok, login, name, avatarUrl }`（验证已保存/临时传入的 token）。
- `repos` → `{ ok, total, repos: [{ fullName, name, private, defaultBranch, cloneUrl, sshUrl, htmlUrl, updatedAt, description }] }`（owner + collaborator，按最近推送排序，最多 100）。
- `create` → `{ ok, action:"create", repo, init, sync }`：在 GitHub 建空仓库（`auto_init:false`），把 `repoUrl` 存进设置，然后 `git init` + 提交推送。
- `select` → `{ ok, action:"select", repoUrl, init, sync }`：选中已有仓库，保存地址后初始化并推送。

`token` 可以随请求临时传入（第一次登录时），传了就顺手写进设置的 `git.token`，之后不用再贴。
错误码：`bad-action`（未知动作）、`repo-required`（select 缺 repoUrl）、`github`（GitHub 返回的错误 / 没 token / 仓库名校验）。

> Git 备份配置在 `~/.dsh/engram/settings.json` 的 `git` 键：`repoUrl` / `branch` / `token` / `authorName` / `authorEmail` / `autoBackupMinutes`。
> `token` 只用于 https 的 `http.extraHeader`，不会写进仓库、也不会出现在错误信息里（已打码）。

### GET /graph&#10;→ { nodes, edges, summary, notice, updatedAt }。节点 kind：root/type/experience/skill；边 kind：root/type/derived。供「关系图」页渲染。

