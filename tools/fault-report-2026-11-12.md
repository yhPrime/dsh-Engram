# 故障注入报告（0.14.0 · task-11「无异常」专项）

- 日期：2026-11-12
- 被测提交：`7c781a4`（容量参数上调后的 HEAD；task-10 `aa90c82` 已包含）
- 运行：`DSH_HOME=<空临时目录> node kernel/tests/fault-injection.test.mjs`
- 隔离：全部在 `os.tmpdir()` 的 `exp-fault-*` 副本里做；真实库 `C:\Users\yh\WorkDeepSeek\.exp\exp-lib.json` 只读、mtime 未变。
- 结果：**9 个场景 · PASS 5 · WARN 4 · FAIL 0**。WARN 是 4 个场景、共 **5 条缺陷（D1–D5）**——F1 一个场景同时暴露 D1（残留锁）与 D2（manifest tmp 不清理）。WARN 都是「静默降级/残留」类，没有数据错乱、没有整库不可读。

## task-12 复验（2026-11-12 晚，HEAD `31532f5`）

- 复跑 `node kernel/tests/fault-injection.test.mjs`：**9/9 PASS，WARN 0，FAIL 0**。原 5 条缺陷（D1–D5）全部关闭：
  - D1：锁目录写 pid+心跳；死 pid / 心跳超 10s / 无 pid 超 2s 立即判残留清理；实测死 pid 3ms、心跳过期 2ms、无 pid 2ms 成功；真占用（活 pid+新鲜心跳）仍明确报错且不抢锁（`store-safety` 新用例）。
  - D2：根目录 `manifest.json.*.tmp` 在写盘前随陈旧 tmp 一起清理。
  - D3：manifest 声明 count>0 而实际行数更少 → 抛「分片损坏：<file> 声明 count=N，实际 M 行」；**manifest 字节未重写**、登记仍在、恢复文件后可读（本次独立核对：manifest bytes unchanged=true / still listed=true / restore 后 4 条）。
  - D4：逐行 `TextDecoder(fatal:true)`；非法字节抛「第 N 行不是合法 UTF-8（拒绝静默替换成 U+FFFD）」并带文件名+行号；BOM 也明确报错；CRLF 正常。
  - D5：冷档登记文件缺失抛「分片丢失：cold/2026-a.jsonl」，热档不受影响。
- **审计（实现方改了判定测试，逐条核对结论：收紧，未放宽）**：
  - `fault-injection`：F1 新增三种伪造残留锁 ≤200ms 断言；F6 从 WARN 改为「必须抛错」；F7 增加「错误含 UTF-8 + 文件名 + 行号」；F8 增加「错误含冷档文件名」。
  - `shard-store.test`：原「登记分片不在磁盘 → 自愈删登记」改写为「明确报错 + 文件名 + manifest 仍登记 + 恢复文件后可读」，比旧断言更严。
  - `store-safety.test`：真残留 ≤200ms 清理；真占用（活 pid+新鲜心跳）明确报错且锁不被抢；保留了「真占用必须报错」的关键约束。
  - **一条建议（不是放宽）**：`fault F6` 自身只断言 `/抛错|分片损坏/`，没有断言「错误含文件名」与「manifest 未被重写」——行为我已独立验证正确，但建议把这两个断言也写进 F6，防以后回归时只测「抛错」而丢了关键约束。
  - 备注：BOM 场景现在报的是「声明 count=N，实际 0 行」，仍是带文件名的明确错误（可接受）；如追求可读性可改成 BOM 专属文案。
- 本任务**未改 kernel**（写范围只有 `kernel/tests/fault*` + 本报告）；4 个 WARN 的修复建议见「缺陷清单」，需 Lead 转 storage-core。

## 汇总

