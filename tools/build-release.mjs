/**
 * 从开发仓（kernel/ + ui/）生成标准 DSH 插件发布仓。
 *
 * 目标：发布仓根目录就是插件包本身（package.json / plugin.js / ui.js / client.js /
 * cordis.patch.yml），安装方式 `dsh plugin add dsh-engram-<版本>.tgz`。
 *
 * Run: node tools/build-release.mjs [releaseRepoPath]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const devRoot = path.dirname(here)
const releaseRoot = path.resolve(process.argv[2] || path.join(devRoot, '..', 'dsh-Engram'))

const KERNEL_FILES = ['index.js', 'plugin.js', 'core.js', 'engine.js', 'settings.js', 'store.js', 'kernel.js', 'retrieval.js', 'cluster.js', 'skills.js', 'tools.js']
const UI_FILES = ['shell.js', 'live.js', 'mock.js', 'data-source.js', 'client.js']
const UI_DIRS = ['locale']

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

function readRewrite(file, replacements) {
  let text = fs.readFileSync(file, 'utf8')
  for (const [from, to] of replacements) text = text.split(from).join(to)
  fs.writeFileSync(file, text, 'utf8')
}

// 清理旧的发布结构（保留 .git）
for (const entry of fs.readdirSync(releaseRoot)) {
  if (entry === '.git') continue
  fs.rmSync(path.join(releaseRoot, entry), { recursive: true, force: true })
}

// 内核运行时
for (const file of KERNEL_FILES) copyFile(path.join(devRoot, 'kernel', file), path.join(releaseRoot, file))
copyFile(path.join(devRoot, 'kernel', 'LICENSE'), path.join(releaseRoot, 'LICENSE'))
copyFile(path.join(devRoot, 'kernel', 'THIRD-PARTY-NOTICES.md'), path.join(releaseRoot, 'THIRD-PARTY-NOTICES.md'))

// UI 运行时
for (const file of UI_FILES) copyFile(path.join(devRoot, 'ui', file), path.join(releaseRoot, file))
for (const dir of UI_DIRS) copyDir(path.join(devRoot, 'ui', dir), path.join(releaseRoot, dir))
copyFile(path.join(devRoot, 'ui', 'icon.svg'), path.join(releaseRoot, 'icon.svg'))
copyFile(path.join(devRoot, 'ui', 'API.md'), path.join(releaseRoot, 'API.md'))

// 路径改写：合并到同一根目录
readRewrite(path.join(releaseRoot, 'live.js'), [["../kernel/engine.js", './engine.js'], ["../kernel/settings.js", './settings.js']])
readRewrite(path.join(releaseRoot, 'shell.js'), [["../kernel/settings.js", './settings.js']])
readRewrite(path.join(releaseRoot, 'client.js'), [
  ["id: 'dsh-exp-ui'", "id: 'dsh-engram-ui'"],
  ["const PACKAGE_NAME = 'dsh-exp-ui'", "const PACKAGE_NAME = 'dsh-engram'"],
  ["'dsh-exp-ui/styles'", "'dsh-engram/styles'"],
  ['[exp-ui]', '[engram]'],
])

// Host 的 UI 半（原 ui/index.js）
fs.writeFileSync(path.join(releaseRoot, 'ui.js'), `/**
 * dsh-engram 的 UI Host 半：等 webServer 就绪，挂接 /exp-ui/api。
 * 客户端半在 client.js。
 */
import { API_PREFIX, APP_NAME, createApi } from './shell.js'

export { API_PREFIX, APP_NAME } from './shell.js'
export { createSource, buildState, buildExperiences } from './shell.js'

export const name = 'dsh-engram-ui'
export const inject = ['webServer']

export function apply(ctx, config = {}) {
  const api = createApi(config)
  return ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: api,
  }))
}
`, 'utf8')

// cordis patch：一个包挂两个入口（工具面 + UI）
fs.writeFileSync(path.join(releaseRoot, 'cordis.patch.yml'), `- insert:
    - id: engram
      name: dsh-engram/plugin
      config:
        hint: true
    - id: engram-ui
      name: dsh-engram/ui
      config:
        source: live
