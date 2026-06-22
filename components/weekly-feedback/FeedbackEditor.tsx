'use client'
import { useEffect, useState, useCallback, useRef } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Underline from '@tiptap/extension-underline'
import Link from '@tiptap/extension-link'
import { GameMention } from './GameMention'
import { GameSuggestion } from './GameSuggestion'

// ⌘ on Apple platforms, Ctrl elsewhere — for shortcut tooltips. Computed once;
// this is a client-only component (immediatelyRender:false), so navigator is safe.
const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent)
  ? '⌘' : 'Ctrl'

export function FeedbackEditor({ value, onChange }: { value: unknown; onChange: (doc: unknown) => void }) {
  const [linkOpen, setLinkOpen] = useState(false)
  const [linkUrl, setLinkUrl] = useState('')
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
    setLinkUrl(editor.getAttributes('link').href || '')
    setLinkOpen(true)
  }, [editor])

  useEffect(() => { openLinkRef.current = openLink }, [openLink])

  const applyLink = () => {
    if (!editor) return
    const url = linkUrl.trim()
    if (url) editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run()
    else editor.chain().focus().unsetLink().run()
    setLinkOpen(false)
  }

  const removeLink = () => {
    if (!editor) return
    editor.chain().focus().unsetLink().run()
    setLinkOpen(false)
  }

  // ⌘K / Ctrl+K → open inline link bar (no native prompt).
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

  if (!editor) return null

  const cls = (active: boolean) => (active ? 'is-active' : undefined)

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
      {linkOpen && (
        <div className="wf-linkbar">
          <input
            autoFocus
            type="text"
            value={linkUrl}
            onChange={e => setLinkUrl(e.target.value)}
            placeholder="https://…"
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); applyLink() }
              if (e.key === 'Escape') { e.preventDefault(); setLinkOpen(false) }
            }}
          />
          <button type="button" onClick={applyLink}>Apply</button>
          <button type="button" onClick={removeLink}>Remove</button>
        </div>
      )}
      <EditorContent editor={editor} className="wf-prose" />
    </div>
  )
}
