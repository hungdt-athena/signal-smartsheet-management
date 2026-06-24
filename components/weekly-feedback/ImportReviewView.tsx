'use client'
import { useEffect, useState, useCallback } from 'react'
import { SectionEditor } from './SectionEditor'
import { Section, newSection } from './types'

// THROWAWAY review surface for the legacy-sheet import. Lists staged records
// (weekly_feedback_import), lets an admin edit them with the normal SectionEditor,
// and Approve → copies into the live weekly_feedback table. Delete with the rest
// of the import machinery once the sync is done.
interface ImportRecord {
  id: number
  batch: string
  evaluator: string
  status: 'pending' | 'approved'
  source_tab: string | null
  updated_at: string
  sections: Section[]
}

const manualCount = (secs: Section[]) =>
  secs.reduce((n, s) => n + (s.alikes || []).reduce((m, b) => m + b.games.filter(g => g.manual).length, 0), 0)

export function ImportReviewView() {
  const [records, setRecords] = useState<ImportRecord[]>([])
  const [expanded, setExpanded] = useState<number | null>(null)
  const [busy, setBusy] = useState<number | 'all' | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(() => {
    setLoading(true)
    fetch('/api/weekly-feedback/import')
      .then(r => r.json())
      .then(d => setRecords(Array.isArray(d.records) ? d.records : []))
      .catch(() => setRecords([]))
      .finally(() => setLoading(false))
  }, [])
  useEffect(() => { load() }, [load])

  const patchSections = (id: number, fn: (s: Section[]) => Section[]) =>
    setRecords(prev => prev.map(r => r.id === id ? { ...r, sections: fn(r.sections) } : r))

  const updateSection = (id: number, sid: string, patch: Partial<Section>) =>
    patchSections(id, secs => secs.map(s => s.id === sid ? { ...s, ...patch } : s))
  const addSection = (id: number) => patchSections(id, secs => [...secs, newSection()])
  const removeSection = (id: number, sid: string) => patchSections(id, secs => secs.filter(s => s.id !== sid))

  const save = useCallback(async (rec: ImportRecord) => {
    await fetch('/api/weekly-feedback/import', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: rec.id, sections: rec.sections }),
    })
  }, [])

  const approve = useCallback(async (rec: ImportRecord) => {
    setBusy(rec.id)
    await save(rec)
    await fetch('/api/weekly-feedback/import/approve', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [rec.id] }),
    })
    setRecords(prev => prev.map(r => r.id === rec.id ? { ...r, status: 'approved' } : r))
    setBusy(null); setExpanded(null)
  }, [save])

  const approveAll = useCallback(async () => {
    if (!confirm('Approve ALL pending records into weekly_feedback? Save any open edits first.')) return
    setBusy('all')
    await fetch('/api/weekly-feedback/import/approve', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ all: true }),
    })
    setBusy(null); setExpanded(null); load()
  }, [load])

  const pending = records.filter(r => r.status === 'pending').length

  if (loading) return <p className="h-sub" style={{ padding: 8 }}>Loading staged imports…</p>
  if (!records.length) return <p className="h-sub" style={{ padding: 8 }}>No staged imports. Run the import script to populate the staging table.</p>

  // Group by evaluator, preserving the server's evaluator,batch order.
  const groups: { evaluator: string; rows: ImportRecord[] }[] = []
  const idx = new Map<string, number>()
  for (const r of records) {
    if (!idx.has(r.evaluator)) { idx.set(r.evaluator, groups.length); groups.push({ evaluator: r.evaluator, rows: [] }) }
    groups[idx.get(r.evaluator)!].rows.push(r)
  }

  return (
    <div className="wf-import">
      <div className="wf-label-row">
        <h3 className="wf-label">Sheet Import — review &amp; approve</h3>
        <div className="wf-label-actions">
          <span className="wf-savestate">{pending} pending · {records.length} total</span>
          <button type="button" className="seg-btn-premium" disabled={!pending || busy === 'all'} onClick={approveAll}>
            {busy === 'all' ? 'Approving…' : 'Approve all pending'}
          </button>
        </div>
      </div>

      {groups.map(g => (
        <div key={g.evaluator} style={{ marginBottom: 14 }}>
          <h4 className="wf-import-eval">{g.evaluator}</h4>
          {g.rows.map(rec => {
            const mc = manualCount(rec.sections)
            const open = expanded === rec.id
            return (
              <div key={rec.id} className={`wf-import-card${rec.status === 'approved' ? ' is-approved' : ''}`}>
                <div className="wf-import-head" onClick={() => setExpanded(open ? null : rec.id)} style={{ cursor: 'pointer' }}>
                  <span className="wf-import-batch">{rec.batch}</span>
                  <span className={`wf-badge wf-badge-${rec.status}`}>{rec.status}</span>
                  <span className="wf-faint">{rec.sections.length} section{rec.sections.length === 1 ? '' : 's'}</span>
                  {mc > 0 && <span className="wf-manual" title="Games not matched to DB">{mc} manual</span>}
                  <span style={{ flex: 1 }} />
                  <button type="button" onClick={e => { e.stopPropagation(); approve(rec) }} disabled={busy === rec.id}>
                    {busy === rec.id ? 'Approving…' : rec.status === 'approved' ? 'Re-approve' : 'Approve'}
                  </button>
                  <button type="button" onClick={e => { e.stopPropagation(); setExpanded(open ? null : rec.id) }}>{open ? 'Close' : 'Review'}</button>
                </div>

                {open && (
                  <div className="wf-import-body">
                    <div className="wf-sections">
                      {rec.sections.map((s, i) => (
                        <SectionEditor
                          key={s.id}
                          section={s}
                          index={i}
                          onChange={patch => updateSection(rec.id, s.id, patch)}
                          onRemove={() => removeSection(rec.id, s.id)}
                          onDuplicate={() => patchSections(rec.id, secs => {
                            const idx = secs.findIndex(x => x.id === s.id); if (idx < 0) return secs
                            const next = [...secs]; next.splice(idx + 1, 0, { ...s, id: newSection().id }); return next
                          })}
                        />
                      ))}
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button type="button" className="wf-addsection" onClick={() => addSection(rec.id)}>+ Add section</button>
                      <button type="button" className="seg-btn-premium" onClick={() => save(rec)}>Save draft</button>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}
