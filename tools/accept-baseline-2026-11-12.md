# P4 验收台架 · 基线（0.14.0 存储分片）

- 生成时间：2026-11-12T05:44:48.129Z
- 仓库：`C:\Users\yh\WorkDeepSeek\插件\dsh-Engram-dev` · 分支 `main` · HEAD `72ec744`
- 运行位置：**只读 pin** `C:\Users\yh\WorkDeepSeek\插件\dsh-Engram-dev\_tmp\accept-shard\pin-72ec744`（git archive 72ec744 的只读副本（主工作树此刻被另一会话的 P1 改动占用，基线从该提交的副本跑））
- 工作树（kernel/ui/tools）：干净
- `kernel/store.js` sha256：`b5748ca3e5429f2d31b7788d141e59ea624beb846a6d254ff46bfadb80507777`
- 运行环境：v24.22.0 · win32 x64 · 12 CPU
- 数据形态：**单文件存储**（exp-lib.json；分片层尚未落地）

## 1 结论

**通过 3 · 跳过 7 · 失败 0**（共 10 条，含回滚演练 R1）

当前阶段未落地分片，迁移/上界/守恒/局部性/冷档判据按计划标 SKIP；基线数字用于 P1/P2 后同一脚本自动对比。

## 2 基线耗时（真实库快照 + 平铺放大）

合成方法：1x = 真实库快照原样（`_tmp/fixtures/exp-lib-snapshot.json`）；4x/10x = 同分布平铺，字段原样、id/taskId 加后缀。每项 1 次预热 + 5 次取样，表中为「中位数 / 最小值」（毫秒，含 OS 文件缓存；不是冷启动）。

> 本机同时有另一会话/杀软在跑，绝对毫秒会漂移（同一脚本两次运行可差 2×）。判断性能回退看**最小值**的比值：中位数会放大外部干扰。

| 规模 | 记录数 | 可见 | exp-lib.json | readStore 中位/最小 | rankExperiences 中位/最小 | writeStore(改1条) 中位/最小 | 提示段冷 | 提示段暖 中位/最小 |
|---|---|---|---|---|---|---|---|---|
| 1x | 128 | 119 | 451.7 KB | 30.1 / 27.96 ms | 20.61 / 20.39 ms | 14.13 / 12.54 ms | 23.46 ms | 0.2 / 0.13 ms |
| 4x | 512 | 476 | 1.76 MB | 75.91 / 68.46 ms | 61.05 / 57.82 ms | 21.97 / 20.61 ms | 58.62 ms | 0.16 / 0.13 ms |
| 10x | 1280 | 1190 | 4.39 MB | 152.94 / 151.74 ms | 144.53 / 138.15 ms | 42.55 / 41.11 ms | 145.46 ms | 0.29 / 0.2 ms |

提示段冷/暖：冷 = 新目录首次渲染（模块缓存 miss，含一次 readStore）；暖 = 同目录再渲染（P0 缓存命中）。基目录不含 `skills/`，故不含技能目录扫描成本（P0 已单独缓存，与分片无关）。

## 3 验收判据（§8 的 9 条 + 回滚演练）

