'use client'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSession } from 'next-auth/react'
import EvalDetailPanel, { type EvalListItem } from './EvalDetailPanel'
import { TrendValuePicker } from './TrendValuePicker'

/** One pending proposal, carrying its game with it — the queue is a flat list of
 *  tags, grouped only for display. Mirrors QueueTag in lib/playtest-tags-queue. */
interface PendingRow {
  id: number
  game_id: string
  title: string
  publisher_name: string | null
  icon_url: string | null
  initial_evaluator: string | null
  field_value: string
  sub_value_id: number | null
  sub_value_name: string | null
  tagged_by_name: string | null
  tagged_at: string
  their_sub_value_id: number | null
  their_sub_value_name: string | null
  conflict: boolean
}

interface HistoryRow {
  id: number
  game_id: string
  title: string
  icon_url: string | null
  field_value: string
  sub_value_name: string | null
  tagged_by_name: string | null
  tagged_at: string
  confirmed_by_name: string | null
  confirmed_at: string | null
  status: string
  sync_result: string | null
  removed_at: string | null
  /** Email of the admin who removed it, or 'signal_sense' when the reconcile
   *  sweep found it gone rather than someone removing it from here. */
  removed_by: string | null
  removed_by_name: string | null
  /** Read live: is the tag in custom_field_values right now? */
  in_signal_sense: boolean
  /** Did playtest_sync create that row? Only then may this app remove it. */
  ours: boolean | null
  /** Latest sub-value overwrite made in Signal Sense after our confirm. The row
   *  still exists in that case, so only the change log reveals it. */
  sub_changed_at: string | null
  sub_changed_from: string | null
  sub_changed_to: string | null
  sub_changed_by: string | null
}

