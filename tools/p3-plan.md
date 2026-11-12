# P3 施工清单：读路径下推 + 外围适配（engine / tools / ui）

- 编写：2026-11-12（接受 task-4 前的前置设计；P1 由 storage-core 在写，尚未提交）
- 依据：计划书 §4.7 / §8.6、`tools/accept-baseline-2026-11-12.md`、`tools/cold-budget.md`
- 范围：只改 `kernel/engine.js`、`kernel/tools.js`、`ui/`（+ 新增 `kernel/tests/engine-manifest.test.mjs`）。**不碰** `store.js` / `shard-store.js` / `skills.js`（storage-core 范围）。
- 读取基线：`store.js`（P1 工作副本）已有 `readManifest`（带自愈）、`readStore`（聚合全部分片）、`writeStore`（全量重写，P2 才增量）；`shard-store.js` 已有 `readManifestFile` / `readShardRecords`（**全部分片**）/ `scanShards` / `storageBytes` / `storageFileCount` / `storageSignature`。

## 0 一句话结论

P3 的读收益只能来自「**按类型读分片**」＋「**/state 不再加载全量经验**」两处；但 `exp_recall` 默认带 `recent`（跨类型、按会话）且若干写回路径需要全量，**在补齐 §2 的 5 个 API 之前不能动 `tools.js` 的召回/写入**，否则要么行为不等价，要么把其它类型从盘上写丢。`engine.snapshot()` 现在读 `exp-lib.json`，P1 迁移后必然报 `exists:false`——这是 P1 落地后立刻会红的点，P3 第一件事就是修它。

## 1 逐点清单

### 1.1 kernel/engine.js

| # | 位置 | 现在怎么取数 | P3 改成什么 | 影响的既有测试 |
|---|---|---|---|---|
| E1 | `createEngine().snapshot()`（当前读 `storeFile(dataDir)` 的 stat + `readStore`） | 只认 `exp-lib.json`；迁移后文件被改名成 `exp-lib.legacy.json` → `exists:false / bytes:0 / updatedAt:''`，但 `readStore()` 仍能读到分片（**P1 落地后即红**） | `readManifest(dataDir)` + `storageUsage(dataDir)`；返回 `{ dataDir, file: manifest 路径, exists: manifest 存在, bytes: totalBytes, updatedAt: 最新 mtime, corrupt, parseError, manifest, storage }`；**不再默认返回 `store`**，需要行的页走 E2 | `ui/tests/live.test.mjs`（断言 `read.store.experiences`）；`ui/tests/contract.test.mjs`（/state 字段） |
| E2 | 新增 `createEngine().readHot()`（页面级） | 无 | `readStore(dataDir)` 一次（全量**热档**，不读冷档），供 `/experiences` 列表、`/experience` 详情、`/graph` 使用；页面级、可加 1–2s TTL | 新增 `engine-manifest.test.mjs`；`ui/tests/live.test.mjs` 改造 |
| E3 | `pending()` / `resolveVerdicts()` / `drainPending()` | 每次 `readStore` 全量 | 可先维持全量（`/pending` 是页面级）；若要用 `manifest.pending`：它只有 `{id,typeId,intent}`，`pendingBrief/pendingRows` 还要 `action/registeredAt/sessionId/pendingReminders` → 见 §2 缺口 G2/G4 | `kernel/tests/pending.test.mjs`、`verdicts.test.mjs`、`ui/tests/pending-api.test.mjs` |
| E4 | `hint()` | `renderHint`（store.js 范围，P0 缓存） | **不动**（跨范围）。若日后要「提示段只读 manifest」，由 storage-core 改 `store.js` | `hint-cache.test.mjs`、`hint-budget.test.mjs` |

### 1.2 kernel/tools.js

