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
