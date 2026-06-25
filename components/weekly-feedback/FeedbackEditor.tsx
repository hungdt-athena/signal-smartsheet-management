'use client'
import { useEffect, useState, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useEditor, EditorContent, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Underline from '@tiptap/extension-underline'
import Link from '@tiptap/extension-link'
import { GameMention } from './GameMention'
import { GameSuggestion } from './GameSuggestion'
import { normalizeUrl } from '@/lib/game-link'

// ⌘ on Apple platforms, Ctrl elsewhere — for shortcut tooltips. Computed once;
// this is a client-only component (immediatelyRender:false), so navigator is safe.
const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent)
  ? '⌘' : 'Ctrl'

// The doc range a link will apply to, plus its current text. Picked when the
// popover opens so Apply can REPLACE exactly that range (never duplicate):
//   - a selection            → the selection
//   - cursor inside a link    → the whole link mark
//   - cursor touching a word  → that word
//   - cursor in blank space   → collapsed (pure insert)
function linkTarget(editor: Editor): { from: number; to: number; text: string } {
  const { state } = editor
  const { selection } = state
  if (editor.isActive('link')) {
    editor.commands.extendMarkRange('link')
    const s = editor.state.selection
    return { from: s.from, to: s.to, text: editor.state.doc.textBetween(s.from, s.to, ' ') }
  }
  if (!selection.empty) {
    return { from: selection.from, to: selection.to, text: state.doc.textBetween(selection.from, selection.to, ' ') }
  }
  // Collapsed: expand over the non-space run the cursor is touching (the word).
  const $pos = selection.$from
  const parent = $pos.parent
  const start = $pos.start()
  const text = parent.textContent
  const off = $pos.pos - start
  let l = off, r = off
  while (l > 0 && !/\s/.test(text[l - 1])) l--
  while (r < text.length && !/\s/.test(text[r])) r++
  if (l === r) return { from: selection.from, to: selection.from, text: '' } // blank space → insert
  return { from: start + l, to: start + r, text: text.slice(l, r) }
}

