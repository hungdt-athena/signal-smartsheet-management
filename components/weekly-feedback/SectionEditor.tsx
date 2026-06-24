'use client'
import { Section, GameAlikeGame } from './types'
import { FeedbackEditor } from './FeedbackEditor'
import { GameSearch } from './GameSearch'

// One section = one 70/30 row. Left: a Tiptap feedback editor. Right: a named
// "game alike" block — a section name plus a list of games, each with an
// optional note. Reorder (↑/↓) and remove live in the row's left rail.
export function SectionEditor({ section, index, total, onChange, onMove, onRemove }: {
  section: Section
  index: number
  total: number
  onChange: (patch: Partial<Section>) => void
  onMove: (dir: -1 | 1) => void
  onRemove: () => void
}) {
  const alike = section.alike
  const setAlike = (patch: Partial<Section['alike']>) => onChange({ alike: { ...alike, ...patch } })
  const addGame = (g: GameAlikeGame) => setAlike({ games: [...alike.games, g] })
  const removeGame = (gi: number) => setAlike({ games: alike.games.filter((_, i) => i !== gi) })

  return (
    <div className="wf-section-row">
      <div className="wf-section-rail">
        <button type="button" title="Move up" disabled={index === 0} onClick={() => onMove(-1)}>↑</button>
        <button type="button" title="Move down" disabled={index === total - 1} onClick={() => onMove(1)}>↓</button>
        <button type="button" className="wf-section-del" title="Remove section" onClick={onRemove}>✕</button>
      </div>

      <div className="wf-section-feedback">
        <FeedbackEditor value={section.feedback} onChange={v => onChange({ feedback: v })} />
      </div>

      <div className="wf-section-alike">
        <input
          className="wf-alike-name"
          value={alike.name}
          onChange={e => setAlike({ name: e.target.value })}
          placeholder="Game Alike"
        />
        <ul className="wf-chips">
          {alike.games.map((g, gi) => (
            <li key={gi} className="wf-chip">
              {g.icon_url && <img src={g.icon_url} alt="" width={18} height={18} />}
              {g.app_link
                ? <a href={g.app_link} target="_blank" rel="noopener noreferrer">{g.title}</a>
                : <span>{g.title}</span>}
              {g.manual && <span className="wf-manual" title="Not in DB">·manual</span>}
              <button type="button" title="Remove game" onClick={() => removeGame(gi)}>✕</button>
            </li>
          ))}
        </ul>
        <GameSearch onPick={addGame} />
      </div>
    </div>
  )
}
