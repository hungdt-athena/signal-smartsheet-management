'use client'
// The "Game" cell every game table uses: a 40px icon with the platform mark on its
// corner, the title, then publisher · release date (what the team scans for first),
// then genres as small light tags. `extra` is a row for page-specific badges (batch,
// evaluator…); `titleAfter` sits right after the title (a copy button).
import type { ReactNode } from 'react'
import { GameIcon } from './GameIcon'
import { fmtDateVN } from '@/lib/format-date'

export function GameCell({
  icon, os, title, titleAfter, publisher, releaseDate, genres, extra, size = 40, minWidth = 220,
}: {
  icon: string | null | undefined
  os?: string | null
  title: ReactNode
  titleAfter?: ReactNode
  publisher?: string | null
  releaseDate?: string | null
  genres?: (string | null | undefined)[]
  extra?: ReactNode
  size?: number
  minWidth?: number
}) {
  const g = (genres ?? []).filter(Boolean) as string[]
  const meta = [publisher || null, releaseDate ? `Released ${fmtDateVN(releaseDate)}` : null].filter(Boolean) as string[]
  return (
    <div className="game-cell" style={{ minWidth }}>
      <GameIcon src={icon} os={os} size={size} />
      <div className="game-cell-text">
        <div className="game-cell-title">
          <span className="cell-name">{title}</span>
          {titleAfter}
        </div>
        {meta.length > 0 && <div className="game-cell-meta" title={meta.join(' · ')}>{meta.join(' · ')}</div>}
        {extra && <div className="game-cell-extra">{extra}</div>}
        {g.length > 0 && (
          <div className="game-cell-genres">{g.map(x => <span key={x} className="genre-tag">{x}</span>)}</div>
        )}
      </div>
    </div>
  )
}