| # | 位置 | 现在怎么取数 | P3 改成什么 | 影响的既有测试 |
|---|---|---|---|---|
| T1 | `exp_recall`（`execute` 312–500） | `readStore` 全量 → `rankExperiences(store,…)` → `pendingTasks(store)` → 可能 `writeStore(store)` | 先 `readManifest` → `routeCluster({types,clusters}, intent)`（只依赖 `store.clusters`，可用 manifest）→ 命中且非 fallback 时只读 `{主簇, 次簇(≥0.7×主), ty_other}` 的分片拼 partial store → 传同一 `rankExperiences`；`merged<3` 或 `route fallback` / `args.all` / `routing=off` / 无 manifest 时回退 `readStore` 全量 | `tools.test.mjs`、`recall.test.mjs`、`session-isolation.test.mjs`（recent）、`skill-empty-weak.test.mjs`（recent）、`ui/tests/contract.test.mjs`（/experiences?query） |
| T1a | `rankExperiences` 的 `recent`（store.js 1943–1967） | 用**全量** `visibleExperiences(store)`（不是收窄后的 pool）按 sessionId 取最近 2 条 | **等价性硬约束**：partial store 只有命中类型，`recent` 会漏其它类型。必须先解决 §2 缺口 G5（recent 索引）或「recent 时回退全量」；不能改成「同类型 recent」 | `session-isolation.test.mjs` 187/270/338、`skill-empty-weak.test.mjs` 60 |
| T2 | `exp_record`（104–300） | `readStore` 全量 → `upsertExperience` → `writeStore` | 仅当**类型已确定**（显式 `typeName` 或 `routeCluster` 命中）时：读目标类型分片 + `ty_other` → `upsertExperience(partial)` → 定向写（§2 G4）；`typeName` 为空且路由 fallback 时回退全量（`upsertExperience` 有跨类型 `owner` 继承：`store.experiences.find(action 相同 && 相似度≥mergeThreshold && typeId≠ty_other)`，见 store.js `if (!hasExplicitType)` 段——**不能只读目标类型**） | `tools.test.mjs`、`pending.test.mjs`、`verdicts.test.mjs`、`session-isolation.test.mjs`、`type-tool.test.mjs` |
| T3 | `exp_feedback`（503–563） | `readStore` 全量 → `applyFeedback` → `writeStore` | **P3 保持全量**：id 定位没有索引（见 §4-3）；且回执 `count: active.length`、`feedbackCovered` 需要全量可见行。等 storage-core 决定是否建 id→type 索引 | `feedback*.test.mjs`、`tools.test.mjs`、`ui/tests/contract.test.mjs`（/feedback） |
| T4 | `exp_type`（658–705） | `readStore` 全量 → `listTypes/createType/renameType/mergeTypes/deleteType/assignType` → `writeStore` | `list/create/rename`：只读 manifest（`types` + `clusters.stats.count`）；`merge/delete`：读涉及的源/目标类型分片 + 定向写；`assign`：id→type 无索引，保持全量 | `type-tool.test.mjs`、`tools.test.mjs` |
| T5 | `exp_consolidate`（565–615） | `readStore` 全量 + `rankExperiences` | **保持全量**（低频、要同族全部样本；收益小、风险大） | `consolidation.test.mjs`、`induction*.test.mjs` |
| T6 | `exp_skill_attach` | 只读技能目录 | 不动 | `skill-attach*.test.mjs` |

### 1.3 ui/

