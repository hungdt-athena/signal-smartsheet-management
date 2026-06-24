'use client'
import { Section, AlikeBlock, GameAlikeGame } from './types'
import { FeedbackEditor } from './FeedbackEditor'
import { GameSearch } from './GameSearch'

// One section = one 70/30 row. Left: a Tiptap feedback editor. Right: one or
// more named "game alike" groups, each a name + a list of games. Reorder (↑/↓)
// and remove the whole section live in the row's left rail.
export function SectionEditor({ section, index, total, onChange, onMove, onRemove }: {
  section: Section
  index: number
  total: number
  onChange: (patch: Partial<Section>) => void
  onMove: (dir: -1 | 1) => void
  onRemove: () => void
}) {
  const alikes = section.alikes
  const setAlikes = (next: AlikeBlock[]) => onChange({ alikes: next })
  const patchBlock = (bi: number, patch: Partial<AlikeBlock>) =>
    setAlikes(alikes.map((b, i) => (i === bi ? { ...b, ...patch } : b)))
  const addBlock = () => setAlikes([...alikes, { name: '', games: [] }])
  const removeBlock = (bi: number) => setAlikes(alikes.filter((_, i) => i !== bi))
  const addGame = (bi: number, g: GameAlikeGame) => patchBlock(bi, { games: [...alikes[bi].games, g] })
  const removeGame = (bi: number, gi: number) => patchBlock(bi, { games: alikes[bi].games.filter((_, i) => i !== gi) })

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
        {alikes.map((block, bi) => (
          <div key={bi} className="wf-alike-block">
            <div className="wf-alike-head">
              <input
                className="wf-alike-name"
                value={block.name}
                onChange={e => patchBlock(bi, { name: e.target.value })}
                placeholder="Game Alike"
              />
              <button type="button" className="wf-alike-del" title="Remove group" onClick={() => removeBlock(bi)}>✕</button>
            </div>
            <ul className="wf-chips">
              {block.games.map((g, gi) => (
                <li key={gi} className="wf-chip">
                  {g.icon_url && <img src={g.icon_url} alt="" width={18} height={18} />}
                  {g.app_link
                    ? <a href={g.app_link} target="_blank" rel="noopener noreferrer">{g.title}</a>
                    : <span>{g.title}</span>}
                  {g.manual && <span className="wf-manual" title="Not in DB">·manual</span>}
                  <button type="button" title="Remove game" onClick={() => removeGame(bi, gi)}>✕</button>
                </li>
              ))}
            </ul>
            <GameSearch onPick={g => addGame(bi, g)} />
          </div>
        ))}
        <button type="button" className="wf-addgroup" onClick={addBlock}>+ Add group</button>
      </div>
    </div>
  )
}