export function FeedbackEditor({ value, onChange }: { value: unknown; onChange: (doc: unknown) => void }) {
  const [linkOpen, setLinkOpen] = useState(false)
  const [linkUrl, setLinkUrl] = useState('')
  const [linkText, setLinkText] = useState('')                       // display text (editable)
  const [linkRange, setLinkRange] = useState<{ from: number; to: number }>({ from: 0, to: 0 })
  const [focusUrl, setFocusUrl] = useState(false)                    // text already known → jump to URL field
  const [linkPos, setLinkPos] = useState<{ left: number; top: number } | null>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const editor = useEditor({
    extensions: [
      StarterKit,
      Underline,
      Link.configure({ openOnClick: false, autolink: true }),
      GameMention,
      GameSuggestion,
    ],
    content: (typeof value === 'object' && value !== null ? value : '') as object | string,
    onUpdate: ({ editor }) => onChange(editor.getJSON()),
    immediatelyRender: false,
  })

  // Use a ref so the ⌘K keydown handler always sees the latest openLink.
  const openLinkRef = useRef<() => void>(() => {})

  const openLink = useCallback(() => {
    if (!editor) return
    const t = linkTarget(editor)
    setLinkRange({ from: t.from, to: t.to })
    setLinkText(t.text)
    setFocusUrl(t.text.trim() !== '')
    setLinkUrl(editor.getAttributes('link').href || '')
    // Anchor the popover under the start of the target range, clamped so it never
    // spills off the right edge.
    const c = editor.view.coordsAtPos(t.from)
    setLinkPos({ left: Math.max(8, Math.min(c.left, window.innerWidth - 328)), top: c.bottom + 6 })
    setLinkOpen(true)
  }, [editor])

  useEffect(() => { openLinkRef.current = openLink }, [openLink])

  const applyLink = () => {
    if (!editor) return
    const url = normalizeUrl(linkUrl)
    const { from, to } = linkRange
    if (!url) { // empty URL → strip the link from the target range
      editor.chain().focus().setTextSelection({ from, to }).unsetLink().run()
      setLinkOpen(false)
      return
    }
    const text = linkText.trim() || url
    const linked = { type: 'text', text, marks: [{ type: 'link', attrs: { href: url } }] }
    if (from === to) {
      // Pure insert (cursor in blank space) → add a trailing space so typing continues unlinked.
      editor.chain().focus().insertContentAt(from, [linked, { type: 'text', text: ' ' }]).run()
    } else {
      // Replace the target range with the linked text — no duplication.
      editor.chain().focus().insertContentAt({ from, to }, linked).run()
    }
    setLinkOpen(false)
  }

  const removeLink = () => {
    if (!editor) return
    const { from, to } = linkRange
    editor.chain().focus().setTextSelection({ from, to }).unsetLink().run()
    setLinkOpen(false)
  }

  // ⌘K / Ctrl+K → open inline link popover (no native prompt).
  useEffect(() => {
    if (!editor) return
    const dom = editor.view.dom
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        openLinkRef.current()
      }
    }
    dom.addEventListener('keydown', onKey)
    return () => dom.removeEventListener('keydown', onKey)
  }, [editor])

  // Click outside the popover (e.g. back into the text) dismisses it, like Docs.
  useEffect(() => {
    if (!linkOpen) return
    const onDown = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) setLinkOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [linkOpen])

  if (!editor) return null

  const cls = (active: boolean) => (active ? 'is-active' : undefined)
  const isEdit = editor.isActive('link')

  return (
    <div className="wf-editor">
      <div className="wf-toolbar">
        <button type="button" title={`Bold (${MOD}+B)`} className={cls(editor.isActive('bold'))} onClick={() => editor.chain().focus().toggleBold().run()}><b>B</b></button>
        <button type="button" title={`Italic (${MOD}+I)`} className={cls(editor.isActive('italic'))} onClick={() => editor.chain().focus().toggleItalic().run()}><i>I</i></button>
        <button type="button" title={`Underline (${MOD}+U)`} className={cls(editor.isActive('underline'))} onClick={() => editor.chain().focus().toggleUnderline().run()}><u>U</u></button>
        <button type="button" title="Bullet list" className={cls(editor.isActive('bulletList'))} onClick={() => editor.chain().focus().toggleBulletList().run()}>• List</button>
        <button type="button" title={`Link (${MOD}+K)`} className={cls(editor.isActive('link'))} onClick={openLink}>Link</button>
        <button type="button" title="Insert a game (paste a store link or search by name)" onClick={() => editor.chain().focus().insertContent('@').run()}>+ Game</button>
      </div>
      {linkOpen && linkPos && createPortal(
        <div ref={popRef} className="wf-linkpop" style={{ left: linkPos.left, top: linkPos.top }}>
          <input
            autoFocus={!focusUrl}
            type="text"
            value={linkText}
            onChange={e => setLinkText(e.target.value)}
            placeholder="Text to display"
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); applyLink() }
              if (e.key === 'Escape') { e.preventDefault(); setLinkOpen(false) }
            }}
          />
          <div className="wf-linkpop-row">
            <input
              autoFocus={focusUrl}
              type="text"
              value={linkUrl}
              onChange={e => setLinkUrl(e.target.value)}
              placeholder="Paste or type a link…"
              onKeyDown={e => {
                if (e.key === 'Enter') { e.preventDefault(); applyLink() }
                if (e.key === 'Escape') { e.preventDefault(); setLinkOpen(false) }
              }}
            />
            <button type="button" className="wf-linkpop-apply" onClick={applyLink}>Apply</button>
            {isEdit && <button type="button" className="wf-linkpop-remove" onClick={removeLink} title="Remove link">Remove</button>}
          </div>
        </div>,
        document.body,
      )}
      <EditorContent editor={editor} className="wf-prose" />
    </div>
  )
}
