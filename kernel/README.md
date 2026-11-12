# dsh-engram

独立的经验 / 技能引擎 + DSH 插件。**不再作为记忆插件的 Provider 扩展**：数据位置、设置、读写都归自己管；记忆系统的做法（settings + currentRoot）直接抄过来，但不是它的子模块。

## 结构

```
core.js     纯核心导出（kernel/retrieval/cluster/store/skills/tools），零 DSH 依赖
engine.js   createEngine({ dataDir })：record/recall/feedback/consolidate/listSkills/validate/snapshot/hint
settings.js 自己的数据位置：$DSH_HOME/engram/settings.json（currentRoot）+ 环境变量/默认目录
tools.js    五个工具：exp_record / exp_recall / exp_feedback / exp_consolidate / exp_type
skills.js   技能沉淀（SKILL.md + skill.json，.exp/skills 独立 git）
plugin.js   DSH 插件入口：注册工具 + 每轮提示段
index.js    库入口：只导出 engine/tools/settings，不含 Provider
```

## 安装（DSH 插件形态）

```bash
npm pack
dsh plugin --profile <profile> add ./dist/dsh-engram-<版本>.tgz
# 在插件管理里启用 dsh-engram（cordis.patch.yml 会挂上 plugin.js）
```

- 只注册工具面与提示段；不挂记忆 Provider、不写记忆插件的配置；
- 数据目录默认 `$DSH_HOME/engram/data`，可用插件配置 `dataDir`、环境变量 `ENGRAM_DATA_DIR`、或 `settings.json` 的 `currentRoot` 覆盖。

## 独立使用（非 DSH）

```js
import { createEngine } from 'dsh-engram/engine'

const engine = createEngine({ dataDir: 'D:/proj/.exp' })
engine.record({ intent, action, outcome, type, context, expectedG, skillId, blockedBy })
engine.recall({ intent, context, limit })      // → { mode, candidates, skill?, pendingSkills? }
engine.feedback({ id: 'skill:<slug>', result: 'helped' })
engine.consolidate({ intent })
engine.listSkills()
engine.validate()
engine.snapshot()                              // { store, file, exists, bytes, updatedAt, corrupt? }
```

不需要 DSH 运行时；外壳（`../ui`）就是这么接的。

## 数据位置（优先级）

1. `config.dataDir`（插件行配置）
2. `ENGRAM_DATA_DIR` 环境变量
3. `$DSH_HOME/engram/settings.json` 的 `currentRoot`
4. 默认 `$DSH_HOME/engram/data`

`setCurrentRoot(root)` 可以记住当前数据根，换机器不用改插件配置。

## 数据格式

```
<dataDir>/
  exp-lib.json          经验库（版本、类型、经验条目）
  skills/<slug>/        SKILL.md + skill.json（技能，.exp 根独立 git）
  .locks/               并发锁（不进提交）
  usage.jsonl           工具调用审计
```

## 工具

- `exp_record`：记做法与结果（支持任务/步骤、预期、情境、技能关联、障碍）
- `exp_recall`：按意图召回（簇路由 + JitRL；高确定技能只返回技能）
- `exp_feedback`：用后反馈（经验 id 或 `skill:<slug>`）
- `exp_consolidate`：同族 ≥3 且正负对照 → 沉淀技能
- `exp_type`：类型管理

## 测试

```bash
npm test          # kernel 全套（core 边界 / engine headless / 工具 / 技能 / 生命周期 …）
node tools/audit.mjs
node tools/eval-routing.mjs
```

## 版本

- 0.32.0：从 `dsh-exp-lib-provider` 改名 `dsh-engram`；
- 0.33.0：**去 Provider**——删除 `provider.js`、index 不再导出 Provider；新增 `settings.js`（currentRoot/ENGRAM_DATA_DIR）；工具/插件/审计统一自有数据根；
- 旧数据（`.exp/exp-lib.json` + `skills/`）直接可读，不需要迁移。

