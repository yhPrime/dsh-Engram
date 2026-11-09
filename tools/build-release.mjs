/**
 * 从开发仓生成标准 DSH 插件发布仓。
 *
 * 开发仓是「一个包 + 两个内部分层目录」（kernel/ 引擎、ui/ 控制台），
 * 发布仓保持同样的目录结构，只替换版本号与元数据：
 *
 *   dsh-Engram/
 *     package.json        ← 唯一插件清单（dsh.bundle + dsh.client）
 *     plugin.js           ← 唯一入口：工具面 + 控制台 API
 *     cordis.patch.yml
 *     icon.svg
 *     kernel/*.js
 *     ui/client.js ui/shell.js ...
 *     ui/locale/*.json
 *
 * 不再做 import 路径改写：发布仓与开发仓同一套相对路径。
 *
 * Run: node tools/build-release.mjs [releaseRepoPath]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const devRoot = path.dirname(here)
const releaseRoot = path.resolve(process.argv[2] || path.join(devRoot, '..', 'dsh-Engram'))

const ROOT_FILES = ['index.js', 'plugin.js', 'cordis.patch.yml', 'icon.svg']
const KERNEL_FILES = ['index.js', 'plugin.js', 'core.js', 'engine.js', 'settings.js', 'store.js', 'kernel.js', 'retrieval.js', 'cluster.js', 'skills.js', 'tools.js']
const UI_FILES = ['client.js', 'shell.js', 'live.js', 'mock.js', 'data-source.js']

function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.copyFileSync(from, to)
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true })
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name)
    const target = path.join(to, entry.name)
    if (entry.isDirectory()) copyDir(source, target)
    else copyFile(source, target)
  }
}

// 清理旧的发布结构（保留 .git 与发布记录）
for (const entry of fs.readdirSync(releaseRoot)) {
  if (entry === '.git' || entry === 'RELEASES.md') continue
  fs.rmSync(path.join(releaseRoot, entry), { recursive: true, force: true })
}

// 包根
for (const file of ROOT_FILES) copyFile(path.join(devRoot, file), path.join(releaseRoot, file))
copyFile(path.join(devRoot, 'kernel', 'LICENSE'), path.join(releaseRoot, 'LICENSE'))
copyFile(path.join(devRoot, 'kernel', 'THIRD-PARTY-NOTICES.md'), path.join(releaseRoot, 'THIRD-PARTY-NOTICES.md'))

// 引擎
for (const file of KERNEL_FILES) copyFile(path.join(devRoot, 'kernel', file), path.join(releaseRoot, 'kernel', file))

// 控制台
for (const file of UI_FILES) copyFile(path.join(devRoot, 'ui', file), path.join(releaseRoot, 'ui', file))
copyDir(path.join(devRoot, 'ui', 'locale'), path.join(releaseRoot, 'ui', 'locale'))
copyFile(path.join(devRoot, 'ui', 'API.md'), path.join(releaseRoot, 'ui', 'API.md'))

// 清单：沿用开发仓的 exports / dsh 声明，只换版本与发布用字段
const devPkg = JSON.parse(fs.readFileSync(path.join(devRoot, 'package.json'), 'utf8'))
const version = devPkg.version
const pkg = {
  name: 'dsh-engram',
  version,
  description: devPkg.description,
  type: 'module',
  main: './index.js',
  exports: devPkg.exports,
  files: devPkg.files,
  icon: './icon.svg',
  dsh: devPkg.dsh,
  engines: devPkg.engines,
  peerDependencies: devPkg.peerDependencies,
  peerDependenciesMeta: devPkg.peerDependenciesMeta,
  keywords: devPkg.keywords,
  license: 'MIT',
  author: 'yhPrime',
  repository: { type: 'git', url: 'git+https://github.com/yhPrime/dsh-Engram.git' },
  homepage: 'https://github.com/yhPrime/dsh-Engram#readme',
  bugs: { url: 'https://github.com/yhPrime/dsh-Engram/issues' },
}
fs.writeFileSync(path.join(releaseRoot, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')

fs.writeFileSync(path.join(releaseRoot, 'README.md'), `# dsh-engram

Engram（记忆痕迹）：经验与技能引擎 + **经验库控制台**，一个标准 DSH 插件。

## 安装

\`\`\`bash
npm pack
dsh plugin --profile <profile> add ./dsh-engram-${version}.tgz
\`\`\`

重启 DSH 后只出现**一个**插件行「dsh-engram」：左侧栏多出「经验库」，控制台含概览 / 关系图 / 经验 / 检索 / 记录 / 技能 / 类型 / 使用记录 / 设置；工具面 \`exp_record / exp_recall / exp_feedback / exp_consolidate / exp_type\` 同包内的 \`/exp-ui/api\` 一并生效。

## 结构

| 路径 | 作用 |
|---|---|
| \`plugin.js\` | 唯一入口：kernel 工具面 + 控制台 API |
| \`cordis.patch.yml\` | 只插一条 \`engram\` 行 |
| \`kernel/\` | 引擎：存储、检索、簇路由、沉淀、反馈、技能 |
| \`ui/\` | 控制台：\`client.js\`（界面）、\`shell.js\`（API）、\`live.js\`/\`mock.js\`（数据源） |
| \`icon.svg\` | 插件图标（经验库自有标记） |

## 配置

在 DSH 插件行或 \`~/.dsh/engram/settings.json\`：

- \`dataDir\` / \`currentRoot\`：经验库目录（含 \`exp-lib.json\`）
- \`source\`：\`live\`（默认）或 \`mock\`（仅演示）
- 内核参数：\`hint\`、\`usageLog\`、\`feedbackEta\`、\`routing\`、\`maxTypes\` 等，全部可在控制台「设置」页修改。

## 许可

MIT，第三方声明见 \`THIRD-PARTY-NOTICES.md\`。
`, 'utf8')

fs.writeFileSync(path.join(releaseRoot, '.gitignore'), `node_modules/\ndist/\n_tmp/\n*.tgz\n*.log\n.exp/\n`, 'utf8')

if (!fs.existsSync(path.join(releaseRoot, 'RELEASES.md'))) {
  fs.writeFileSync(path.join(releaseRoot, 'RELEASES.md'), '# 发布记录\n', 'utf8')
}
console.log(`release built: ${releaseRoot} (v${version})`)
