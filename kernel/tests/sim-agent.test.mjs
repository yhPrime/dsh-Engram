/**
 * 行为模拟测试（不拟真，只模拟智能体的四段回路）：
 *
 *   记忆（exp_record）→ 回想（exp_recall）→ 使用（照召回做，或不用）→ 更新（exp_record 同做法 / exp_feedback）
 *
 * 数据是假的，数值是可控的：G=0.99 就该排第一，G=-0.99 就该沉底。
 * 这里断言的是「回路行为」，不是「数据像不像真的」。
 *
 * Run: node tests/sim-agent.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { readStore, readUsage, writeStore } from '../store.js'
import { abstractState } from '../kernel.js'
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

/** 模拟智能体：只通过工具面动作，和真实 agent 看到的接口一致。 */
class SimAgent {
  constructor(dataDir) {
    this.dataDir = dataDir
    this.tools = buildTools((definition) => definition, { dataDir })
  }

  call(name, args) {
    const tool = this.tools.find((item) => item.name === name)
    return tool.execute(args)
  }

  record(input) {
    return this.call('exp_record', input)
  }

  recall(intent, extra = {}) {
    return this.call('exp_recall', { intent, ...extra })
  }

  feedback(id, result) {
    return this.call('exp_feedback', { id, result })
  }

  /** 使用：照召回结果采用 top1 的做法（模拟「照着经验做」）。 */
  adoptTop(recallResult) {
    const top = recallResult.candidates && recallResult.candidates[0]
    return top ? top.action : null
  }

  evidenceIds(recallResult) {
    const ids = []
    for (const candidate of recallResult.candidates || []) {
      for (const evidence of candidate.evidence || []) ids.push(evidence.id)
    }
    return ids
  }
}

const newAgent = () => new SimAgent(fs.mkdtempSync(path.join(os.tmpdir(), 'exp-sim-')))

check('记忆 → 回想：正回报做法排在负回报前面，负样本仍被召回', () => {
  const agent = newAgent()
  const good = agent.record({ intent: '做研学课 PPT 插页', action: '先定主题色再排版', outcome: 'success', type: 'PPT / 课件' })
  const bad = agent.record({ intent: '做研学课 PPT 插页', action: '直接套模板', outcome: 'failed', type: 'PPT / 课件', note: '页脚错位' })
  const recalled = agent.recall('做研学课 PPT 插页')
  assert.equal(recalled.candidates[0].action, '先定主题色再排版')
  assert.equal(recalled.mode, 'advantage', '有正负对照时应走 advantage 排序')
  const ids = agent.evidenceIds(recalled)
  assert.ok(ids.includes(good.id) && ids.includes(bad.id), '两条都应被召回（负样本保留做对照）')
})

check('使用 → 更新：照 top1 再做一次，就地更新 hits 而不是新增', () => {
  const agent = newAgent()
  agent.record({ intent: '给插件跑测试', action: '先跑 npm test', outcome: 'success', type: '代码' })
  const recalled = agent.recall('给插件跑测试')
  const adopted = agent.adoptTop(recalled)
  assert.equal(adopted, '先跑 npm test')
  const again = agent.record({ intent: '给插件跑测试', action: adopted, outcome: 'success', type: '代码' })
  assert.equal(again.action, 'updated')
  assert.equal(again.hits, 2)
  assert.equal(readStore(agent.dataDir).experiences.filter((x) => !x.deleted_at && !x.superseded_by).length, 1)
})

check('用错 → 下沉：连败后原来排第一的会掉到负样本之后', () => {
  const agent = newAgent()
  const good = agent.record({ intent: '给课件排页码', action: '克隆相邻页再改', outcome: 'success', type: 'PPT / 课件' })
  const bad = agent.record({ intent: '给课件排页码', action: '硬改页脚文本', outcome: 'failed', type: 'PPT / 课件', note: '分母不对' })
  assert.equal(agent.recall('给课件排页码').candidates[0].action, '克隆相邻页再改')
  for (let i = 0; i < 4; i += 1) agent.feedback(good.id, 'hurt')
  const after = agent.recall('给课件排页码')
  assert.equal(after.candidates[0].action, '硬改页脚文本', 'G 被压到负值以下后，连失败做法都会排到它前面')
  const badG = after.candidates.find((candidate) => candidate.action === '硬改页脚文本').evidence[0].G
  assert.ok(badG < 0, '失败那条仍是负值（负样本没被洗白）')
  assert.ok(readStore(agent.dataDir).experiences.find((x) => x.id === bad.id))
})

check('新成功做法 → 取代旧做法：旧条隐藏但保留', () => {
  const agent = newAgent()
  const old = agent.record({ intent: '发布插件到 GitHub', action: 'git subtree split 后推送', outcome: 'success', type: '代码' })
  const made = agent.record({ intent: '发布插件到 GitHub', action: '用 git commit-tree 直接造提交', outcome: 'success', type: '代码' })
  assert.equal(made.action, 'superseded')
  assert.equal(made.supersededId, old.id)
  const recalled = agent.recall('发布插件到 GitHub')
  assert.ok(!agent.evidenceIds(recalled).includes(old.id), '被取代的旧条不再召回')
  const kept = readStore(agent.dataDir).experiences.find((item) => item.id === old.id)
  assert.ok(kept && kept.superseded_by === made.id, '旧条仍在库里，标记 superseded_by')
})

