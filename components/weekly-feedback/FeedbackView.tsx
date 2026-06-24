'use client'
import { useMemo } from 'react'
import { generateHTML } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Underline from '@tiptap/extension-underline'
import Link from '@tiptap/extension-link'
import { GameMention } from './GameMention'
import { Section, AlikeBlock } from './types'

const EXTS = [StarterKit, Underline, Link, GameMention]

// A section's feedback is a Tiptap document. Render to HTML; guard against
// null / non-doc values so it never throws.
function docToHtml(doc: unknown): string {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return ''
  try { return generateHTML(doc as object, EXTS) } catch { return '' }
}

function AlikeView({ alike }: { alike: AlikeBlock }) {
  if (!alike?.games?.length && !alike?.name) return null
  return (
    <div className="wf-alike-view">
      {alike.name && <strong className="wf-alike-view-name">{alike.name}</strong>}
      {!!alike?.games?.length && (
        <ul>
          {alike.games.map((g, i) => (
            <li key={i}>
              {g.icon_url && <img src={g.icon_url} alt="" width={16} height={16} />}
              {g.app_link
                ? <a href={g.app_link} target="_blank" rel="noopener noreferrer">{g.title}</a>
                : <span>{g.title}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// One section's feedback cell for the list table. `no` numbers the section when
// the row has more than one (null = single section, no badge). The list renders
// one table row per section, so feedback ↔ game-alike line up by row border.
export function FeedbackCell({ doc, no }: { doc: unknown; no: number | null }) {
  const html = useMemo(() => docToHtml(doc), [doc])
  return (
    <div className="wf-cell">
      {no != null && <span className="wf-sec-no">{no}</span>}
      <div className="wf-cell-body">
        {html ? <div className="wf-prose" dangerouslySetInnerHTML={{ __html: html }} /> : <span className="wf-faint">—</span>}
      </div>
    </div>
  )
}

export function AlikeCell({ alike, no }: { alike: AlikeBlock | undefined; no: number | null }) {
  const body = alike ? <AlikeView alike={alike} /> : null
  return (
    <div className="wf-cell">
      {no != null && <span className="wf-sec-no">{no}</span>}
      <div className="wf-cell-body">{body || <span className="wf-faint">—</span>}</div>
    </div>
  )
}

// Read-only full render of a week's sections as 70/30 rows — used when a manager
// views another evaluator's week.
export function FeedbackView({ sections }: { sections: Section[] }) {
  const list = Array.isArray(sections) ? sections : []
  return (
    <div className="wf-view">
      {list.map(s => (
        <div key={s.id} className="wf-section-row wf-section-row-view">
          <div className="wf-section-feedback">
            {(() => { const html = docToHtml(s.feedback); return html ? <div className="wf-prose" dangerouslySetInnerHTML={{ __html: html }} /> : null })()}
          </div>
          <div className="wf-section-alike"><AlikeView alike={s.alike} /></div>
        </div>
      ))}
    </div>
  )
}
