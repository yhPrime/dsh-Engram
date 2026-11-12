/**
 * 召回与数据质量测试（2026-10-29 加的回归面）：
 *  - 自然短意图必须召得回（旧实现过阈 0/17）；
 *  - artifact 别名归一（pptx / 幻灯片 / 课件 都算 ppt）；
 *  - 无关意图不许假召回；
 *  - 无成败对照时排序必须标 degenerate + mode=evidence，别假装 Â 有区分度；
 *  - 有对照（success vs failed）时回到 advantage 模式，好做法排前；
 *  - 写入侧清洗工具调用残渣、从残渣里捞回丢失的类型；
 *  - exp_type assign 能定点改挂类型且不动 hits；
 *  - 回报口径只有 kernel 的 OUTCOME_SCORES 一份。
 * Run: node tests/recall.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { buildTools } from '../tools.js'
import {
  DEGENERATE_ADV_SPREAD,
  rankExperiences,
  readStore,
  scoreOf,
  upsertExperience,
  visibleExperiences,
  writeStore,
} from '../store.js'
import { RECALL_MIN_SIMILARITY, canonicalArtifacts, similarityV2, stateOf } from '../retrieval.js'

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

function tempStore(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  return { dir, store: readStore(dir) }
}

/* ------------------------------------------------------- 召回：短意图 --- */

const ppt = tempStore('exp-recall-ppt-')
upsertExperience(ppt.store, { intent: '在既有 PPTX 课件中间插一页过渡页', action: '整页克隆相邻页 + Morph 拷贝整块', outcome: 'success', type: 'PPT / 课件', note: '页码按插页后物理页序重算' })
upsertExperience(ppt.store, { intent: 'PPT 课件新增过渡页前做史实核校', action: '先读史实底稿再落字', outcome: 'success', type: 'PPT / 课件' })
upsertExperience(ppt.store, { intent: '给小学课堂互动推演做计分简化', action: '三处冗余收成一个只加不减的数', outcome: 'success', type: '代码 / 插件' })
upsertExperience(ppt.store, { intent: '在沙箱里推 GitHub 被拒', action: 'escalate 到 danger-full-access', outcome: 'success', type: '环境 / 部署' })

check('自然短意图「做个研学课 PPT」必须召得回，且插页那条排第一', () => {
  const ranked = rankExperiences(ppt.store, '做个研学课 PPT', 5)
  assert.ok(ranked.neighbor_count >= 1, `neighbor_count=${ranked.neighbor_count}`)
  const top = ranked.candidates[0]
  assert.equal(top.evidence[0].intent.includes('PPT'), true, `top=${top.evidence[0].intent}`)
})

check('artifact 别名归一：pptx / 幻灯片 / 课件 命中同一组', () => {
  assert.deepEqual(canonicalArtifacts('做个 PPTX'), ['ppt'])
  assert.deepEqual(canonicalArtifacts('幻灯片排版'), ['ppt'])
  assert.deepEqual(canonicalArtifacts('课件改版式'), ['ppt'])
  const query = stateOf('幻灯片插一页')
  const candidate = stateOf('在既有 PPTX 课件中间插一页过渡页', '整页克隆')
  assert.ok(similarityV2(query, candidate) > 0.3, '同一 artifact 组 + 共同词应给出高分')
})

check('artifact 组只收产物名词：动作别名「推送」不算 git（2026-11-07 修）', () => {
  // 曾把「推送」当 git 别名 → 描述里写了「推送」的「网络 / 心跳」簇把 git 意图吸走，路由误判 3 条。
  assert.deepEqual(canonicalArtifacts('推送'), [])
  assert.deepEqual(canonicalArtifacts('上传附件'), [])
  assert.deepEqual(canonicalArtifacts('推送到 GitHub'), ['git'])
  assert.deepEqual(canonicalArtifacts('清空一个 git 工作区'), ['git'])
})

check('无关意图不假召回（阈值以上也不行）', () => {
  for (const intent of ['帮我订一张机票', '写一首关于秋天的诗', '今天天气怎么样']) {
    const ranked = rankExperiences(ppt.store, intent, 5)
    assert.equal(ranked.neighbor_count, 0, `${intent} 召回了 ${ranked.neighbor_count} 条`)
    assert.ok(ranked.note.includes('没有相似度'), `${intent} 的 note 应说明召回为空`)
  }
})

check('阈值与常量对外可见，便于审计', () => {
  assert.ok(RECALL_MIN_SIMILARITY > 0 && RECALL_MIN_SIMILARITY < 0.5)
  assert.ok(DEGENERATE_ADV_SPREAD > 0)
})

/* ------------------------------------------------- 排序：无对照 / 有对照 --- */

check('全成功库：mode=evidence + degenerate，rank_score 改按证据强度', () => {
  const ranked = rankExperiences(ppt.store, 'PPT 插页怎么做', 5)
  assert.equal(ranked.mode, 'evidence')
  assert.equal(ranked.degenerate, true)
  assert.ok(ranked.note.includes('不具区分度'), ranked.note)
  assert.ok(ranked.candidates.every((item) => item.advantage === 0), '全成功样本的 Â 应恒为 0')
  const top = ranked.candidates[0]
  assert.equal(top.rank_score, top.evidence_strength)
  assert.ok(top.evidence_strength > 0)
})

