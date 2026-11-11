/**
 * 手改摘要进 pending brief（0.13.0 P3 集成）：
 * 记录时带 artifacts + config.cwd → 下一次回执里的 pending brief 应包含「手改：…」。
 *
 * Run: node tests/pending-edit.test.mjs
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { buildTools } from '../tools.js'

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

const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore', timeout: 30000, windowsHide: true })

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-pending-edit-'))
git(repo, ['init'])
git(repo, ['config', 'user.email', 'test@example.com'])
git(repo, ['config', 'user.name', 'Test'])
fs.writeFileSync(path.join(repo, 'note.md'), '第一行\n第二行\n', 'utf8')
git(repo, ['add', '.'])
git(repo, ['commit', '-m', 'baseline'])

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-pending-data-'))
const tools = buildTools((definition) => definition, { dataDir, cwd: repo, autoBind: false })
const call = (name, args) => tools.find((item) => item.name === name).execute(args)

check('pending brief 带「手改」摘要', () => {
  call('exp_record', { intent: '写一页过渡页文案', action: '先写两行草稿', typeName: '文档 / 教案', artifacts: ['note.md'] })
  fs.writeFileSync(path.join(repo, 'note.md'), '第一行\n第二行改过了\n', 'utf8')
  const recalled = call('exp_recall', { intent: '写一页过渡页文案' })
  const brief = recalled.pending && recalled.pending[0] ? recalled.pending[0].brief : ''
  assert.ok(brief.includes('手改'), `brief=${brief}`)
  assert.ok(brief.length <= 80, `brief 超长：${brief.length}`)
})

check('没有 artifacts 的 pending 不出「手改」', () => {
  const cleanData = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-pending-data2-'))
  const cleanTools = buildTools((definition) => definition, { dataDir: cleanData, cwd: repo, autoBind: false })
  const clean = (name, args) => cleanTools.find((item) => item.name === name).execute(args)
  clean('exp_record', { intent: '整理会议纪要', action: '先列要点', typeName: '文档 / 教案' })
  const recalled = clean('exp_recall', { intent: '整理会议纪要' })
  const text = (recalled.pending || []).map((item) => item.brief).join('|')
  assert.ok(!text.includes('手改'), text)
})

console.log('')
console.log(`结果：通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exit(1)
