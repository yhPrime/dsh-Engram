# dsh-engram

Engram（记忆痕迹）：经验与技能引擎 + **经验库控制台**，一个标准 DSH 插件。

## 安装

```bash
npm pack
dsh plugin --profile <profile> add ./dsh-engram-0.11.0.tgz
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

## 许可

MIT，第三方声明见 `THIRD-PARTY-NOTICES.md`。
