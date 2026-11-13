/**
 * 一键分类临时会话：预算/无工具/最小上下文/解析/本地兜底。
 * Run: node kernel/tests/experience-classify.test.mjs
 */
import assert from 'node:assert/strict'
import { classifyExperienceWithSession, localClassifyExperience, EXPERIENCE_SESSION_MAX_TOKENS } from '../experience-classify.js'

let passed = 0
let failed = 0
const check = (name, fn) => {
  try { fn(); passed += 1; console.log(`  ok   ${name}`) } catch (error) { failed += 1; console.log(`  FAIL ${name}`); console.log(`       ${error.message}`) }
}
const llmOf = (reply, seen) => ({
  stream(options) {
    if (seen) seen.push(options)
    return (async function* () { yield reply })()
  },
})

await check('临时会话只发最小上下文、低 token、不注入工具', async () => {
  const seen = []
  const reply = '{"category":"办公","tags":["PPT","版式"]}'
  const out = await classifyExperienceWithSession({ llm: llmOf(reply, seen), route: { provider: 'p', model: 'm' }, text: 'x'.repeat(5000), typeNames: ['办公', '开发'], tagNames: ['PPT'] })
  assert.equal(out.category, '办公')
  assert.deepEqual(out.tags, ['PPT', '版式'])
  assert.equal(out.classifier, 'session')
  assert.equal(seen.length, 1)
  assert.equal(seen[0].maxTokens, EXPERIENCE_SESSION_MAX_TOKENS)
  assert.equal(seen[0].temperature, 0)
  assert.equal(seen[0].tools, undefined)
  assert.ok(seen[0].messages[0].content[0].text.length < 1700)
})

await check('模型给的分类不在候选里：拒绝，退回 null', async () => {
  const out = await classifyExperienceWithSession({ llm: llmOf('{"category":"不存在","tags":["x"]}'), route: { provider: 'p', model: 'm' }, text: '做 PPT', typeNames: ['办公'] })
  assert.equal(out, null)
})

check('没有模型：本地关键词兜底，标记 local', () => {
  const out = localClassifyExperience({ text: 'python-pptx 自动插页', typeNames: ['开发', '办公'], tagNames: ['PPT'] })
  assert.equal(out.classifier, 'local')
  assert.equal(out.category, '办公')
})

console.log('')
console.log(`结果：通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exit(1)
