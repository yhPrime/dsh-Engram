#!/usr/bin/env node
/**
 * patch-memory-spaces-footer 的测试。
 *
 * 三层：
 *   ① 纯函数：锚点 / 文案 / 幂等 / 页脚外文案不动；
 *   ② 失败要响：锚点缺失时抛错（上游改实现时不许静默乱改）；
 *   ③ 真文件：把已安装的 client.js 复制到 _tmp 副本上补丁，跑 node --check 与二次幂等。
 *
 * 跑法：node tests/patch-memory-spaces-footer.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

import {
  EXPERIENCE_TEXT,
  FOOTER_ANCHOR,
  PATCHED_CONDITION,
  patchFile,
  patchText,
  resolveTarget,
} from '../tools/patch-memory-spaces-footer.mjs'

const MEMORY_TEXT = 't("common.memories", { count: body.stats?.totalInsights ?? 0 })'

/** 照真实 client.js（0.5.22 / 0.5.24 一致）的页脚结构缩写的夹具 */
const FIXTURE = `\t\t\t\t\t\t\tchildren: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
\t\t\t\t\t\t\t\tclassName: sidebarCss.bodyCardStats,
\t\t\t\t\t\t\t\tchildren: !nativeSpaceProvider(body.provider) ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
\t\t\t\t\t\t\t\t\tclassName: css.bodyFooterBlock,
\t\t\t\t\t\t\t\t\ttitle: t(body.provider.kind === "remote" ? "overview.providerRemote" : "overview.providerLocal"),
\t\t\t\t\t\t\t\t\tchildren: t(body.provider.kind === "remote" ? "overview.providerRemote" : "overview.providerLocal")
\t\t\t\t\t\t\t\t}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
\t\t\t\t\t\t\t\t\tclassName: \`\${css.bodyFooterBlock} \${css.bodyFooterGrow}\`,
\t\t\t\t\t\t\t\t\ttitle: body.provider.location || body.provider.label,
\t\t\t\t\t\t\t\t\tchildren: body.provider.location || body.provider.label
\t\t\t\t\t\t\t\t})] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
\t\t\t\t\t\t\t\t\t/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
\t\t\t\t\t\t\t\t\t\tclassName: css.bodyFooterBlock,
\t\t\t\t\t\t\t\t\t\ttitle: ${MEMORY_TEXT},
\t\t\t\t\t\t\t\t\t\tchildren: ${MEMORY_TEXT}
\t\t\t\t\t\t\t\t\t}),
\t\t\t\t\t\t\t\t\t/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
\t\t\t\t\t\t\t\t\t\tclassName: css.bodyFooterBlock,
\t\t\t\t\t\t\t\t\t\ttitle: t("common.edges", { count: body.stats?.edgeCount ?? 0 }),
\t\t\t\t\t\t\t\t\t\tchildren: t("common.edges", { count: body.stats?.edgeCount ?? 0 })
\t\t\t\t\t\t\t\t\t}),
\t\t\t\t\t\t\t\t\t/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
\t\t\t\t\t\t\t\t\t\tclassName: css.bodyFooterBlock,
\t\t\t\t\t\t\t\t\t\ttitle: (0, dsh_mnemon_client.humanBytes)(body.stats?.dbSizeBytes ?? 0),
\t\t\t\t\t\t\t\t\t\tchildren: (0, dsh_mnemon_client.humanBytes)(body.stats?.dbSizeBytes ?? 0)
\t\t\t\t\t\t\t\t\t})
\t\t\t\t\t\t\t\t] })
\t\t\t\t\t\t\t}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
\t\t\t\t\t\t\t\tclassName: css.bodyCardActions,
\t\t\t\t\t\t\t\tchildren: "actions"
\t\t\t\t\t\t\t})]
\t\t\t\t\t\t}),
// 页脚之外另有一处同样的文案（例如别的页面），补丁不许动它
\t\t\t\t\t\tconst elsewhere = ${MEMORY_TEXT};
`

function countOf(text, needle) {
  return text.split(needle).length - 1
}

