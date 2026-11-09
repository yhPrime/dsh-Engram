# 发布说明 / Release policy

这个 GitHub 仓库是 **发布仓**：`main` 只放可发布的稳定源码与文档。

- 日常开发在本地开发仓（`dsh-Engram-dev`）进行，开发提交不直接推到这里；
- 发布时：在开发仓跑完 `kernel/npm test`、`ui/npm test`、`node kernel/tools/audit.mjs`、`node kernel/tools/eval-routing.mjs`，再把稳定源码同步到本仓提交；
- 本仓只接受发布提交和发布修复，不接受实验性改动、临时脚本、调试日志；
- 版本号在 `kernel/package.json` / `ui/package.json` 中维护，发布提交打 `vX.Y.Z` tag。

## 当前发布

- v0.7.0：内核 0.33.3、外壳 0.7.0；关系图、真实数据默认、完整设置页。

## 本地开发仓

`C:\Users\yh\WorkDeepSeek\插件\dsh-Engram-dev`（独立 git，无远程；开发完成后按上面的流程同步到发布仓）。