| # | 位置 | 现在怎么取数 | P3 改成什么 | 影响的既有测试 |
|---|---|---|---|---|
| U1 | `ui/live.js` `read()`（211–250）、`file`（202） | `engine.snapshot()` 返回全量 `store`；`file = <dataDir>/exp-lib.json` | `read()` 返回 `{manifest, storage, dataDir, file: manifest.json, exists, bytes: totalBytes, updatedAt, notice}`；另加 `hot()`（调 engine.readHot）给需要行的页 | `ui/tests/live.test.mjs` 34–70（断言 read.exists/read.store） |
| U2 | `ui/shell.js` `buildState`（248–282，`/state`） | `read.store` 全量 → `statsOf(store)` | 只用 `manifest` + `storage`：`totals.visible`=Σ`clusters[].stats.count`、`totals.all`=Σ`buckets[].count`、`types`=`manifest.types`+cluster 计数、`stats.byCategory`=cluster 名/计数、`stats.dbSizeBytes`=`storage.totalBytes`；`topEntities/deleted/superseded/retired` 见 §2 G6 | `ui/tests/contract.test.mjs` 74–90 |
| U3 | `buildExperiences`（284–302，`/experiences`） | 非检索态 `listOf(store)` 全量排序+分页；检索态走 `source.recall` | 检索态不变（已由 T1 优化）；非检索态 **页面级** `readHot()` 后排序分页（`sort=recent/g/hits/type` 是全局序，**不能按分片分页**） | `ui/tests/contract.test.mjs` 93–130、`pages-smoke.test.mjs`（经验页 null rows） |
| U4 | `buildExperience`（304–309，`/experience`） | `detailOf(store)` 全量 | 页面级 `readHot()` 查找；冷档记录先不支持详情（或 §2 G3 落地后按 `cold` 查） | `ui/tests/contract.test.mjs` |
| U5 | `buildPending`（316–319，`/pending`） | `source.pending` → engine 全量 | 保持全量（页面级）；或用 `manifest.pending` + §2 G2/G4 | `pending-api.test.mjs`、`contract.test.mjs` |
| U6 | `buildGraph`（493+，`/graph`） | `read.store` 全量可见行 | **保持全量热档**（页面级；冷档按 §4.5 不进关系图）；不按类型分页 | `ui/tests/contract.test.mjs`、graph 相关渲染测试 |
| U7 | `buildSettings`（477–490，`/settings`） | `read.file/bytes/exists/updatedAt` | 同 E1 的 storage；显示 `manifest.json` + 分片 + 冷档 + legacy 标记 | `ui/tests/contract.test.mjs`（/settings） |
| U8 | `ui/data-source.js` `statsOf/listOf/detailOf` | 接收 store | 新增 `statsOfManifest(manifest, storage)`；`listOf` 改为接收行数组（mock/live 共用）；mock 路径不动 | `ui/tests/render.test.mjs`、`mock.test.mjs` |
| U9 | 冷档页 | 无 | 新增 `/cold`（GET 分页列出 cold 记录）+ `/cold/recall`（POST 按意图检索）；**`client.js` 在仓库根目录、不在 task-4 写范围** → 需要 Lead 扩范围或另派 | 新增 ui 测试；`render.test.mjs`/`pages-smoke.test.mjs` 的 tab 列表 |

## 2 所需 API 对账（截至 P1 工作副本）

### 2.1 已有、P3 可直接用

| API | 出处 | 用途 |
|---|---|---|
| `readManifest(dataDir)`（带自愈，可能写 manifest） | store.js | 提示段/路由/条数/类型/簇签名 |
| `readManifestFile(dataDir)` | shard-store.js | 只读 manifest（不自愈） |
| `readShardRecords(dataDir, manifest)` | shard-store.js | **全部**热档记录（P3 回退路径、页面级） |
| `scanShards(dataDir)` | shard-store.js | 重建 manifest（P3 不用） |
| `storageBytes / storageFileCount / storageSignature` | shard-store.js | 总字节/文件数/缓存指纹 |
| `shardBucketIndex(id,k)` / `shardRelPath(typeId,index)` | shard-store.js | 单条定位到分片文件名（需要已知 typeId） |
| `routeCluster(store,intent)` | cluster.js | 只需 `store.clusters`（manifest 足够） |

### 2.2 缺口（P3 需要、现在没有）

> 汇总给 storage-core（我不改它的文件）。格式：缺什么 / 谁需要 / 建议签名。

**G1 按类型读分片**
- 缺什么：只读指定类型分片的读取器（`readShardRecords` 只能全读）。
- 谁需要：`exp_recall` 主路径、`exp_record`、`exp_type merge/delete`、`engine.pending`。
- 建议签名：`readShardRecordsOfTypes(dataDir, manifest, typeIds: string[]) → { records: object[], files: string[] }`（沿用缺文件/坏行即抛错的守卫；`typeIds` 含 `ty_other` 时一并读）。

**G2 按 {id,typeId} 读指定记录**
- 缺什么：按 id 列表 + 已知 typeId 只读对应分片并过滤。
- 谁需要：`exp_recall` 的 `pendingTasks/verdicts`（`manifest.pending` 有 id+typeId）、`exp_record` 的 pending 回填。
- 建议签名：`readRecordsByIds(dataDir, manifest, refs: Array<{id:string,typeId:string}>) → object[]`。

**G3 冷档读取**
- 缺什么：冷档记录读取（现在只有 `scanShards().cold` 的计数，没有读行 API，也没有通过 manifest 的路径）。
- 谁需要：`exp_recall({cold:true})`、控制台冷档页。
- 建议签名：`readColdRecords(dataDir, manifest, options?: {years?: number[]}) → object[]`（按 `manifest.cold.years[].file` 顺序；坏行抛错）。

