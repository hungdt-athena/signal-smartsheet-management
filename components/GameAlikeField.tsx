'use client'
import { GameAlikeGame } from './weekly-feedback/types'
import { GameSearch } from './weekly-feedback/GameSearch'
import { PlatformIcon } from './weekly-feedback/PlatformIcon'

// Flat "Game Alike" list for an evaluation. Mirrors the weekly-feedback chip +
// GameSearch UX, but a single ungrouped list. Read-only when `disabled`.
export function GameAlikeField({ value, onChange, disabled }: {
  value: GameAlikeGame[]
  onChange: (next: GameAlikeGame[]) => void
  disabled?: boolean
}) {
  const games = value || []
  const addGame = (g: GameAlikeGame) => onChange([...games, g])
  const removeGame = (gi: number) => onChange(games.filter((_, i) => i !== gi))

  if (disabled) return <GameAlikeChips value={games} />

  return (
    <div className="wf-alike-block" style={{ margin: 0 }}>
      <ul className="wf-chips">
        {games.map((g, gi) => (
          <li key={gi} className="wf-chip">
            {g.icon_url && <img src={g.icon_url} alt="" width={18} height={18} />}
            {g.app_link
              ? <a href={g.app_link} target="_blank" rel="noopener noreferrer">{g.title}</a>
              : <span>{g.title}</span>}
            <PlatformIcon link={g.app_link} />
            {g.manual && <span className="wf-manual" title="Not in DB">·manual</span>}
            <button type="button" title="Remove game" onClick={() => removeGame(gi)}>✕</button>
          </li>
        ))}
      </ul>
      <GameSearch onPick={addGame} />
    </div>
  )
}

// Read-only chips for list/table cells.
export function GameAlikeChips({ value }: { value: GameAlikeGame[] | null | undefined }) {
  const games = value || []
  if (!games.length) return <span style={{ fontSize: 12, color: 'var(--faint)' }}>—</span>
  return (
    <div className="wf-alike-games">
      {games.map((g, i) => {
        const inner = (
          <>
            {g.icon_url && <img src={g.icon_url} alt="" width={18} height={18} />}
            <span className="wf-alike-game-title">{g.title}</span>
            <PlatformIcon link={g.app_link} />
          </>
        )
        return g.app_link
          ? <a key={i} className="wf-alike-game is-link" href={g.app_link} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}>{inner}</a>
          : <span key={i} className="wf-alike-game">{inner}</span>
      })}
    </div>
  )
}
