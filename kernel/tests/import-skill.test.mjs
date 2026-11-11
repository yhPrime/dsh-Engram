/**
 * 外部技能导入测试（0.12.0）：/skills/import 背后的 kernel 逻辑
 *  - frontmatter 解析 / 标签抽取 / 类型猜测 / 本地兜底；
 *  - 模型回复解析：正常 JSON、```json 围栏、垃圾文本、order 越界；
 *  - 模型给的分类不在类型列表里 → 留空（不伪造类型）；
 *  - 流式块拼装（字符串 / {text} / {delta:{text}}）；
 *  - 端到端：有 llm → classifier='session'；没有 llm → 'local'；文件读不到 → 抛错。
 * Run: node kernel/tests/import-skill.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  DEFAULT_ORDER,
  MAX_TAGS,
  alignClassification,
  classifyWithSession,
  collectStreamText,
  extractTags,
  guessCategory,
  importSkill,
  localClassify,
  parseClassification,
  parseSkillMarkdown,
  readImportSource,
  routeOf,
} from '../import-skill.js'
import { listSkills, readSkill } from '../skills.js'

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

async function checkAsync(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}`)
    console.log(`       ${error && error.message ? error.message : error}`)
  }
}

function tempDataDir() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-import-'))
  return path.join(base, '.exp')
}

/** 一个假模型：按 scripted 文本吐块。 */
function fakeLlm(text, { fail = false } = {}) {
  return {
    stream() {
      if (fail) throw new Error('provider exploded')
      return (async function* () {
        for (const piece of String(text).split('')) yield { type: 'text-delta', text: piece }
      })()
    },
  }
}

const TYPES = ['代码 / 插件', 'PPT / 课件', '文档 / 教案']

console.log('== frontmatter ==')

check('有 frontmatter：name/description/body 都要拆出来', () => {
  const parsed = parseSkillMarkdown('---\nname: 我的技能\ndescription: 一句话说明\n---\n\n# 何时用\n正文\n')
  assert.equal(parsed.name, '我的技能')
  assert.equal(parsed.description, '一句话说明')
  assert.equal(parsed.body, '# 何时用\n正文')
})

check('没有 frontmatter：整篇当正文，name 留空', () => {
  const parsed = parseSkillMarkdown('# 标题\n正文')
  assert.equal(parsed.name, '')
  assert.equal(parsed.body, '# 标题\n正文')
})

check('CRLF 也要能解析', () => {
  const parsed = parseSkillMarkdown('---\r\nname: 甲\r\n---\r\n正文\r\n')
  assert.equal(parsed.name, '甲')
  assert.equal(parsed.body, '正文')
})

check('frontmatter 值带引号要去掉', () => {
  const parsed = parseSkillMarkdown("---\nname: '带引号'\n---\n正文\n")
  assert.equal(parsed.name, '带引号')
})

console.log('== 本地兜底 ==')

check('标签抽取去重并按出现次数排序', () => {
  const tags = extractTags('dsh 插件 导入 技能 导入 技能 导入')
  assert.equal(tags[0], '导入', `最高频应是「导入」，实际 ${tags[0]}`)
  assert.ok(tags.length <= MAX_TAGS)
})

check('停用词不进标签', () => {
  const tags = extractTags('这是一个可以使用的技能，但是需要内容')
  assert.ok(!tags.includes('这个'))
  assert.ok(!tags.includes('技能'))
})

check('类型按出现次数猜', () => {
  assert.equal(guessCategory('做 PPT 课件，PPT 课件要好看', TYPES), 'PPT / 课件')
})

check('类型一个都没出现 → 空串', () => {
  assert.equal(guessCategory('完全无关的文本', TYPES), '')
})

check('本地兜底如实标 local，且不给假排序', () => {
  const out = localClassify({ text: '做 PPT 课件', typeNames: TYPES })
  assert.equal(out.classifier, 'local')
  assert.equal(out.order, DEFAULT_ORDER)
  assert.equal(out.category, 'PPT / 课件')
  assert.ok(out.note.includes('不额外消耗'))
})

