/**
 * P1/S1 静态守卫：`--eng-*` 引用必须都有定义；核心布局/密度契约必须在。
 * 只读 client.js，不加载 React。Run: node ui/tests/eng-tokens.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const clientFile = path.join(here, '..', '..', 'client.js')
const source = fs.readFileSync(clientFile, 'utf8')

let passed = 0
let failed = 0
function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}`)
    console.log(`       ${error && error.stack ? error.stack : error}`)
  }
}

const defined = new Set()
for (const match of source.matchAll(/(--eng-[a-z0-9-]+)\s*:/g)) defined.add(match[1])
const referenced = new Set()
for (const match of source.matchAll(/var\((--eng-[a-z0-9-]+)/g)) referenced.add(match[1])

check('client.js 里有 --eng-* token 定义', () => {
  assert.ok(defined.size >= 40, `只找到 ${defined.size} 个 --eng-* 定义，token 层可能没落`)
})

check('每个 var(--eng-*) 引用都有定义（防拼错/漏声明）', () => {
  const missing = [...referenced].filter((name) => !defined.has(name)).sort()
  assert.deepEqual(missing, [], `未定义的 --eng-*：${missing.join(', ')}`)
})

check('密度档：data-density 挂载 + comfortable/compact 覆盖块', () => {
  assert.ok(source.includes("'data-density': density"), 'Console 根节点没挂 data-density')
  assert.ok(source.includes('.eng-app[data-density="comfortable"]'), '缺 comfortable 覆盖块')
  assert.ok(source.includes('.eng-app[data-density="compact"]'), '缺 compact 覆盖块')
  assert.ok(source.includes("localStorage.getItem('eng:density')"), '没有读 localStorage 的密度偏好')
})

check('容器命名 + 内容宽度 token', () => {
  assert.ok(/container-name:\s*eng/u.test(source), '`.eng-app` 没加 container-name: eng')
  assert.ok(source.includes('--eng-content-max: 1240px'), '内容宽度 token 不是 1240')
  assert.ok(source.includes('max-width: min(var(--eng-content-max), 100%)'), '内容区没用 --eng-content-max')
})

check('骨架/错误态/Kbd 已进组件与样式', () => {
  for (const name of ['function Skeleton', 'function ErrorState', 'function Kbd']) {
    assert.ok(source.includes(name), `缺 ${name}`)
  }
  assert.ok(source.includes('.eng-skeleton-row'), '缺骨架样式')
  assert.ok(source.includes('.eng-error-state'), '缺错误态样式')
  assert.ok(source.includes('.eng-kbd'), '缺 Kbd 样式')
})

check('默认皮肤白 + 蓝：accent token 与白卡片', () => {
  for (const name of ['--eng-accent', '--eng-accent-text', '--eng-accent-soft', '--eng-accent-fill', '--eng-accent-strong']) {
    assert.ok(source.includes(`${name}:`), `缺 ${name}`)
  }
  assert.ok(source.includes('--dsw-alias-link'), 'accent 没接 DSH 链接色（自带明暗两套）')
  assert.ok(source.includes('--dsw-alias-brand-primary-new-colorprimary-new-color'), '主按钮没接 DSH 蓝色 token')
  assert.ok(source.includes('.eng-card { min-width: 0; border: 1px solid color-mix'), '卡片没用灰边 + 白底')
  assert.ok(source.includes('background: var(--dsw-alias-bg-layer-1); box-shadow: 0 1px 2px rgba(0,0,0,.03)'), '卡片不是白底')
})

check('reduced-motion 覆盖块存在且在 CSS 末尾', () => {
  const index = source.indexOf('@media (prefers-reduced-motion: reduce)')
  assert.ok(index > 0, '没有 reduced-motion 覆盖')
  assert.ok(index > source.indexOf('.eng-skeleton-row'), 'reduced-motion 应在组件样式之后')
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed > 0 ? 1 : 0