const fmt = (d: string | null) =>
  d ? new Date(d).toLocaleDateString('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: 'short', year: 'numeric' }) : '—'

// Today and the first of this month as YYYY-MM-DD in UTC+7, the only timezone
// this dashboard reckons dates in. en-CA formats as ISO, which is what a
// <input type="date"> and the API's ?from/?to expect.
const todayLocal = () =>
  new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' })
const monthStartLocal = () => `${todayLocal().slice(0, 7)}-01`

// Written into Signal Sense → green; already there or deliberately left alone →
// muted; refused because the value is retired → red.
const RESULT_PILL: Record<string, string> = {
  inserted: 'on', enriched: 'on', overwritten: 'on',
  duplicate: 'muted', kept: 'muted', inactive: 'off',
}

/** Opens a game's evaluation panel. Both views pass the games they are showing,
 *  so the panel's prev/next walks the list the admin is looking at. */
type OpenGame = (gameId: string, list: EvalListItem[]) => void

// A game title that opens its evaluation panel — the tag says which trend, the
// panel says what the game is and who evaluated it.
function GameButton({ title, gameId, onOpen, list }: {
  title: string; gameId: string; onOpen: OpenGame; list: EvalListItem[]
}) {
  return (
    <button type="button" onClick={() => onOpen(gameId, list)}
      title="Open the evaluation"
      style={{
        border: 0, background: 'none', padding: 0, cursor: 'pointer',
        font: 'inherit', color: 'var(--accent)', textAlign: 'left',
      }}>{title}</button>
  )
}

// Admin review of Trends tags proposed during playtest. A tag only reaches
// Signal Sense's custom_field_values when it is confirmed here.
export function TaggingTab() {
  const [view, setView] = useState<'pending' | 'history'>('pending')
  const [detail, setDetail] = useState<{ gameId: string; list: EvalListItem[] } | null>(null)
  const { data: session } = useSession()
  const role = session?.user?.role
  const userName = session?.user?.name || ''

  const openGame: OpenGame = (gameId, list) => setDetail({ gameId, list })

  return (
    <div className="page tag-page">
      <div className="page-head">
        <div>
          <h1 className="h-title">Tagging</h1>
          <p className="h-sub">Trends proposed while playtesting. Confirming writes them into Signal Sense.</p>
        </div>
        <div className="seg">
          <button className={'seg-btn' + (view === 'pending' ? ' active' : '')} onClick={() => setView('pending')}>Pending</button>
          <button className={'seg-btn' + (view === 'history' ? ' active' : '')} onClick={() => setView('history')}>History</button>
        </div>
      </div>

      {view === 'pending' ? <PendingView onOpenGame={openGame} /> : <HistoryView onOpenGame={openGame} />}

      {detail && (
        <div className="eval-modal-backdrop" onClick={() => setDetail(null)}>
          <div className="eval-modal-container" onClick={e => e.stopPropagation()}
            style={{ padding: '20px 24px 24px' }}>
            <EvalDetailPanel
              initialGameId={detail.gameId}
              gameList={detail.list}
              role={role}
              userName={userName}
              hideRecordSections={false}
              onClose={() => setDetail(null)}
              onNavigate={gameId => setDetail(d => (d ? { ...d, gameId } : d))}
            />
          </div>
        </div>
      )}
    </div>
  )
}

// A checkbox that can also sit half-ticked, for "some of this group is picked".
// `indeterminate` is a DOM property with no React attribute, so it goes on via a
// ref rather than a prop.
function TriCheckbox({ checked, indeterminate, onChange, title, disabled }: {
  checked: boolean; indeterminate: boolean; onChange: () => void
  title: string; disabled?: boolean
}) {
  return (
    <input
      type="checkbox"
      ref={el => { if (el) el.indeterminate = !checked && indeterminate }}
      checked={checked}
      disabled={disabled}
      title={title}
      aria-label={title}
      onChange={onChange}
      style={{ cursor: disabled ? 'default' : 'pointer' }}
    />
  )
}

function PendingView({ onOpenGame }: { onOpenGame: OpenGame }) {
  // One row per proposed tag. Every action edits this list in place — nothing in
  // this view refetches the queue on a change, so the admin keeps their scroll
  // position, their selection and their place in a long list of games.
  const [rows, setRows] = useState<PendingRow[]>([])
  const [loading, setLoading] = useState(true)
  /** Ticked for review: the unit that Confirm and Reject act on. */
  const [selected, setSelected] = useState<Set<number>>(new Set())
  /** Conflict rows whose playtest sub-value should replace Signal Sense's. */
  const [overwrite, setOverwrite] = useState<Set<number>>(new Set())
  const [working, setWorking] = useState(false)
  /** Rows mid-flight on their own, so only they show as busy. */
  const [rowBusy, setRowBusy] = useState<Set<number>>(new Set())
  const [msg, setMsg] = useState<string | null>(null)
  // Catalog for the inline value/sub-value editors. A failed load leaves the
  // rows readable but not editable, rather than offering an empty picker.
  const [options, setOptions] = useState<string[]>([])
  const [subValues, setSubValues] = useState<{ id: number; name: string }[]>([])
  const [optionsError, setOptionsError] = useState(false)
  const [editing, setEditing] = useState<number | null>(null)
  /** The whole queue's size, which the loaded rows are counted against. */
  const [total, setTotal] = useState(0)
  const sentinelRef = useRef<HTMLTableRowElement>(null)
  const limit = 50

  // One page at a time, appended — same shape as History. `append` distinguishes
  // "next page" from a fresh read, which replaces what is on screen. The offset
  // is how many rows are already held, so rows leaving the queue mid-scroll
  // cannot make the next page skip anything.
  const load = useCallback(async (offset: number, append: boolean) => {
    setLoading(true)
    try {
      const r = await fetch(`/api/playtest-tags/pending?offset=${offset}&limit=${limit}`)
      const d = r.ok ? await r.json() : { tags: [], total: 0 }
      const next = (d.tags || []) as PendingRow[]
      if (append && next.length === 0) {
        // An empty page while total still claims more would leave the observer
        // asking forever. Trust what actually arrived and stop.
        setRows(prev => { setTotal(prev.length); return prev })
      } else {
        // Appending is keyed on id: a row already held must not appear twice if
        // the queue shifted between the two reads.
        setRows(prev => {
          if (!append) return next
          const held = new Set(prev.map(r2 => r2.id))
          return [...prev, ...next.filter(r2 => !held.has(r2.id))]
        })
        setTotal(d.total || 0)
      }
    } catch {
      if (!append) { setRows([]); setTotal(0) }
    }
    setLoading(false)
  }, [])

  const loadOptions = useCallback(() => {
    setOptionsError(false)
    fetch('/api/trends/options')
      .then(r => { if (!r.ok) throw new Error('failed'); return r.json() })
      .then(d => { setOptions(d.values || []); setSubValues(d.subValues || []) })
      .catch(() => { setOptionsError(true) })
  }, [])

  useEffect(() => { void load(0, false) }, [load])
  useEffect(() => { loadOptions() }, [loadOptions])

  // Rows that left the queue: drop them and forget every flag that referenced
  // them, so a stale id cannot leak into a later confirm. `total` follows, or
  // "12 of 40" would keep counting rows that are no longer pending.
  const dropRows = (ids: number[]) => {
    const gone = new Set(ids)
    setRows(prev => prev.filter(r => !gone.has(r.id)))
    setTotal(t => Math.max(0, t - ids.length))
    const without = (s: Set<number>) => {
      const next = new Set(s)
      for (const id of ids) next.delete(id)
      return next
    }
    setSelected(without)
    setOverwrite(without)
  }

  const markBusy = (ids: number[], busy: boolean) => setRowBusy(prev => {
    const next = new Set(prev)
    for (const id of ids) { if (busy) next.add(id); else next.delete(id) }
    return next
  })

  // Correct one pending proposal in place. The response carries the row as the
  // queue would read it now, so the conflict flag and the Signal Sense
  // comparison come from the server rather than being guessed here.
  const patchTag = async (id: number, patch: { field_value?: string; sub_value_id?: number | null }) => {
    setEditing(id)
    try {
      const r = await fetch(`/api/playtest-tags/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) { setMsg(d.error || 'Could not update that tag'); return }
      setMsg(null)
      const tag = d.tag as PendingRow | undefined
      if (tag && typeof tag.conflict === 'boolean') {
        setRows(prev => prev.map(row => (row.id === id ? { ...row, ...tag } : row)))
        // The edit may have resolved the conflict it was ticked for; a tick on a
        // row that is no longer in conflict does nothing, so clear it.
        if (!tag.conflict) setOverwrite(prev => {
          if (!prev.has(id)) return prev
          const next = new Set(prev); next.delete(id); return next
        })
      } else {
        // The row was resolved underneath the edit and no longer reads back as
        // pending. Drop it rather than leaving a row that is not in the queue.
        dropRows([id])
        setMsg('That tag was reviewed elsewhere — removed it from the queue.')
      }
    } catch { setMsg('Network error') }
    finally { setEditing(null) }
  }

  const toggleOverwrite = (id: number) => setOverwrite(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })

  const toggleRow = (id: number) => setSelected(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })

  // Toggle a whole group: all of it selected means untick, anything else means
  // tick the lot — the same rule for the header and for one game's cell.
  const toggleMany = (ids: number[]) => setSelected(prev => {
    const next = new Set(prev)
    if (ids.every(id => next.has(id))) for (const id of ids) next.delete(id)
    else for (const id of ids) next.add(id)
    return next
  })

  // Confirm the ticked tags. One request per game because a confirm is atomic
  // per game server-side; sequential so a failure on one game is reported
  // against that game rather than racing the others' messages.
  const confirmSelected = async () => {
    const chosen = rows.filter(r => selected.has(r.id))
    if (chosen.length === 0) return
    const byGame = new Map<string, PendingRow[]>()
    for (const r of chosen) {
      const g = byGame.get(r.game_id)
      if (g) g.push(r); else byGame.set(r.game_id, [r])
    }

    setWorking(true)
    markBusy(chosen.map(r => r.id), true)
    const counts: Record<string, number> = {}
    const skipped: string[] = []
    const done: number[] = []
    const failed: string[] = []

    for (const [gameId, gameRows] of Array.from(byGame)) {
      const ids = gameRows.map(r => r.id)
      try {
        const res = await fetch('/api/playtest-tags/confirm', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ game_id: gameId, ids, overwrite: ids.filter(id => overwrite.has(id)) }),
        })
        const d = await res.json().catch(() => ({}))
        if (!res.ok) { failed.push(`${gameRows[0].title}: ${d.error || 'confirm failed'}`); continue }
        for (const x of (d.results || []) as { result: string }[]) {
          counts[x.result] = (counts[x.result] || 0) + 1
        }
        // `skipped` names the tags that did not reach Signal Sense (retired
        // value, or the row moved underneath us) so the summary is actionable
        // rather than a count of results nobody asked for.
        for (const s of (d.skipped || []) as { field_value: string; reason: string }[]) {
          skipped.push(`${s.field_value} (${s.reason})`)
        }
        // Every requested id is resolved now, whether it was written or not:
        // ids missing from `results` were confirmed or rejected elsewhere.
        done.push(...ids)
      } catch { failed.push(`${gameRows[0].title}: network error`) }
    }

    markBusy(chosen.map(r => r.id), false)
    dropRows(done)
    setWorking(false)

    const parts: string[] = []
    if (done.length) {
      const breakdown = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')
      parts.push(`Confirmed ${done.length} tag${done.length === 1 ? '' : 's'}${breakdown ? ` — ${breakdown}` : ''}`)
    }
    if (skipped.length) parts.push(`not written: ${skipped.join('; ')}`)
    if (failed.length) parts.push(`failed — ${failed.join('; ')}`)
    setMsg(parts.join(' · ') || 'Nothing to confirm')
  }

  const rejectTags = async (ids: number[]) => {
    if (ids.length === 0) return
    markBusy(ids, true)
    try {
      const r = await fetch('/api/playtest-tags/reject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      })
      if (!r.ok) { setMsg('Reject failed'); markBusy(ids, false); return }
      dropRows(ids)
      setMsg(`Rejected ${ids.length} tag${ids.length === 1 ? '' : 's'} — nothing was written to Signal Sense.`)
    } catch { setMsg('Network error') }
    markBusy(ids, false)
  }

  const gameCount = useMemo(() => new Set(rows.map(r => r.game_id)).size, [rows])

  // One entry per game, in the order the rows arrived, so the panel's prev/next
  // walks the games the admin is looking at.
  const gameList = useMemo<EvalListItem[]>(() => {
    const seen = new Set<string>()
    const list: EvalListItem[] = []
    for (const r of rows) {
      if (seen.has(r.game_id)) continue
      seen.add(r.game_id)
      list.push({ game_id: r.game_id, title: r.title })
    }
    return list
  }, [rows])

  // Values already proposed for a game are hidden from that game's pickers: the
  // pending set is unique on (game, value), so renaming onto one would 409.
  const usedByGame = useMemo(() => {
    const m = new Map<string, Set<string>>()
    for (const r of rows) {
      const s = m.get(r.game_id)
      if (s) s.add(r.field_value); else m.set(r.game_id, new Set([r.field_value]))
    }
    return m
  }, [rows])

  const hasMore = rows.length < total

  // Load the next page when the sentinel row scrolls into the list's viewport.
  // `root` is the scrolling card, not the window — the observer would never fire
  // against the window since the list scrolls inside its own box.
  useEffect(() => {
    const el = sentinelRef.current
    if (!el || !hasMore || loading || working) return
    const io = new IntersectionObserver(entries => {
      if (entries[0]?.isIntersecting) void load(rows.length, true)
    }, { root: el.closest('.tag-scroll'), rootMargin: '200px' })
    io.observe(el)
    return () => io.disconnect()
  }, [hasMore, loading, working, rows.length, load])

  if (loading && rows.length === 0) return <div className="card"><p className="empty">Loading…</p></div>
  if (rows.length === 0) {
    return (
      <div className="card">
        {msg && <p style={{ margin: '0 0 10px', fontSize: 12.5, color: 'var(--muted)' }}>{msg}</p>}
        <p className="empty">
          Nothing waiting for review. Trends tagged during playtest show up here.
        </p>
      </div>
    )
  }

  const allIds = rows.map(r => r.id)
  const selectedRows = rows.filter(r => selected.has(r.id))
  const cleanIds = rows.filter(r => !r.conflict).map(r => r.id)
  // Ticked conflicts left unticked for overwrite: confirming rejects them, so
  // say so before the click rather than in the result summary.
  const keptCount = selectedRows.filter(r => r.conflict && !overwrite.has(r.id)).length

  return (
    <div className="card">
      <div className="card-head" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
        <span className="card-label">
          Pending
          <span style={{ color: 'var(--faint)', fontWeight: 400, marginLeft: 8 }}>
            {hasMore ? `${rows.length} of ${total}` : `${total} tag${total === 1 ? '' : 's'}`}
            {' '}· {gameCount} game{gameCount === 1 ? '' : 's'}{hasMore ? ' loaded' : ''}
          </span>
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {selected.size === 0 ? (
            <>
              <span style={{ fontSize: 12, color: 'var(--faint)' }}>Tick the tags to review</span>
              {cleanIds.length > 0 && cleanIds.length < rows.length && (
                <button className="btn btn-sm btn-ghost" onClick={() => setSelected(new Set(cleanIds))}>
                  Select {cleanIds.length} without conflicts
                </button>
              )}
            </>
          ) : (
            <>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                {selected.size} selected
                {keptCount > 0 && (
                  <span style={{ color: 'var(--warn)' }}>
                    {' '}· {keptCount} conflict{keptCount === 1 ? '' : 's'} will be rejected unless ticked to overwrite
                  </span>
                )}
              </span>
              <button className="btn btn-primary btn-sm" disabled={working}
                onClick={confirmSelected}>
                {working ? 'Confirming…' : `Confirm ${selected.size} tag${selected.size === 1 ? '' : 's'}`}
              </button>
              <button className="btn btn-sm" disabled={working}
                title="Discard these proposals without writing anything to Signal Sense"
                onClick={() => rejectTags(Array.from(selected))}>
                Reject
              </button>
              <button className="btn btn-sm btn-ghost" disabled={working}
                onClick={() => setSelected(new Set())}>Clear</button>
            </>
          )}
        </div>
      </div>

      {optionsError && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <span style={{ fontSize: 12.5, color: 'var(--warn)' }}>
            The trends list didn&apos;t load, so tags can be confirmed or rejected but not edited.
          </span>
          <button className="btn btn-sm" onClick={loadOptions}>Try again</button>
        </div>
      )}

      {msg && <p style={{ margin: '0 0 10px', fontSize: 12.5, color: 'var(--muted)' }}>{msg}</p>}

      <div className="tbl-wrap tag-scroll">
        <table className="tbl">
          <thead>
            <tr>
              <th style={{ width: 34 }}>
                <TriCheckbox
                  checked={selected.size === rows.length}
                  indeterminate={selected.size > 0}
                  onChange={() => toggleMany(allIds)}
                  title="Select all loaded tags"
                  disabled={working}
                />
              </th>
              <th style={{ width: '30%' }}>Game</th>
              <th style={{ width: '24%' }}>Trend</th>
              <th style={{ width: '26%' }}>Sub-value</th>
              <th style={{ width: '20%' }}>Proposed by</th>
              <th style={{ width: 52 }} />
            </tr>
          </thead>
          <tbody>
            {rows.map(t => (
              <tr key={t.id} style={rowBusy.has(t.id) ? { opacity: 0.5 } : undefined}>
                <td>
                  <input type="checkbox" checked={selected.has(t.id)}
                    disabled={working || rowBusy.has(t.id)}
                    aria-label={`Select ${t.field_value} on ${t.title}`}
                    onChange={() => toggleRow(t.id)}
                    style={{ cursor: 'pointer' }} />
                </td>
                <td className="cell-name">
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                    {t.icon_url && (
                      <img src={t.icon_url} alt="" width={24} height={24}
                        style={{ borderRadius: 6, flexShrink: 0, border: '1px solid var(--border)' }} />
                    )}
                    <span style={{ minWidth: 0 }}>
                      <GameButton title={t.title} gameId={t.game_id} onOpen={onOpenGame} list={gameList} />
                      <span style={{ display: 'block', fontSize: 11, fontWeight: 400, color: 'var(--faint)' }}>
                        {t.publisher_name || '—'} · {t.initial_evaluator || 'unassigned'}
                      </span>
                    </span>
                  </span>
                </td>
                <td>
                  {optionsError ? (
                    <span className="num">{t.field_value}</span>
                  ) : (
                    <TrendValuePicker
                      options={options}
                      exclude={usedByGame.get(t.game_id) ?? new Set()}
                      label={t.field_value}
                      title="Change the trend value"
                      triggerClassName="input"
                      triggerStyle={{ fontSize: 12.5, padding: '6px 9px', width: '100%' }}
                      disabled={editing === t.id || working || rowBusy.has(t.id)}
                      onPick={v => patchTag(t.id, { field_value: v })}
                    />
                  )}
                </td>
                <td>
                  {optionsError ? (
                    <span style={{ color: 'var(--faint)' }}>{t.sub_value_name || 'None'}</span>
                  ) : (
                    <select
                      className="input"
                      style={{ fontSize: 12.5, padding: '6px 9px', width: '100%' }}
                      value={t.sub_value_id ?? ''}
                      disabled={editing === t.id || working || rowBusy.has(t.id)}
                      onChange={e => patchTag(t.id, { sub_value_id: e.target.value ? Number(e.target.value) : null })}
                    >
                      <option value="">None</option>
                      {subValues.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  )}
                  {/* A conflict changes what Confirm does to this row, so it
                      belongs on the row rather than in a column of its own:
                      Signal Sense's sub-value stands unless this is ticked. */}
                  {t.conflict && (
                    <label style={{ display: 'flex', alignItems: 'flex-start', gap: 6, marginTop: 5, fontSize: 11, color: 'var(--warn)', cursor: 'pointer' }}>
                      <input type="checkbox" checked={overwrite.has(t.id)}
                        disabled={working || rowBusy.has(t.id)}
                        aria-label={`Overwrite ${t.their_sub_value_name} on ${t.field_value}`}
                        onChange={() => toggleOverwrite(t.id)}
                        style={{ marginTop: 1 }} />
                      <span>
                        Signal Sense has <strong>{t.their_sub_value_name}</strong> — tick to overwrite,
                        otherwise this tag is rejected
                      </span>
                    </label>
                  )}
                </td>
                <td style={{ fontSize: 12, color: 'var(--muted)' }}>
                  {t.tagged_by_name || 'unknown'}
                  <span style={{ display: 'block', fontSize: 11, color: 'var(--faint)', fontFamily: 'var(--num)' }}>
                    {fmt(t.tagged_at)}
                  </span>
                </td>
                <td>
                  <button className="btn btn-sm btn-ghost" title="Reject this tag"
                    disabled={working || rowBusy.has(t.id)}
                    onClick={() => rejectTags([t.id])}
                    style={{ color: 'var(--faint)' }}>✕</button>
                </td>
              </tr>
            ))}
            {/* Watched by the observer above: crossing into view loads the next
                page. Kept inside the table so it scrolls with the rows. */}
            {(hasMore || loading) && (
              <tr ref={sentinelRef}>
                <td colSpan={6} className="tag-sentinel">
                  {loading ? 'Loading…' : `${rows.length} of ${total} — scroll for more`}
                </td>
              </tr>
            )}
            {!hasMore && !loading && rows.length > 0 && (
              <tr><td colSpan={6} className="tag-sentinel">All {total} shown</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function HistoryView({ onOpenGame }: { onOpenGame: OpenGame }) {
  const [rows, setRows] = useState<HistoryRow[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  // Defaults to this month: the queue is reviewed continuously, so the useful
  // question is "what did we do lately", not "everything ever".
  const [from, setFrom] = useState(monthStartLocal)
  const [to, setTo] = useState(todayLocal)
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState<number | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<number | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [loading, setLoading] = useState(false)
  const sentinelRef = useRef<HTMLTableRowElement>(null)
  const limit = 50

  // One page at a time, appended. `append` distinguishes "next page" from a
  // fresh read after the filters changed, which must replace what is on screen.
  const fetchPage = useCallback(async (p: number, append: boolean) => {
    const qs = new URLSearchParams({ page: String(p), limit: String(limit) })
    if (from) qs.set('from', from)
    if (to) qs.set('to', to)
    setLoading(true)
    try {
      const r = await fetch(`/api/playtest-tags/history?${qs}`)
      const d = r.ok ? await r.json() : { rows: [], total: 0 }
      const next = (d.rows || []) as HistoryRow[]
      if (append && next.length === 0) {
        // An empty page while total still claims more would leave the observer
        // asking forever. Trust what actually arrived and stop.
        setRows(prev => { setTotal(prev.length); return prev })
      } else {
        setRows(prev => (append ? [...prev, ...next] : next))
        setTotal(d.total || 0)
      }
      setPage(p)
    } catch {
      if (!append) { setRows([]); setTotal(0) }
    }
    setLoading(false)
  }, [from, to])

  // Sweep for tags deleted in Signal Sense, then read. Signal Sense keeps no
  // deletion log of its own, so this is the only chance to notice, and the sweep
  // has to finish first or the first paint would miss the stamps it writes.
  //
  // Keyed on reloadKey alone: a date tweak or a scroll must not re-run a
  // database sweep, and this leaves the first page load to this effect rather
  // than the filter one below.
  useEffect(() => {
    let live = true
    fetch('/api/playtest-tags/reconcile', { method: 'POST' })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (live && d?.removed > 0) setMsg(`${d.removed} tag${d.removed === 1 ? '' : 's'} no longer in Signal Sense — recorded as removed.`) })
      .catch(() => {})
      .finally(() => { if (live) void fetchPage(1, false) })
    return () => { live = false }
    // fetchPage is intentionally omitted: including it would re-sweep on every
    // date change, and the filter effect below already handles those.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey])

  // Filter changes re-read from page 1 without sweeping. Skipped on mount, where
  // the sweep effect above does the first read.
  const mounted = useRef(false)
  useEffect(() => {
    if (!mounted.current) { mounted.current = true; return }
    void fetchPage(1, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to])

  // Two-click confirm, the same shape as the evaluation panel's Clear all. This
  // deletes a row out of Signal Sense's table, so a stray click must not do it.
  const askRemove = (r: HistoryRow) => {
    if (confirmRemove !== r.id) {
      setConfirmRemove(r.id)
      setTimeout(() => setConfirmRemove(c => (c === r.id ? null : c)), 4000)
      return
    }
    setConfirmRemove(null)
    void removeTag(r)
  }

  const removeTag = async (r: HistoryRow) => {
    setBusy(r.id)
    try {
      const res = await fetch('/api/playtest-tags/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: r.id }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) setMsg(d.error || 'Could not remove that tag')
      else setMsg(d.outcome === 'deleted'
        ? `Removed ${r.field_value} from Signal Sense.`
        : `${r.field_value} was already gone from Signal Sense — recorded as removed.`)
      setReloadKey(k => k + 1)
    } catch { setMsg('Network error') }
    setBusy(null)
  }

  const hasMore = rows.length < total

  // Load the next page when the sentinel row scrolls into the list's viewport.
  // `root` is the scrolling card, not the window — the observer would never fire
  // against the window since the list scrolls inside its own box.
  useEffect(() => {
    const el = sentinelRef.current
    if (!el || !hasMore || loading) return
    const io = new IntersectionObserver(entries => {
      if (entries[0]?.isIntersecting) void fetchPage(page + 1, true)
    }, { root: el.closest('.tag-scroll'), rootMargin: '200px' })
    io.observe(el)
    return () => io.disconnect()
  }, [hasMore, loading, page, fetchPage])

  // One Game cell per game, spanning its tags. Rows arrive newest-first, so a
  // game's group takes the position of its most recent tag and keeps that order
  // inside — grouping must not reshuffle the page into a different sort.
  const groups = useMemo(() => {
    const byGame = new Map<string, HistoryRow[]>()
    for (const r of rows) {
      const g = byGame.get(r.game_id)
      if (g) g.push(r)
      else byGame.set(r.game_id, [r])
    }
    return Array.from(byGame, ([game_id, gameRows]) => ({ game_id, rows: gameRows }))
  }, [rows])

  // One entry per game on this page, so the panel's prev/next walks the games
  // the admin is looking at rather than every game in the system.
  const gameList = useMemo<EvalListItem[]>(
    () => groups.map(g => ({ game_id: g.game_id, title: g.rows[0].title })), [groups])

  return (
    <div className="card">
      <div className="card-head" style={{ alignItems: 'flex-end' }}>
        <span className="card-label">
          Reviewed
          <span style={{ color: 'var(--faint)', fontWeight: 400, marginLeft: 8 }}>{total}</span>
        </span>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10 }}>
          <div className="field">
            <span className="label">From</span>
            <input className="input" type="date" style={{ width: 150 }}
              value={from} onChange={e => setFrom(e.target.value)} />
          </div>
          <div className="field">
            <span className="label">To</span>
            <input className="input" type="date" style={{ width: 150 }}
              value={to} onChange={e => setTo(e.target.value)} />
          </div>
          {/* The range starts at this month, so "Clear" would be a lie — name what
              each button actually selects. */}
          {(from || to) && (
            <button className="btn btn-sm btn-ghost" onClick={() => { setFrom(''); setTo('') }}>All time</button>
          )}
          {(from !== monthStartLocal() || to !== todayLocal()) && (
            <button className="btn btn-sm btn-ghost"
              onClick={() => { setFrom(monthStartLocal()); setTo(todayLocal()) }}>This month</button>
          )}
        </div>
      </div>

      {msg && <p style={{ margin: '0 0 10px', fontSize: 12.5, color: 'var(--muted)' }}>{msg}</p>}

      <div className="tbl-wrap tag-scroll">
        <table className="tbl">
          <thead>
            <tr>
              <th style={{ width: 172 }}>Game</th>
              <th style={{ width: 150 }}>Trend</th>
              <th style={{ width: 116 }}>Sub-value</th>
              <th style={{ width: 116 }}>Proposed</th>
              <th style={{ width: 116 }}>Reviewed</th>
              <th style={{ width: 96 }}>Result</th>
              <th>Note</th>
              <th style={{ width: 84 }} />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={8} className="empty">Nothing reviewed yet.</td></tr>
            )}
            {groups.map(g => g.rows.map((r, i) => (
              <tr key={r.id}>
                {i === 0 && (
                  <td className="cell-name" rowSpan={g.rows.length}
                    style={{ verticalAlign: 'top', borderRight: '1px solid var(--border)' }}>
                    <span style={{ display: 'inline-flex', alignItems: 'flex-start', gap: 8 }}>
                      {r.icon_url && (
                        <img src={r.icon_url} alt="" width={24} height={24}
                          style={{ borderRadius: 6, flexShrink: 0, border: '1px solid var(--border)' }} />
                      )}
                      <span style={{ minWidth: 0 }}>
                        <GameButton title={r.title} gameId={r.game_id} onOpen={onOpenGame} list={gameList} />
                        {g.rows.length > 1 && (
                          <span style={{ display: 'block', fontSize: 11, fontWeight: 400, color: 'var(--faint)' }}>
                            {g.rows.length} tags
                          </span>
                        )}
                      </span>
                    </span>
                  </td>
                )}
                <td className="num">{r.field_value}</td>
                <td style={{ color: r.sub_value_name ? undefined : 'var(--faint)' }}>{r.sub_value_name || '—'}</td>
                <td>
                  {r.tagged_by_name || '—'}
                  <span style={{ display: 'block', fontSize: 11, color: 'var(--faint)', fontFamily: 'var(--num)' }}>
                    {fmt(r.tagged_at)}
                  </span>
                </td>
                <td>
                  {r.confirmed_by_name || '—'}
                  <span style={{ display: 'block', fontSize: 11, color: 'var(--faint)', fontFamily: 'var(--num)' }}>
                    {fmt(r.confirmed_at)}
                  </span>
                </td>
                <td>
                  <span className={`pill ${r.removed_at ? 'off' : RESULT_PILL[r.sync_result ?? ''] ?? 'tag'}`} style={{ fontSize: 10 }}>
                    {r.removed_at ? 'removed' : (r.sync_result || r.status)}
                  </span>
                </td>
                {/* What happened to the tag after it was reviewed. Empty for a tag
                    still sitting in Signal Sense exactly as it was synced. */}
                <td style={{ fontSize: 11.5, lineHeight: 1.5 }}>
                  {r.removed_at && (
                    <span style={{ display: 'block', color: 'var(--muted)' }}>
                      was {r.sync_result || r.status}, removed {fmt(r.removed_at)}
                      {r.removed_by === 'signal_sense'
                        ? ' in Signal Sense'
                        : r.removed_by_name ? ` by ${r.removed_by_name}` : ''}
                    </span>
                  )}
                  {r.sub_changed_at && (
                    <span style={{ display: 'block', color: 'var(--warn)' }}>
                      sub-value now {r.sub_changed_to || 'None'}
                      {r.sub_changed_from ? ` (was ${r.sub_changed_from})` : ''}, {fmt(r.sub_changed_at)}
                      {r.sub_changed_by ? ` by ${r.sub_changed_by}` : ''}
                    </span>
                  )}
                  {!r.removed_at && !r.sub_changed_at && (
                    <span style={{ color: 'var(--faint)' }}>—</span>
                  )}
                </td>
                <td>
                  {r.status === 'synced' && r.in_signal_sense && (
                    r.ours ? (
                      <button className="btn btn-sm btn-ghost" disabled={busy === r.id}
                        title={confirmRemove === r.id
                          ? `Deletes ${r.field_value} from Signal Sense — click again to confirm`
                          : 'Delete this tag from Signal Sense and record the removal'}
                        onClick={() => askRemove(r)}
                        style={confirmRemove === r.id
                          ? { color: 'var(--bad)', borderColor: 'var(--bad)', background: 'var(--bad-weak)', fontWeight: 600 }
                          : { color: 'var(--bad)' }}>
                        {busy === r.id ? '…' : confirmRemove === r.id ? 'Confirm?' : 'Remove'}
                      </button>
                    ) : (
                      <span style={{ fontSize: 10.5, color: 'var(--faint)' }} title="playtest sync did not create this row, so it cannot be removed from here">
                        added in Signal Sense
                      </span>
                    )
                  )}
                </td>
              </tr>
            )))}
            {/* Watched by the observer above: crossing into view loads the next
                page. Kept inside the table so it scrolls with the rows. */}
            {(hasMore || loading) && (
              <tr ref={sentinelRef}>
                <td colSpan={8} className="tag-sentinel">
                  {loading ? 'Loading…' : `${rows.length} of ${total} — scroll for more`}
                </td>
              </tr>
            )}
            {!hasMore && !loading && rows.length > 0 && (
              <tr><td colSpan={8} className="tag-sentinel">All {total} shown</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
