'use client'
import { useMemo } from 'react'
import { generateHTML } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Underline from '@tiptap/extension-underline'
import Link from '@tiptap/extension-link'
import { GameMention } from './GameMention'
import { PlatformIcon } from './PlatformIcon'
import { Section, AlikeBlock } from './types'

const EXTS = [StarterKit, Underline, Link, GameMention]

// A section's feedback is a Tiptap document. Render to HTML; guard against
// null / non-doc values so it never throws.
function docToHtml(doc: unknown): string {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return ''
  try { return generateHTML(doc as object, EXTS) } catch { return '' }
}

function AlikeView({ alikes }: { alikes: AlikeBlock[] }) {
  const blocks = (alikes || []).filter(b => b?.name || b?.games?.length)
  if (!blocks.length) return null
  return (
    <div className="wf-alike-view">
      {blocks.map((b, bi) => (
        <div key={bi} className="wf-alike-view-block">
          {b.name && <strong className="wf-alike-view-name">{b.name}</strong>}
          {!!b.games?.length && (
            <div className="wf-alike-games">
              {b.games.map((g, i) => {
                const inner = (
                  <>
                    {g.icon_url && <img src={g.icon_url} alt="" width={18} height={18} />}
                    <span className="wf-alike-game-title">{g.title}</span>
                    <PlatformIcon link={g.app_link} />
                  </>
                )
                return g.app_link
                  ? <a key={i} className="wf-alike-game is-link" href={g.app_link} target="_blank" rel="noopener noreferrer">{inner}</a>
                  : <span key={i} className="wf-alike-game">{inner}</span>
              })}
            </div>
          )}
        </div>
      ))}
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

export function AlikeCell({ alikes, no }: { alikes: AlikeBlock[] | undefined; no: number | null }) {
  const body = alikes?.length ? <AlikeView alikes={alikes} /> : null
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
          <div className="wf-section-alike"><AlikeView alikes={s.alikes} /></div>
        </div>
      ))}
    </div>
  )
}