check('失败样本不被成功清掉（负样本保留）', () => {
  const agent = newAgent()
  agent.record({ intent: '装插件到 profile', action: 'dsh plugin add 目录', outcome: 'failed', type: '环境 / 部署', note: '目录形式不装' })
  agent.record({ intent: '装插件到 profile', action: 'dsh plugin add tgz', outcome: 'success', type: '环境 / 部署' })
  const rows = readStore(agent.dataDir).experiences.filter((item) => !item.deleted_at && !item.superseded_by)
  assert.equal(rows.length, 2, '一负一正应并存')
  assert.ok(rows.some((item) => item.G < 0))
})

check('同族 ≥3 条 → 归纳提示只给一句；不足 3 条 → 不给', () => {
  const agent = newAgent()
  agent.record({ intent: '做研学课 PPT 封面页', action: '做法甲', outcome: 'success', type: 'PPT / 课件' })
  agent.record({ intent: '给研学课 PPT 加一张地图页', action: '做法乙', outcome: 'success', type: 'PPT / 课件' })
  agent.record({ intent: '检查研学课 PPT 的排版', action: '做法丙', outcome: 'failed', type: 'PPT / 课件' })
  const recalled = agent.recall('研学课 PPT', { limit: 3 })
  assert.equal(typeof recalled.induction, 'string')
  assert.equal(recalled.induction.includes('\n'), false)
  assert.ok(recalled.induction.includes('本次可见 3 条'))

  const fresh = newAgent()
  fresh.record({ intent: '写教案任务单', action: '做法甲', outcome: 'success', type: '文档 / 教案' })
  assert.equal(fresh.recall('写教案任务单').induction, undefined)
})

check('排序尊重可控假值：G=0.99 第一，G=-0.99 不进前三', () => {
  const agent = newAgent()
  const seed = agent.record({ intent: '整理 Excel 表格', action: '种子', outcome: 'success', type: '表格 / 数据' })
  const dir = agent.dataDir
  const store = readStore(dir)
  const type = store.types.find((item) => item.id === seed.typeId) || store.types.find((item) => item.name === '表格 / 数据')
  for (let i = 0; i < 20; i += 1) {
    const intent = `整理 Excel 表格：第 ${i} 种数据清洗场景`
    const action = `做法 ${i}`
    const G = i === 3 ? 0.99 : (i === 7 ? -0.99 : 0.6)
    const ts = new Date(Date.now() - i * 60000).toISOString()
    store.experiences.push({
      id: `ex_sim${String(i).padStart(3, '0')}`,
      ts, lastSeenAt: ts, hits: 1,
      intent, action,
      state: abstractState(intent, action),
      step_rewards: [G], G, GOutcome: G, GSource: 'outcome',
      outcome: G < 0 ? 'failed' : 'success',
      note: '', origin: 'manual',
      typeId: type.id, typeName: type.name,
      deleted_at: null, superseded_by: null,
    })
  }
  writeStore(dir, store)

  const recalled = agent.recall('整理 Excel 表格数据', { limit: 5 })
  assert.equal(recalled.candidates[0].action, '做法 3', 'G=0.99 应排第一')
  assert.ok(!recalled.candidates.slice(0, 3).some((candidate) => candidate.action === '做法 7'), 'G=-0.99 不应进前三')
})

check('调用日志与行为一一对应：四段回路都留痕', () => {
  const agent = newAgent()
  const made = agent.record({ intent: '查论文结论', action: '先读摘要', outcome: 'success', type: '调研 / 资料' })
  agent.recall('查论文结论')
  agent.feedback(made.id, 'helped')
  const usage = readUsage(agent.dataDir)
  assert.deepEqual(usage.map((row) => row.tool), ['exp_record', 'exp_recall', 'exp_feedback'])
  assert.equal(usage[1].hit, true)
  assert.equal(usage[2].result, 'helped')
})

check('取代链 A→B→C：C 指向 B，不是回头改写 A', () => {
  const agent = newAgent()
  const a = agent.record({ intent: '发布插件到 GitHub', action: '做法甲', outcome: 'success', type: '代码' })
  const b = agent.record({ intent: '发布插件到 GitHub', action: '做法乙', outcome: 'success', type: '代码' })
  const c = agent.record({ intent: '发布插件到 GitHub', action: '做法丙', outcome: 'success', type: '代码' })
  assert.equal(b.action, 'superseded')
  assert.equal(c.action, 'superseded')
  const store = readStore(agent.dataDir)
  const rowA = store.experiences.find((item) => item.id === a.id)
  const rowB = store.experiences.find((item) => item.id === b.id)
  const rowC = store.experiences.find((item) => item.id === c.id)
  assert.equal(rowA.superseded_by, b.id)
  assert.equal(rowB.superseded_by, c.id, 'C 必须取代当前可见的 B')
  assert.equal(rowC.supersedes, b.id)
  const ids = agent.evidenceIds(agent.recall('发布插件到 GitHub'))
  assert.deepEqual(ids, [c.id], '三次取代后只应召回 C')
})

