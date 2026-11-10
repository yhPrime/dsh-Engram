/**
 * 技能召回：描述解析（YAML 块标量）、覆盖率匹配、试用技能决策。
 * Run: node kernel/tests/skill-recall.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const skills = await import('../skills.js')
const engineModule = await import('../engine.js')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-recall-'))
const dataDir = path.join(root, 'exp')
fs.mkdirSync(dataDir, { recursive: true })
process.env.ENGRAM_DATA_DIR = dataDir
process.env.DSH_HOME = path.join(root, 'dsh-home')

let passed = 0
let failed = 0
async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}`)
    console.log(`       ${error && error.stack ? error.stack : error}`)
  }
}

function makeSkill(dir, slug, frontmatter, body, confidence) {
  const target = path.join(dir, 'skills', slug)
  fs.mkdirSync(target, { recursive: true })
  fs.writeFileSync(path.join(target, 'SKILL.md'), `---\n${frontmatter}\n---\n\n${body}\n`, 'utf8')
  fs.writeFileSync(path.join(target, 'skill.json'), JSON.stringify({
    id: slug,
    typeName: '代码 / 插件',
    context: [],
    triggers: [],
    confidence: { uses: 0, helped: 0, hurt: 0, lastUsedAt: null, ...(confidence || {}) },
    revisions: 0,
    obstacles: {},
    resolved: [],
    derivedFrom: [],
    order: 50,
    pendingCommit: false,
  }, null, 2), 'utf8')
}

makeSkill(dataDir, 'mirror-skill', 'name: 镜像技能\ndescription: |\n  把 Aelos 人形机器人的舞蹈动作左右镜像，\n  MOTORA 与 MOTORB 互换。', '# 何时用\n做左右镜像时。')
makeSkill(dataDir, 'page-skill', 'name: 页码技能\ndescription: >\n  理顺 PPTX 课件右下角页码，\n  修正分母与缺页。', '# 何时用\n页码乱时。')
makeSkill(dataDir, 'deck-skill', 'name: 改页技能\ndescription: 改既有 PPTX 课件里某一页的文案', '# 何时用\n改文案时。', { uses: 3, helped: 3, hurt: 0 })
makeSkill(dataDir, 'excel-skill', 'name: 表格技能\ndescription: 给 Excel 表格做数据透视表', '# 何时用\n透视时。', { uses: 3, helped: 3, hurt: 0 })

await check('YAML 块标量：`description: |` / `>` 能解析成完整描述（不是「|」）', () => {
  const mirror = skills.readSkillBySlug(dataDir, 'mirror-skill')
  assert.ok(mirror.description.includes('左右镜像'), `描述被截断：${JSON.stringify(mirror.description)}`)
  assert.equal(mirror.description.startsWith('|'), false)
  const page = skills.readSkillBySlug(dataDir, 'page-skill')
  assert.ok(page.description.includes('右下角页码'), `折叠块没解析：${JSON.stringify(page.description)}`)
})

await check('匹配：未养熟的技能也能按短语命中（覆盖率补救 Jaccard 稀释）', () => {
  const list = skills.listSkills(dataDir)
  const hit = skills.matchSkill(list, '把 Aelos 人形机器人的舞蹈动作左右镜像', { requireConfident: false })
  assert.ok(hit !== null, '未命中')
  assert.equal(hit.skill.slug, 'mirror-skill')
})

await check('召回决策：未养熟 → skill-trial，且带正文与试用说明', async () => {
  const engine = engineModule.createEngine({ dataDir, env: process.env })
  const result = await engine.recall({ intent: '理顺 PPTX 课件右下角页码' })
  assert.equal(result.mode, 'skill-trial', `mode=${result.mode}`)
  assert.equal(result.skill.id, 'page-skill')
  assert.ok(result.skill.body.length > 0, '试用技能没有正文')
  assert.match(result.note, /试用技能/u)
})

await check('召回决策：明显更像的未验证技能优先于养熟的旧技能（防错配）', async () => {
  const engine = engineModule.createEngine({ dataDir, env: process.env })
  // deck-skill 是养熟的（uses 3），但「页码」意图下 page-skill 分数明显更高
  const result = await engine.recall({ intent: '理顺 PPTX 课件右下角页码' })
  assert.equal(result.skill.id, 'page-skill', `错配成 ${result.skill.id}`)
})

await check('召回决策：养熟的技能直接给 skill 模式', async () => {
  const engine = engineModule.createEngine({ dataDir, env: process.env })
  const result = await engine.recall({ intent: '改既有 PPTX 课件里某一页的文案' })
  assert.equal(result.mode, 'skill', `mode=${result.mode}`)
  assert.equal(result.skill.id, 'deck-skill')
})

await check('召回决策：无关意图不硬塞技能', async () => {
  const engine = engineModule.createEngine({ dataDir, env: process.env })
  const result = await engine.recall({ intent: '给猫剪指甲的注意事项' })
  assert.equal(result.skill, undefined)
  assert.notEqual(result.mode, 'skill')
  assert.notEqual(result.mode, 'skill-trial')
})

await check('技能命中时经验候选并列返回（不再被技能模式吞掉）', async () => {
  const engine = engineModule.createEngine({ dataDir, env: process.env })
  await engine.record({ intent: '把 Aelos 人形机器人的舞蹈动作左右镜像', action: '先按 200−x 反转 19 号舵机，再互换 A↔B', outcome: 'success' })
  const result = await engine.recall({ intent: '把 Aelos 人形机器人的舞蹈动作左右镜像' })
  assert.equal(result.mode, 'skill-trial')
  assert.ok(Array.isArray(result.candidates), 'candidates 不是数组')
  assert.ok(result.candidates.length > 0, '技能模式把经验候选吞掉了')
})

await check('新技能默认排在高位（order 90），后续靠使用回归', () => {
  const created = skills.createSkill(dataDir, { slug: 'fresh-order', name: '新技能排序', description: '刚加进来的技能' })
  const meta = JSON.parse(fs.readFileSync(path.join(created.dir, 'skill.json'), 'utf8'))
  assert.equal(meta.order, 90, `新技能 order=${meta.order}`)
})
fs.rmSync(root, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
