/**
 * ooxml 解析测试（0.13.0 P3）：零依赖 zip 读取、pptx 形状抽取、docx 段落、结构化差异。
 *
 * Run: node tests/ooxml.test.mjs
 */
import assert from 'node:assert/strict'

import { diffOffice, extractDocParagraphs, extractSlideShapes, readOffice, readZipEntries } from '../ooxml.js'

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

/** 最小 zip 写入器（stored，无压缩）：够让读取端跑通。 */
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
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt32LE(0, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuffer.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, nameBuffer, data)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt32LE(0, 12)
    central.writeUInt32LE(0, 16)
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

const slide = (titleSize, text, x) => `<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree>
<p:sp><p:nvSpPr><p:cNvPr id="2" name="标题"/></p:nvSpPr><p:spPr><a:off x="${x}" y="100"/><a:ext cx="800" cy="200"/></p:spPr>
<p:txBody><a:p><a:r><a:rPr sz="${titleSize}"/><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>
<p:sp><p:nvSpPr><p:cNvPr id="3" name="正文"/></p:nvSpPr><p:spPr><a:off x="10" y="20"/><a:ext cx="30" cy="40"/></p:spPr>
<p:txBody><a:p><a:r><a:rPr sz="1800"/><a:t>正文内容</a:t></a:r></a:p></p:txBody></p:sp>
</p:spTree></p:cSld></p:sld>`

check('zip 读取：stored 条目能读回', () => {
  const zip = makeZip({ 'ppt/slides/slide1.xml': '<x/>' })
  const entries = readZipEntries(zip)
  assert.equal(entries.size, 1)
  assert.equal(entries.get('ppt/slides/slide1.xml').toString('utf8'), '<x/>')
})

check('坏文件：返回空 Map / null，不抛错', () => {
  assert.equal(readZipEntries(Buffer.from('not a zip')).size, 0)
  assert.equal(readOffice(Buffer.from('not a zip'), 'pptx'), null)
})

check('pptx 形状抽取：名称/坐标/尺寸/文本/字号', () => {
  const zip = makeZip({ 'ppt/slides/slide1.xml': slide(4000, '封面标题', 100) })
  const office = readOffice(zip, 'pptx')
  assert.equal(office.kind, 'pptx')
  const shapes = office.slides[0].shapes
  assert.equal(shapes.length, 2)
  assert.deepEqual(
    { name: shapes[0].name, x: shapes[0].x, cx: shapes[0].cx, text: shapes[0].text, size: shapes[0].size },
    { name: '标题', x: 100, cx: 800, text: '封面标题', size: 40 },
  )
})

check('pptx 差异：字号/位置/文本能压成一句人话', () => {
  const before = readOffice(makeZip({ 'ppt/slides/slide1.xml': slide(4000, '封面标题', 100) }), 'pptx')
  const after = readOffice(makeZip({ 'ppt/slides/slide1.xml': slide(3200, '封面标题改', 200) }), 'pptx')
  const { summary, changes } = diffOffice(before, after)
  assert.ok(changes.length >= 3, `changes=${JSON.stringify(changes)}`)
  assert.ok(summary.includes('字号 40→32'), summary)
  assert.ok(summary.includes('标题 文本改'), summary)
  assert.ok(summary.length <= 80)
})

check('docx：段落抽取 + 差异', () => {
  const xml = (text) => `<w:document><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p><w:p><w:r><w:t>第二段</w:t></w:r></w:p></w:body></w:document>`
  const before = readOffice(makeZip({ 'word/document.xml': xml('第一段') }), 'docx')
  const after = readOffice(makeZip({ 'word/document.xml': xml('第一段改') }), 'docx')
  assert.deepEqual(before.paragraphs, ['第一段', '第二段'])
  const { changes, summary } = diffOffice(before, after)
  assert.equal(changes.length, 1)
  assert.ok(summary.includes('段落1 文本改'), summary)
})

check('extractDocParagraphs 直接抽文本', () => {
  assert.deepEqual(extractDocParagraphs('<w:p><w:r><w:t>A</w:t></w:r><w:r><w:t>B</w:t></w:r></w:p>'), ['AB'])
})

check('extractSlideShapes 空输入不抛错', () => {
  assert.deepEqual(extractSlideShapes(''), [])
})

console.log('')
console.log(`结果：通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exit(1)
