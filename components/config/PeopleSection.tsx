// components/config/PeopleSection.tsx — who appears in the evaluator dropdowns.
//
// The dropdowns used to list every name that had ever evaluated anything, so the
// system account `Shortcut` and everyone who has left sat in the Evaluate / Short
// List / Weekly Feedback filters forever. Two flags fix that:
//   Filter — listed in the evaluator dropdowns
//   Report — counted in the Report tab (same store as Report › Config)
// There is no Assign flag: the roster that decides who receives games belongs to
// Team Ops, and duplicating it here would let the two screens disagree.
//
// Deactivated users are not listed at all — Users Management owns that, and
// deactivating is the way to drop someone from this table for good.
'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'

interface Person {
  key: string
  name: string
  title: string
  lastEval: string | null
  recent: number
  total: number
  hasAccount: boolean
  inFilters: boolean
  inReport: boolean
}

const TITLE_CLASS: Record<string, string> = {
  System: 'is-system', Freelancer: 'is-freelancer', Admin: 'is-admin',
}

function shortDate(iso: string | null): string {
  if (!iso) return 'never'
  return new Date(iso).toLocaleDateString('en-CA')   // YYYY-MM-DD, locale-proof
}

export function PeopleSection() {
  const [people, setPeople] = useState<Person[]>([])
  const [staleDays, setStaleDays] = useState(7)
  const [noAccount, setNoAccount] = useState(0)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [q, setQ] = useState('')

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/config/people', { cache: 'no-store' })
      if (res.ok) {
        const json = await res.json()
        setPeople(json.people ?? [])
        setStaleDays(json.staleDays ?? 7)
        setNoAccount(json.noAccount ?? 0)
      } else {
        setError('Could not load the people list')
      }
    } catch {
      setError('Could not load the people list')
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { fetchData() }, [fetchData])

  const patch = useCallback(async (body: Record<string, unknown>, busyKey: string) => {
    setSaving(busyKey); setError(null)
    try {
      const res = await fetch('/api/config/people', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (res.ok) {
        const json = await res.json()
        if (json.people) setPeople(json.people)
        if (typeof json.noAccount === 'number') setNoAccount(json.noAccount)
      } else {
        setError('Could not save that change')
      }
    } catch {
      setError('Network error')
    } finally { setSaving(null) }
  }, [])

  const shown = useMemo(() => {
    const term = q.trim().toLowerCase()
    return term ? people.filter(p => p.key.includes(term)) : people
  }, [people, q])

  const visible = people.filter(p => p.inFilters)
  const stale = people.filter(p => p.inFilters && p.recent === 0)

  return (
    <div className="card">
      <div className="card-head">
        <span className="card-label">People in filters</span>
        <span className="card-note">
          Who is listed in the evaluator dropdowns, and who counts in the Report ·{' '}
          <b>{visible.length}/{people.length} in filters</b> · deactivate someone in Users
          Management to drop them from this table
        </span>
      </div>

      {error && <p className="msg-err" style={{ marginBottom: 8 }}>{error}</p>}

      <div className="ppl-tools">
        <input className="input ppl-search" value={q} onChange={e => setQ(e.target.value)}
          placeholder="Find someone…" aria-label="Find someone" />
        {visible.length < people.length && (
          <button className="btn btn-sm" disabled={!!saving}
            onClick={() => patch({ keys: people.map(p => p.key), inFilters: true }, 'all')}>
            Show everyone
          </button>
        )}
        <span className="ppl-hint">Hiding someone never deletes anything — old games keep their name.</span>
        {noAccount > 0 && (
          <span className="ppl-warn">
            {noAccount} {noAccount === 1 ? 'name has' : 'names have'} no user account —
            run “Audit evaluators” in Users Management.
          </span>
        )}
      </div>

      <div className="ppl-body">
        <div className="ppl-table-wrap">
          <table className="ppl-table">
            <thead>
              <tr>
                <th className="ppl-who">Person</th>
                <th className="ppl-num">Eval {staleDays}d</th>
                <th>Filter<span>dropdown</span></th>
                <th>Report<span>scored</span></th>
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 && (
                <tr><td colSpan={4} className="ppl-empty">{loading ? 'Loading…' : 'Nobody matches that'}</td></tr>
              )}
              {shown.map(p => (
                <tr key={p.key} className={saving === p.key ? 'is-saving' : undefined}>
                  <td className="ppl-who">
                    <span className="ppl-name">{p.name}</span>
                    <span className="ppl-meta">
                      <span className={'ppl-tag ' + (TITLE_CLASS[p.title] ?? '')}>{p.title}</span>
                      <span className={p.recent === 0 ? 'is-stale' : undefined}>
                        last eval {shortDate(p.lastEval)}
                      </span>
                      {!p.hasAccount && <span className="ppl-tag is-orphan">no account</span>}
                    </span>
                  </td>
                  <td className="ppl-num">{p.recent || '—'}</td>
                  <td><Check on={p.inFilters} busy={!!saving} label={`${p.name} in filters`}
                    onChange={v => patch({ key: p.key, inFilters: v }, p.key)} /></td>
                  <td><Check on={p.inReport} busy={!!saving} label={`${p.name} in report`}
                    onChange={v => patch({ key: p.key, inReport: v }, p.key)} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="ppl-side">
          <div className="ppl-side-label">Filters will show</div>
          <div className="ppl-dd">
            <div className="ppl-dd-head"><span>All evaluators</span><span aria-hidden>▴</span></div>
            <div className="ppl-dd-list">
              {visible.length === 0
                ? <div className="ppl-dd-item is-empty">Nobody is turned on</div>
                : visible.map(p => <div key={p.key} className="ppl-dd-item">{p.name}</div>)}
            </div>
          </div>
          {stale.length > 0 && (
            <div className="ppl-stale">
              <span><b>{stale.length}</b> with no evaluation in {staleDays} days: {stale.map(p => p.name).join(', ')}.</span>
              <button className="btn btn-sm" disabled={!!saving}
                onClick={() => patch({ keys: stale.map(p => p.key), inFilters: false }, 'stale')}>
                Hide from filters
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function Check({ on, busy, label, onChange }: {
  on: boolean
  busy: boolean
  label: string
  onChange: (v: boolean) => void
}) {
  return (
    <button
      type="button"
      className="ppl-cb"
      role="checkbox"
      aria-checked={on}
      aria-label={label}
      disabled={busy}
      onClick={() => onChange(!on)}
    />
  )
}