**G4 按类型定向写（P3 的关键）**
- 缺什么：只重写指定类型的桶 + 合并 manifest，其它类型文件一字节不动。
- 为什么不能凑合：P1 的 `writeStore` 是**全量重写**；把 partial store 传进去会把未读到的类型当成「空」删掉（数据丢失）。P2 的增量写按「整个 store 的指纹 diff」做，也无法接受 partial store。
- 谁需要：`exp_recall`（mark/verdicts/pending 写回）、`exp_record`、`exp_type merge/delete`。
- 建议签名：`writeTypeShards(dataDir, manifest, input: { types?: object[], clusters?: object[], rowsByType: Record<string, object[]>, touchedTypeIds: string[] }) → manifest`（只替换 `touchedTypeIds` 的桶；manifest 的 `buckets[]` 其它项原样沿用；`pending`/`clusters` 允许传入已更新的值；仍先写数据后写 manifest）。

**G5 `recent` 的跨类型索引（或确认回退）**
- 缺什么：`recent` 需要「本会话最近 2 条」但可能落在任意类型；partial 读拿不到。
- 谁需要：`exp_recall`（默认 `recent: true`）。
- 建议签名（二选一）：
  - 扩展 manifest：`manifest.recent = [{ sessionId, rows: [{id, typeId, lastSeenAt}] }]`（每会话 ≤5 条、总 ≤100 条，写入时维护）→ P3 用 G2 读取；
  - 或明确「P3 命中路由时若 `recent` 开启则放弃下推、走全量」，接受这次不省读。
- 决策点：这是 P3 收益的开关（默认路径带 recent）。

**G6 manifest 统计（/state 需要）**
- 缺什么：`deleted/superseded/retired` 计数、`topEntities`（对全部 intent 分词计数）不在 manifest；`buildState` 的契约字段又不能删。
- 谁需要：`engine.snapshot` / `ui buildState`。
- 建议签名：`buildManifest` 增加 `stats: { all, visible, deleted, superseded, retired, byType: {...}, topEntities: [{entity,count}] }`（体积估算：≤2–3 KB，`MANIFEST_MAX_BYTES` 余量足够；topEntities 取写入时现成的 8 条）；或 P3 把 `/state` 这几格标「—」（需产品确认）。

**G7 storage 明细（/state 与设置页）**
- 缺什么：`storageBytes` 只给总和且**不含 legacy**；没有分项（manifest/桶/冷档/legacy/文件数/最新 mtime）。/state 要「manifest 字节 + 分片总字节 + 冷档字节 + legacy 存在标记」。
- 谁需要：`engine.snapshot`、`ui buildState/buildSettings`。
- 建议签名：`storageUsage(dataDir) → { manifestBytes, bucketBytes, bucketFiles, coldBytes, coldFiles, legacy: {exists, bytes}, fileCount, totalBytes, updatedAt }`。

**G8 manifest 读缓存（可选，非阻塞）**
- 缺什么：`readManifest` 每次解析 manifest（≤128 KB）+ `shardsMismatch`（每个桶一次 stat）。单次约 0.3–1 ms，提示段/召回每轮都调，可接受但不理想。
- 谁需要：`exp_recall` / `engine.snapshot`。
- 建议签名：`readManifestCached(dataDir, {ttlMs=10000})`（键 mtime+size+文件数；写后主动失效）。可延到 P3 之后。

## 3 不能做的事（语义红线）

1. **不能把 partial store 交给 `writeStore`**。P1 `writeStore` 全量重写全部分片；partial store 会让其它类型的记录从盘上消失。必须先有 G4。
2. **不能只读 1–2 个分片就跑 `rankExperiences` 并声称等价**：`recent` 用全量可见行（store.js 1943），`merged<3` 时 pool 会退回全量。等价条件：命中类型 + `ty_other` + 次簇（≥0.7×主簇）三类齐全；`merged<3`、route fallback、`args.all`、`routing=off`、无 manifest 一律回退全量。
3. **不能按 id 只读一片**：没有 id→type 索引（计划书 §4.2 明确不建全局逐条索引；6000 条 id→type 约 170 KB，超 manifest 128 KB，需要单独文件——别在 P3 私自加）。`exp_feedback`、`exp_type assign`、`/experience` 详情在 P3 保持全量热档读（≤12 MB）。
4. **关系图/全量检索必须全量**：`buildGraph`、`/experiences` 的全局排序分页要看全部可见热档；不能按类型分页（会改变排序/漏条）。冷档按 §4.5 不进关系图/簇统计/提示段。
5. **`renderHint`（store.js）不在 P3 范围**：仍是 `readStoreForHint` 全量 + P0 缓存；「提示段只读 manifest」要 storage-core 改 store.js，别在本任务里越界。
6. **不能改 `readStore()` 的对外语义**：它必须继续返回聚合后的全量热档 `{version,types,experiences,clusters}`，所有既有调用方（含 `exp_feedback`/`exp_consolidate`/graph）依赖它。P3 只能新增「按类型」读路径，不能把 readStore 改成只返回部分。
7. **不能把 manifest 当事实源对外返回记录**：manifest 是缓存（D1），记录只能来自 `buckets/`；缺文件/坏行仍要抛错，不能静默空库。
8. **`/state` 字段契约不能删**：`ui/tests/contract.test.mjs` 断言 `app/version/source/dataDir/file/exists/bytes/updatedAt/notice/totals/stats/types/usage` 等键；可以改取值来源，不能拿掉键（G6 未落地时用 0/「—」占位并在 `notice` 说明）。

