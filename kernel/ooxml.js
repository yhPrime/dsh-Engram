/**
 * 零依赖 Office 解析（0.13.0 P3）：读 zip、抽 pptx 的形状（位置/尺寸/字号/文本）与 docx 段落。
 *
 * 为什么不用第三方库：插件是零运行时依赖的单包，装 zip 库会破坏「拷进去就能用」。
 * 这里只实现 Office 文件实际用得到的部分：EOCD → 中央目录 → deflate 解压。
 */
import zlib from 'node:zlib'

const EOCD = 0x06054b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50

/** 读 zip 的所有条目：Map<entryName, Buffer>；坏文件返回空 Map（调用方降级）。 */
export function readZipEntries(buffer) {
  const entries = new Map()
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) return entries
  let eocd = -1
  for (let index = buffer.length - 22; index >= Math.max(0, buffer.length - 65557); index -= 1) {
    if (buffer.readUInt32LE(index) === EOCD) {
      eocd = index
      break
    }
  }
  if (eocd < 0) return entries
  const count = buffer.readUInt16LE(eocd + 10)
  let offset = buffer.readUInt32LE(eocd + 16)
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL) break
    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength)
    offset += 46 + nameLength + extraLength + commentLength
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== LOCAL) continue
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const data = buffer.subarray(dataStart, dataStart + compressedSize)
    try {
      entries.set(name, method === 0 ? Buffer.from(data) : zlib.inflateRawSync(data))
    } catch {
      // 坏条目跳过
    }
  }
  return entries
}

function decodeXmlEntities(text) {
  return String(text || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function attr(text, name) {
  const match = new RegExp(`${name}="([^"]*)"`).exec(String(text || ''))
  return match === null ? '' : decodeXmlEntities(match[1])
}

/** 从 slide XML 抽形状：{ name, x, y, cx, cy, text, size }（EMU 与 pt 原值，不做单位换算）。 */
export function extractSlideShapes(xml) {
  const shapes = []
  const blocks = String(xml || '').match(/<p:sp>[\s\S]*?<\/p:sp>/g) || []
  for (const block of blocks) {
    const name = attr(/<p:cNvPr[^>]*>/.exec(block) ? /<p:cNvPr[^>]*>/.exec(block)[0] : '', 'name')
    const off = /<a:off[^>]*x="(-?\d+)"[^>]*y="(-?\d+)"/.exec(block)
    const ext = /<a:ext[^>]*cx="(\d+)"[^>]*cy="(\d+)"/.exec(block)
    const texts = [...block.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((item) => decodeXmlEntities(item[1]))
    const sizeMatch = /sz="(\d+)"/.exec(block)
    shapes.push({
      name,
      x: off === null ? null : Number(off[1]),
      y: off === null ? null : Number(off[2]),
      cx: ext === null ? null : Number(ext[1]),
      cy: ext === null ? null : Number(ext[2]),
      text: texts.join('').trim(),
      size: sizeMatch === null ? null : Number(sizeMatch[1]) / 100,
    })
  }
  return shapes
}

/** 从 docx document.xml 抽段落文本。 */
export function extractDocParagraphs(xml) {
  return [...String(xml || '').matchAll(/<w:p[\s>][\s\S]*?<\/w:p>/g)].map((item) => (
    [...item[0].matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((run) => decodeXmlEntities(run[1])).join('')
  )).filter((line) => line.trim() !== '')
}

/** 读一个 Office 文件：按扩展名返回 { kind, slides|paragraphs }；解析失败返回 null。 */
export function readOffice(buffer, ext) {
  const lower = String(ext || '').toLowerCase().replace(/^\./, '')
  if (!['pptx', 'docx'].includes(lower)) return null
  const entries = readZipEntries(buffer)
  if (entries.size === 0) return null
  if (lower === 'pptx') {
    const slides = []
    const names = [...entries.keys()].filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort((left, right) => Number(left.match(/(\d+)/)[1]) - Number(right.match(/(\d+)/)[1]))
    for (const name of names) slides.push({ name, shapes: extractSlideShapes(entries.get(name).toString('utf8')) })
    return { kind: 'pptx', slides }
  }
  return { kind: 'docx', paragraphs: extractDocParagraphs(entries.get('word/document.xml') ? entries.get('word/document.xml').toString('utf8') : '') }
}

/**
 * 对比两份 Office 文档的结构差异，压成一句人话（≤80 字）+ 明细。
 * 只比「用户改得动」的字段：位置、尺寸、字号、文本。
 */
export function diffOffice(before, after) {
  const changes = []
  if (before === null || after === null || before.kind !== after.kind) return { summary: '', changes }
  if (before.kind === 'pptx') {
    const beforeShapes = before.slides.flatMap((slide) => slide.shapes)
    const afterShapes = after.slides.flatMap((slide) => slide.shapes)
    const count = Math.min(beforeShapes.length, afterShapes.length)
    for (let index = 0; index < count; index += 1) {
      const oldShape = beforeShapes[index]
      const newShape = afterShapes[index]
      const label = newShape.name || oldShape.name || `形状${index + 1}`
      if (oldShape.text !== newShape.text && (oldShape.text || newShape.text)) {
        changes.push({ target: label, field: 'text', from: oldShape.text, to: newShape.text })
      }
      if (oldShape.size !== newShape.size && (oldShape.size || newShape.size)) {
        changes.push({ target: label, field: 'size', from: oldShape.size, to: newShape.size })
      }
      for (const [field, name] of [['x', '左'], ['y', '上'], ['cx', '宽'], ['cy', '高']]) {
        if (oldShape[field] !== newShape[field] && (oldShape[field] !== null || newShape[field] !== null)) {
          changes.push({ target: label, field, from: oldShape[field], to: newShape[field], label: name })
        }
      }
    }
    if (beforeShapes.length !== afterShapes.length) {
      changes.push({ target: '整页', field: 'shapes', from: beforeShapes.length, to: afterShapes.length })
    }
  } else {
    const count = Math.max(before.paragraphs.length, after.paragraphs.length)
    for (let index = 0; index < count; index += 1) {
      const oldText = before.paragraphs[index] || ''
      const newText = after.paragraphs[index] || ''
      if (oldText !== newText) changes.push({ target: `段落${index + 1}`, field: 'text', from: oldText, to: newText })
    }
  }
  return { summary: summarizeChanges(changes), changes }
}

function cut(text, max) {
  const value = String(text === undefined || text === null ? '' : text).replace(/\s+/g, ' ').trim()
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

/** 差异压成一句：标题 字号 40→32；装饰块 左 100→120。 */
export function summarizeChanges(changes, max = 80) {
  const parts = []
  for (const change of Array.isArray(changes) ? changes : []) {
    if (change.field === 'text') parts.push(`${cut(change.target, 12)} 文本改`)
    else if (change.field === 'size') parts.push(`${cut(change.target, 12)} 字号 ${change.from}→${change.to}`)
    else if (change.field === 'shapes') parts.push(`形状数 ${change.from}→${change.to}`)
    else parts.push(`${cut(change.target, 12)} ${change.label || change.field} ${change.from}→${change.to}`)
  }
  return cut(parts.join('；'), max)
}
