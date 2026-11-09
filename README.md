# dsh-Engram（忆痕）

经验与技能引擎的独立仓库：**内核**（经验库 / JitRL 召回 / 技能沉淀 / 存储）与 **外壳 UI** 放在一起。**不再作为记忆插件的扩展安装**；DSH 插件只是其中一种安装形态。

## 结构

```
kernel/   内核（dsh-engram 0.32.0）
          - core.js   稳定 core 入口（kernel/retrieval/cluster/store/skills/tools）
          - engine.js createEngine({ dataDir }) 门面（独立宿主用这个）
          - store/kernel/retrieval/cluster/skills/tools
          - index.js / plugin.js / provider.js（DSH 适配层，只做注册/协议）
ui/       外壳（当前 dsh-exp-ui 0.4.0，已合并到主干，不再依赖隔壁分支）
          - shell.js / client.js / data-source.js / live.js / mock.js
          - API.md / README.md / tests
```

## 从哪来

- `kernel/`：`C:\Users\yh\WorkDeepSeek\插件\dsh-exp-lib-provider`（master，0.31.9）
- `ui/`：`dsh-exp-ui` 0.4.0（从隔壁分支 dsh-d24c6004-09a4 同步后并入主干；0.4.0 为视觉打磨：磨砂底、状态色边、提示可关）

两边都是**复制**，不是子模块；后续在这个仓库里按独立化计划推进（core/engine 子路径 → 适配器瘦身 → 独立分发）。

## 独立化计划

见本仓库 `docs/独立化-计划书.md`；按 M1–M4 执行。

## 独立使用（非 DSH）

```js
// 开发期（本仓库内）
import { createEngine } from './kernel/engine.js'

// 发布后（包名待定，先用子路径）
import { createEngine } from 'dsh-engram/engine'

const engine = createEngine({ dataDir: 'D:/proj/.exp' })
engine.record({ intent, action, outcome, type, context, expectedG, skillId, blockedBy })
engine.recall({ intent, context, limit })   // → { mode, candidates, skill?, pendingSkills? }
engine.feedback({ id: 'skill:<slug>', result: 'helped' })
engine.consolidate({ intent })
engine.listSkills()
engine.validate()
```

- 只要一个 `dataDir`，不需要 DSH 运行时、不注册 Provider；
- 所有读写都经 engine，不要直接改 `.exp` 文件；
- `core` 只含纯核心（零 DSH 依赖），`engine` 是门面；适配器入口 `index/plugin/provider` 依赖 DSH Provider SDK。

## 与记忆系统的关系

- 记忆方式抄记忆系统（settings + currentRoot + 独立数据根），但**不挂 Provider、不依赖记忆插件**；
- 数据位置由 `kernel/settings.js` 解析：config.dataDir → ENGRAM_DATA_DIR → settings.currentRoot → 默认目录；
- 记忆插件的空间/Provider 配置与本项目无关。

## 当前状态（0.33.0）

- 内核：M1–M4 完成，`core` 零 DSH 依赖，`engine` 可独立使用；包名 `dsh-engram`；
- 外壳：`ui/` 0.5.0「经验库控制台」——概览/经验/检索/记录/技能/类型/使用记录/设置，live 走 `createEngine`（记录/召回/反馈/沉淀/校验全接）；
- kernel 328 项 / ui 58 项测试全绿；audit 无 FAIL；eval 过 G1。

## 约定

- 数据仍在 `<root>/.exp`（经验库 JSON + `skills/` + `.git` + `.locks`）；
- 消费方（外壳/CLI）只经 engine 访问，不直接读写 `.exp`；
- 只 commit，不 push、不安装，除非明确要求。