console.log('== 模型回复解析 ==')

check('裸 JSON 能解析', () => {
  const parsed = parseClassification('{"category":"代码 / 插件","tags":["a","b"],"order":70}')
  assert.deepEqual(parsed, { category: '代码 / 插件', tags: ['a', 'b'], order: 70, summaryZh: '' })
})

check('```json 围栏能剥掉', () => {
  const parsed = parseClassification('```json\n{"category":"x","tags":[],"order":10}\n```')
  assert.equal(parsed.category, 'x')
})

check('前后带解释也能挖出 JSON', () => {
  const parsed = parseClassification('好的：{"category":"x","tags":["t"],"order":5} 就这样')
  assert.equal(parsed.order, 5)
})

check('垃圾文本返回 null', () => {
  assert.equal(parseClassification('我不知道'), null)
  assert.equal(parseClassification(''), null)
})

check('order 越界会被夹回 0–100', () => {
  assert.equal(parseClassification('{"category":"x","tags":[],"order":999}').order, 100)
  assert.equal(parseClassification('{"category":"x","tags":[],"order":-5}').order, 0)
  assert.equal(parseClassification('{"category":"x","tags":[]}').order, DEFAULT_ORDER)
})

check('tags 去重并限制条数', () => {
  const parsed = parseClassification('{"category":"x","tags":["a","a","b","c","d","e","f","g"],"order":1}')
  assert.deepEqual(parsed.tags, ['a', 'b', 'c', 'd', 'e', 'f'])
})

check('分类不在类型列表里 → 留空，不伪造类型', () => {
  const aligned = alignClassification(parseClassification('{"category":"编的类型","tags":[],"order":1}'), TYPES)
  assert.equal(aligned.category, '')
})

check('分类在列表里 → 保留', () => {
  const aligned = alignClassification(parseClassification('{"category":"文档 / 教案","tags":[],"order":1}'), TYPES)
  assert.equal(aligned.category, '文档 / 教案')
})

console.log('== 流式拼装 ==')

check('字符串块直接拼', () => {
  assert.equal(collectStreamText(['a', 'b']), 'ab')
})

check('{text} 与 {delta:{text}} 都认', () => {
  assert.equal(collectStreamText([{ text: 'a' }, { delta: { text: 'b' } }, null, 42]), 'ab')
})

check('routeOf 规整 provider/model', () => {
  assert.deepEqual(routeOf({ provider: 'p', model: 'm' }), { provider: 'p', model: 'm' })
  assert.equal(routeOf({ provider: '', model: 'm' }), null)
  assert.equal(routeOf(null), null)
})

console.log('== 来源读取 ==')

check('粘贴正文可用', () => {
  const out = readImportSource({ content: '# 技能' })
  assert.equal(out.text, '# 技能')
})

check('两者都空要报错', () => {
  assert.throws(() => readImportSource({}), /要么给一个 SKILL\.md 路径/)
})

check('文件不存在要报错', () => {
  assert.throws(() => readImportSource({ filePath: path.join(os.tmpdir(), 'definitely-not-here-123.md') }), /读不到这个路径/)
})