check('再记一条已被取代的做法：复活它（而不是静默更新到隐藏条或新开重复条）', () => {
  const agent = newAgent()
  const a = agent.record({ intent: '发布插件到 GitHub', action: '做法甲', outcome: 'success', type: '代码' })
  const b = agent.record({ intent: '发布插件到 GitHub', action: '做法乙', outcome: 'success', type: '代码' })
  assert.equal(b.action, 'superseded')
  const again = agent.record({ intent: '发布插件到 GitHub', action: '做法甲', outcome: 'success', type: '代码' })
  assert.equal(again.action, 'revived', '同一做法又做成了 → 解除隐藏')
  assert.equal(again.id, a.id)
  const store = readStore(agent.dataDir)
  const rowA = store.experiences.find((item) => item.id === a.id)
  assert.equal(rowA.superseded_by, null)
  assert.ok(typeof rowA.revived_at === 'string')
  assert.equal(rowA.hits, 2, '复活后 hits 递增')
  const rowB = store.experiences.find((item) => item.id === b.id)
  assert.equal(rowB.superseded_by, a.id, '复活要顶替现任：B 被 A 隐掉')
  assert.equal(rowA.supersedes, b.id)
  const visible = store.experiences.filter((item) => !item.deleted_at && !item.superseded_by)
  assert.equal(visible.length, 1)
  assert.equal(visible[0].id, a.id)
  assert.ok(rowA.history.some((event) => event.type === 'revived'))
})

check('反馈后重记成功：就地更新基准，但反馈历史保留、G 仍为负', () => {
  const agent = newAgent()
  const made = agent.record({ intent: '给插件跑测试', action: '先跑 npm test', outcome: 'success', type: '代码' })
  agent.feedback(made.id, 'hurt')
  agent.feedback(made.id, 'hurt')
  const retried = agent.record({ intent: '给插件跑测试', action: '先跑 npm test', outcome: 'success', type: '代码' })
  assert.equal(retried.action, 'updated', 'outcome 没翻转，就地更新')
  const rows = readStore(agent.dataDir).experiences.filter((item) => !item.deleted_at && !item.superseded_by)
  assert.equal(rows.length, 1)
  const row = rows[0]
  assert.equal(row.GOutcome, 0.8, '基准回到 outcome')
  assert.ok(row.G < 0, '反馈历史还在，G 不应被重置成 0.8')
  assert.equal(row.GSource, 'feedback')
  assert.equal(row.feedback.hurt, 2)
})

check('limit 只影响输出条数，不影响排名与 mode', () => {
  const agent = newAgent()
  agent.record({ intent: '整理 Excel 表格', action: '先清洗再透视', outcome: 'success', type: '表格 / 数据' })
  agent.record({ intent: '整理 Excel 表格', action: '直接排序交差', outcome: 'failed', type: '表格 / 数据', note: '没去重' })
  const wide = agent.recall('整理 Excel 表格', { limit: 8 })
  const narrow = agent.recall('整理 Excel 表格', { limit: 1 })
  assert.equal(narrow.candidates.length, 1)
  assert.equal(narrow.candidates[0].action, wide.candidates[0].action, 'limit=1 的 top1 应与 limit=8 一致')
  assert.equal(narrow.mode, wide.mode)
})

check('全负族：给出 warning，提醒别照做', () => {
  const agent = newAgent()
  agent.record({ intent: '装插件到 profile', action: '做法甲', outcome: 'failed', type: '环境 / 部署', note: '目录不装' })
  agent.record({ intent: '装插件到 profile', action: '做法乙', outcome: 'failed', type: '环境 / 部署', note: '缺 tgz' })
  const recalled = agent.recall('装插件到 profile')
  assert.equal(typeof recalled.warning, 'string')
  assert.ok(recalled.warning.includes('全是负回报'))
})

check('类型计数只算可见条（取代后 3 条应显示 1）', () => {
  const agent = newAgent()
  agent.record({ intent: '发布插件到 GitHub', action: '做法甲', outcome: 'success', type: '代码' })
  agent.record({ intent: '发布插件到 GitHub', action: '做法乙', outcome: 'success', type: '代码' })
  agent.record({ intent: '发布插件到 GitHub', action: '做法丙', outcome: 'success', type: '代码' })
  const listed = agent.call('exp_type', { action: 'list' })
  const type = (listed.types || []).find((item) => item.name === '代码')
  assert.ok(type, '应列出该类型')
  assert.equal(type.count, 1, 'count 应为可见条数')
})

console.log('')
console.log(`结果：通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exit(1)
