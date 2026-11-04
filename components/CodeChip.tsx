'use client'
import { useEffect, useRef, useState } from 'react'

const COPIED_MS = 1500

/** Asks the server for a game's demo code (it makes one if missing). Never throws: null on any failure. */
export async function fetchDemoCode(gameId: string): Promise<string | null> {
  try {
    const r = await fetch('/api/evaluations/demo-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gameId }),
    })
    if (!r.ok) return null
    const j = await r.json()
    return typeof j?.code === 'string' && j.code ? j.code : null
  } catch { return null }
}

/** Asks the server for a game's record code. The server makes one only for a game with a
 *  Confirmed bucket. Never throws: null on any failure. */
export async function fetchRecordCode(gameId: string): Promise<string | null> {
  try {
    const r = await fetch('/api/evaluations/record-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gameId }),
    })
    if (!r.ok) return null
    const j = await r.json()
    return typeof j?.code === 'string' && j.code ? j.code : null
  } catch { return null }
}

export interface LazyCodeRow { id: number; game_id: string; record_code?: string | null; locked: boolean }

/** Record codes for locked (recording/recorded) rows that arrived without one, keyed by row id.
 *  One request at a time, one try per row: a failure leaves the row without a chip. */
export function useLazyRecordCodes(rows: LazyCodeRow[]): Record<number, string> {
  const [codes, setCodes] = useState<Record<number, string>>({})
  const [tick, setTick] = useState(0)
  const tried = useRef<Set<number>>(new Set())
  const busy = useRef(false)
  useEffect(() => {
    if (busy.current) return
    const next = rows.find(r => r.locked && !r.record_code && r.game_id && !tried.current.has(r.id))
    if (!next) return
    busy.current = true
    tried.current.add(next.id)
    fetchRecordCode(next.game_id).then(code => {
      busy.current = false
      if (code) setCodes(c => ({ ...c, [next.id]: code }))
      setTick(t => t + 1)  // re-run this effect for the next row
    })
  }, [rows, tick])
  return codes
}

/** A 6-character file code. Click copies it. Without clipboard access the code stays as
 *  selectable text, so it can still be copied by hand. */
export function CodeChip({ code, label }: { code: string | null; label?: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  if (!code) return null

  const copy = async (e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      await navigator.clipboard.writeText(code)
    } catch { return }
    setCopied(true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), COPIED_MS)
  }

  return (
    <span className="code-chip-wrap">
      {label && <span className="code-chip-label">{label}</span>}
      <button type="button" className={`code-chip${copied ? ' is-copied' : ''}`}
        title="Name the file with this code" aria-label={`Copy code ${code}`} onClick={copy}>
        <span className="code-chip-code">{code}</span>
        {copied && <span className="code-chip-note">Copied</span>}
      </button>
    </span>
  )
}
