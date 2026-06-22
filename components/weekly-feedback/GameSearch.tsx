'use client'
import { useState, useRef, useEffect, useCallback } from 'react'
import { GameHit, GameAlikeGame, searchGames } from './types'
import { looksLikeUrl, parseStoreLink } from '@/lib/game-link'

const hitToGame = (h: GameHit): GameAlikeGame => ({ ...h, manual: false })

export function GameSearch({ onPick }: { onPick: (g: GameAlikeGame) => void }) {
  const [text, setText] = useState('')
  const [hits, setHits] = useState<GameHit[]>([])
  const [loading, setLoading] = useState(false)
  const [noMatchLink, setNoMatchLink] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const runSearch = useCallback(async (value: string) => {
    setNoMatchLink(null)
    if (looksLikeUrl(value)) {
      const parsed = parseStoreLink(value)
      if (!parsed) { setHits([]); return }
      setLoading(true)
      const results = await searchGames({ link: value })
      setLoading(false)
      if (results.length) { onPick(hitToGame(results[0])); setText(''); setHits([]) }
      else setNoMatchLink(value) // not in DB → offer manual add
      return
    }
    if (value.trim().length < 2) { setHits([]); return }
    setLoading(true)
    setHits(await searchGames({ q: value }))
    setLoading(false)
  }, [onPick])

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => { void runSearch(text) }, 250)
    return () => { if (timer.current) clearTimeout(timer.current) }
  }, [text, runSearch])

  const addManual = () => {
    if (!noMatchLink) return
    const title = window.prompt('Game name (not found in DB):')?.trim()
    if (!title) return
    onPick({ game_id: null, title, app_link: noMatchLink, icon_url: null, manual: true })
    setText(''); setNoMatchLink(null)
  }

  return (
    <div className="wf-gamesearch" style={{ position: 'relative' }}>
      <input
        value={text}
        onChange={e => setText(e.target.value)}
        placeholder="Paste a store link or type a game name…"
        style={{ width: '100%' }}
      />
      {loading && <span className="wf-hint">searching…</span>}
      {noMatchLink && (
        <button type="button" onClick={addManual} className="wf-addmanual">
          Not in DB — add "{noMatchLink}" manually
        </button>
      )}
      {hits.length > 0 && (
        <ul className="wf-hits" style={{ position: 'absolute', zIndex: 20, background: '#fff', width: '100%' }}>
          {hits.map(h => (
            <li key={h.game_id}>
              <button type="button" onClick={() => { onPick(hitToGame(h)); setText(''); setHits([]) }}>
                {h.icon_url && <img src={h.icon_url} alt="" width={20} height={20} />}
                {h.title}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