| # | 判据 | 状态 | 证据 / 说明 |
|---|---|---|---|
| J1 | 迁移等价 | ⏭ SKIP | 当前 commit 仍是单文件存储：readStore 读真实库副本后未生成 manifest.json，没有「迁移后」可比。P1 落地后同一判据自动生效；golden 逐字段哈希已入档（J-哈希）。 |
| J2 | 迁移幂等 | ⏭ SKIP | 当前是单文件存储，没有「第二次迁移」可测；P1 落地后自动生效。 |
| J3 | 单文件上界 | ⏭ SKIP | 当前是单文件存储（exp-lib.json），没有分片/冷档可断言；P1/P2 落地后自动按 3×N_MAX 数据检查「桶 ≤1 MB、冷档 ≤8 MB、数据文件 ≤54」。 |
| J4 | 压缩守恒 | ⏭ SKIP | 当前是单文件存储，压缩未实现；P1/P2 落地后检查 manifest 计数与分片实际行数一致、热+冷不丢「不应丢」的记录。 |
| J5 | 写入局部性 | ⏭ SKIP | 当前是单文件存储：写一条必然整文件重写（这正是要修的），判据不适用；P1/P2 落地后自动检查「只有该类型分片变化」。 |
| J6 | 提示段等价 | ⏭ SKIP | 单文件存储下新旧同源；golden 已录制（slim 179705ba10b7… / full a03755b1eda9…），P1 落地后与分片库渲染结果逐字符比对。 |
| J7 | Git 合并 | ✅ PASS | 不同文件各改一条：无冲突；同文件不同行（ty_code.0.jsonl 第 1/5 行）：无冲突；⚠ manifest.json updated_at 同行并发：冲突（manifest.json）——真实写路径必碰 manifest，P1 需决定去掉该字段或写入时保留旧值 |
| J8 | 回归 | ✅ PASS | 10 个测试文件逐文件全绿（96.4s，范围 core） |
| J9 | 冷档可查 | ⏭ SKIP | 当前是单文件存储，没有冷档；P2 落地并触发一次下沉后自动检查「字段完整 / 默认召回取不到 / 提示段不计入」。 |
| R1 | 回滚演练 | ✅ PASS | 恢复 legacy → 归档分片 → 校验读库 全通过（15.08 ms，4 步）；legacy 缺失分支正确中止且未改文件 |

## 4 库规模与类型分布（golden fixture）

- fixture：`C:\Users\yh\WorkDeepSeek\插件\dsh-Engram-dev\_tmp\fixtures\exp-lib-snapshot.json`（451.7 KB，sha256 `f3fdbf26e0097a328c030a07bd22c9588b9a8d1a824252db7113a722cd5b75d7`，沿用已有副本）
- 记录 128 条 / 可见 119 条 / 类型 14 个 / pending 0 条
- 下表按**全部 128 条**统计（含墓碑/被取代，分片要落盘的正是这些），单行 JSON 字节 ≈ 分片里的实际行宽

| 类型 | typeId | 条数 | 占比 | 单行 JSON 字节 |
|---|---|---|---|---|
| 代码 / 插件 | ty_code | 42 | 32.8% | 88.7 KB |
| 验收 / 判据 | ty_c47b3aa8 | 33 | 25.8% | 61.8 KB |
| 文档 / 教案 | ty_doc | 14 | 10.9% | 28.7 KB |
| 环境 / 部署 | ty_ops | 13 | 10.2% | 26.9 KB |
| 网络 / 心跳 | ty_b65a7bed | 11 | 8.6% | 22.2 KB |
| PPT / 课件 | ty_ppt | 9 | 7.0% | 25.1 KB |
| 上下文 / 运行时 | ty_e37ba9d1 | 2 | 1.6% | 3.9 KB |
| 标识 / 状态归属 | ty_254b19cb | 2 | 1.6% | 4.0 KB |
| 调研 / 资料 | ty_research | 1 | 0.8% | 3.1 KB |
| 未分类 | ty_other | 1 | 0.8% | 4.0 KB |

## 5 golden fixture 与逐字段哈希

- 哈希清单：`C:\Users\yh\WorkDeepSeek\插件\dsh-Engram-dev\_tmp\fixtures\exp-lib-snapshot.hashes.json`（sha256 与 fixture 字节一致）
- 全量记录哈希：`80832aabb25c70f827a74d4bf15bef4b372cdbe755d3f435100de5ca2cae26bc`
- 可见记录哈希：`f3ab97f0846669d111791417edd33ef781b1563c8d59f9494b1abf7c6d7721f8`
- 类型哈希：`ac6a8ab06d3f3bc1acaa4adba9939396d94bb6a2bd3226a98c775275228e6447`