| # | 场景 | 造法 | 实际 | 判定 |
|---|---|---|---|---|
| F1 | 半写（残留 tmp / 进程被杀） | 20 分钟前的 `.tmp` 残留 + 写子进程 500ms 后 SIGKILL | 残留被忽略、buckets 下 tmp 清零；被杀后 readStore 仍有 50–80 条可解析；**锁目录残留 → 下次写等 10s 报错、60s 后才自愈**；根目录 manifest tmp 不清理 | WARN |
| F2 | 单分片损坏 | 分片追加非 JSON 行 / 截断到行中 | readStore 抛「经验库分片损坏：buckets/ty_0.0.jsonl 第 N 行不是合法 JSON」；其它类型定向读正常；恢复后行数复原 | PASS |
| F3 | manifest 损坏/缺失/版本不符 | 坏 JSON / 删除 / version=99 / types 非数组 | 损坏与缺失都自愈（行数不变、分片字节不变、manifest 重建）；version 99 与结构坏不返回空库 | PASS |
| F4 | 并发写（两进程） | 两个子进程各 `withStoreLock` + `readStore/upsert/writeStore` 写 5 条 | 最终 12 条（种子 2+10），id 唯一，w0=5/w1=5，两进程 exit 0 | PASS |
| F5 | 超大记录（100KB note/action） | 存储层直接写入 100KB 行；再以 1KB 桶上限 `compactStore` | 行 >100KB 落盘并可读回；压缩后 readStore 4 条，单条仍在热档或冷档；无死循环 | PASS |
| F6 | 空库 / 空分片 | 空目录、仅 manifest、仅 buckets、新增 0 字节分片、清空已声明分片 | 前四种正常；**已声明 count>0 的分片被清 0 字节后 readStore 从 4 条变 3 条（静默少行，manifest 自愈后无法察觉）** | WARN |
| F7 | 非 UTF-8 / BOM / CRLF | BOM 前缀、字符串内插 0xFF、整文件 CRLF | BOM 明确抛「分片损坏」；**0xFF 被解码成 U+FFFD 静默替换，无告警/计数**；CRLF 正常 4 条 | WARN |
| F8 | 冷档缺失 | `manifest.cold` 指向不存在的 `cold/2026-a.jsonl` | 热档 4 条正常；**冷档查询 `readColdStore` 静默返回 0 条、不抛错** | WARN |
| F9 | 磁盘满 / 写失败 | monkeypatch `fs.writeFileSync`：写 manifest（含临时文件）抛 ENOSPC；恢复后重试 | 抛 `ENOSPC`；失败后 readStore 5 条可解析；无残留 tmp；重试成功 | PASS |

## 逐项说明

### F1 半写（残留 tmp / 进程被杀）— WARN
- **造法**：播种 5 条分片库；在 `buckets/` 与根目录各放一个 mtime 20 分钟前的 `.tmp`；再启动一个真实写循环子进程，500ms 后 `SIGKILL`；随后尝试 `withStoreLock` 写入。
- **实际**：残留 tmp 不影响读取；写盘清掉了 `buckets/*.tmp`；子进程被杀时已写入 50–80 条，重启读全部可解析、无半行。**但被杀的子进程留下 `exp-lib.json.lock` 目录**：下一次写会空等 **10s** 后抛「经验库正被另一个进程写入」，把锁目录 mtime 改老（>60s）后重试才成功（~10ms）。根目录 `manifest.json.*.tmp` 没有清理路径（只清 buckets 下的）。
- **可接受吗**：数据安全可接受（不丢已提交数据、无半行）；**可用性不可接受**——插件进程崩溃后 60s 内记经验会报错。
- **修复建议**：锁文件写 pid/启动时间并做存活检查，或把 `STALE_LOCK_MS` 降到数秒；同时给根目录 manifest tmp 加与 buckets 相同的 >10min 清理（`kernel/store.js`，不在本任务写范围）。

### F2 单分片损坏 — PASS
- **造法**：向非空分片追加 `{this is not json`；再把文件截断到一行中间；最后恢复原文件。
- **实际**：整库读抛「经验库分片损坏：…第 N 行不是合法 JSON」，带文件名与行号；健康类型仍可用 `readShardRecordsOfTypes` 定向读取（3 条）；截断同样抛错；恢复后 6 条。
- **可接受吗**：可接受——明确报错、不静默跳过、不返回不完整快照；控制台可按类型降级。
- **修了什么**：无（符合预期）。

### F3 manifest 损坏/缺失/版本不符 — PASS
- **造法**：写坏 JSON / 删除 / `version=99` / `types` 改成字符串，各读一次。
- **实际**：损坏：5 条 + manifest 重新生成，**分片字节不变**；缺失：5 条 + manifest 重写；version 99：5 条；types 结构坏：5 条。
- **可接受吗**：可接受——manifest 按 D1 定位为可重建缓存，损坏/缺失自愈，不静默返回空库。
- **修了什么**：无。

### F4 并发写（两进程）— PASS
- **造法**：两个子进程各用 `withStoreLock` 串行写 5 条不同 tag 的记录。
- **实际**：最终 12 条（种子 2 + 10），id 唯一，两个进程都 exit 0；同类型并发被锁串行化。
- **可接受吗**：可接受——无丢更新、无 JSON 损坏。
- **修了什么**：无。

### F5 超大记录 — PASS
- **造法**：`exp_record` 语义会把 note/action 截到 2000 字（产品约束，不算故障），因此直接在存储层构造 note/action 各 100KB 的行写盘；再以 1KB 桶上限触发 `compactStore`。
- **实际**：行 >100KB 实际落盘并可读回；强制压缩后 readStore 仍有 4 条，单条在热档或冷档，无死循环。
- **可接受吗**：可接受——`compactBucket` 的「至少留一条」生效。
- **修了什么**：无。

