'use client'
import { useEffect, useState } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Underline from '@tiptap/extension-underline'
import Link from '@tiptap/extension-link'
import { GameSearch } from './GameSearch'
import { GameAlikeGame } from './types'

// ⌘ on Apple platforms, Ctrl elsewhere — for shortcut tooltips. Computed once;
// this is a client-only component (immediatelyRender:false), so navigator is safe.
const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent)
  ? '⌘' : 'Ctrl'

export function FeedbackEditor({ value, onChange }: { value: unknown; onChange: (doc: unknown) => void }) {
  const [showInsert, setShowInsert] = useState(false)
  const editor = useEditor({
    extensions: [
      StarterKit,
      Underline,
      Link.configure({ openOnClick: false, autolink: true }),
    ],
    content: (typeof value === 'object' && value !== null ? value : '') as object | string,
    onUpdate: ({ editor }) => onChange(editor.getJSON()),
    immediatelyRender: false,
  })

  // ⌘K / Ctrl+K → link prompt. Tiptap's Link extension binds no shortcut by
  // default; bold/italic/underline already come from StarterKit + Underline.
  useEffect(() => {
    if (!editor) return
    const dom = editor.view.dom
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        const url = window.prompt('URL:')?.trim()
        if (url) editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run()
        else if (url === '') editor.chain().focus().unsetLink().run()
      }
    }
    dom.addEventListener('keydown', onKey)
    return () => dom.removeEventListener('keydown', onKey)
  }, [editor])

  if (!editor) return null

  const cls = (active: boolean) => (active ? 'is-active' : undefined)
  const insertGame = (g: GameAlikeGame) => {
    setShowInsert(false)
    if (g.app_link) {
      editor.chain().focus()
        .insertContent([
          { type: 'text', text: g.title, marks: [{ type: 'link', attrs: { href: g.app_link } }] },
          { type: 'text', text: ' ' },
        ])
        .run()
    } else {
      editor.chain().focus().insertContent(`${g.title} `).run()
    }
  }

  const setLink = () => {
    const url = window.prompt('URL:')?.trim()
    if (url) editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run()
    else editor.chain().focus().unsetLink().run()
  }

  return (
    <div className="wf-editor">
      <div className="wf-toolbar">
        <button type="button" title={`Bold (${MOD}+B)`} className={cls(editor.isActive('bold'))} onClick={() => editor.chain().focus().toggleBold().run()}><b>B</b></button>
        <button type="button" title={`Italic (${MOD}+I)`} className={cls(editor.isActive('italic'))} onClick={() => editor.chain().focus().toggleItalic().run()}><i>I</i></button>
        <button type="button" title={`Underline (${MOD}+U)`} className={cls(editor.isActive('underline'))} onClick={() => editor.chain().focus().toggleUnderline().run()}><u>U</u></button>
        <button type="button" title="Bullet list" className={cls(editor.isActive('bulletList'))} onClick={() => editor.chain().focus().toggleBulletList().run()}>• List</button>
        <button type="button" title={`Link (${MOD}+K)`} className={cls(editor.isActive('link'))} onClick={setLink}>Link</button>
        <button type="button" title="Insert a game (paste a store link or search by name)" onClick={() => setShowInsert(v => !v)}>+ Game</button>
      </div>
      {showInsert && <GameSearch onPick={insertGame} />}
      <EditorContent editor={editor} className="wf-prose" />
    </div>
  )
}