| 字段 | sha256 |
|---|---|
| `id` | `e9c1f4e9efa892f8bb2d2d875bd922d139cc36270f3ea86e99ed885b31946a5c` |
| `ts` | `2186e28b5616ddc61f47183dcc91cd4a11d857167e5549b243f15492ec18cc3b` |
| `lastSeenAt` | `541d6338f2d7859da325d79a415e9b86fe0ea1766da6424351a3e5d4f79584d4` |
| `hits` | `ffc55326feff172956d29e93d37ff69e9f58378b6fb6240446b21a41c389e060` |
| `intent` | `ec54849be9f2368e2a45250a6e7e690fa2a8f1d052703e2baf4b291ef06a5c4d` |
| `action` | `5318f3d5261646fd13b7e2e8fd580470828991d5da3c70f060bb28e555477a54` |
| `state` | `a3997b78c9e735e7ec29c0b4fcf0193f810cb2a469e72948ece515bf6001c1cf` |
| `step_rewards` | `e2b5d40d400325a2923f302320c6c01ae39ace102b9b26cab218eda091358701` |
| `G` | `93a66dd5a9bcc962028c2babc117e714d0036d8aebf46adfbe272466124cc45e` |
| `GOutcome` | `bde1ea47f8d20cff4be6409a66c77005c0e0033f9d915ee80aadccea435b3fb7` |
| `outcome` | `b7b995fa99168a81badc5a911b47ab2172ae746d167c709e7fc389a8917c014f` |
| `note` | `c96d4cefba75b4a2e80aa3df606a6df300870aa39100b6076ca885bfd9ccd3d8` |
| `origin` | `ead711b4323037f6c188a1f6385161ef570e070cb454f55d5f2fe23e195be1e3` |
| `typeId` | `427f61e6f49dba32489aaf4f84103f3c2d3ed43837478d7dfa56f00a15ba02bc` |
| `typeName` | `83cd57cac70176297a2007f7bcb81b4bc0c53d806d026c99900dc4014d5f220c` |
| `typeSource` | `6f1c3a2b2be8e5494fcb0a3c48d2360c75b402f665d224340fe58711d3347fb6` |
| `deleted_at` | `828e286842ea9278e132514b55b789836786f97c8c5310b4c7f441f5c11c6f44` |
| `superseded_by` | `03ec8dee07a74edbcf6ca30c8027a52029124cb6b6a377e7c961add67dacdef7` |
| `retired_at` | `0d7fe7e810c17d311b9742abeb961363fde030822f0e249f6ef7d7b29e05f74b` |
| `supersedes` | `5ef1f28baccb27555b7389e3aa8cc204f174bbe8a1c75bf754f63202eb274f7c` |
| `feedback_log` | `a9d1d7055f18020f4eea9f58060ab30ad6597dce6496721d23f9d7363e802aca` |
| `feedback` | `cd2db665afbcd7ec1bcbaab2b05aad8cffceb831f4a5a7be26e9908556d6bd03` |
| `lastFeedbackAt` | `9080974e33d13b9167f851db175eb16aeed828b4c87425b4d9587b0e870c801b` |
| `context` | `6a7c1ea0b4d034843ebd3311c5810c972811eba9c07fc9cf14f8762ebfffea54` |
| `verdict` | `0d7fe7e810c17d311b9742abeb961363fde030822f0e249f6ef7d7b29e05f74b` |
| `verdictAt` | `0d7fe7e810c17d311b9742abeb961363fde030822f0e249f6ef7d7b29e05f74b` |
| `decidedBy` | `0d7fe7e810c17d311b9742abeb961363fde030822f0e249f6ef7d7b29e05f74b` |
| `pendingReminders` | `0d7fe7e810c17d311b9742abeb961363fde030822f0e249f6ef7d7b29e05f74b` |
| `dimensions` | `0d7fe7e810c17d311b9742abeb961363fde030822f0e249f6ef7d7b29e05f74b` |
| `taskId` | `67eb92efaf03bd18a8a98ba0f8516d6be4e918d7c3ba1b5d4b8e992f83ca8b3c` |
| `kind` | `df9bc1b5a16f4d60eeff9e0298e7d9a50e13a64df02db9cbcc742d1023ef03e6` |
| `stepIndex` | `90614c084a1680baa3fd5bc8821af5870d45e9a7b77a4dae1c910182180c4db3` |
| `stepTotal` | `fb3951b65a5768ddbe96655c1b56b3e0f81f3aac4e94ace66965415e6cfecdf3` |
| `failedStep` | `0d7fe7e810c17d311b9742abeb961363fde030822f0e249f6ef7d7b29e05f74b` |
| `expectedG` | `3ccb52b9c87ccc5d4945fb1c83b51281e94828ffe320004052e8b3c69da2511c` |
| `predictionError` | `3ccb52b9c87ccc5d4945fb1c83b51281e94828ffe320004052e8b3c69da2511c` |
| `history` | `58209c031b23f281e6b51a435a2b0705ea56da4da625551ee35ef7504f9e9a94` |

