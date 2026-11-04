'use client'
import { useEffect, useRef, useState } from 'react'
import { looksLikeUrl } from '@/lib/demo-link-name'

export const CHECK_DELAY_MS = 600

interface Expected { code: string | null; title: string | null }
interface Mismatch { fileName: string; expected: Expected }

export function demoLinkWarningText(fileName: string, expected: Expected): string {
  const what = expected.code
    ? `mã ${expected.code} hay tên game "${expected.title ?? ''}"`
    : `tên game "${expected.title ?? ''}"`
  return `Tên file là "${fileName}", không khớp ${what}. Kiểm tra lại link.`
}

/** Asks the server whether a demo link's Drive file is named after the game. Never throws:
 *  null for ok, unknown, or any failure. */
async function checkDemoLink(gameId: string, link: string): Promise<Mismatch | null> {
  try {
    const r = await fetch('/api/evaluations/check-demo-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gameId, link }),
    })
    if (!r.ok) return null
    const j = await r.json()
    if (j?.status !== 'mismatch' || typeof j.fileName !== 'string') return null
    return { fileName: j.fileName, expected: { code: j.expected?.code ?? null, title: j.expected?.title ?? null } }
  } catch { return null }
}

/** A mismatch for the link being typed, or null. Checks only a link the user edited (not the
 *  one already saved when the field opened), only once it looks like a URL, and only after
 *  typing pauses. The result holds while the value stays the same, also after it is saved. */
export function useDemoLinkCheck(gameId: string | null | undefined, value: string, savedValue: string | null | undefined): Mismatch | null {
  const link = value.trim()
  const [result, setResult] = useState<{ gameId: string; link: string; mismatch: Mismatch } | null>(null)
  // Read at the moment the value changes: a save that lands while the check waits must not cancel it.
  const savedRef = useRef(savedValue)
  savedRef.current = savedValue

  useEffect(() => {
    if (!gameId || !looksLikeUrl(link) || link === (savedRef.current ?? '').trim()) return
    let cancelled = false
    const t = setTimeout(() => {
      checkDemoLink(gameId, link).then(mismatch => {
        if (!cancelled && mismatch) setResult({ gameId, link, mismatch })
      })
    }, CHECK_DELAY_MS)
    return () => { cancelled = true; clearTimeout(t) }
  }, [gameId, link])

  return result && result.gameId === gameId && result.link === link ? result.mismatch : null
}

/** Small warning under a demo link input when the file looks like another game's. */
export function DemoLinkWarning({ gameId, value, savedValue }: {
  gameId: string | null | undefined; value: string; savedValue: string | null | undefined
}) {
  const mismatch = useDemoLinkCheck(gameId, value, savedValue)
  if (!mismatch) return null
  return (
    <div className="demo-link-warn" role="status">
      {demoLinkWarningText(mismatch.fileName, mismatch.expected)}
    </div>
  )
}
