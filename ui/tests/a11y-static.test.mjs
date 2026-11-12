/**
 * P3 静态无障碍/交互守卫：焦点生命周期、可访问名、键盘入口、无弹窗。
 * 只读 client.js，不加载 React。Run: node ui/tests/a11y-static.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = fs.readFileSync(path.join(here, '..', '..', 'client.js'), 'utf8')

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

check('模态焦点生命周期：useModalFocus 覆盖 4 个浮层', () => {
  assert.ok(source.includes('function useModalFocus'))
  const uses = (source.match(/useModalFocus\(/g) || []).length
  assert.ok(uses >= 4, `只有 ${uses} 处调用（命令面板/快捷键/推送冲突/导入至少要 4）`)
  assert.ok(source.includes("event.key === 'Escape'"), 'Esc 没处理')
  assert.ok(source.includes("event.key !== 'Tab'"), 'Tab 循环没处理')
  assert.ok(source.includes('previous.focus'), '关闭后没还原焦点')
})

check('Field 给控件生成 id 并让 label 关联', () => {
  assert.ok(source.includes('htmlFor: fieldId'), 'label 没有 htmlFor')
  assert.ok(source.includes("`eng-field-${fieldSeq}`"), '没有生成稳定 id')
  assert.ok(source.includes('id: (child.props && child.props.id) || fieldId'), '控件没挂 id')
})

check('拖拽区有键盘入口与可访问名', () => {
  const marker = source.indexOf("role: 'button', tabIndex: 0, 'aria-label': '拖入技能文件夹或 SKILL.md'")
  assert.ok(marker > 0, '拖拽区缺 role/aria-label')
  assert.ok(source.indexOf("onKeyDown: (event) => { if (event.key === 'Enter'", marker) > marker, '拖拽区缺 keydown')
})

check('Toast 有 aria-live；列表/页签有选中语义', () => {
  assert.ok(source.includes("'aria-live': 'polite'"), 'Toast 没有 aria-live')
  assert.ok(source.includes("'aria-selected'"), '页签/命令选项没有 aria-selected')
  assert.ok(source.includes("'aria-expanded'"), '折叠控件没有 aria-expanded')
})

check('命令面板与快捷键表可访问（输入框 + 列表语义）', () => {
  assert.ok(source.includes("placeholder: '输入命令"), '命令面板缺输入框')
  assert.ok(source.includes("role: 'listbox'"), '命令列表缺 listbox')
  assert.ok(source.includes("role: 'option'"), '命令项缺 option')
  assert.ok(source.includes("className: 'eng-shortcut-row'"), '快捷键表缺行')
})

check('没有 alert / confirm / prompt', () => {
  assert.equal(/alert\s*\(|confirm\s*\(|prompt\s*\(/u.test(source), false)
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed > 0 ? 1 : 0
