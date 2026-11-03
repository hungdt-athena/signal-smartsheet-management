'use client'
// Export the Insight / Priority IV games of one batch or one month: a Slides deck from the
// Master Template, a Google Sheet (both land in the shared "generated" folder), or an xlsx
// download. Managers only -- ShortListExportButton renders nothing for an evaluator.
import { useEffect, useState } from 'react'
import { Modal } from '@/components/ui/Modal'
import { Seg } from '@/components/ui/Seg'
import { BatchPicker, parseBatchPick } from '@/components/ui/BatchPicker'
import { batchLabelsOfMonth } from '@/lib/batch-month'
import { isManagerRole } from '@/lib/roles'
import { fmtDateTimeVN } from '@/lib/format-date'
import type { ExportFormat, ExportType } from '@/lib/shortlist-export/types'

type Games = 'insight' | 'priority_iv' | 'both'
type Counts = { insight: number; priorityIV: number }
type Done = { url: string; warnings: string[] }
type Existing = { url: string; createdTime: string | null }

const API = '/api/shortlist-export'

function typesOf(g: Games): ExportType[] {
  return g === 'both' ? ['insight', 'priority_iv'] : [g]
}

function countLine(g: Games, c: Counts): string {
  if (g === 'insight') return `${c.insight} Insight`
  if (g === 'priority_iv') return `${c.priorityIV} Priority IV`
  return `${c.insight} Insight · ${c.priorityIV} Priority IV`
}

function countOf(g: Games, c: Counts): number {
  return (g !== 'priority_iv' ? c.insight : 0) + (g !== 'insight' ? c.priorityIV : 0)
}

/** The pick to open on: the page's own pick when it can be exported, else the newest batch. */
function startPick(defaultPick: string, labels: string[]): string {
  const { batch, month } = parseBatchPick(defaultPick)
  if (batch && labels.includes(batch)) return batch
  if (month && batchLabelsOfMonth(month).some(l => labels.includes(l))) return defaultPick
  return labels[0] ?? ''
}

function fileNameOf(disposition: string | null): string {
  const m = disposition && /filename\*=UTF-8''([^;]+)/.exec(disposition)
  return m ? decodeURIComponent(m[1]) : 'export.xlsx'
}

