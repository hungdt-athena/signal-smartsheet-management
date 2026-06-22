'use client'
import { GameAlikeSection, GameAlikeGame } from './types'
import { GameSearch } from './GameSearch'

export function GameAlikeEditor({ value, onChange }: {
  value: GameAlikeSection[]
  onChange: (v: GameAlikeSection[]) => void
}) {
  const sections = value ?? []
  const update = (i: number, patch: Partial<GameAlikeSection>) =>
    onChange(sections.map((s, idx) => idx === i ? { ...s, ...patch } : s))
  const addSection = () => onChange([...sections, { name: '', games: [] }])
  const removeSection = (i: number) => onChange(sections.filter((_, idx) => idx !== i))
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir
    if (j < 0 || j >= sections.length) return
    const next = [...sections]; [next[i], next[j]] = [next[j], next[i]]; onChange(next)
  }
  const addGame = (i: number, g: GameAlikeGame) =>
    update(i, { games: [...sections[i].games, g] })
  const removeGame = (i: number, gi: number) =>
    update(i, { games: sections[i].games.filter((_, idx) => idx !== gi) })

  return (
    <div className="wf-gamealike">
      {sections.map((s, i) => (
        <div key={i} className="wf-section">
          <div className="wf-section-head">
            <input
              value={s.name ?? ''}
              onChange={e => update(i, { name: e.target.value })}
              placeholder="Section name (optional)"
            />
            <button type="button" onClick={() => move(i, -1)} title="Move up">↑</button>
            <button type="button" onClick={() => move(i, 1)} title="Move down">↓</button>
            <button type="button" onClick={() => removeSection(i)} title="Remove section">✕</button>
          </div>
          <ul className="wf-chips">
            {s.games.map((g, gi) => (
              <li key={gi} className="wf-chip">
                {g.icon_url && <img src={g.icon_url} alt="" width={18} height={18} />}
                {g.app_link
                  ? <a href={g.app_link} target="_blank" rel="noopener">{g.title}</a>
                  : <span>{g.title}</span>}
                {g.manual && <span className="wf-manual" title="Not in DB">·manual</span>}
                <button type="button" onClick={() => removeGame(i, gi)}>✕</button>
              </li>
            ))}
          </ul>
          <GameSearch onPick={g => addGame(i, g)} />
        </div>
      ))}
      <button type="button" onClick={addSection} className="wf-addsection">+ Add section</button>
    </div>
  )
}
