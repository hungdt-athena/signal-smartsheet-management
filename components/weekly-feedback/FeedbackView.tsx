'use client'
import { useMemo } from 'react'
import { generateHTML } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Underline from '@tiptap/extension-underline'
import Link from '@tiptap/extension-link'

const EXTS = [StarterKit, Underline, Link]

// Both feedback and game_alike are Tiptap documents. Render one to HTML; guard
// against null / non-doc values (e.g. legacy `[]` game_alike) so it never throws.
function docToHtml(doc: unknown): string {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return ''
  try { return generateHTML(doc as object, EXTS) } catch { return '' }
}

export function FeedbackView({ feedback, gameAlike, part = 'both' }: {
  feedback: unknown
  gameAlike: unknown
  // The sheet-style list view renders Feedback and Game Alike in separate
  // columns, so it asks for one part per cell.
  part?: 'feedback' | 'gamealike' | 'both'
}) {
  const fb = useMemo(() => docToHtml(feedback), [feedback])
  const ga = useMemo(() => docToHtml(gameAlike), [gameAlike])

  return (
    <div className="wf-view">
      {part !== 'gamealike' && <div className="wf-prose" dangerouslySetInnerHTML={{ __html: fb }} />}
      {part !== 'feedback' && <div className="wf-prose" dangerouslySetInnerHTML={{ __html: ga }} />}
    </div>
  )
}
