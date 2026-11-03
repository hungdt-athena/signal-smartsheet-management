// One-off: turn the 2026-09-29 template inspect (flat list, depth = group nesting, box in pt)
// into a slides_v1.Schema$Presentation-shaped fixture for tests. When the service-account
// key is available, prefer dump-template.mjs, which writes the same file from the live deck.
import { readFileSync, writeFileSync } from 'node:fs'

const [src = '__tests__/fixtures/master-template-structure.json', out = '__tests__/fixtures/master-template.json'] = process.argv.slice(2)
const d = JSON.parse(readFileSync(src, 'utf8'))
const EMU = 12700
const dim = v => ({ magnitude: Math.round(v * EMU), unit: 'EMU' })

function toElement(e) {
  const base = { objectId: e.id }
  if (e.box) {
    base.size = { width: dim(e.box.w), height: dim(e.box.h) }
    base.transform = { scaleX: 1, scaleY: 1, translateX: Math.round(e.box.x * EMU), translateY: Math.round(e.box.y * EMU), unit: 'EMU' }
  }
  if (e.kind === 'group') return { ...base, transform: { scaleX: 1, scaleY: 1, translateX: 0, translateY: 0, unit: 'EMU' }, elementGroup: { children: [] } }
  if (e.kind === 'image') return { ...base, image: { contentUrl: 'https://example.invalid/i.png' } }
  if (e.kind === 'other') return { ...base, video: { source: 'YOUTUBE', id: 'sample' } }
  if (e.kind === 'line') return { ...base, line: {} }
  const shapeType = e.kind.split(':')[1] || 'TEXT_BOX'
  const shape = { shapeType }
  if (e.text) {
    const content = e.text.endsWith('\n') ? e.text : e.text + '\n'
    shape.text = { textElements: [{ startIndex: 0, endIndex: content.length, textRun: { content, style: { fontSize: { magnitude: 14, unit: 'PT' } } } }] }
  }
  return { ...base, shape }
}

const slides = d.slides.map(s => {
  const pageElements = []
  const stack = [] // stack[depth] = children array for that depth
  stack[0] = pageElements
  for (const e of s.elements) {
    const el = toElement(e)
    stack[e.depth].push(el)
    if (el.elementGroup) stack[e.depth + 1] = el.elementGroup.children
  }
  return { objectId: s.id, pageElements }
})
writeFileSync(out, JSON.stringify({ presentationId: 'fixture', title: d.title, pageSize: d.size, slides }, null, 1))
console.log('wrote', out, slides.length, 'slides')
