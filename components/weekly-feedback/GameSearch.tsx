'use client'
import { useState, useRef, useEffect, useCallback } from 'react'
import { GameHit, GameAlikeGame, searchGames, hitToGame } from './types'
import { looksLikeUrl, parseStoreLink, normalizeUrl } from '@/lib/game-link'
import { PlatformIcon } from './PlatformIcon'

// Compact add-game control for a section's "game alike" panel. Paste a store
// link to add the matched game directly, or type a name to pick from results.
// When nothing matches, an inline form lets you add the game as a named hyperlink.
export function GameSearch({ onPick }: { onPick: (g: GameAlikeGame) => void }) {
  const [text, setText] = useState('')
  const [hits, setHits] = useState<GameHit[]>([])
  const [loading, setLoading] = useState(false)
  const [noResults, setNoResults] = useState(false) // searched, nothing found → offer manual add
  const [manual, setManual] = useState<{ name: string; link: string } | null>(null) // inline add-link form
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const runSearch = useCallback(async (value: string) => {
    setNoResults(false)
    if (looksLikeUrl(value)) {
      const parsed = parseStoreLink(value)
      if (!parsed) { setHits([]); setNoResults(true); return } // unrecognised URL → add manually
      setLoading(true)
      const results = await searchGames({ link: value })
      setLoading(false)
      if (results.length) { onPick(hitToGame(results[0])); setText(''); setHits([]) }
      else { setHits([]); setNoResults(true) } // valid store link, not in DB → add manually
      return
    }
    if (value.trim().length < 2) { setHits([]); return }
    setLoading(true)
    const results = await searchGames({ q: value })
    setLoading(false)
    setHits(results)
    setNoResults(results.length === 0)
  }, [onPick])

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => { void runSearch(text) }, 250)
    return () => { if (timer.current) clearTimeout(timer.current) }
  }, [text, runSearch])

  // Open the inline form, pre-filling whichever field the typed text fits:
  // a URL seeds the link (name blank), anything else seeds the name.
  const openManual = () => {
    const t = text.trim()
    const isUrl = looksLikeUrl(t)
    setManual({ name: isUrl ? '' : t, link: isUrl ? t : '' })
  }
  const submitManual = () => {
    const name = manual?.name.trim()
    if (!name) return
    onPick({ game_id: null, title: name, app_link: manual?.link.trim() ? normalizeUrl(manual.link) : null, icon_url: null, manual: true })
    setText(''); setHits([]); setNoResults(false); setManual(null)
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

      {manual ? (
        <div className="wf-manual-form">
          <span className="wf-manual-form-title">Add as a link</span>
          <input
            autoFocus
            value={manual.name}
            onChange={e => setManual(m => m && { ...m, name: e.target.value })}
            onKeyDown={e => { if (e.key === 'Enter') submitManual() }}
            placeholder="Name *"
          />
          <input
            value={manual.link}
            onChange={e => setManual(m => m && { ...m, link: e.target.value })}
            onKeyDown={e => { if (e.key === 'Enter') submitManual() }}
            placeholder="Link (optional)"
          />
          <div className="wf-manual-form-actions">
            <button type="button" className="wf-manual-add" disabled={!manual.name.trim()} onClick={submitManual}>Add</button>
            <button type="button" className="wf-manual-cancel" onClick={() => setManual(null)}>Cancel</button>
          </div>
        </div>
      ) : noResults && !loading && (
        <button type="button" onClick={openManual} className="wf-addmanual">
          + Add &quot;{text.trim()}&quot; as a link
        </button>
      )}

      {hits.length > 0 && !manual && (
        <ul className="wf-hits" style={{ position: 'absolute', zIndex: 20, width: '100%' }}>
          {hits.map(h => (
            <li key={h.game_id}>
              <button type="button" onClick={() => { onPick(hitToGame(h)); setText(''); setHits([]) }}>
                {h.icon_url && <img src={h.icon_url} alt="" width={30} height={30} />}
                <span className="wf-hit-title">{h.title}</span>
                <PlatformIcon link={h.app_link} size={17} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