P1 迁移后，同一份数据的 `visibleExperiences` 逐字段哈希必须与上表一致（`kernel/tests/shard-accept.test.mjs` / 本脚本 J1 会断言）。

## 6 提示段 golden（J6）

- 期望文件：`C:\Users\yh\WorkDeepSeek\插件\dsh-Engram-dev\_tmp\fixtures\exp-lib-snapshot.expected.json`（沿用已有；数据集 sha256 `f3fdbf26e0097a328c030a07bd22c9588b9a8d1a824252db7113a722cd5b75d7`）
- slim(1400) sha256：`179705ba10b732c2d32036cb3e28c2006264270f5ab7d2f410875310fc67429c`
- full(4000) sha256：`a03755b1eda9679a4c2749973642e9600371c3a192099d6508ef02c211fd573a`

P1 之后，分片库渲染的提示段必须与 golden 逐字符相等（J6 自动比对）。

## 7 回滚演练

步骤与命令见 [tools/rollback-shard.md](./rollback-shard.md)。本次演练在 `_tmp` 副本上实际执行了：

1. 造「已迁移」形态（legacy + manifest + 18 个合成分片 + cold）；
2. 归档 `buckets/`、`cold/`、`manifest.json` → `rollback-archive-20261112/`；
3. `exp-lib.legacy.json` → `exp-lib.json`；
4. 校验恢复后的库可读、条数正确；
5. 另造一个没有 legacy 的目录，确认回滚会中止且不改任何文件。

结果：**PASS** · 恢复 legacy → 归档分片 → 校验读库 全通过（15.08 ms，4 步）；legacy 缺失分支正确中止且未改文件

注意：回滚 = **回到迁移时刻**。迁移之后新写/改的记录只在 `buckets/` 里，归档后不会自动并回旧库；要保留这部分数据，先导出（P2 后提供）或人工合并。`cold/` 里的下沉记录同理。

## 8 复现

```powershell
# 基线（单文件存储，今天就能跑）
node tools/accept-shard.mjs --out=tools/accept-baseline-2026-11-12.md

# P1/P2 落地后：同一脚本自动改跑真判据，并与本次基线对比
node tools/accept-shard.mjs --out=_tmp/accept-shard/p1-report.md

# 全量回归（逐文件，约 1-2 分钟）
node tools/accept-shard.mjs --regression=all --out=_tmp/accept-shard/regression.md
```

## 9 未验项 / 风险

- **单文件上界/压缩未实测**：当前单文件存储只证明基线；3×N_MAX 的桶/冷档上界要 P2 压缩落地后由 J3/J4 检验（本脚本已备好 heavy 数据路径）。
- **真机双设备并发**：J7 只在 `_tmp` 里造了合成分片布局验证「不同文件/不同行可自动合并」；真实 `.exp` 双设备冲突率仍未测。
- **manifest 的 Git 冲突风险（J7 观察项）**：若每次写都更新 `manifest.json` 的 `updated_at`，两台设备各写一条会在该行冲突（计划书 §4.2 保留该字段）。P1 需决定：去掉该字段、写入时保留旧值、或按设备/类型分文件。
- **回归结论受并发会话影响**：若另一会话正在改 `kernel/store.js`，J8 在运行时刻可能读到中间态；报告头部的「工作树」与 store.js sha256 是判定依据。
- **提示段耗时未设硬阈值**：§8.6 只记录不判红，避免环境抖动假红。

