'use client'
import { useMemo } from 'react'
import { generateHTML } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Underline from '@tiptap/extension-underline'
import Link from '@tiptap/extension-link'
import { GameAlikeSection } from './types'

const EXTS = [StarterKit, Underline, Link]

export function FeedbackView({ feedback, gameAlike }: { feedback: unknown; gameAlike: GameAlikeSection[] }) {
  const html = useMemo(() => {
    if (!feedback || typeof feedback !== 'object') return ''
    try { return generateHTML(feedback as object, EXTS) } catch { return '' }
  }, [feedback])

  return (
    <div className="wf-view">
      <div className="wf-prose" dangerouslySetInnerHTML={{ __html: html }} />
      <div className="wf-gamealike-view">
        {(gameAlike ?? []).map((s, i) => (
          <div key={i} className="wf-section-view">
            {s.name && <strong>{s.name}</strong>}
            <ul>
              {s.games.map((g, gi) => (
                <li key={gi}>
                  {g.app_link ? <a href={g.app_link} target="_blank" rel="noopener">{g.title}</a> : g.title}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  )
}
