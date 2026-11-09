# 发布记录 / Release policy

这是 **标准 DSH 插件发布仓**：仓库根目录就是可安装的插件包。

- 安装：`npm pack` 后 `dsh plugin --profile <profile> add ./dsh-engram-<版本>.tgz`
- 开发在本地开发仓（`dsh-Engram-dev`）进行，发布时用 `tools/build-release.mjs` 生成到这里；
- `main` 只放稳定发布，实验改动不进来；
- 每次发布打 `vX.Y.Z` tag。

## 包结构（标准 DSH 插件）

| 文件 | 作用 |
|---|---|
| `package.json` | 插件清单；`dsh.bundle.patch` + `dsh.client` |
| `plugin.js` | 工具面 + 每轮提示段 |
| `ui.js` | UI Host 半（`/exp-ui/api`） |
| `client.js` | 经验库控制台客户端 |
| `cordis.patch.yml` | 挂载 `dsh-engram/plugin` 与 `dsh-engram/ui` |
| `engine.js` / `core.js` | 独立使用入口 |
| `icon.svg` / `locale/` | 面板图标与文案 |

## 当前发布

- **v0.7.1**（内核 0.33.3 / 外壳 0.7.1）
  - 经验库控制台：概览 / 关系图 / 经验 / 检索 / 记录 / 技能 / 类型 / 使用记录 / 设置
  - 关系图：类型 → 经验 → 技能网络
  - 默认真实数据、完整设置页、赛博朋克主题
- v0.7.0：首个标准发布（此前为 monorepo 开发布局）
