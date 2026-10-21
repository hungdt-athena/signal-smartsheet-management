'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { usePathname } from 'next/navigation'
import { useSession } from 'next-auth/react'

interface QueueGame { id: number; title: string; bucket: '5min' | '20min'; batch: string; category_group: string | null }

const storeKey = (name: string) => `record-badge-hidden:${name.trim().toLowerCase()}`

function readHidden(name: string): number[] {
  try {
    const raw = JSON.parse(window.localStorage.getItem(storeKey(name)) || '[]')
    return Array.isArray(raw) ? raw.filter((n): n is number => typeof n === 'number') : []
  } catch { return [] }
}

function writeHidden(name: string, ids: number[]) {
  try { window.localStorage.setItem(storeKey(name), JSON.stringify(ids)) } catch { /* private mode: hides until reload */ }
}

/** Count of games the signed-in person still has to record, next to Record in the sidebar.
 *  Opens a list with "Mark all as recorded". That only hides the games from this badge, in
 *  this browser: the Record tab still shows them as Recording until a matching YouTube
 *  upload turns up, so the video stays the one source of truth for "recorded". */
export function RecordQueueBadge() {
  const { data: session } = useSession()
  const pathname = usePathname()
  const name = session?.user?.name || ''
  const [games, setGames] = useState<QueueGame[] | null>(null)
  const [hidden, setHidden] = useState<number[]>([])
  const [undo, setUndo] = useState<number[] | null>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)

  useEffect(() => { if (name) setHidden(readHidden(name)) }, [name])

  // Again on page change, on coming back to the tab and once a minute. A failed read keeps
  // the last list rather than flashing the badge away.
  useEffect(() => {
    if (!name) return
    let alive = true
    const load = () => {
      fetch('/api/record/my-queue', { cache: 'no-store' })
        .then(r => (r.ok ? r.json() : null))
        .then(j => {
          if (!alive || !j || !Array.isArray(j.games)) return
          setGames(j.games)
          // Forget hidden ids that left the queue (recorded, or moved to an older batch).
          const live = new Set<number>(j.games.map((g: QueueGame) => g.id))
          setHidden(prev => {
            const kept = prev.filter(id => live.has(id))
            if (kept.length !== prev.length) writeHidden(name, kept)
            return kept.length === prev.length ? prev : kept
          })
        })
        .catch(() => {})
    }
    load()
    const timer = setInterval(load, 60_000)
    const onVisible = () => { if (document.visibilityState === 'visible') load() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { alive = false; clearInterval(timer); document.removeEventListener('visibilitychange', onVisible) }
  }, [name, pathname])

  const close = useCallback(() => { setPos(null); setUndo(null) }, [])
  useEffect(() => {
    if (!pos) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (popRef.current?.contains(t) || btnRef.current?.contains(t)) return
      close()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onDown) }
  }, [pos, close])

  const shown = (games || []).filter(g => !hidden.includes(g.id))
  if (shown.length === 0 && !pos) return null

  const toggle = () => {
    if (pos) return close()
    const r = btnRef.current?.getBoundingClientRect()
    if (r) setPos({ top: Math.max(8, Math.min(r.top - 8, window.innerHeight - 360)), left: r.right + 26 })
  }
  const markAll = () => {
    const ids = shown.map(g => g.id)
    const next = [...hidden, ...ids]
    setHidden(next); writeHidden(name, next); setUndo(ids)
  }
  const undoMark = () => {
    if (!undo) return
    const next = hidden.filter(id => !undo.includes(id))
    setHidden(next); writeHidden(name, next); setUndo(null)
  }
  const batches = Array.from(new Set(shown.map(g => g.batch)))

  return (
    <>
      {shown.length > 0 && (
        <button ref={btnRef} type="button" className="sb-count" onClick={toggle}
          aria-haspopup="dialog" aria-expanded={!!pos}
          aria-label={`${shown.length} to record`}>
          {shown.length > 99 ? '99+' : shown.length}
        </button>
      )}
      {pos && createPortal(
        <div ref={popRef} className="rq-pop" role="dialog" aria-label="Games to record" style={{ top: pos.top, left: pos.left }}>
          <div className="rq-head">
            <b>To record</b>
            <span>{batches.length > 0 ? batches.join(' · ') : 'Current and previous batch'}</span>
          </div>
          {shown.length === 0 ? (
            <p className="rq-empty">Nothing left on the badge.</p>
          ) : (
            <ul className="rq-list">
              {shown.map(g => (
                <li key={g.id}>
                  <span className="t" title={g.title}>{g.title}</span>
                  <span className="m">{g.bucket === '20min' ? "20'" : "5'"}{g.category_group ? ` · ${g.category_group}` : ''}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="rq-foot">
            {shown.length > 0 ? (
              <>
                <button type="button" className="btn btn-sm" onClick={markAll}>Mark all as recorded</button>
                <span>Hides them from this badge only. Record tab still shows Recording until the video is uploaded.</span>
              </>
            ) : undo ? (
              <button type="button" className="btn btn-sm btn-ghost" onClick={undoMark}>Undo</button>
            ) : null}
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}
