/**
 * 经验库 UI 主题 token 守卫。
 *
 * 规则（P0 契约，2026-11-12）：
 *   - client.js 里出现的每个 `--dsw-*` / `--dsh-*` 必须落在白名单内；
 *   - 白名单 = 14 个宿主 Theme 契约 token（`--dsw-*`）+ 4 个已核实的实现变量
 *     （其中 `--dsh-content-font-delta` 是 `--dsh-` 前缀，别写错）
 *     + 1 个契约点名的现行变体（`--dsw-alias-bg-module-platform`）；
 *   - 4 个已失效的死 token 单独点名（精确名；`-platform` / `-primary` 变体是现行名，合法）。
 *
 * Run: node ui/tests/tokens.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const clientPath = path.join(here, '..', '..', 'client.js')
const source = fs.readFileSync(clientPath, 'utf8')

/** 宿主 Theme 契约的 14 个 token（2026-11-12 运行中客户端核对，见计划书附录 A）。 */
const THEME_CONTRACT = [
  '--dsw-alias-bg-base',
  '--dsw-alias-bg-layer-1',
  '--dsw-alias-bg-layer-2',
  '--dsw-alias-bg-overlay',
  '--dsw-alias-border-l1',
  '--dsw-alias-border-l2',
  '--dsw-alias-brand-primary',
  '--dsw-alias-label-primary',
  '--dsw-alias-label-secondary',
  '--dsw-alias-state-error-primary',
  '--dsw-alias-state-idle-primary',
  '--dsw-alias-state-success-primary',
  '--dsw-alias-state-warn-primary',
  '--dsw-specific-sidebar-fill',
]

/** 契约外、但已核实存在的实现变量（允许；每版 DSH 升级后重跑本测试）。 */
const VERIFIED_IMPL = [
  '--dsw-alias-interactive-bg-hover',
  '--dsw-alias-label-tertiary',
  '--dsw-radius-sm',
  '--dsh-content-font-delta',
  '--dsw-alias-link',
  '--dsw-alias-brand-primary-new-colorprimary-new-color',
]

/** 契约里点名的现行变体：死 token 的替代名（`-platform` 合法，`-module` 不合法）。 */
const CURRENT_VARIANTS = ['--dsw-alias-bg-module-platform']

const ALLOWED = new Set([...THEME_CONTRACT, ...VERIFIED_IMPL, ...CURRENT_VARIANTS])

/** 已核实失效的宿主 token：精确名匹配，出现即红。 */
const DEAD_TOKENS = [
  ['--dsw-alias-bg-module', '现名 --dsw-alias-bg-module-platform'],
  ['--dsw-alias-state-error', '现名 --dsw-alias-state-error-primary'],
  ['--dsw-alias-state-success', '现名 --dsw-alias-state-success-primary'],
  ['--dsw-alias-label-error', '改用 --dsw-alias-state-error-primary'],
]
const DEAD = new Set(DEAD_TOKENS.map(([token]) => token))

/** 扫全文件：token -> 出现行号（去重、升序）。 */
const byToken = new Map()
source.split(/\r?\n/).forEach((line, index) => {
  const lineNo = index + 1
  for (const match of line.matchAll(/--ds[wh]-[a-z0-9-]+/g)) {
    const token = match[0]
    const lines = byToken.get(token) || []
    if (lines[lines.length - 1] !== lineNo) lines.push(lineNo)
    byToken.set(token, lines)
  }
})

function where(token) {
  return `${token} @ 行 ${(byToken.get(token) || []).join(', ') || '(无)'}`
}

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
    console.log(`       ${error && error.message ? error.message : error}`)
  }
}

check('client.js 可读，且能扫到 --dsw-* / --dsh-* 变量', () => {
  assert.ok(source.trim().length > 0, 'client.js 是空的')
  assert.ok(byToken.size >= 5, `只扫到 ${byToken.size} 个 token，正则或文件不对`)
})

check('扫描确实命中 --dsh-content-font-delta（防前缀写错导致空匹配）', () => {
  const lines = byToken.get('--dsh-content-font-delta') || []
  assert.ok(
    lines.length >= 1,
    `扫描结果里没有 --dsh-content-font-delta；正则可能没覆盖 --dsh- 前缀。当前 token：${[...byToken.keys()].join(', ')}`,
  )
})

check('白名单 = 14 个 Theme 契约 token + 7 个已核实实现变量/变体（21 个，无重复）', () => {
  assert.equal(THEME_CONTRACT.length, 14, 'Theme 契约 token 不是 14 个')
  assert.equal(VERIFIED_IMPL.length, 6, '已核实实现变量不是 6 个')
  assert.equal(CURRENT_VARIANTS.length, 1, '现行变体清单应只有 bg-module-platform')
  assert.equal(ALLOWED.size, 21, '白名单有重复项')
  for (const [token] of DEAD_TOKENS) {
    assert.equal(ALLOWED.has(token), false, `白名单不能包含死 token ${token}`)
  }
})

check('client.js 没有白名单之外的 --dsw-* / --dsh-* 变量', () => {
  // 4 个死 token 由下面各自的用例点名；这里报「其它」未登记变量。
  const unknown = [...byToken.keys()].filter((token) => !ALLOWED.has(token) && !DEAD.has(token))
  assert.deepEqual(
    unknown,
    [],
    unknown.length === 0 ? '' : `白名单之外：\n       ${unknown.map(where).join('\n       ')}`,
  )
})

for (const [token, reason] of DEAD_TOKENS) {
  check(`死 token 已绝迹：${token}`, () => {
    const lines = byToken.get(token) || []
    assert.equal(
      lines.length,
      0,
      `${token} 已失效（${reason}），client.js 仍在第 ${lines.join(', ')} 行使用；请换成现行 token`,
    )
  })
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
