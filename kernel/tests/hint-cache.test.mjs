/**
 * 提示段缓存（0.14.0 P0）：
 *  - 提示段每次模型请求都跑，readStore 与 listSkills 各约 24 ms / 61 ms；
 *  - 缓存只服务提示段，写盘立刻失效，跨进程最迟 1–2 秒；
 *  - 记录/召回/控制台仍走 readStore / listSkills 原路，不吃缓存。
 *
 * Run: node kernel/tests/hint-cache.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { readStore, readManifest, renderHint, writeStore } from '../store.js'
import { clearSkillsHintCache, listSkills, listSkillsCached } from '../skills.js'

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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-hint-cache-'))

function makeSkill(slug, name) {
  const skillDir = path.join(dir, 'skills', slug)
  fs.mkdirSync(skillDir, { recursive: true })
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} 专用说明\n---\n\n正文\n`, 'utf8')
}

// 先铺 1 条经验 + 2 个技能
const base = readStore(dir)
base.experiences.push({ id: 'ex_1', intent: '给课件插页', action: '克隆相邻页', outcome: 'success', G: 0.8, GOutcome: 0.8, ts: '2026-11-12T00:00:00.000Z', typeId: 'ty_other', typeName: '未分类', verdict: 'decided', hits: 1 })
writeStore(dir, base)
makeSkill('alpha', '阿尔法')
makeSkill('beta', '贝塔')

check('listSkillsCached：连续两次命中同一份结果（同一引用）', () => {
  const first = listSkillsCached(dir, { onlyLocal: true })
  const second = listSkillsCached(dir, { onlyLocal: true })
  assert.equal(first.length, 2)
  assert.equal(second, first, '第二次应是缓存里的同一数组')
})

check('listSkills（非提示路径）不吃缓存：每次都是新数组', () => {
  const a = listSkills(dir, { onlyLocal: true })
  const b = listSkills(dir, { onlyLocal: true })
  assert.notEqual(a, b)
})

check('技能目录变了但没清缓存 → 仍给旧结果（证明确实缓存生效）', () => {
  const before = listSkillsCached(dir, { onlyLocal: true })
  makeSkill('gamma', '伽马')
  const after = listSkillsCached(dir, { onlyLocal: true })
  assert.equal(after.length, 2, `缓存期内应仍是 2 个，实际 ${after.length}`)
  assert.equal(after, before)
})

check('clearSkillsHintCache 后立刻看到新技能', () => {
  clearSkillsHintCache(dir)
  const fresh = listSkillsCached(dir, { onlyLocal: true })
  assert.equal(fresh.length, 3)
})

check('提示段连续两次文本一致', () => {
  const a = renderHint({ dataDir: dir, hintMode: 'slim', hintSkills: true }, 1400)
  const b = renderHint({ dataDir: dir, hintMode: 'slim', hintSkills: true }, 1400)
  assert.equal(a, b)
  assert.ok(a.includes('技能：'))
})

check('writeStore 后提示段立刻看到新条（同进程失效）', () => {
  const before = renderHint({ dataDir: dir, hintMode: 'slim', hintSkills: false }, 1400)
  const next = readStore(dir)
  next.experiences.push({ id: 'ex_2', intent: '给课件加装饰', action: '先画一个圆', outcome: 'unknown', G: 0, ts: '2026-11-12T01:00:00.000Z', typeId: 'ty_other', typeName: '未分类', verdict: 'pending', registeredAt: '2026-11-12T01:00:00.000Z', hits: 1 })
  writeStore(dir, next)
  const after = renderHint({ dataDir: dir, hintMode: 'slim', hintSkills: false }, 1400)
  assert.notEqual(after, before, '写盘后提示段必须变')
  assert.ok(after.includes('待判定'), `应出现待判定行：${after}`)
})

check('readStore 永远是最新（不吃提示缓存）', () => {
  const fresh = readStore(dir)
  assert.equal(fresh.experiences.length, 2)
})

check('提示段缓存不改变计数口径（与 readStore 一致）', () => {
  const hint = renderHint({ dataDir: dir, hintMode: 'slim', hintSkills: false }, 1400)
  const count = readStore(dir).experiences.filter((item) => !item.deleted_at && !item.superseded_by && !item.retired_at).length
  assert.ok(hint.includes(`共 ${count} 条`), `提示段计数应与 readStore 一致（${count}）：${hint}`)
})

check('指纹只认 manifest：只改分片（不动 manifest）时提示段缓存不失效', () => {
  const before = renderHint({ dataDir: dir, hintMode: 'slim', hintSkills: false }, 1400)
  const manifest = readManifest(dir)
  assert.notEqual(manifest, null, '这个用例要求已经是分片布局')
  // 找一条 decided 的记录，改成 pending：真被重算的话提示段会多出「待判定」行。
  let patchedFile = ''
  for (const bucket of manifest.buckets) {
    const file = path.join(dir, bucket.file)
    const text = fs.readFileSync(file, 'utf8')
    const patched = text.replace('"verdict":"decided"', '"verdict":"pending"')
    if (patched !== text) {
      fs.writeFileSync(file, patched, 'utf8')
      patchedFile = file
      break
    }
  }
  assert.notEqual(patchedFile, '', '夹具里应有一条 verdict=decided 的记录')
  const after = renderHint({ dataDir: dir, hintMode: 'slim', hintSkills: false }, 1400)
  assert.equal(after, before, 'manifest 没变 → 提示段继续用缓存（指纹来源只有 manifest，不扫分片）')
  // readStore 不吃提示缓存：分片的改动它立刻能看到，说明上面确实是缓存命中而不是数据没变。
  assert.ok(readStore(dir).experiences.some((row) => row.verdict === 'pending'), 'readStore 应看到分片改动')
})

console.log('')
console.log(`结果：通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exit(1)
