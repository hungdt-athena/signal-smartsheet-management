'use client'
import { useState } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Underline from '@tiptap/extension-underline'
import Link from '@tiptap/extension-link'
import { GameSearch } from './GameSearch'
import { GameAlikeGame } from './types'

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
  if (!editor) return null

  const btn = (active: boolean) => ({ fontWeight: active ? 700 : 400 })
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
        <button type="button" style={btn(editor.isActive('bold'))} onClick={() => editor.chain().focus().toggleBold().run()}>B</button>
        <button type="button" style={btn(editor.isActive('italic'))} onClick={() => editor.chain().focus().toggleItalic().run()}><i>I</i></button>
        <button type="button" style={btn(editor.isActive('underline'))} onClick={() => editor.chain().focus().toggleUnderline().run()}><u>U</u></button>
        <button type="button" style={btn(editor.isActive('bulletList'))} onClick={() => editor.chain().focus().toggleBulletList().run()}>• List</button>
        <button type="button" style={btn(editor.isActive('link'))} onClick={setLink}>Link</button>
        <button type="button" onClick={() => setShowInsert(v => !v)}>+ Game</button>
      </div>
      {showInsert && <GameSearch onPick={insertGame} />}
      <EditorContent editor={editor} className="wf-prose" />
    </div>
  )
}