check('直接给技能文件夹：读里面的 SKILL.md', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-dir-'))
  try {
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: 文件夹技能\ndescription: 测试\n---\n\n# 何时用\n测试\n', 'utf8')
    const out = readImportSource({ filePath: dir })
    assert.equal(out.source, 'SKILL.md')
    assert.match(out.text, /文件夹技能/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

check('文件夹里没有 SKILL.md：提示要放在根目录', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-dir-'))
  try {
    fs.mkdirSync(path.join(dir, 'scripts'))
    assert.throws(() => readImportSource({ filePath: dir }), /这个文件夹里没有 SKILL\.md/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

console.log('== 端到端 ==')

await checkAsync('有模型会话：用模型给的分类，classifier=session', async () => {
  const dataDir = tempDataDir()
  const llm = fakeLlm('{"category":"文档 / 教案","tags":["教案","常规课"],"order":77}')
  const out = await importSkill({
    dataDir,
    content: '---\nname: 教案排版\ndescription: 把教案排好看\n---\n正文',
    typeNames: TYPES,
    deps: { getLlm: () => llm, getRoute: () => ({ provider: 'p', model: 'm' }) },
  })
  assert.equal(out.classifier, 'session')
  assert.equal(out.category, '文档 / 教案')
  // 新建技能一律从高位起步（模型给的 77 低于 90，不采用）
  assert.equal(out.order, 90)
  assert.equal(out.action, 'created')
  const row = readSkill(path.join(dataDir, 'skills', out.slug))
  assert.ok(row !== null, '技能目录应已落盘')
  assert.equal(row.meta.typeName, '文档 / 教案')
  assert.equal(row.meta.order, 90)
})

await checkAsync('模型给了中文摘要 → 并进 description（英文技能可被中文任务召回）', async () => {
  const dataDir = tempDataDir()
  const llm = fakeLlm('{"category":"代码 / 插件","tags":["动画","前端"],"order":60,"summaryZh":"给网页加 CSS 动画并调节缓动"}')
  const out = await importSkill({
    dataDir,
    content: '---\nname: animate-helpers\ndescription: Build smooth web animations\n---\n正文',
    typeNames: TYPES,
    deps: { getLlm: () => llm, getRoute: () => ({ provider: 'p', model: 'm' }) },
  })
  const row = readSkill(path.join(dataDir, 'skills', out.slug))
  assert.ok(row !== null)
  assert.ok(row.description.includes('给网页加 CSS 动画并调节缓动'), `描述没带中文摘要：${row.description}`)
})
await checkAsync('没有模型：退回本地，classifier=local 且不报错', async () => {
  const dataDir = tempDataDir()
  const out = await importSkill({
    dataDir,
    content: '做一些 PPT 课件相关的事',
    typeNames: TYPES,
    deps: { getLlm: () => undefined, getRoute: () => null },
  })
  assert.equal(out.classifier, 'local')
  assert.equal(out.category, 'PPT / 课件')
  assert.equal(out.order, DEFAULT_ORDER)
  assert.equal(listSkills(dataDir).length, 1)
})

await checkAsync('模型调用炸了：也要退回本地，不能把导入整体废掉', async () => {
  const dataDir = tempDataDir()
  const out = await importSkill({
    dataDir,
    content: '# 随便什么',
    typeNames: TYPES,
    deps: { getLlm: () => fakeLlm('', { fail: true }), getRoute: () => ({ provider: 'p', model: 'm' }) },
  })
  assert.equal(out.classifier, 'local')
})

await checkAsync('模型答非所问（不是 JSON）：退回本地', async () => {
  const dataDir = tempDataDir()
  const out = await importSkill({
    dataDir,
    content: '# 随便什么',
    typeNames: TYPES,
    deps: { getLlm: () => fakeLlm('我不太确定'), getRoute: () => ({ provider: 'p', model: 'm' }) },
  })
  assert.equal(out.classifier, 'local')
})

await checkAsync('同一技能再导一次走 updated，不新建目录', async () => {
  const dataDir = tempDataDir()
  const body = '---\nname: 同一个\ndescription: d\n---\n正文'
  const first = await importSkill({ dataDir, content: body, typeNames: TYPES, deps: {} })
  const second = await importSkill({ dataDir, content: body, typeNames: TYPES, deps: {} })
  assert.equal(first.action, 'created')
  assert.equal(second.action, 'updated')
  assert.equal(listSkills(dataDir).length, 1)
})

await checkAsync('classifyWithSession 缺 llm 或 route 时直接返回 null', async () => {
  assert.equal(await classifyWithSession({ llm: null, route: { provider: 'p', model: 'm' }, text: 'x', typeNames: TYPES }), null)
  assert.equal(await classifyWithSession({ llm: fakeLlm('{}'), route: null, text: 'x', typeNames: TYPES }), null)
})

console.log('')
if (failed > 0) {
  console.log(`失败 ${failed} 项 / 通过 ${passed} 项`)
  process.exit(1)
}
console.log(`全部通过（${passed} 项）`)
