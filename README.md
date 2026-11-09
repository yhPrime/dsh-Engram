# dsh-Engram（忆痕）

经验与技能引擎的独立仓库：**内核**（经验库 / JitRL 召回 / 技能沉淀 / 存储）与 **外壳 UI** 放在一起，DSH 只作为可选适配器。

## 结构

```
kernel/   内核（当前从 dsh-exp-lib-provider 0.31.9 复制）
          - store.js / kernel.js / retrieval.js / cluster.js / skills.js
          - tools.js（四个工具 + 经验沉淀）
          - index.js / plugin.js / provider.js（DSH 适配层，独立化后会瘦身）
ui/       外壳（当前从 dsh-exp-ui 0.3.0 复制，隔壁分支 dsh-d24c6004-09a4）
          - shell.js / client.js / data-source.js / live.js / mock.js
          - API.md / README.md / tests
```

## 从哪来

- `kernel/`：`C:\Users\yh\WorkDeepSeek\插件\dsh-exp-lib-provider`（master，0.31.9）
- `ui/`：`C:\Users\yh\WorkDeepSeek\插件\.agents\worktrees\dsh-d24c6004-09a4\dsh-exp-ui`（0.3.0）

两边都是**复制**，不是子模块；后续在这个仓库里按独立化计划推进（core/engine 子路径 → 适配器瘦身 → 独立分发）。

## 独立化计划

见旧仓库：`归档/过程/2026-11-09-engram-独立化-计划书.md`（下一步把该计划搬进本仓库 `docs/` 并按 M1–M4 执行）。

## 约定

- 数据仍在 `<root>/.exp`（经验库 JSON + `skills/` + `.git` + `.locks`）；
- 消费方（外壳/CLI）只经 engine 访问，不直接读写 `.exp`；
- 只 commit，不 push、不安装，除非明确要求。