const contrast = tempStore('exp-recall-contrast-')
const successAction = 'subtree split 出发布分支再 force-with-lease'
const failedAction = '直接 git push 原始分支'
upsertExperience(contrast.store, { intent: '把插件发布到 GitHub', action: successAction, outcome: 'accepted', type: '代码 / 插件' })
upsertExperience(contrast.store, { intent: '把插件发布到 GitHub', action: failedAction, outcome: 'failed', type: '代码 / 插件', note: '推错了旧树' })

check('有对照：失败做法不被取代，两条都在（负样本必须留着）', () => {
  const visible = visibleExperiences(contrast.store)
  assert.equal(visible.length, 2, `visible=${visible.length}`)
  assert.equal(visible.some((item) => item.outcome === 'failed'), true)
})

check('有对照：mode=advantage，成功做法advantage 为正、失败为负，且排在前', () => {
  const ranked = rankExperiences(contrast.store, '把插件发布到 GitHub', 5)
  assert.equal(ranked.mode, 'advantage')
  assert.equal(ranked.degenerate, false)
  assert.ok(ranked.advantage_spread > DEGENERATE_ADV_SPREAD, `spread=${ranked.advantage_spread}`)
  const top = ranked.candidates[0]
  assert.equal(top.action, successAction)
  assert.ok(top.advantage > 0, `top.advantage=${top.advantage}`)
  const bad = ranked.candidates.find((item) => item.action === failedAction)
  assert.ok(bad && bad.advantage < 0, `failed 的 advantage=${bad && bad.advantage}`)
})

check('空库：不抛错，mode=evidence 且 note 提示先照常做再记录', () => {
  const empty = tempStore('exp-recall-empty-')
  const ranked = rankExperiences(empty.store, '做一个从没做过的东西', 5)
  assert.equal(ranked.candidates.length, 0)
  assert.equal(ranked.mode, 'evidence')
})

/* ------------------------------------------------------------- 写入闸门 --- */

check('写入清洗：note 里的 </note> 与 <parameter> 残渣被剥掉', () => {
  const { dir, store } = tempStore('exp-sanitize-')
  const tools = buildTools((definition) => definition, { dataDir: dir })
  const record = tools.find((tool) => tool.name === 'exp_record')
  const out = record.execute({
    intent: 'PPT 中插一页过渡页',
    action: '克隆相邻页再重画',
    outcome: 'accepted',
    note: '插入后页码要按物理页序重算\n</note>\n<parameter name="type">PPT / 课件',
  })
  assert.equal(out.noteSanitized, true)
  assert.equal(out.typeRecoveredFromNote, true, '类型应从残渣里捞回')
  assert.equal(out.typeName, 'PPT / 课件')
  const stored = readStore(dir).experiences[0]
  assert.ok(!/<\/?note>|<parameter/i.test(stored.note), `残留：${stored.note}`)
  assert.ok(stored.note.includes('页码'), '正常文字要保留')
})

check('exp_type assign：定点改挂类型，不动 hits、不新增条', () => {
  const { dir, store } = tempStore('exp-assign-')
  const misplaced = upsertExperience(store, { intent: 'PPT 页码乱了', action: '重排页码', outcome: 'success' })
  upsertExperience(store, { intent: '做研学课课件', action: '套母版', outcome: 'success', type: 'PPT / 课件' })
  const tools = buildTools((definition) => definition, { dataDir: dir })
  const typeTool = tools.find((tool) => tool.name === 'exp_type')
  // 先落盘，工具会重新读文件
  writeStore(dir, store)
  const before = readStore(dir)
  const target = before.experiences.find((item) => item.id === misplaced.experience.id)
  assert.equal(target.typeName, '未分类')
  const out = typeTool.execute({ action: 'assign', id: target.id, name: 'PPT / 课件' })
  assert.equal(out.to, 'PPT / 课件')
  assert.equal(out.from, '未分类')
  const after = readStore(dir)
  const updated = after.experiences.find((item) => item.id === target.id)
  assert.equal(updated.typeName, 'PPT / 课件')
  assert.equal(updated.hits, 1, 'assign 不能伪造 hits')
  assert.equal(after.experiences.length, before.experiences.length)
})

/* ------------------------------------------------------------ 回报口径 --- */

check('回报口径只有一份：与非参数 critic 的 OUTCOME_SCORES 对齐', () => {
  assert.equal(scoreOf('accepted'), 1)
  assert.equal(scoreOf('success'), 0.8)
  assert.equal(scoreOf('partial'), 0.3)
  assert.equal(scoreOf('unknown'), 0)
  assert.equal(scoreOf('failed'), -0.6)
  assert.equal(scoreOf('corrected'), -0.8)
  assert.equal(scoreOf('aborted'), -1)
  assert.equal(scoreOf('success', 0.15), 0.15, '显式分数优先')
})

for (const prefix of ['exp-recall-ppt-', 'exp-recall-contrast-', 'exp-sanitize-', 'exp-assign-', 'exp-recall-empty-']) {
  for (const entry of fs.readdirSync(os.tmpdir())) {
    if (entry.startsWith(prefix)) {
      try {
        fs.rmSync(path.join(os.tmpdir(), entry), { recursive: true, force: true })
      } catch {}
    }
  }
}

console.log('')
console.log(`结果：通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exit(1)