test('补丁把页脚改成「有 stats 就显示统计」，并把经验库文案写成「条经验」', () => {
  const { text, changed } = patchText(FIXTURE)
  assert.equal(changed, true)
  assert.equal(countOf(text, PATCHED_CONDITION), 1)
  assert.equal(countOf(text, `children: !nativeSpaceProvider(body.provider) ?`), 0, '原条件应被替换掉')
  assert.equal(countOf(text, EXPERIENCE_TEXT), 2, 'title 与 children 两处都要换')
  // 经验库文案里仍保留「N 条记忆」作为其他 Provider 的回退
  assert.ok(EXPERIENCE_TEXT.includes(MEMORY_TEXT))
  // 页脚外的同类文案不动：页脚内 2 处被包进 EXPERIENCE_TEXT（仍含原串），再加外面 1 处
  assert.equal(countOf(text, MEMORY_TEXT), 3)
  assert.ok(text.trimEnd().endsWith(`const elsewhere = ${MEMORY_TEXT};`))
})

test('已打过补丁的文本再跑一次不变（幂等）', () => {
  const first = patchText(FIXTURE).text
  const second = patchText(first)
  assert.equal(second.changed, false)
  assert.equal(second.text, first)
})

test('锚点缺失时抛错，不静默改错地方', () => {
  const broken = FIXTURE.replace('!nativeSpaceProvider(body.provider) ?', 'nativeSpaceProvider(body.provider) ?')
  assert.throws(() => patchText(broken), /锚点/)
})

test('页脚里没有「条记忆」文案时抛错（上游改了标签就停下）', () => {
  const broken = FIXTURE.split(MEMORY_TEXT).join('t("common.memories2")')
  assert.throws(() => patchText(broken), /条记忆/)
})

test('找不到页脚起点时抛错', () => {
  const broken = FIXTURE.replace('sidebarCss.bodyCardStats', 'sidebarCss.somethingElse')
  assert.throws(() => patchText(broken), /页脚条件应恰好命中/)
})

/** 真实的已安装文件（本机才有；没有就跳过） */
function installedClientPath() {
  try {
    return resolveTarget({})
  } catch {
    return undefined
  }
}

test('真文件副本：补丁后语法正确、断开硬链接、二次运行幂等', (t) => {
  const installed = installedClientPath()
  if (installed === undefined) {
    t.skip('本机没有安装 dsh-mnemon-source-memory-spaces，跳过')
    return
  }

  const root = path.dirname(fileURLToPath(import.meta.url))
  const workspaceRoot = path.resolve(root, '..', '..')
  const scratchParent = path.join(workspaceRoot, '_tmp')
  fs.mkdirSync(scratchParent, { recursive: true })
  const scratch = fs.mkdtempSync(path.join(scratchParent, 'patch-memory-spaces-'))
  const copy = path.join(scratch, 'client.js')

  // 已安装副本可能已经打过补丁（本机就是），先按逆变换还原成未打补丁的样子再测。
  const installedText = fs.readFileSync(installed, 'utf8')
  const wasPatched = installedText.includes(PATCHED_CONDITION) && installedText.includes(EXPERIENCE_TEXT)
  const unpatched = wasPatched
    ? installedText.split(PATCHED_CONDITION).join(FOOTER_ANCHOR).split(EXPERIENCE_TEXT).join(MEMORY_TEXT)
    : installedText
  if (wasPatched) {
    // 逆变换必须精确：还原后再打一次补丁，应与安装副本逐字节一致。
    assert.equal(patchText(unpatched).text, installedText, '逆变换应与安装副本还原一致')
  }
  fs.writeFileSync(copy, unpatched, 'utf8')
  assert.equal(fs.statSync(copy).nlink, 1, '副本是独立 inode')

  const first = patchFile(copy, { backup: false })
  assert.equal(first.changed, true)
  assert.equal(first.nlinkAfter, 1, 'rename 覆盖后不是硬链接')

  const patched = fs.readFileSync(copy, 'utf8')
  assert.equal(countOf(patched, PATCHED_CONDITION), 1)
  assert.equal(countOf(patched, EXPERIENCE_TEXT), 2)
  const patchedBytes = Buffer.byteLength(patched, 'utf8')
  assert.ok(patchedBytes > first.bytesBefore, '只加了条件与文案，文件应变长')
  assert.ok(patchedBytes - first.bytesBefore < 4096, '改动量应在几百字节量级')

  // client.js 是 window.__ModuleLoader__.load(...) 包装，顶层没有 import/export，
  // 用 vm.Script 解析就等价于 `node --check`（沙箱里起子进程会被 EPERM 拦）。
  assert.doesNotThrow(() => new vm.Script(patched, { filename: copy }), '补丁后应能被解析')

  const second = patchFile(copy, { backup: false })
  assert.equal(second.changed, false, '第二次应无事可做')
  assert.equal(fs.readFileSync(copy, 'utf8'), patched)

  fs.rmSync(scratch, { recursive: true, force: true })
})
