/**
 * artifact-diff 测试（0.13.0 P3）：用真实 git 基线对比「交付版 vs 用户改后版」。
 *
 * Run: node tests/artifact-diff.test.mjs
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { diffArtifact, diffText, summarizeUserEdits } from '../artifact-diff.js'

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

function git(cwd, args) {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore', timeout: 30000, windowsHide: true })
}

function makeZip(files) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const [name, content] of Object.entries(files)) {
    const nameBuffer = Buffer.from(name, 'utf8')
    const data = Buffer.from(content, 'utf8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuffer.length, 26)
    locals.push(local, nameBuffer, data)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuffer.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBuffer)
    offset += 30 + nameBuffer.length + data.length
  }
  const centralBuffer = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(Object.keys(files).length, 8)
  eocd.writeUInt16LE(Object.keys(files).length, 10)
  eocd.writeUInt32LE(centralBuffer.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBuffer, eocd])
}

const slide = (size, text, x) => `<p:sld><p:cSld><p:spTree>
<p:sp><p:nvSpPr><p:cNvPr id="2" name="标题"/></p:nvSpPr><p:spPr><a:off x="${x}" y="100"/><a:ext cx="800" cy="200"/></p:spPr>
<p:txBody><a:p><a:r><a:rPr sz="${size}"/><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>
</p:spTree></p:cSld></p:sld>`

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-artifact-'))
git(repo, ['init'])
git(repo, ['config', 'user.email', 'test@example.com'])
git(repo, ['config', 'user.name', 'Test'])

fs.writeFileSync(path.join(repo, 'note.md'), '第一行\n第二行\n', 'utf8')
fs.writeFileSync(path.join(repo, 'deck.pptx'), makeZip({ 'ppt/slides/slide1.xml': slide(4000, '封面', 100) }))
fs.writeFileSync(path.join(repo, '.gitignore'), '*.tmp\n', 'utf8')
git(repo, ['add', '.'])
git(repo, ['commit', '-m', 'baseline'])

check('文本：行差异能识别改动行', () => {
  fs.writeFileSync(path.join(repo, 'note.md'), '第一行\n第二行改\n', 'utf8')
  const diff = diffArtifact({ cwd: repo, artifact: 'note.md' })
  assert.ok(diff !== null)
  assert.equal(diff.changed, true)
  assert.ok(diff.summary.includes('改动 1 行'), diff.summary)
})

check('pptx：结构化差异（字号/文本）', () => {
  fs.writeFileSync(path.join(repo, 'deck.pptx'), makeZip({ 'ppt/slides/slide1.xml': slide(3200, '封面改', 200) }))
  const diff = diffArtifact({ cwd: repo, artifact: 'deck.pptx' })
  assert.ok(diff !== null)
  assert.equal(diff.changed, true)
  assert.ok(diff.summary.includes('字号'), diff.summary)
  assert.ok(diff.changes.length >= 2)
})

check('无基线（未提交的新文件）：返回 null', () => {
  fs.writeFileSync(path.join(repo, 'new.md'), 'x', 'utf8')
  assert.equal(diffArtifact({ cwd: repo, artifact: 'new.md' }), null)
})

check('多产物汇总：summary ≤80 字', () => {
  const out = summarizeUserEdits({ cwd: repo, artifacts: ['note.md', 'deck.pptx'] })
  assert.equal(out.files.length, 2)
  assert.ok(out.summary.length <= 80)
})

check('diffText：纯新增/删除能算出来', () => {
  const added = diffText('a\n', 'a\nb\n')
  assert.equal(added.added, 1)
  const removed = diffText('a\nb\n', 'a\n')
  assert.equal(removed.removed, 1)
})

check('回归 BUG-5：diffText 样例行按码点截断，不劈 emoji', () => {
  const result = diffText(`${'😀'.repeat(40)}\n`, `${'🎉'.repeat(40)}\n`)
  for (const sample of result.samples) {
    for (const text of [sample.from, sample.to]) {
      assert.doesNotMatch(text, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
    }
  }
})

console.log('')
console.log(`结果：通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exit(1)
