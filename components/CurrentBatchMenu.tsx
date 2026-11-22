'use client'
// The team's current batch is a global setting, not a filter, so it lives in a popover off
// the Short List header instead of sitting in the filter bar.
//
// Nothing here saves on a pick. Changing the batch moves every List_Idea save of the whole team
// to another batch, so a stray click in the picker must not do it: the pick is held until the
// manager confirms it (or cancels, or closes the popover). The start time is the same kind of
// setting, and a datetime field fires on every typed segment, so it saves on its own button.
//
// A failed save is reported as a toast by the caller (the picker goes back to the value the
// server still has), so this menu holds no error state of its own.
import { useEffect, useRef, useState } from 'react'
import { BatchPicker } from '@/components/ui/BatchPicker'

// "2026-10-13T17:09" -> "13 Oct, 17:09": the batch start as the header button shows it.
function fmtStart(at: string | null) {
  const m = at ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2})/.exec(at) : null
  if (!m) return ''
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][parseInt(m[2], 10) - 1]
  return `${parseInt(m[3], 10)} ${mon}, ${m[4]}`
}

export function CurrentBatchMenu({ value, options, startsAt, onChange, onStartChange }: {
  value: string | null; options: string[]; startsAt: string | null
  onChange: (v: string) => void; onStartChange: (at: string) => void
}) {
  const [open, setOpen] = useState(false)
  // A pick waiting for confirmation: '' is "clear the batch", null is nothing pending.
  const [pending, setPending] = useState<string | null>(null)
  // The start time as typed, saved only by its button.
  const [startDraft, setStartDraft] = useState(startsAt || '')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => { setStartDraft(startsAt || '') }, [startsAt])
  // Closing the popover drops whatever was not confirmed.
  useEffect(() => {
    if (open) return
    setPending(null)
    setStartDraft(startsAt || '')
  }, [open, startsAt])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element
      // BatchPicker portals its panel to <body>, so it is outside `ref` but not outside the popover.
      if (ref.current?.contains(t) || t.closest?.('.bp-pop')) return
      setOpen(false)
    }
    // Esc with the picker open closes the picker only (it marks the key handled).
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])

  const pick = (v: string) => setPending(v === (value || '') ? null : v)
  const confirm = () => {
    if (pending === null) return
    onChange(pending)
    setPending(null)
  }
  const startChanged = !!value && startDraft !== '' && startDraft !== (startsAt || '')

  return (
    <div className="sl-cur" ref={ref}>
      <button type="button" className="btn sl-cur-btn" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        <span className="k">Current batch</span>
        <b>{value || '— none —'}</b>
        {value && startsAt && <span className="k" title="When this batch starts (Vietnam time)">from {fmtStart(startsAt)}</span>}
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--faint)' }}>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="sl-pop">
          <h4>Current batch</h4>
          <p>Applies to all categories. Evaluators auto-fill it for List_Idea.</p>
          <BatchPicker
            value={pending ?? (value || '')}
            onChange={pick}
            batches={options}
            current={value}
            // "Not set" keeps the old "— none —": a manager can still clear the current batch.
            allowAll
            allLabel="Not set"
            allowMonth={false}
            placeholder="Not set"
            ariaLabel="Current batch"
            width="100%"
          />
          {pending !== null && (
            <div className="sl-confirm" role="alertdialog" aria-label="Confirm the current batch">
              <div className="sl-confirm-move">
                <span>{value || 'Not set'}</span>
                <span aria-hidden="true">→</span>
                <b>{pending || 'Not set'}</b>
              </div>
              <p>
                {pending
                  ? `For all categories: new List_Idea saves go to ${pending}.`
                  : 'For all categories: new List_Idea saves get no batch until one is set.'}
              </p>
              <div className="sl-confirm-actions">
                <button type="button" className="btn btn-sm" onClick={() => setPending(null)}>Cancel</button>
                <button type="button" className="btn btn-sm btn-primary" onClick={confirm}>
                  {pending ? 'Change batch' : 'Clear batch'}
                </button>
              </div>
            </div>
          )}
          {value && pending === null && (
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, fontWeight: 700, color: 'var(--muted)' }}>
              Starts at
              <span style={{ display: 'flex', gap: 6 }}>
                <input type="datetime-local" className="input" style={{ flex: 1, minWidth: 0 }} value={startDraft}
                  onChange={e => setStartDraft(e.target.value)} />
                {startChanged && (
                  <button type="button" className="btn btn-sm btn-primary" onClick={() => onStartChange(startDraft)}>
                    Save start
                  </button>
                )}
              </span>
            </label>
          )}
        </div>
      )}
    </div>
  )
}