`, 'utf8')

// 标准 DSH 插件 package.json
const version = JSON.parse(fs.readFileSync(path.join(devRoot, 'ui', 'package.json'), 'utf8')).version
const pkg = {
  name: 'dsh-engram',
  version,
  description: 'Engram（记忆痕迹）：经验与技能引擎 + 经验库控制台（标准 DSH 插件）',
  type: 'module',
  main: './index.js',
  exports: {
    '.': './index.js',
    './plugin': './plugin.js',
    './ui': './ui.js',
    './client': './client.js',
    './engine': './engine.js',
    './core': './core.js',
    './store': './store.js',
    './tools': './tools.js',
    './retrieval': './retrieval.js',
    './icon': './icon.svg',
    './locale/*.json': './locale/*.json',
  },
  files: [
    'index.js', 'plugin.js', 'ui.js', 'client.js', 'core.js', 'engine.js', 'settings.js',
    'store.js', 'kernel.js', 'retrieval.js', 'cluster.js', 'skills.js', 'tools.js',
    'shell.js', 'live.js', 'mock.js', 'data-source.js',
    'cordis.patch.yml', 'icon.svg', 'locale/*.json',
    'README.md', 'RELEASES.md', 'API.md', 'LICENSE', 'THIRD-PARTY-NOTICES.md',
  ],
  icon: './icon.svg',
  dsh: {
    bundle: { patch: './cordis.patch.yml' },
    client: { platform: 'web', immediately: true, inject: [] },
  },
  engines: { node: '>=22' },
  peerDependencies: {
    '@deepseek-ai/dsh-client-ui-primitives': '>=0.2.0-rc.2 || >=0.2.1-rc.2',
    '@deepseek-ai/dsh-tools': '*',
    'dsh-mnemon-source-memory-spaces': '^0.5.0',
  },
  peerDependenciesMeta: {
    '@deepseek-ai/dsh-client-ui-primitives': { optional: true },
    '@deepseek-ai/dsh-tools': { optional: true },
    'dsh-mnemon-source-memory-spaces': { optional: true },
  },
  keywords: ['deepseek-harness', 'dsh', 'experience', 'skills', 'console'],
  license: 'MIT',
  author: 'yhPrime',
}
fs.writeFileSync(path.join(releaseRoot, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')

fs.writeFileSync(path.join(releaseRoot, 'README.md'), `# dsh-engram

Engram（记忆痕迹）：经验与技能引擎 + **经验库控制台**，一个标准 DSH 插件。

## 安装

\`\`\`bash
npm pack
dsh plugin --profile <profile> add ./dsh-engram-${version}.tgz
\`\`\`

重启 DSH 后：左侧栏出现「经验库」，控制台含概览 / 关系图 / 经验 / 检索 / 记录 / 技能 / 类型 / 使用记录 / 设置；工具面 \`exp_record / exp_recall / exp_feedback / exp_consolidate / exp_type\`。

## 配置

在 DSH 插件行或 \`~/.dsh/engram/settings.json\`：

- \`dataDir\` / \`currentRoot\`：经验库目录（含 \`exp-lib.json\`）
- \`source\`：\`live\`（默认）或 \`mock\`（仅演示）
- 内核参数：\`hint\`、\`usageLog\`、\`feedbackEta\`、\`routing\`、\`maxTypes\` 等，全部可在控制台「设置」页修改。

## 入口

| 文件 | 作用 |
|---|---|
| \`plugin.js\` | 工具面 + 每轮提示段 |
| \`ui.js\` | UI Host 半（/exp-ui/api） |
| \`client.js\` | 控制台客户端 |
| \`engine.js\` / \`core.js\` | 独立使用入口 |

## 许可

MIT，第三方声明见 \`THIRD-PARTY-NOTICES.md\`。
`, 'utf8')

// .gitignore
fs.writeFileSync(path.join(releaseRoot, '.gitignore'), `node_modules/\ndist/\n_tmp/\n*.tgz\n*.log\n.exp/\n`, 'utf8')

// 不要覆盖 RELEASES.md（发布记录保留）
if (!fs.existsSync(path.join(releaseRoot, 'RELEASES.md'))) {
  fs.writeFileSync(path.join(releaseRoot, 'RELEASES.md'), '# 发布记录\n', 'utf8')
}
console.log(`release built: ${releaseRoot} (v${version})`)
