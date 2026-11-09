# 经验库控制台（dsh-exp-ui）

经验库的**界面外壳**：左侧栏图标 + 主面板（检索 / 列表 / **固化技能** / 类型 / 使用记录 / 详情 / 用后反馈），默认跑在内置**示例数据**上。

- 与真实经验库（`exp-lib` / `dsh-engram`）**分开命名、分开装**：本包不注册任何工具，不写真实数据。
- 接口与返回形状已固定：真实经验库接入时只把数据源从 `mock` 换成 `live`，界面不用改。
- 没有真实数据也能完整点：示例库覆盖成功/失败/被纠正/退休/被取代/已删除/超长备注/任务步骤等形态，另有 5 个示例固化技能。

完整接口与返回值见 [API.md](./API.md)。

## 它提供什么

| 项 | 值 |
|八个页面：概览 / 经验 / 检索 / 记录 / 技能 / 类型 / 使用记录 / 设置。覆盖记录、召回（含技能模式）、反馈、沉淀、类型管理、技能校验与数据源状态。

---|---|
| 包名 / 插件行 | `dsh-exp-ui` / `exp-ui` |
| 依赖 | 只需要 `webServer`（Host）；不依赖 mnemon、不依赖经验库插件 |
| 工具面 | 无（刻意：外壳不写数据） |
| 数据源 | `mock`（内置示例，默认）/ `live`（只读 `<dataDir>/exp-lib.json` + `<dataDir>/skills/`） |
| 面板 | 侧栏「exp-ui」→ 主面板（含「固化技能」页签）；插件页有「exp-ui」卡片 |
| 接口前缀 | `/exp-ui/api` |

## 安装

**一律用 tarball**（目录安装会建 pnpm `link:`，卸载时可能连带清掉源码）：

```powershell
npm pack
dsh plugin --profile <profile> add ./dsh-exp-ui-<版本>.tgz
```

换版本后**重启 DSH** 才会加载新的 Host JS；客户端半在页面加载时注册，重开页面即可。启用后左侧栏点「exp-ui」。

## 配置

插件行 config（`cordis.patch.yml`）：

```yaml
- id: exp-ui
  name: dsh-exp-ui
  config:
    source: mock      # mock = 内置示例数据；live = 读真实库文件
    # dataDir: ~/WorkDeepSeek/.exp   # 仅 source: live 时用
```

- `mock`：反馈只改内存，**不落盘**；重启恢复。
- `live`：只读真实经验库文件；读不到/读坏了按空库显示并给提示；反馈按钮禁用（`409 read-only`）。

## 测试

```powershell
npm test
```

四个文件：`tests/mock.test.mjs`（示例数据完整性）、`tests/shell.test.mjs`（HTTP 契约、mock/live、损坏文件兜底）、`tests/client.test.mjs`（插槽注册与首屏渲染冒烟）、`tests/contract.test.mjs`（API.md 与真实返回对账）。

## 交互（点击顺序与查看逻辑）

按 master-detail（列表 → 详情侧栏）+ filter chips + 键盘可达的常见做法重排：

1. 默认落在「经验」列表；顶部检索（按 `/` 聚焦）→ 类型 chips 收窄 → 点行打开右侧详情。
2. 再点一次当前行、按 Esc、或点「返回」都收起详情；详情里 ↑/↓ 换上一条/下一条，列表里 ↑/↓ 移动游标、Enter 打开。
3. 换筛选 / 换检索会自动收起详情，避免右侧还挂着已经不在列表里的条目。
4. 「固化技能」整张卡片可点开看 `SKILL.md` 正文；「使用记录」里带经验 id 的行可直接跳到那条经验。
5. 窄容器（宽度 < 900px）详情改成整层覆盖 + 返回按钮，不再挤压列表；统计条压成一行，先让位给列表。
6. 视觉：面板底做成磨砂面（浅色主题的 `--dsw-alias-bg-base` 是 `transparent`，直接透壁纸会很脏）；列表行左侧 3px 状态色（成功绿 / 失败红 / 部分黄），一眼扫结果；提示条可关闭、无反馈的行不再显示「反馈 —」；搜索框有焦点环。

参考（只读参考，未引入依赖）：

- [Master-detail（Azure DevOps 设计系统）](https://developer.microsoft.com/en-ca/azure-devops/components/master-detail)
- [Filter chips（goodpractices.design）](https://goodpractices.design/components/filter-chips)
- [Filter UI and UX Design: Best Practices](https://uxpin.com/studio/blog/filter-ui-and-ux)
- [Keyboard navigation complete guide](https://levelaccess.com/blog/keyboard-navigation-complete-web-accessibility-guide)
- [Modal / full page / side panel 取舍](https://vc-ux-standards.github.io/design-standards/records/modal-vs-page.html)

## 边界

- 不做写入语义（upsert/取代/退休/沉淀）：那是经验库引擎的事，外壳只调用接口。
- 固化技能只读：`live` 扫 `<dataDir>/skills/<slug>/`（`SKILL.md` + `skill.json`）；状态规则与 exp-lib 的 `highConfidence` 一致（`attempts = helped + hurt`，≥3 且比例 ≥0.8 且无未解障碍才算已固化）。缺目录返回空数组，`skill.json` 读坏仍按 `SKILL.md` 出条目。
- 检索排序是简化实现（分词 + Jaccard + 简单优势），只保证界面能拿到候选/证据/分数；正式 JitRL 排序随引擎接入替换。
- 侧栏那格**只放图标**：行按钮、label、点击切面板都由宿主 `.panelRow` 负责；图标优先用宿主图标族 `IconChecklistOutlineRegular`（`@deepseek-ai/dsh-client-ui-primitives`，peer 依赖声明为 optional），拿不到才退回自绘 16 栅格图标。
- 真实视觉未验：需要装进 profile、重启后在界面上看。