### F6 空库 / 空分片 — WARN
- **造法**：空目录、仅 manifest 的空库、删除 manifest 只留 buckets、新增一个 manifest 未登记的 0 字节分片；最后把一个声明 `count=1` 的分片清零。
- **实际**：前四种都正常（空库 0 条；仅 buckets 重建 4 条；新增空分片读取仍 4 条不崩）。**清零已声明分片后 readStore 3 条**：空文件被当作空分片，manifest 按实际重建，行数静默变少且之后无法察觉。
- **可接受吗**：不可接受（静默数据丢失）。这是「文件被外部清空」场景，不是正常半写（半写会因 JSON 行损坏而报错，见 F2）；但 0 字节是合法文件，现有实现无法区分「新空分片」与「旧数据被清空」。
- **修复建议**：manifest 声明 `count>0` 而文件 0 字节时报错或隔离（与 F2 同等处理），不要用重建把损失抹平（`kernel/shard-store.js`，不在本任务写范围）。

### F7 非 UTF-8 / BOM / CRLF — WARN
- **造法**：分片前加 UTF-8 BOM；在 JSON 字符串值里插入原始 `0xFF` 字节；整文件改写为 CRLF。
- **实际**：BOM 抛「分片损坏」；CRLF 正常 4 条；**非法字节被 Node 按 UTF-8 解码成 U+FFFD 静默替换**（action 变成 `"�种子做法 2"`），JSON 仍合法，读路径无法察觉。
- **可接受吗**：BOM/CRLF 可接受；非法字节静默替换不可接受（数据被改而不告警）。
- **修复建议**：逐行用 `TextDecoder('utf-8', { fatal: true })` 解码，非法行报错或跳过并计数（`kernel/shard-store.js`，不在本任务写范围）。

### F8 冷档缺失 — WARN
- **造法**：手动在 manifest.cold 登记一个不存在的 `cold/2026-a.jsonl`，再查热档与冷档。
- **实际**：热档 4 条正常；`readColdStore` 返回 0 条、不抛错。
- **可接受吗**：按验收要求「cold:true 明确报错」——不可接受。当前无法区分「本来没有冷档」与「冷档文件丢了」。
- **修复建议**：`readColdRecords` 对 manifest 登记但缺失的文件抛错（或返回 `{missing:[...]}` 让工具层报错），热档路径保持不受影响（`kernel/shard-store.js`/`store.js`，不在本任务写范围）。

### F9 磁盘满 / 写失败 — PASS
- **造法**：monkeypatch `fs.writeFileSync`，对路径含 `manifest.json` 的写入（含临时文件）抛 `ENOSPC`；恢复后重试。
- **实际**：抛 `ENOSPC: no space left on device`；失败后 readStore 5 条可解析；无残留 tmp；恢复后重写成功。
- **可接受吗**：可接受——原子写（临时文件 + rename）保证失败不破坏旧文件，错误可上抛，重试可恢复。
- **修了什么**：无。

## 缺陷清单（4 个 WARN 场景共 5 条；需 Lead 转 storage-core；本任务未改 kernel）

| id | 级别 | 现象 | 建议落点 |
|---|---|---|---|
| D1 | 中 | 崩溃残留锁目录：下次写空等 10s 报错，最长 60s 才自愈 | `kernel/store.js` `withStoreLock`（pid/心跳或缩短 stale） |
| D2 | 低 | 根目录 `manifest.json.*.tmp` 无清理，长期积累垃圾 | `kernel/shard-store.js` 清理路径 |
| D3 | 中 | manifest 声明 count>0 的分片被清 0 字节后静默少行（自愈掩盖损失） | `kernel/shard-store.js` `scanShards`/`readBucketRows` |
| D4 | 中 | 非法 UTF-8 字节被静默替换为 U+FFFD | `kernel/shard-store.js` 逐行 fatal 解码 |
| D5 | 中 | 冷档登记文件缺失时静默返回 0 条 | `kernel/shard-store.js` `readColdRecords` |

## 本任务内修了什么

只修了测试自身的问题（不是产品修复）：半写/损坏/编码/空分片用例的构造顺序、并发子进程条数、超大记录绕过 2000 字产品截断、磁盘满 patch 命中 manifest 临时文件等；产品代码零改动。

## 未覆盖 / 边界

- 真磁盘满没有用真实配额/只读目录制造（Windows 下不易稳定），用 `ENOSPC` monkeypatch 模拟写失败；未覆盖「rename 阶段失败」。
- 杀进程场景用单进程写循环 + SIGKILL，不等价于整个 DSH 插件宿主被杀（但走同一 `withStoreLock`/`readStore`/`writeStore` 路径）。
- 未覆盖多设备 Git 并发写入（按用户裁定不在本次范围）。
- 未覆盖冷档文件内容损坏（只测缺失）；未覆盖 `manifest.buckets` 指向错误 typeId 等语义损坏。
