# 回滚演练：0.14.0 分片存储 → 0.13.x 单文件

- 适用：`dsh-Engram` 0.14.0（P1 起，`.exp` 里出现 `manifest.json` / `buckets/` / `cold/` / `exp-lib.legacy.json`）
- 目标：五分钟内把经验库退回旧版单文件形态，且**不静默丢数据**
- 演练状态：2026-11-12 在 `_tmp` 副本上实际跑过（见文末「演练记录」）；真实 `.exp` 未触碰
- 配套台架：`node tools/accept-shard.mjs`（判据 R1 会自动重跑本文的步骤 2–4）

## 0 先读这一句

**回滚 = 回到迁移时刻。** `exp-lib.legacy.json` 是迁移那一刻的旧库快照；迁移之后新写/改的记录只在
`buckets/` 里，`cold/` 里的下沉记录也不在旧库里。回滚会把它们归档（不删），但旧版插件读不到。
所以要保留迁移后的数据：**先导出**（P2 起提供 `cold:true` 检索 / 控制台冷档页），或至少保留整个
`rollback-archive-*` 目录再人工处理。不要直接 `rm -rf buckets/ cold/`。

## 1 前置检查（只读）

```powershell
$exp = 'C:\Users\yh\WorkDeepSeek\.exp'

# 1.1 当前是不是分片形态（有 manifest + legacy 才能按本文回滚）
Test-Path "$exp\manifest.json", "$exp\exp-lib.legacy.json"

# 1.2 没有进程正在写（锁目录应不存在；看到它先等几秒再确认）
Test-Path "$exp\exp-lib.json.lock"
```

- 两个 `True` → 继续。
- `manifest.json` 不存在 → 当前不是分片形态，**无需回滚**，停止。
- `exp-lib.legacy.json` 不存在 → **中止**：旧库快照丢了，按本文回滚只会得到空库；先找备份。
- 锁存在 → 可能有插件/命令在写；先在 DSH 里禁用 `dsh-Engram` 或等锁消失。

## 2 停插件

在 DSH 里禁用 / 卸载 `dsh-Engram` 0.14.0（或停掉正在跑 DSH 的会话），确保回滚过程中没有进程写 `.exp`。
这一步不做，回滚到一半又写回 `manifest.json` 就白做。

## 3 整目录备份

```powershell
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
Copy-Item $exp "$exp.bak-$stamp" -Recurse -Force
"备份：$exp.bak-$stamp"
```

## 4 归档分片（不删）

```powershell
$archive = "$exp\rollback-archive-$stamp"
New-Item -ItemType Directory $archive | Out-Null

# 分片与冷档整目录搬进归档
if (Test-Path "$exp\buckets") { Move-Item "$exp\buckets" "$archive\buckets" }
if (Test-Path "$exp\cold")    { Move-Item "$exp\cold"    "$archive\cold" }
# manifest 也进归档（旧版不认识它，留着只会让 Git 多一次 diff）
if (Test-Path "$exp\manifest.json") { Move-Item "$exp\manifest.json" "$archive\manifest.json" }
```

归档而不是删除，是为了事后核对「迁移后写了哪些记录」；确认旧版跑稳后再手工删归档。

## 5 恢复 legacy

```powershell
if (!(Test-Path "$exp\exp-lib.legacy.json")) { throw 'legacy 不存在，中止（不要继续）' }
Move-Item "$exp\exp-lib.legacy.json" "$exp\exp-lib.json"
```

**顺序**：先归档分片（步骤 4）再动 legacy（步骤 5），保证中途失败时 `exp-lib.legacy.json` 还在，
可以原样重跑。

## 6 验证

在插件仓库目录（`dsh-Engram-dev`）里跑，只读检查：

```powershell
$env:ENGRAM_DATA_DIR = $exp
node -e "import('./kernel/store.js').then((m) => { const s = m.readStore(process.env.ENGRAM_DATA_DIR); console.log('可见经验:', m.visibleExperiences(s).length, '/ 类型:', s.types.length) })"
```

再确认目录里没有分片残留：

```powershell
Get-ChildItem $exp -Name   # 应只有 exp-lib.json / skills / usage.jsonl / .locks / 备份与归档目录
```

最后打开控制台看经验页条数与检索是否正常。

## 7 装回旧版插件

安装/启用 0.13.x 的 `dsh-Engram`，重启 DSH。确认：

1. 控制台经验页能打开、条数与步骤 6 一致；
2. `exp_recall` 能召回；
3. `.exp` 里没有再生成 `manifest.json` / `buckets/`。

## 8 确认稳定后再清理

```powershell
# 确认旧版跑稳（建议 1–2 天）后，再删归档与本次备份
# Remove-Item "$exp\rollback-archive-$stamp" -Recurse
# Remove-Item "$exp.bak-$stamp" -Recurse
```

## 9 回滚失败怎么办

按步骤 3 的整目录备份原样恢复：

```powershell
Remove-Item $exp -Recurse -Force
Copy-Item "$exp.bak-$stamp" $exp -Recurse
```

然后重新走「前置检查」。整目录备份里同时有 legacy、manifest、buckets，也可以据此重新决定
「留在新版」还是「再回滚一次」。

## 演练记录（2026-11-12，`_tmp` 副本）

台架 R1 在 `dsh-Engram-dev/_tmp/accept-shard/runs/<时间戳>/rollback/` 下：

1. 用真实库快照造「已迁移」形态：`exp-lib.legacy.json` + `manifest.json` + 合成分片 + `cold/2026.jsonl`；
2. 执行本文步骤 4 → 5（归档 `buckets/`、`cold/`、`manifest.json`，再把 legacy 改名成 `exp-lib.json`）；
3. 断言：恢复后的 `exp-lib.json` 与 legacy 快照字节一致、原位无 manifest/分片、归档里三样都在、
   `readStore` 可读且可见条数 = 128 条里的 119 条；
4. 另造一个**没有 legacy** 的目录，确认回滚会中止且不改任何文件。

结果：**PASS**（2026-11-12，基线提交 `72ec744`）。真实 `.exp` 按只读约束未参与演练；
真机双设备下的「一边回滚、一边旧版写」场景属于未验项。