## 4 测试影响清单（改之前先跑，改之后逐文件跑）

必跑（P3 直接相关）：
`kernel/tests/tools.test.mjs`、`recall.test.mjs`、`session-isolation.test.mjs`、`skill-empty-weak.test.mjs`、`pending.test.mjs`、`verdicts.test.mjs`、`type-tool.test.mjs`、`feedback.test.mjs`、`feedback-ledger.test.mjs`、`engine-headless.test.mjs`、`cluster.test.mjs`、`store.test.mjs`、`store-safety.test.mjs`、`hint-cache.test.mjs`、`plugin.test.mjs`；
`ui/tests/live.test.mjs`、`contract.test.mjs`、`render.test.mjs`、`pages-smoke.test.mjs`、`pending-api.test.mjs`、`mock.test.mjs`。

必须新增：
1. `kernel/tests/engine-manifest.test.mjs`（task-4 验收）：
   - `snapshot()` 在「已迁移」目录上返回 `exists:true`、`bytes` 分项正确、`legacy` 标记正确；**不调用 `readStore`**（可给 engine 注入依赖计数，或在测试里用只读目录 + 计时）；
   - `/state` 等价的 `buildState` 不加载全量经验（用 mock source 断言 `read()` 未被调用）。
2. 召回等价测试（加在 `engine-manifest.test.mjs` 或 `recall.test.mjs`）：同一数据集，`exp_recall` 路由命中路径与 `{all:true}` 全量路径的 **candidate ids + 顺序 + rank_score** 完全一致；带 `recent` 时 `recent` 数组一致。
3. ui：`/cold` 列表与按意图检索；`/state` 的 storage 分项。

## 5 施工顺序（P1 提交后）

1. **先跑台架** `node tools/accept-shard.mjs`：预期 J1（迁移等价）/J2（幂等）/J6（提示段等价）转 PASS；J5（写入局部性）仍 FAIL（P2 才做），J3/J4 在 P2 前也不达标——把 FAIL 当阶段事实记录，不当 P3 阻塞。
2. **修 E1/U1/U7（engine.snapshot + live/settings）**：不依赖任何新 API（`readManifest` + `storageBytes` 已可先拼出总量；分项等 G7）。顺手消掉 P1 落地后 UI 的 `exists:false` 假红。
3. **G1/G2/G3/G4/G5/G6/G7 落地后**，按 T1 → T2 → T4 → U2/U3/U4 顺序改，每步逐文件跑上面清单。
4. **T3 保持全量、T5 保持全量**，在代码注释里写明原因，避免后人「顺手优化」。
5. **U9 冷档页**需要 `client.js`（根目录，超出 task-4 写范围）→ 先做 `/cold` API + 测试，UI 入口等 Lead 定。

## 6 待 Lead 决策

1. **G5（recent）**：加 manifest recent 索引，还是接受「带 recent 时回退全量」？前者 P3 收益完整，后者默认路径几乎不省读。
2. **G6（/state 统计）**：manifest 加 `stats` 块（推荐，2–3 KB），还是 UI 让 `deleted/superseded/retired/topEntities` 显示「—」？
3. **G4（定向写）**：由 storage-core 在 P2 的增量写里一并提供（推荐），还是 P3 单开一个 `writeTypeShards`？
4. **U9（冷档页）**：需要把 `client.js` 纳入 task-4 写范围，或另开一条任务。