export function ShortListExportDialog({ onClose, defaultPick }: { onClose: () => void; defaultPick: string }) {
  const [labels, setLabels] = useState<string[] | null>(null)
  const [pick, setPick] = useState('')
  const [games, setGames] = useState<Games>('both')
  const [format, setFormat] = useState<ExportFormat>('slides')
  const [counts, setCounts] = useState<Counts | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState<Done | null>(null)
  // A deck / sheet already exported for these exact choices: open it instead of building twice.
  const [existing, setExisting] = useState<Existing | null>(null)

  useEffect(() => {
    let live = true
    fetch(API).then(r => r.json()).then((d: { labels?: string[] }) => {
      if (!live) return
      const ls = d.labels ?? []
      setLabels(ls)
      setPick(startPick(defaultPick, ls))
    }).catch(() => { if (live) setError('Could not load the batches') })
    return () => { live = false }
  }, [defaultPick])

  useEffect(() => {
    if (!pick) return
    let live = true
    setCounts(null)
    fetch(`${API}?pick=${encodeURIComponent(pick)}`).then(r => r.json()).then((d: { counts?: Counts | null; error?: string }) => {
      if (!live) return
      if (d.counts) setCounts(d.counts)
      else setError(d.error || 'Could not count the games')
    }).catch(() => { if (live) setError('Could not count the games') })
    return () => { live = false }
  }, [pick])

  useEffect(() => {
    setExisting(null)
    if (!pick || format === 'xlsx') return
    let live = true
    const qs = new URLSearchParams({ pick, types: typesOf(games).join(','), format })
    fetch(`${API}/existing?${qs}`).then(r => r.json()).then((d: { existing?: Existing | null }) => {
      if (live) setExisting(d.existing ?? null)
    }).catch(() => { /* no hint is fine: the user can still export */ })
    return () => { live = false }
  }, [pick, games, format])

  const total = counts ? countOf(games, counts) : 0

  async function run() {
    setBusy(true); setError(''); setDone(null)
    try {
      const r = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pick, types: typesOf(games), format }),
      })
      if (!r.ok) {
        const d = await r.json().catch(() => ({})) as { error?: string }
        setError(d.error || 'Export failed')
        return
      }
      if (format === 'xlsx') {
        const url = URL.createObjectURL(await r.blob())
        const a = document.createElement('a')
        a.href = url
        a.download = fileNameOf(r.headers.get('content-disposition'))
        document.body.appendChild(a)
        a.click()
        a.remove()
        URL.revokeObjectURL(url)
        onClose()
        return
      }
      const d = await r.json() as Done
      setDone(d)
      setExisting(null)
    } catch {
      setError('Export failed. Check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="Export" sub="Insight and Priority IV games of one batch or one month." onClose={onClose} busy={busy} width={480}
      footer={<>
        <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>Close</button>
        <button type="button" className="btn btn-primary" onClick={run} disabled={busy || !counts || total === 0}>
          {busy ? 'Building…' : existing ? 'Export again' : 'Export'}
        </button>
      </>}>
      <div style={{ display: 'grid', gap: 14 }}>
        <div style={{ display: 'grid', gap: 6 }}>
          <span className="h-sub">Games</span>
          <Seg ariaLabel="Games" value={games} onChange={v => { setGames(v); setDone(null) }}
            options={[{ value: 'insight', label: 'Insight' }, { value: 'priority_iv', label: 'Priority IV' }, { value: 'both', label: 'Both' }]} />
        </div>
        <div style={{ display: 'grid', gap: 6 }}>
          <span className="h-sub">Batch or month</span>
          <BatchPicker value={pick} onChange={v => { setPick(v); setDone(null); setError('') }} batches={labels ?? []}
            allowAll={false} allowMonth disabled={!labels || busy} width="100%" ariaLabel="Batch or month" />
        </div>
        <div style={{ display: 'grid', gap: 6 }}>
          <span className="h-sub">Format</span>
          <Seg ariaLabel="Format" value={format} onChange={v => { setFormat(v); setDone(null) }}
            options={[{ value: 'slides', label: 'Slides' }, { value: 'sheets', label: 'Google Sheets' }, { value: 'xlsx', label: 'xlsx' }]} />
        </div>
        <p className="h-sub" aria-live="polite">
          {!counts ? (pick ? 'Counting games…' : '') : total === 0 ? 'No games in this period' : countLine(games, counts)}
        </p>
        {busy && format === 'slides' && <p className="h-sub">A month can take a minute or two.</p>}
        {error && <p role="alert" style={{ color: 'var(--danger, #c0392b)' }}>{error}</p>}
        {existing && !done && (
          <div style={{ display: 'grid', gap: 6 }}>
            <p className="h-sub">Already exported {fmtDateTimeVN(existing.createdTime)}. Open it, or export again for a new file.</p>
            <a href={existing.url} target="_blank" rel="noreferrer" className="btn btn-sm">Open file</a>
          </div>
        )}
        {done && (
          <div style={{ display: 'grid', gap: 6 }}>
            <a href={done.url} target="_blank" rel="noreferrer" className="btn btn-sm">Open file</a>
            {done.warnings.map(w => <p key={w} className="h-sub">{w}</p>)}
          </div>
        )}
      </div>
    </Modal>
  )
}

export function ShortListExportButton({ role, defaultPick }: { role: string | null | undefined; defaultPick: string }) {
  const [open, setOpen] = useState(false)
  if (!isManagerRole(role)) return null
  return (
    <>
      <button type="button" className="btn btn-sm" onClick={() => setOpen(true)}>Export</button>
      {open && <ShortListExportDialog onClose={() => setOpen(false)} defaultPick={defaultPick} />}
    </>
  )
}
