/**
 * 手改学习（0.13.0 P3）：用户手改过的产物 → 差异摘要。
 *
 * 基线：`git show HEAD:<相对路径>`（= 助手交付的版本）；工作树里的 = 用户改后的版本。
 * 文本类用行 diff；pptx/docx 用 ooxml 结构化对比（位置/尺寸/字号/文本）。
 * 这里只产出「改了什么」，不判断好坏——判断留给模型。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { diffOffice, readOffice } from './ooxml.js'

const TEXT_EXTS = new Set(['md', 'txt', 'json', 'js', 'mjs', 'ts', 'py', 'css', 'html', 'htm', 'csv', 'yml', 'yaml'])

function extOf(file) {
  return path.extname(String(file || '')).toLowerCase().replace(/^\./, '')
}

function gitShow(cwd, relPath) {
  // 沙箱里把 git 输出接到 pipe 会 EPERM：写到临时文件再读（stdio 用 fd，不走管道）。
  const tmp = path.join(os.tmpdir(), `engram-gitshow-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`)
  let fd = null
  try {
    fd = fs.openSync(tmp, 'w')
    execFileSync('git', ['-C', cwd, 'show', `HEAD:${relPath}`], {
      timeout: 20000,
      windowsHide: true,
      stdio: ['ignore', fd, 'ignore'],
    })
    fs.closeSync(fd)
    fd = null
    return fs.readFileSync(tmp)
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        // 已关闭
      }
    }
    try {
      fs.unlinkSync(tmp)
    } catch {
      // 临时文件不存在
    }
  }
}

/** 文本行级差异：只给「改了哪几行、增删多少」，不塞全文。 */
export function diffText(before, after) {
  const oldLines = String(before || '').split(/\r?\n/)
  const newLines = String(after || '').split(/\r?\n/)
  const limit = Math.min(oldLines.length, newLines.length)
  let changed = 0
  const samples = []
  for (let index = 0; index < limit; index += 1) {
    if (oldLines[index] === newLines[index]) continue
    changed += 1
    if (samples.length < 2) samples.push({ line: index + 1, from: oldLines[index].slice(0, 40), to: newLines[index].slice(0, 40) })
  }
  const added = Math.max(0, newLines.length - oldLines.length)
  const removed = Math.max(0, oldLines.length - newLines.length)
  const parts = []
  if (changed > 0) parts.push(`改动 ${changed} 行`)
  if (added > 0) parts.push(`新增 ${added} 行`)
  if (removed > 0) parts.push(`删除 ${removed} 行`)
  return { changed, added, removed, samples, summary: parts.join('，') }
}

/** 读一个产物的「交付版 vs 用户版」并求差；读不到基线返回 null。 */
export function diffArtifact({ cwd, artifact }) {
  const rel = String(artifact || '').trim()
  if (rel === '' || cwd === undefined || cwd === null) return null
  const current = path.resolve(cwd, rel)
  let afterBuffer
  try {
    afterBuffer = fs.readFileSync(current)
  } catch {
    return null
  }
  const beforeBuffer = gitShow(cwd, rel.replace(/\\/g, '/'))
  if (beforeBuffer === null) return null
  const ext = extOf(rel)
  if (ext === 'pptx' || ext === 'docx') {
    const before = readOffice(beforeBuffer, ext)
    const after = readOffice(afterBuffer, ext)
    if (before === null || after === null) return null
    const { summary, changes } = diffOffice(before, after)
    return { artifact: rel, kind: ext, summary, changes, changed: changes.length > 0 }
  }
  if (TEXT_EXTS.has(ext)) {
    const result = diffText(beforeBuffer.toString('utf8'), afterBuffer.toString('utf8'))
    return { artifact: rel, kind: ext, ...result, changes: result.samples, changed: result.changed + result.added + result.removed > 0 }
  }
  return { artifact: rel, kind: ext, summary: '', changes: [], changed: false }
}

/** 多个产物一起看：返回 { summary, files[] }，summary 压到 ≤80 字（给 pending brief 用）。 */
export function summarizeUserEdits({ cwd, artifacts }) {
  const files = []
  for (const artifact of Array.isArray(artifacts) ? artifacts.slice(0, 5) : []) {
    const diff = diffArtifact({ cwd, artifact })
    if (diff !== null && diff.changed) files.push(diff)
  }
  if (files.length === 0) return { summary: '', files: [] }
  const parts = files.map((file) => `${path.basename(file.artifact)}：${file.summary || '有改动'}`)
  const summary = parts.join('；')
  return { summary: summary.length <= 80 ? summary : `${summary.slice(0, 79)}…`, files }
}
