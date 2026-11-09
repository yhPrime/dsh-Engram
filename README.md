# dsh-engram

Engram（记忆痕迹）：经验与技能引擎 + **经验库控制台**，一个标准 DSH 插件。

## 安装

```bash
npm pack
dsh plugin --profile <profile> add ./dsh-engram-0.7.1.tgz
```

重启 DSH 后：左侧栏出现「经验库」，控制台含概览 / 关系图 / 经验 / 检索 / 记录 / 技能 / 类型 / 使用记录 / 设置；工具面 `exp_record / exp_recall / exp_feedback / exp_consolidate / exp_type`。

## 配置

在 DSH 插件行或 `~/.dsh/engram/settings.json`：

- `dataDir` / `currentRoot`：经验库目录（含 `exp-lib.json`）
- `source`：`live`（默认）或 `mock`（仅演示）
- 内核参数：`hint`、`usageLog`、`feedbackEta`、`routing`、`maxTypes` 等，全部可在控制台「设置」页修改。

## 入口

| 文件 | 作用 |
|---|---|
| `plugin.js` | 工具面 + 每轮提示段 |
| `ui.js` | UI Host 半（/exp-ui/api） |
| `client.js` | 控制台客户端 |
| `engine.js` / `core.js` | 独立使用入口 |

## 许可

MIT，第三方声明见 `THIRD-PARTY-NOTICES.md`。
