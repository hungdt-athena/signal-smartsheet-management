'use client'
import { useState, useEffect, useCallback, useRef, useMemo, memo, Suspense } from 'react'
import type { CSSProperties, MouseEvent as ReactMouseEvent, RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useSession } from 'next-auth/react'
import { useSearchParams } from 'next/navigation'
import { StyledSelect } from '@/components/StyledSelect'
import { MultiSelect } from '@/components/MultiSelect'
import { DateFilter, dateFilterParams, monthToValue, valueToYearMonth, valueLabel } from '@/components/DateFilter'
import type { YearMonth } from '@/components/DateFilter'
import { useDateFilter } from '@/hooks/useDateFilter'
import { useConfig } from '@/hooks/useConfig'
import EvalDetailPanel, { weekBatches } from '@/components/EvalDetailPanel'
import { weekLabelOrder } from '@/lib/weekly-feedback'
import {
  SEARCH_MIN_CHARS, SEARCH_DEBOUNCE_MS, SEARCH_TOTAL_CAP, SEARCH_PAGE_SIZE,
} from '@/lib/eval-search'
import { Highlight } from '@/components/Highlight'
import { QuickStatsModal } from '@/components/QuickStatsModal'
import { WeeklyFeedbackTab } from '@/components/weekly-feedback/WeeklyFeedbackTab'
import { TaggingTab } from '@/components/TaggingTab'
import { BUCKETS, prettyConclusion, type Bucket } from '@/lib/buckets'
import type { EvalDetail, EvalListItem } from '@/components/EvalDetailPanel'
import { GameAlikeChips, GameAlikeField } from '@/components/GameAlikeField'
import { TrendTagCell, type GameTrendTag } from '@/components/TrendTagCell'
import type { GameAlikeGame } from '@/components/weekly-feedback/types'
import { isManagerRole } from '@/lib/roles'

interface Evaluation {
  id: number
  game_id: string
  category_group: string
  genre_1: string | null
  genre_2: string | null
  initial_evaluator: string | null
  final_evaluator: string | null
  assigned_date: string | null
  evaluate_date: string | null
  initial_note: string | null
  initial_conclusion: string | null
  drive_link: string | null
  imported_at: string
  title: string
  os: string
  app_link: string
  icon_url: string | null
  release_date: string | null
  publisher_name: string | null
  tags: GameTrendTag[] | null
}


const CONCLUSION_COLORS: Record<string, string> = {
  'Bypass': 'error', 'M_ByPass': 'error', 'Skip': 'error', 'Link_dead': 'error',
  // Stale_release: pushed by mistake (back-catalog game), taken out of the queue
  // without anyone evaluating it. Not selectable — set by the prune script only.
  'Stale_release': 'error',
  'Playtest & Bypass': 'error',
  'Good': 'success', 'Conclusion': 'success',
  'List_Idea': 'success', 'Priority I': 'success', 'Priority II': 'success',
  'Priority III: Watchlist for next phase': 'running',
  'Priority IV: Idea': 'running', 'Watchlist for next milestone': 'running',
  'Need deeper testing': 'running', 'Wait for PlayTest': 'running',
  'Check Market Data': 'running', 'Need Direction': 'running',
}

const CONCLUSION_OPTIONS = [
  'Bypass', 'Conclusion', 'Good', 'Link_dead', 'M_ByPass', 'Need deeper testing', 'Skip',
  'Wait for PlayTest', 'Priority IV: Idea', 'Priority III: Watchlist for next phase',
  'Check Market Data', 'Watchlist for next milestone', 'Priority II', 'Priority I',
  'Need Direction', 'List_Idea', 'Playtest & Bypass',
]

// Sentinel for the Short List "Final conclusion" filter meaning "not yet
// decided" (final_conclusion IS NULL). Kept in sync with the server check.
const FINAL_CONCLUSION_NONE = '(none)'

// Final Conclusion is the moderator's triage verdict (distinct from the
// evaluator's initial_conclusion). Options are managed from the Config tab
// (see useConfig); these are just the badge colors keyed by value.
const FINAL_CONCLUSION_STYLES: Record<string, { bg: string; color: string }> = {
  'Priority V':  { bg: '#ede9fe', color: '#6d28d9' },
  'Priority IV': { bg: '#0f766e', color: '#ffffff' },
  'Bypass':      { bg: '#d23b3b', color: '#ffffff' },
  'Theme/Art':   { bg: '#dbeafe', color: '#2563eb' },
  'Insight':     { bg: '#15803d', color: '#ffffff' },
  'Watch List':  { bg: '#dcfce7', color: '#16a34a' },
  'Not Found':   { bg: '#374151', color: '#e5e7eb' },
}

function osLabel(os: string) {
  const o = (os || '').toLowerCase()
  if (o === 'ios') return 'iOS'
  if (o === 'android') return 'Android'
  return os ? os.toUpperCase() : '—'
}

// Tiny per-cell copy button. Reveals on row hover; copies the given text
// (a URL for hyperlink cells, the displayed value otherwise).
function CopyBtn({ text }: { text: string | null | undefined }) {
  const [done, setDone] = useState(false)
  if (!text) return null
  return (
    <button
      type="button"
      className={`cell-copy${done ? ' done' : ''}`}
      title="Copy to clipboard"
      onClick={e => {
        e.stopPropagation()
        navigator.clipboard.writeText(text).then(() => {
          setDone(true)
          setTimeout(() => setDone(false), 1200)
        }).catch(() => {})
      }}
    >
      {done ? (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </button>
  )
}

function FinalConclusionBadge({ value }: { value: string }) {
  const s = FINAL_CONCLUSION_STYLES[value] || { bg: 'var(--surface-3)', color: 'var(--muted)' }
  return (
    <span style={{
      display: 'inline-block', fontSize: 11, fontWeight: 700, padding: '3px 10px',
      borderRadius: 999, background: s.bg, color: s.color, whiteSpace: 'nowrap', lineHeight: 1.5,
    }}>{value}</span>
  )
}

interface ShortListItem {
  id: number
  game_id: string
  title: string
  icon_url: string | null
  os: string
  app_link: string | null
  genre_1: string | null
  genre_2: string | null
  initial_evaluator: string | null
  initial_note: string | null
  final_note: string | null
  game_alike: GameAlikeGame[] | null
  initial_conclusion: string | null
  final_conclusion: string | null
  batch: string | null
  drive_link: string | null
  publisher_name: string | null
  assigned_date: string | null
  evaluate_date: string | null
  category_group: string
  tags: GameTrendTag[] | null
}

// Dashed accent pill for empty editable cells ("+ Set" / "+ Add note").
const ADD_PILL: CSSProperties = {
  fontSize: 11, fontWeight: 600, color: 'var(--accent)', border: '1px dashed var(--accent-border)',
  borderRadius: 999, padding: '2px 9px', background: 'var(--accent-weak)', whiteSpace: 'nowrap', cursor: 'pointer',
}

// Truncated note text with a large floating preview on hover. The preview is
// portaled to <body> so the scrolling table container never clips it.
function NoteHover({ text, maxWidth = 240 }: { text: string; maxWidth?: number }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const show = () => {
    const r = ref.current?.getBoundingClientRect()
    if (r) setPos({ top: r.bottom + 6, left: Math.min(r.left, window.innerWidth - 380) })
  }
  return (
    <span
      ref={ref}
      onMouseEnter={show}
      onMouseLeave={() => setPos(null)}
      style={{ fontSize: 12.5, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block', maxWidth, cursor: 'inherit' }}
    >
      {text}
      {pos && createPortal(
        <div style={{
          position: 'fixed', top: pos.top, left: pos.left, zIndex: 1000, maxWidth: 360,
          background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)',
          borderRadius: 10, boxShadow: '0 10px 30px rgba(0,0,0,0.20)', padding: '10px 13px',
          fontSize: 13.5, lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        }}>{text}</div>,
        document.body
      )}
    </span>
  )
}

// Floating editor anchored under a table cell. Portaled to <body> so it is
// never clipped by the scrolling table; closes on outside click, scroll
// (outside itself), or resize. Flips above the cell when space is tight.
function CellPopover({ anchor, onClose, width = 200, children }: {
  anchor: DOMRect
  onClose: () => void
  width?: number
  children: React.ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const inside = (t: EventTarget | null) => !!ref.current?.contains(t as Node)
    const onDoc = (e: MouseEvent) => { if (!inside(e.target)) onClose() }
    const onScroll = (e: Event) => { if (!inside(e.target)) onClose() }
    document.addEventListener('mousedown', onDoc)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onClose)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  const spaceBelow = window.innerHeight - anchor.bottom
  const flipUp = spaceBelow < 240 && anchor.top > spaceBelow
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - width - 12))
  return createPortal(
    <div
      ref={ref}
      onClick={e => e.stopPropagation()}
      style={{
        position: 'fixed', left, width, zIndex: 3000,
        top: flipUp ? undefined : anchor.bottom + 5,
        bottom: flipUp ? window.innerHeight - anchor.top + 5 : undefined,
        background: 'var(--surface)', border: '1px solid var(--border-strong)',
        borderRadius: 9, boxShadow: 'var(--shadow-md)',
      }}
    >
      {children}
    </div>,
    document.body
  )
}

const CHECK_PATH = 'M20 6L9 17l-5-5'

function FinalConclusionCell({ item, isManager, options, onSaved }: {
  item: ShortListItem
  isManager: boolean
  options: string[]
  onSaved: (id: number, value: string) => void
}) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const val = item.final_conclusion

  const pick = async (v: string) => {
    setAnchor(null)
    if (!v || v === val) return
    try {
      const res = await fetch('/api/evaluations', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: item.id, final_conclusion: v }),
      })
      if (res.ok) onSaved(item.id, v)
    } catch { /* ignore */ }
  }

  return (
    <>
      <span
        onClick={e => { if (isManager) { e.stopPropagation(); setAnchor(e.currentTarget.getBoundingClientRect()) } }}
        title={isManager ? 'Click to set final conclusion' : undefined}
        style={{ cursor: isManager ? 'pointer' : 'default', display: 'inline-flex' }}
      >
        {val
          ? <FinalConclusionBadge value={val} />
          : isManager
            ? <span style={ADD_PILL}>+ Set</span>
            : <span style={{ fontSize: 12, color: 'var(--faint)' }}>—</span>}
      </span>
      {anchor && (
        <CellPopover anchor={anchor} onClose={() => setAnchor(null)} width={220}>
          <div style={{ padding: 4, maxHeight: 280, overflowY: 'auto' }}>
            {options.map(c => (
              <div key={c} className={'ssel-opt' + (c === val ? ' sel' : '')} onClick={() => pick(c)}>
                <span>{c}</span>
                {c === val && (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d={CHECK_PATH} />
                  </svg>
                )}
              </div>
            ))}
          </div>
        </CellPopover>
      )}
    </>
  )
}

// Demo Video cell with inline import. Games without a demo video show "+ Import";
// clicking reveals an input to paste a Drive/video link, saved via PATCH drive_link.
// Anyone who can see the row may attach a video (view is access-controlled upstream).
function DemoVideoCell({ item, onSaved }: {
  item: ShortListItem
  onSaved: (id: number, value: string | null) => void
}) {
  const [editing, setEditing] = useState(false)
  const [val, setVal] = useState(item.drive_link || '')
  const [saving, setSaving] = useState(false)

  const cancel = () => { setVal(item.drive_link || ''); setEditing(false) }

  const save = async () => {
    const v = val.trim()
    if (v === (item.drive_link || '')) { setEditing(false); return }
    setSaving(true)
    try {
      const res = await fetch('/api/evaluations', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: item.id, drive_link: v || null }),
      })
      if (res.ok) onSaved(item.id, v || null)
    } catch { /* ignore */ }
    setSaving(false)
    setEditing(false)
  }

  if (editing) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }} onClick={e => e.stopPropagation()}>
        <input
          autoFocus
          className="input"
          style={{ fontSize: 11, padding: '3px 6px', width: 150 }}
          placeholder="Paste video link…"
          value={val}
          onChange={e => setVal(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') cancel() }}
          disabled={saving}
        />
        <button className="btn btn-primary btn-sm" style={{ padding: '3px 7px', fontSize: 11 }} onClick={save} disabled={saving} title="Save link">✓</button>
        <button className="btn btn-ghost btn-sm" style={{ padding: '3px 6px', fontSize: 11 }} onClick={cancel} disabled={saving} title="Cancel">✕</button>
      </span>
    )
  }

  if (item.drive_link) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center' }}>
        <a href={item.drive_link} target="_blank" rel="noopener" onClick={e => e.stopPropagation()} className="drive-btn">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="23 7 16 12 23 17 23 7" /><rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
          </svg>
          Video
        </a>
        <button className="cell-copy" title="Replace video link"
          onClick={e => { e.stopPropagation(); setVal(item.drive_link || ''); setEditing(true) }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
          </svg>
        </button>
        <CopyBtn text={item.drive_link} />
      </span>
    )
  }

  return (
    <button onClick={e => { e.stopPropagation(); setEditing(true) }}
      title="Import a demo video link"
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4, border: 'none', background: 'transparent',
        cursor: 'pointer', fontSize: 12, fontWeight: 600, color: 'var(--accent)', padding: 0,
      }}>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
      </svg>
      Import
    </button>
  )
}

// Manager-only inline Final Note. Click to reveal a textarea; save via PATCH
// final_note. Non-managers see the text read-only (no edit affordance).
function FinalNoteCell({ item, isManager, onSaved }: {
  item: ShortListItem
  isManager: boolean
  onSaved: (id: number, value: string | null) => void
}) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const [val, setVal] = useState(item.final_note || '')
  const [saving, setSaving] = useState(false)

  const openEdit = (e: ReactMouseEvent) => {
    e.stopPropagation()
    setVal(item.final_note || '')
    setAnchor(e.currentTarget.getBoundingClientRect())
  }
  const close = () => setAnchor(null)

  const save = async () => {
    const v = val.trim()
    if (v === (item.final_note || '')) { close(); return }
    setSaving(true)
    try {
      const res = await fetch('/api/evaluations', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: item.id, final_note: v || null }),
      })
      if (res.ok) onSaved(item.id, v || null)
    } catch { /* ignore */ }
    setSaving(false)
    close()
  }

  return (
    <>
      <span
        onClick={isManager ? openEdit : undefined}
        style={{ display: 'inline-flex', alignItems: 'center', maxWidth: 240, cursor: isManager ? 'pointer' : 'default' }}
      >
        {item.final_note
          ? <NoteHover text={item.final_note} maxWidth={220} />
          : isManager
            ? <span style={ADD_PILL}>+ Add note</span>
            : <span style={{ fontSize: 12, color: 'var(--faint)' }}>—</span>}
      </span>
      {anchor && (
        <CellPopover anchor={anchor} onClose={close} width={300}>
          <div style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <textarea
              autoFocus
              className="input"
              rows={4}
              style={{ fontSize: 13, resize: 'vertical', width: '100%', minHeight: 86, lineHeight: 1.5 }}
              placeholder="Final note…"
              value={val}
              onChange={e => setVal(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save(); if (e.key === 'Escape') close() }}
              disabled={saving}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 10.5, color: 'var(--faint)' }}>⌘/Ctrl+Enter to save</span>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="btn btn-ghost btn-sm" onClick={close} disabled={saving}>Cancel</button>
                <button className="btn btn-primary btn-sm" onClick={save} disabled={saving}>Save</button>
              </div>
            </div>
          </div>
        </CellPopover>
      )}
    </>
  )
}

// Inline "Game Alike" editor for the Short List. Display is read-only chips;
// editable for the row owner or a manager. Clicking opens a popover with the
// full GameAlikeField (search + chips); the current chips persist when it
// closes (outside click / Done) so nothing is lost without an explicit save.
function GameAlikeCell({ item, canEdit, onSaved }: {
  item: ShortListItem
  canEdit: boolean
  onSaved: (id: number, value: GameAlikeGame[]) => void
}) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const [draft, setDraft] = useState<GameAlikeGame[]>(item.game_alike || [])
  const draftRef = useRef(draft)
  draftRef.current = draft
  const games = item.game_alike || []

  const open = (e: ReactMouseEvent) => {
    e.stopPropagation()
    setDraft(item.game_alike || [])
    setAnchor(e.currentTarget.getBoundingClientRect())
  }

  const commit = useCallback(() => {
    setAnchor(null)
    const next = draftRef.current
    if (JSON.stringify(next) === JSON.stringify(item.game_alike || [])) return
    fetch('/api/evaluations', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: item.id, game_alike: next }),
    }).then(res => { if (res.ok) onSaved(item.id, next) }).catch(() => { /* ignore */ })
  }, [item.id, item.game_alike, onSaved])

  return (
    <>
      <span
        onClick={canEdit ? open : undefined}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: canEdit ? 'pointer' : 'default', maxWidth: '100%' }}
      >
        {games.length
          ? <GameAlikeChips value={games} />
          : canEdit
            ? <span style={ADD_PILL}>+ Add</span>
            : <span style={{ fontSize: 12, color: 'var(--faint)' }}>—</span>}
        {canEdit && games.length > 0 && (
          <button type="button" className="cell-copy" title="Edit game alike" onClick={open} style={{ flexShrink: 0 }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
            </svg>
          </button>
        )}
      </span>
      {anchor && (
        <CellPopover anchor={anchor} onClose={commit} width={340}>
          <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.4px' }}>Game Alike</span>
            <GameAlikeField value={draft} onChange={setDraft} />
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-primary btn-sm" onClick={commit}>Done</button>
            </div>
          </div>
        </CellPopover>
      )}
    </>
  )
}

function ShortListEvalTab() {
  const { data: session } = useSession()
  const role = session?.user?.role
  const userName = session?.user?.name || ''
  const isManager = isManagerRole(role)
  const { final_conclusion: finalConclusionOptions } = useConfig()

  const [data, setData] = useState<ShortListItem[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [availableEvaluators, setAvailableEvaluators] = useState<string[]>([])
  const [filterCategory, setFilterCategory] = useState('puzzle')
  const [filterConclusions, setFilterConclusions] = useState<string[]>(['List_Idea'])
  const [availableConclusions, setAvailableConclusions] = useState<string[]>(CONCLUSION_OPTIONS)
  const [filterFinalConclusions, setFilterFinalConclusions] = useState<string[]>([])
  const [filterEvaluator, setFilterEvaluator] = useState('')
  const [filterBatch, setFilterBatch] = useState('')
  const [currentBatch, setCurrentBatch] = useState<string | null>(null)
  const [availableBatches, setAvailableBatches] = useState<string[]>([])
  // Short List is organised by batch, so the date filter defaults to all-time
  // (evaluated basis) rather than the current month — the month would fight the
  // batch slicing and hide games evaluated in other months of the same batch.
  const df = useDateFilter('evaluated', false)
  // Default to newest-first so the most recently evaluated games surface on top.
  const [sortAsc, setSortAsc] = useState(false)
  const fetchSeqRef = useRef(0)
  // Once the server reports the team's current batch, default the batch filter to
  // it — but only the first time, so a later manual "All batches" choice sticks.
  const batchDefaultedRef = useRef(false)
  const [detailGameId, setDetailGameId] = useState<string | null>(null)

  // The filter params both fetches share. Kept in one place so the rows request and
  // the facets request can never disagree about what is being looked at.
  const scopeParams = useCallback(() => {
    const params = new URLSearchParams({ category: filterCategory })
    if (filterConclusions.length > 0) params.set('conclusions', filterConclusions.join(','))
    if (filterFinalConclusions.length > 0) params.set('final_conclusions', filterFinalConclusions.join(','))
    // Evaluators are locked to their own rows -- by the server, from the session, which
    // ignores this param for them. Sending it added nothing but a dependency on
    // useSession() having resolved, which duplicated both first-load requests the moment
    // it did. Managers still send whatever they picked.
    if (filterEvaluator) params.set('evaluator', filterEvaluator)
    for (const [k, v] of Object.entries(dateFilterParams(df.value, df.autoMonth))) params.set(k, v)
    return params
  }, [filterCategory, filterConclusions, filterFinalConclusions, filterEvaluator, df.value, df.autoMonth])

  // Dropdown contents. Deliberately NOT dependent on batch or sort: `available_batches`
  // and `default_batch` ignore the batch filter by design, and nothing here depends on
  // sort order -- so switching batch (the most common action on this tab) no longer
  // re-runs any of these table-wide scans.
  const fetchFacets = useCallback(async () => {
    try {
      const res = await fetch(`/api/evaluations/facets?${scopeParams()}`)
      const json = await res.json()
      if (json.available_months) df.setAvailableMonths(json.available_months)
      if (json.available_evaluators) setAvailableEvaluators(json.available_evaluators)
      if (json.available_batches) setAvailableBatches(json.available_batches)
      if (json.current_batch !== undefined) {
        setCurrentBatch(json.current_batch)
        if (!batchDefaultedRef.current) {
          batchDefaultedRef.current = true
          // Pre-select the team's current batch, but fall back to the most recent
          // batch with games (server-resolved default_batch) when current is empty.
          const def = json.default_batch !== undefined ? json.default_batch : json.current_batch
          if (def) setFilterBatch(def)
        }
      }
      if (json.available_conclusions?.length) {
        const merged = Array.from(new Set([...json.available_conclusions, ...filterConclusions]))
        setAvailableConclusions(CONCLUSION_OPTIONS.filter(c => merged.includes(c)).concat(merged.filter(c => !CONCLUSION_OPTIONS.includes(c))))
      }
    } catch { /* ignore */ }
  }, [scopeParams, filterConclusions])

  const fetchData = useCallback(async () => {
    const seq = ++fetchSeqRef.current
    setLoading(true)
    try {
      const params = scopeParams()
      params.set('limit', '500')
      params.set('sort', sortAsc ? 'asc' : 'desc')
      // Dropdowns come from /facets now; this request only pays for its own rows.
      params.set('meta', '0')
      // Filter batch server-side: doing it client-side over the 500-row page meant
      // batch rows outside the loaded window vanished (and the count flipped with
      // sort direction). Let the DB filter before LIMIT instead.
      if (filterBatch) params.set('batch', filterBatch)
      const res = await fetch(`/api/evaluations?${params}`)
      const json = await res.json()
      if (seq !== fetchSeqRef.current) return
      setData(json.data || [])
      setTotal(json.total || 0)
      if (df.autoMonth && json.applied_month !== undefined) {
        const ap = json.applied_month as YearMonth | null
        // Suppress the redundant refetch after resolving month=auto. The batch default
        // no longer lands in this response (it comes from /facets, on its own effect),
        // so unlike before there is no batch-narrowed refetch for a blanket suppress to
        // swallow.
        df.suppressFetchRef.current = true
        df.suppressFacetsRef.current = true
        df.setAutoMonth(false)
        df.setValue(v => ap ? monthToValue(ap, v.basis) : { ...v, from: null, to: null })
      }
    } catch { /* ignore */ }
    setLoading(false)
  }, [scopeParams, filterBatch, sortAsc, df.autoMonth])

  useEffect(() => {
    if (df.suppressFacetsRef.current) { df.suppressFacetsRef.current = false; return }
    fetchFacets()
  }, [fetchFacets, df.suppressFacetsRef])

  useEffect(() => {
    if (df.suppressFetchRef.current) { df.suppressFetchRef.current = false; return }
    fetchData()
  }, [fetchData])

  const handleFinalConclusionSaved = (id: number, value: string) => {
    setData(prev => prev.map(d => d.id === id ? { ...d, final_conclusion: value } : d))
  }

  const handleDriveLinkSaved = (id: number, value: string | null) => {
    setData(prev => prev.map(d => d.id === id ? { ...d, drive_link: value } : d))
  }

  const handleFinalNoteSaved = (id: number, value: string | null) => {
    setData(prev => prev.map(d => d.id === id ? { ...d, final_note: value } : d))
  }

  const handleGameAlikeSaved = (id: number, value: GameAlikeGame[]) => {
    setData(prev => prev.map(d => d.id === id ? { ...d, game_alike: value } : d))
  }

  // Batch options come from the batches actually present (server-provided,
  // date-range-independent) so all-time batches are selectable regardless of the
  // month picker. Newest-first via the batch label order.
  const batchOptions = [...availableBatches].sort((a, b) => weekLabelOrder(b) - weekLabelOrder(a))
  // A fallback-defaulted batch may not be in the present-batch list yet (e.g. a
  // fresh week with no games) — surface it so the dropdown reflects the selection.
  if (filterBatch && !batchOptions.includes(filterBatch)) batchOptions.unshift(filterBatch)

  // Manager control: set the team's current batch. Offer this + next calendar
  // month's weeks so W4→W1-next-month rollover (after the 28th) is one click.
  const saveCurrentBatch = async (v: string) => {
    setCurrentBatch(v || null)
    try {
      await fetch('/api/evaluations/current-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category: filterCategory, batch: v || null }),
      })
    } catch { /* ignore */ }
  }
  const currentBatchOptions = (() => {
    const now = new Date()
    const y = now.getFullYear(), m = now.getMonth() + 1
    const nextY = m === 12 ? y + 1 : y
    const nextM = m === 12 ? 1 : m + 1
    const opts = [...weekBatches(y, m), ...weekBatches(nextY, nextM)]
    if (currentBatch && !opts.includes(currentBatch)) opts.unshift(currentBatch)
    return opts
  })()

  return (
    <div className="page" style={{ paddingBottom: 16, height: '100vh', boxSizing: 'border-box', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <div className="page-head" style={{ marginBottom: 10, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <h1 className="h-title">Short List</h1>
          <p className="h-sub">{total} games · {filterCategory}{filterBatch ? ` · ${filterBatch}` : ''}</p>
        </div>
        {isManager && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Current batch</span>
              <span style={{ fontSize: 10.5, color: 'var(--faint)' }}>evaluators auto-fill this for List_Idea</span>
            </div>
            <div style={{ width: 170 }}>
              <StyledSelect
                value={currentBatch || ''}
                onChange={saveCurrentBatch}
                placeholder="Not set"
                options={[{ value: '', label: '— none —' }, ...currentBatchOptions.map(b => ({ value: b, label: b }))]}
              />
            </div>
          </div>
        )}
      </div>

      <div className="filter-row" style={{ position: 'relative', zIndex: 30 }}>
        <DateFilter value={df.value}
          onChange={v => { df.setAutoMonth(false); df.setValue(v) }} />

        <div style={{ width: 140 }}>
          <StyledSelect
            value={filterCategory}
            onChange={setFilterCategory}
            placeholder="Category"
            options={[
              { value: 'puzzle', label: 'Puzzle' },
              { value: 'arcade', label: 'Arcade' },
              { value: 'simulation', label: 'Simulation' },
            ]}
          />
        </div>

        {isManager && (
          <div style={{ width: 180 }}>
            <StyledSelect
              value={filterEvaluator}
              onChange={setFilterEvaluator}
              placeholder="All evaluators"
              options={[{ value: '', label: 'All evaluators' }, ...availableEvaluators.map(e => ({ value: e, label: e }))]}
            />
          </div>
        )}

        <div style={{ width: 160 }}>
          <StyledSelect
            value={filterBatch}
            onChange={setFilterBatch}
            placeholder="All batches"
            options={[{ value: '', label: 'All batches' }, ...batchOptions.map(b => ({ value: b, label: b }))]}
          />
        </div>

        <div style={{ width: 200 }}>
          <MultiSelect
            value={filterConclusions}
            onChange={setFilterConclusions}
            placeholder="Conclusions"
            options={availableConclusions.map(c => ({ value: c, label: prettyConclusion(c) }))}
          />
        </div>

        <div style={{ width: 200 }}>
          <MultiSelect
            value={filterFinalConclusions}
            onChange={setFilterFinalConclusions}
            placeholder="Final conclusions"
            options={[
              { value: FINAL_CONCLUSION_NONE, label: '— Not set —' },
              ...finalConclusionOptions.map(c => ({ value: c, label: c })),
            ]}
          />
        </div>

        <button
          className="btn btn-sm"
          title={sortAsc ? 'Sorted oldest first — click to sort newest first' : 'Sorted newest first — click to sort oldest first'}
          onClick={() => setSortAsc(v => !v)}
          style={{ display: 'flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap' }}>
          {sortAsc ? (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 19V5M5 12l7-7 7 7" />
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 5v14M5 12l7 7 7-7" />
            </svg>
          )}
          {sortAsc ? 'Oldest first' : 'Newest first'}
        </button>

        <span className="sync" style={{ marginLeft: 'auto', fontSize: 12.5, fontWeight: 600 }}>
          {loading ? 'Loading...' : `${data.length} results`}
        </span>
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <div className="tbl-wrap" style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
          <table className="tbl">
            <thead style={{ position: 'sticky', top: 0, zIndex: 2, background: 'var(--surface)', boxShadow: '0 1px 0 var(--border)' }}>
              <tr>
                <th style={{ width: 36 }}>#</th>
                <th style={{ width: 280 }}>Game</th>
                <th style={{ width: 110 }}>Link</th>
                <th style={{ width: 90 }}>Demo Video</th>
                <th style={{ width: 220 }}>Initial Note</th>
                <th style={{ width: 150 }}>Final Conclusion</th>
                <th style={{ width: 220 }}>Final Note</th>
                <th style={{ width: 170 }}>Tagging</th>
                <th>Game Alike</th>
              </tr>
            </thead>
            <tbody>
              {data.length === 0 && !loading && (
                <tr><td colSpan={9} className="empty">No games found</td></tr>
              )}
              {loading && Array.from({ length: 5 }).map((_, i) => (
                <tr key={i}>{Array.from({ length: 9 }).map((__, c) => (
                  <td key={c}><span className="skeleton" style={{ width: [30, 240, 70, 60, 200, 110, 200, 150, 140][c] || 80, height: 14 }} /></td>
                ))}</tr>
              ))}
              {data.map((item, idx) => (
                <tr key={item.id} className="tbl-row-premium" style={{ cursor: 'pointer' }}
                  onClick={() => setDetailGameId(item.game_id)}>
                  <td className="num" style={{ color: 'var(--faint)', fontSize: 12 }}>{idx + 1}</td>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 230 }}>
                      {item.icon_url ? (
                        <img src={item.icon_url} alt="" width={44} height={44} style={{ borderRadius: 10, flexShrink: 0 }} />
                      ) : (
                        <div style={{ width: 44, height: 44, borderRadius: 10, background: 'var(--surface-3)', flexShrink: 0 }} />
                      )}
                      <div style={{ minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center' }}>
                          <span className="cell-name" style={{ fontSize: 13, lineHeight: 1.3 }}>{item.title}</span>
                          <CopyBtn text={item.title} />
                        </div>
                        <div style={{ display: 'flex', gap: 4, marginTop: 2, flexWrap: 'wrap', alignItems: 'center' }}>
                          {item.batch && (
                            <span className="pill" style={{ padding: '1px 6px', fontSize: 9, fontWeight: 700, background: 'var(--accent-weak)', color: 'var(--accent)', border: '1px solid var(--accent-border)' }}>{item.batch}</span>
                          )}
                          {item.initial_evaluator && (
                            <span className="pill muted" style={{ padding: '1px 7px', fontSize: 9.5, fontWeight: 700 }}>{item.initial_evaluator}</span>
                          )}
                        </div>
                        {item.publisher_name && (
                          <div style={{ display: 'flex', alignItems: 'center', marginTop: 2 }}>
                            <span style={{ fontSize: 11, color: 'var(--faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 230 }}
                              title={item.publisher_name}>
                              {item.publisher_name}
                            </span>
                            <CopyBtn text={item.publisher_name} />
                          </div>
                        )}
                      </div>
                    </div>
                  </td>
                  <td>
                    <span style={{ display: 'inline-flex', alignItems: 'center' }}>
                      {item.app_link ? (
                        <a href={item.app_link} target="_blank" rel="noopener" onClick={e => e.stopPropagation()}
                          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12.5, fontWeight: 600, color: 'var(--accent)', textDecoration: 'none' }}>
                          {osLabel(item.os)}
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.7 }}>
                            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3" />
                          </svg>
                        </a>
                      ) : (
                        <span style={{ fontSize: 12.5, color: 'var(--faint)' }}>{osLabel(item.os)}</span>
                      )}
                      <CopyBtn text={item.app_link} />
                    </span>
                  </td>
                  <td onClick={e => e.stopPropagation()}>
                    <DemoVideoCell item={item} onSaved={handleDriveLinkSaved} />
                  </td>
                  <td>
                    {item.initial_note ? (
                      <span style={{ display: 'inline-flex', alignItems: 'center', maxWidth: 260 }}>
                        <NoteHover text={item.initial_note} maxWidth={240} />
                        <CopyBtn text={item.initial_note} />
                      </span>
                    ) : <span style={{ fontSize: 12, color: 'var(--faint)' }}>—</span>}
                  </td>
                  <td onClick={e => e.stopPropagation()}>
                    <span style={{ display: 'inline-flex', alignItems: 'center' }}>
                      <FinalConclusionCell item={item} isManager={isManager} options={finalConclusionOptions} onSaved={handleFinalConclusionSaved} />
                      <CopyBtn text={item.final_conclusion} />
                    </span>
                  </td>
                  <td onClick={e => e.stopPropagation()}>
                    <span style={{ display: 'inline-flex', alignItems: 'center' }}>
                      <FinalNoteCell item={item} isManager={isManager} onSaved={handleFinalNoteSaved} />
                      <CopyBtn text={item.final_note} />
                    </span>
                  </td>
                  <td>
                    <TrendTagCell tags={item.tags} maxWidth={160} />
                  </td>
                  <td onClick={e => e.stopPropagation()}>
                    <GameAlikeCell
                      item={item}
                      canEdit={isManager || (!!item.initial_evaluator && item.initial_evaluator.toLowerCase() === userName.toLowerCase())}
                      onSaved={handleGameAlikeSaved}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {detailGameId && (
        <div className="eval-modal-backdrop" onClick={() => setDetailGameId(null)}>
          <div className="eval-modal-container" onClick={e => e.stopPropagation()}
            style={{ padding: '20px 24px 24px' }}>
            <EvalDetailPanel
              initialGameId={detailGameId}
              gameList={data.map(d => ({ game_id: d.game_id, title: d.title }))}
              role={role}
              userName={userName}
              hideRecordSections
              showFinalConclusion
              onClose={() => setDetailGameId(null)}
              onNavigate={setDetailGameId}
              onSaved={fetchData}
            />
          </div>
        </div>
      )}
    </div>
  )
}

function conclusionBadge(c: string | null) {
  if (!c) return <span className="badge idle">Pending</span>
  return <span className={`badge ${CONCLUSION_COLORS[c] || 'neutral'}`}>{prettyConclusion(c)}</span>
}

function fmtDate(d: string | null) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: '2-digit' })
}

// dd/MM/YY - hh:mm in Asia/Ho_Chi_Minh (UTC+7) - the hour matters for filtering
// and for telling apart evaluations submitted on the same day.
function fmtDateTime(d: string | null) {
  if (!d) return '—'
  const dt = new Date(d)
  const day = dt.toLocaleDateString('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: '2-digit' })
  const time = dt.toLocaleTimeString('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', hour12: false })
  return `${day} - ${time}`
}

// One table row, memoised.
//
// It is rendered up to PAGE_SIZE at a time and the infinite scroll keeps appending,
// so a list of 400-600 rows is normal. Every one of them used to re-render whenever
// `activeGameId` changed -- which is every Prev/Next inside the detail panel, since
// the panel drives the highlighted row through the parent. Each row carries an
// <img>, several pills and a TrendTagCell, so that was hundreds of nodes reconciled
// per keypress: the jank people felt while paging through games.
//
// Now only the two rows whose `isActive` actually flipped re-render. `onOpen` is
// kept stable by the parent (see openDetail) so this holds.
const EvalRow = memo(function EvalRow({ ev, idx, isActive, activeRowRef, onOpen, term }: {
  ev: Evaluation
  idx: number
  isActive: boolean
  activeRowRef: RefObject<HTMLTableRowElement>
  onOpen: (gameId: string) => void
  /** The live search term, '' when there is no search. A string keeps this row inside
   *  the memo: it only changes when the search does, and then the whole table redraws. */
  term: string
}) {
  const genres = [ev.genre_1, ev.genre_2].filter(Boolean) as string[]
  // The store id is not a column. When a search matched on it rather than on the title,
  // show it -- otherwise the row appears with no visible reason for being in the results.
  const idMatched = term !== '' && ev.game_id.toLowerCase().includes(term.toLowerCase())
  return (
      <tr
        ref={isActive ? activeRowRef : null}
        className={`tbl-row-premium${isActive ? ' tbl-row-active' : ''}`}
        style={{ cursor: 'pointer' }}
        onClick={() => onOpen(ev.game_id)}>
        <td className="num" style={{ color: 'var(--faint)', fontSize: 12 }}>
          {idx + 1}
        </td>
        <td>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 220 }}>
            {ev.icon_url ? (
              <img src={ev.icon_url} alt="" width={32} height={32}
                style={{ borderRadius: 7, flexShrink: 0 }} />
            ) : (
              <div style={{ width: 32, height: 32, borderRadius: 7, background: 'var(--surface-3)', flexShrink: 0 }} />
            )}
            <div style={{ minWidth: 0 }}>
              <div className="cell-name" style={{ fontSize: 13, lineHeight: 1.3 }}>
                <Highlight text={ev.title} term={term} />
              </div>
              {idMatched && (
                <div style={{ fontSize: 10.5, color: 'var(--faint)', fontFamily: 'var(--num)', marginTop: 2 }}>
                  <Highlight text={ev.game_id} term={term} />
                </div>
              )}
              <div style={{ display: 'flex', gap: 4, marginTop: 3, flexWrap: 'wrap' }}>
                <span className="pill muted" style={{ padding: '1px 6px', fontSize: 10 }}>
                  {ev.os?.toUpperCase()}
                </span>
                {genres.map(g => (
                  <span key={g} className="pill tag" style={{ padding: '1px 6px', fontSize: 10 }}>
                    {g}
                  </span>
                ))}
              </div>
              {ev.publisher_name && (
                <div style={{ fontSize: 11, color: 'var(--faint)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {ev.publisher_name}
                </div>
              )}
            </div>
          </div>
        </td>
        <td style={{ fontSize: 12.5, fontWeight: 600, whiteSpace: 'nowrap', color: ev.initial_evaluator ? 'var(--text)' : 'var(--faint)' }}>
          {ev.initial_evaluator || '—'}
        </td>
        <td style={{ fontSize: 12.5, whiteSpace: 'nowrap', color: ev.final_evaluator ? 'var(--text)' : 'var(--faint)' }}>
          {ev.final_evaluator || '—'}
        </td>
        <td className="num" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
          {fmtDate(ev.assigned_date)}
        </td>
        <td>
          <div style={{ fontSize: 12, color: ev.initial_note ? 'var(--text)' : 'var(--faint)', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {ev.initial_note || '—'}
          </div>
        </td>
        <td>{conclusionBadge(ev.initial_conclusion)}</td>
        <td>
          <TrendTagCell tags={ev.tags} maxWidth={170} />
        </td>
        <td className="num" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
          {fmtDateTime(ev.evaluate_date)}
        </td>
        <td>
          {ev.drive_link ? (
            <a href={ev.drive_link} target="_blank" rel="noopener"
              onClick={e => e.stopPropagation()}
              className="drive-btn">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="23 7 16 12 23 17 23 7" />
                <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
              </svg>
              Video
            </a>
          ) : (
            <span style={{ fontSize: 12, color: 'var(--faint)' }}>—</span>
          )}
        </td>
      </tr>
  )
})

const PAGE_SIZE = 200

// useSearchParams requires a Suspense boundary for static prerendering.
export default function EvaluationsPage() {
  return (
    <Suspense>
      <EvaluationsRouter />
    </Suspense>
  )
}

// Dispatch on category at the top level so Short List and the standard tab are
// separate component subtrees — switching between them mounts/unmounts cleanly
// (no rules-of-hooks violation from a conditional early return mid-component).
function EvaluationsRouter() {
  const searchParams = useSearchParams()
  const category = searchParams.get('cat') || 'puzzle'
  if (category === 'weekly_feedback') return <WeeklyFeedbackTab />
  if (category === 'tagging') return <TaggingTab />
  return category === 'short_list' ? <ShortListEvalTab /> : <EvaluationsPageInner />
}

function EvaluationsPageInner() {
  const { data: session } = useSession()
  const role = session?.user?.role
  const userName = session?.user?.name || ''

  // The three buckets are merged into one "Evaluate" tab; the active bucket is
  // in-page state (was the ?cat= query param when each bucket had its own nav entry).
  const [category, setCategory] = useState<Bucket>('puzzle')

  const [data, setData] = useState<Evaluation[]>([])
  const [total, setTotal] = useState(0)
  const [conclusionOptions, setConclusionOptions] = useState<string[]>([])
  const [evaluatorOptions, setEvaluatorOptions] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(true)

  const [filterEvaluator, setFilterEvaluator] = useState('')
  const [filterConclusion, setFilterConclusion] = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const [sortAsc, setSortAsc] = useState(true)
  // Standard evaluators tab tracks when work was assigned → default basis =
  // assigned. First load sends month=auto; the server resolves the default month
  // (current month, falling back to latest with data) and echoes it back.
  const df = useDateFilter('assigned')
  const fetchSeqRef = useRef(0)

  const [search, setSearch] = useState('')
  // The box is debounced before it reaches the server, and only a term long enough for
  // a trigram index to serve goes there at all -- see lib/eval-search.
  const [debouncedSearch, setDebouncedSearch] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [search])
  const searchTerm = debouncedSearch.trim()
  const searching = searchTerm.length >= SEARCH_MIN_CHARS
  // The term the REQUEST is built from -- '' until it is long enough to be worth
  // asking the server. Typing below the floor must not change this, or every one of
  // those keystrokes would re-issue the month query it is not even searching.
  const activeQuery = searching ? searchTerm : ''
  const [totalCapped, setTotalCapped] = useState(false)
  // A search overrides these filters, so they stop taking clicks while one is live --
  // greyed out rather than hidden, so it is obvious they are coming back.
  const inertWhileSearching = searching ? { opacity: 0.45 } : undefined
  const [tableExpanded, setTableExpanded] = useState(false)
  const [showQuickStats, setShowQuickStats] = useState(false)
  const [detailGameId, setDetailGameId] = useState<string | null>(null)
  const [detailList, setDetailList] = useState<EvalListItem[]>([])
  const [activeGameId, setActiveGameId] = useState<string | null>(null)
  const activeRowRef = useRef<HTMLTableRowElement | null>(null)

  const [apiStats, setApiStats] = useState({ total: 0, evaluated: 0, pending: 0 })
  const stats = useMemo(() => ({
    totalCount: apiStats.total,
    evaluatedCount: apiStats.evaluated,
    pendingCount: apiStats.pending,
    percent: apiStats.total > 0 ? Math.round((apiStats.evaluated / apiStats.total) * 100) : 0,
  }), [apiStats])

  const pageRef = useRef(1)
  const sentinelRef = useRef<HTMLDivElement>(null)

  // Pending is always shown all-time on the assigned basis: a game awaiting evaluation
  // may have been assigned in any earlier month, so the date picker must not narrow it.
  // (Picker is hidden in this mode.) Shared by the rows and facets requests so the
  // dropdowns describe the same window the table is showing.
  const evalDateParams = useCallback(() => (
    filterStatus === 'pending'
      ? { date_basis: 'assigned' as const }
      : dateFilterParams(df.value, df.autoMonth)
  ), [filterStatus, df.value, df.autoMonth])

  // Dropdown contents: independent of sort and of which page the infinite scroll is on.
  const fetchFacets = useCallback(async () => {
    try {
      const params = new URLSearchParams({ category })
      // Deliberately NOT scoped by the signed-in evaluator here. An evaluator only ever
      // sees their own rows, but that is decided server-side from the session and the
      // `evaluator` param is ignored for them -- sending it changed nothing except this
      // request's identity, which made it wait for useSession() to resolve and then fire
      // a second time when it did. Managers still send their picked filter.
      if (filterEvaluator) params.set('evaluator', filterEvaluator)
      if (filterConclusion) params.set('conclusion', filterConclusion)
      if (filterStatus) params.set('status', filterStatus)
      for (const [k, v] of Object.entries(evalDateParams())) params.set(k, v)
      const res = await fetch(`/api/evaluations/facets?${params}`)
      const json = await res.json()
      if (json.available_months) df.setAvailableMonths(json.available_months)
      if (json.available_conclusions) setConclusionOptions(json.available_conclusions)
      if (json.available_evaluators) setEvaluatorOptions(json.available_evaluators)
    } catch { /* ignore */ }
  }, [category, filterEvaluator, filterConclusion, filterStatus, evalDateParams])

  useEffect(() => {
    if (df.suppressFacetsRef.current) { df.suppressFacetsRef.current = false; return }
    fetchFacets()
  }, [fetchFacets, df.suppressFacetsRef])

  const fetchPage = useCallback(async (page: number, append: boolean) => {
    const seq = ++fetchSeqRef.current
    if (append) setLoadingMore(true); else setLoading(true)
    try {
      // A search asks a different question, so it comes with a different page size:
      // fewer rows, because relevance puts what you wanted at the top.
      const pageLimit = activeQuery ? SEARCH_PAGE_SIZE : PAGE_SIZE
      const params = new URLSearchParams({ category, page: String(page), limit: String(pageLimit) })
      // See fetchFacets: the evaluator scope is the server's to enforce, so this request
      // does not depend on the session having loaded. It used to, and the cost was a
      // duplicate of every first-load request once useSession() came back.
      if (filterEvaluator) params.set('evaluator', filterEvaluator)
      params.set('sort', sortAsc ? 'asc' : 'desc')
      // While a search is live it OVERRIDES the narrowing filters -- date window,
      // conclusion, status -- rather than mutating them. A search that comes back empty
      // because the picker was on September is a search that looks broken; and because
      // nothing is mutated, clearing the box needs no restore step: the untouched state
      // simply builds the old request again.
      if (activeQuery) {
        params.set('q', activeQuery)
      } else {
        if (filterConclusion) params.set('conclusion', filterConclusion)
        if (filterStatus) params.set('status', filterStatus)
        // Pending is always shown all-time on the assigned basis: a game awaiting
        // evaluation may have been assigned in any earlier month, so the date picker
        // must not narrow it. (Picker is hidden in this mode — see below.)
        for (const [k, v] of Object.entries(evalDateParams())) params.set(k, v)
      }
      // Dropdowns come from /api/evaluations/facets on their own effect below.
      params.set('meta', '0')
      const res = await fetch(`/api/evaluations?${params}`)
      const json = await res.json()
      if (seq !== fetchSeqRef.current) return // stale response; a newer fetch owns the state
      const rows = json.data || []
      if (append) {
        setData(prev => [...prev, ...rows])
      } else {
        setData(rows)
      }
      if (json.total !== undefined) setTotal(json.total)
      // The cards above the table are the month's workload, not the search's: a lookup
      // must not rewrite them, least of all with a total the server deliberately capped.
      if (json.stats && !activeQuery) setApiStats(json.stats)
      setTotalCapped(!!json.total_capped)
      // A search sends no month at all, so its response resolves none: letting it
      // through here would clear the month the picker is on and lose it for good.
      if (!activeQuery && df.autoMonth && json.applied_month !== undefined) {
        // Lock in the server-resolved month: the picker shows it and all
        // later fetches use explicit params instead of re-resolving auto.
        const ap = json.applied_month as YearMonth | null
        df.suppressFetchRef.current = true
        // The facets response in flight alongside this one already resolved the same
        // month, so its contents are the ones for `ap`. Locking `ap` in must not send
        // an identical request again.
        df.suppressFacetsRef.current = true
        df.setAutoMonth(false)
        df.setValue(v => ap ? monthToValue(ap, v.basis) : { ...v, from: null, to: null })
      }
      setHasMore(rows.length === pageLimit)
    } catch { /* ignore */ }
    setLoading(false)
    setLoadingMore(false)
  }, [category, filterEvaluator, filterConclusion, filterStatus, evalDateParams, df.autoMonth, sortAsc,
    activeQuery])

  useEffect(() => {
    if (df.suppressFetchRef.current) {
      df.suppressFetchRef.current = false
      return
    }
    pageRef.current = 1
    fetchPage(1, false)
  }, [fetchPage])

  useEffect(() => {
    const el = sentinelRef.current
    if (!el) return
    const observer = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting && hasMore && !loading && !loadingMore) {
        pageRef.current += 1
        fetchPage(pageRef.current, true)
      }
    }, { rootMargin: '200px' })
    observer.observe(el)
    return () => observer.disconnect()
  }, [hasMore, loading, loadingMore, fetchPage])

  const filtered = useMemo(() => {
    // A live search is already the server's answer, over every month. Below the index
    // floor we keep filtering the rows in hand instead, which is instant and costs
    // nothing -- and is a subset of what the server would return, so crossing the
    // threshold only ever widens the list.
    if (searching) return data
    const q = search.trim().toLowerCase()
    if (!q) return data
    return data.filter(d => d.title.toLowerCase().includes(q) || d.game_id.toLowerCase().includes(q))
  }, [data, search, searching])

  // Server-provided full list for the category (ignores month + pagination);
  // fall back to deriving from loaded rows until the first page-1 response lands.
  const evaluators = evaluatorOptions.length > 0
    ? evaluatorOptions
    : Array.from(new Set(data.map(d => d.initial_evaluator).filter(Boolean) as string[]))

  // Read through a ref so this callback keeps one identity for the life of the page.
  // It is the click handler on every row, and EvalRow is memoised on its props: a new
  // function each render would defeat the memo and put all 400-600 rows back in the
  // re-render path the memo exists to keep them out of.
  const filteredRef = useRef(filtered)
  filteredRef.current = filtered

  const openDetail = useCallback((gameId: string) => {
    setDetailList(filteredRef.current.map(d => ({ game_id: d.game_id, title: d.title })))
    setDetailGameId(gameId)
    setActiveGameId(gameId)
  }, [])

  const handleNavigate = (gameId: string) => {
    setActiveGameId(gameId)
  }

  const handleClose = () => {
    setDetailGameId(null)
    // activeGameId remains set so the row stays highlighted after close
    // Scroll the highlighted row into view
    setTimeout(() => {
      activeRowRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }, 50)
  }

  return (
    <div className="page" style={{ paddingBottom: 16, height: '100vh', boxSizing: 'border-box', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <div className="page-head" style={{ marginBottom: 10 }}>
        <div>
          <h1 className="h-title">Evaluations</h1>
          <p className="h-sub">
            {total} games · {category}
            {filterStatus === 'pending' ? ' · All time' : df.value.from ? ` · ${valueLabel(df.value)}` : ''}
            {!isManagerRole(role) && userName ? ` · ${userName}` : ''}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {BUCKETS.map(b => (
            <button key={b} className={`seg-btn-premium${category === b ? ' active' : ''}`}
              onClick={() => setCategory(b)}>
              {b.charAt(0).toUpperCase() + b.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* Summary Stats Widgets */}
      <div className="stats-grid" style={{ display: tableExpanded ? 'none' : undefined }}>
        <div className="stat-card">
          <span className="stat-label">Total Games</span>
          <div className="stat-val">{stats.totalCount}</div>
          <span className="stat-subtext">Listed in database</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Evaluated</span>
          <div className="stat-val">
            {stats.evaluatedCount}
            <span className="pill success" style={{ fontSize: 10, padding: '2px 6px', marginLeft: 8 }}>{stats.percent}%</span>
          </div>
          <span className="stat-subtext">Completed reviews</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Pending</span>
          <div className="stat-val" style={{ color: stats.pendingCount > 0 ? 'var(--warn)' : 'var(--text)' }}>
            {stats.pendingCount}
          </div>
          <span className="stat-subtext">Awaiting evaluation</span>
        </div>
        <div className="stat-card" role="button" tabIndex={0}
          onClick={() => setShowQuickStats(true)}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') setShowQuickStats(true) }}
          style={{ cursor: 'pointer' }}>
          <span className="stat-label">Quick Stats</span>
          <div className="stat-val" style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--accent)' }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="20" x2="18" y2="10" />
              <line x1="12" y1="20" x2="12" y2="4" />
              <line x1="6" y1="20" x2="6" y2="14" />
            </svg>
            View
          </div>
          <span className="stat-subtext">Per-evaluator breakdown</span>
        </div>
      </div>

      {/* Filters */}
      <div className="filter-row" style={{ position: 'relative', zIndex: 30, display: tableExpanded ? 'none' : undefined }}>
        <div className="search-wrap">
          <span className="search-icon-abs">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
            </svg>
          </span>
          <input className="search-input" placeholder="Search games..."
            value={search} onChange={e => setSearch(e.target.value)} />
        </div>

        {/* Pending is locked to all-time assigned (see fetchPage), so the date
            picker would be inert — hide it and show the fixed scope instead. */}
        {filterStatus === 'pending' || searching ? (
          <span className="btn btn-sm"
            title={searching ? 'A search looks at every month. Clear it to go back to the date filter.' : undefined}
            style={{ cursor: 'default', gap: 6, minWidth: 200, justifyContent: 'flex-start', opacity: 0.7 }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
              <line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" />
            </svg>
            <span style={{ color: 'var(--muted)' }}>Assigned</span>{' · All time'}
          </span>
        ) : (
          <DateFilter
            value={df.value}
            onChange={v => { df.setAutoMonth(false); df.setValue(v) }}
          />
        )}

        <div className="seg-wrapper" style={inertWhileSearching}>
          {[
            { value: '', label: 'All' },
            { value: 'pending', label: 'Pending' },
            { value: 'done', label: 'Done' },
          ].map(s => (
            <button key={s.value} className={`seg-btn-premium${filterStatus === s.value ? ' active' : ''}`}
              disabled={searching}
              onClick={() => setFilterStatus(s.value)}>
              {s.label}
            </button>
          ))}
        </div>

        <button
          className="btn btn-sm"
          // Relevance decides a search's order, so there is nothing here to reverse.
          disabled={searching}
          title={searching
            ? 'Search results are ordered by how well they match'
            : sortAsc ? 'Sorted oldest first — click to sort newest first' : 'Sorted newest first — click to sort oldest first'}
          onClick={() => { setSortAsc(v => !v); pageRef.current = 1 }}
          style={{ display: 'flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap', ...inertWhileSearching }}>
          {sortAsc ? (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 19V5M5 12l7-7 7 7" />
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 5v14M5 12l7 7 7-7" />
            </svg>
          )}
          {sortAsc ? 'Oldest first' : 'Newest first'}
        </button>

        {isManagerRole(role) && (
          <div style={{ width: 180 }}>
            <StyledSelect
              value={filterEvaluator}
              onChange={setFilterEvaluator}
              placeholder="All evaluators"
              options={[{ value: '', label: 'All evaluators' }, ...evaluators.map(e => ({ value: e, label: e }))]}
            />
          </div>
        )}

        <div style={{ width: 220, ...inertWhileSearching }}>
          <StyledSelect
            value={filterConclusion}
            onChange={setFilterConclusion}
            disabled={searching}
            placeholder="All conclusions"
            options={[{ value: '', label: 'All conclusions' }, ...conclusionOptions.map(c => ({ value: c, label: prettyConclusion(c) }))]}
          />
        </div>

        <span className="sync" style={{ marginLeft: 'auto', fontSize: 12.5, fontWeight: 600 }}>
          {loading
            ? 'Loading...'
            : searching
              // Capped on purpose: an exact all-time count costs more than the rows it
              // counts, and "500+" is all the header has to say.
              ? `${totalCapped ? `${SEARCH_TOTAL_CAP}+` : total} results for "${searchTerm}"`
              : `${filtered.length}${search ? ` / ${total}` : ''} results`}
        </span>
      </div>

      {/* Table */}
      <div className="card" style={{ padding: 0, overflow: 'hidden', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {/* Expand/collapse toggle */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '4px 8px 0', flexShrink: 0 }}>
          <button
            className="btn btn-ghost btn-sm"
            title={tableExpanded ? 'Show filters' : 'Expand table'}
            onClick={() => setTableExpanded(v => !v)}
            style={{ padding: '3px 8px', fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }}>
            {tableExpanded ? (
              <>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M6 15l6-6 6 6" />
                </svg>
                Show filters
              </>
            ) : (
              <>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M6 9l6 6 6-6" />
                </svg>
                Expand table
              </>
            )}
          </button>
        </div>
        <div className="tbl-wrap" style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
          <table className="tbl">
            <thead style={{ position: 'sticky', top: 0, zIndex: 2, background: 'var(--surface)', boxShadow: '0 1px 0 var(--border)' }}>
              <tr>
                <th style={{ width: 36 }}>#</th>
                <th>Game</th>
                <th>Initial</th>
                <th>Final</th>
                <th>Assigned</th>
                <th>Note</th>
                <th>Conclusion</th>
                <th>Tagging</th>
                <th>Evaluated</th>
                <th>Drive</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && !loading && (
                <tr><td colSpan={10} className="empty">{search ? 'No games match your search' : 'No evaluations found'}</td></tr>
              )}
              {filtered.map((ev, idx) => (
                <EvalRow key={ev.id} ev={ev} idx={idx} term={searchTerm}
                  isActive={ev.game_id === activeGameId}
                  activeRowRef={activeRowRef}
                  onOpen={openDetail} />
              ))}
            </tbody>
          </table>
          <div ref={sentinelRef} style={{ height: 1 }} />
          {loadingMore && (
            <div style={{ textAlign: 'center', padding: '12px 0', fontSize: 12, color: 'var(--faint)' }}>
              Loading more...
            </div>
          )}
        </div>
      </div>

      {/* Quick Stats Modal */}
      {showQuickStats && (
        <QuickStatsModal
          category={category}
          month={valueToYearMonth(df.value)}
          onClose={() => setShowQuickStats(false)}
        />
      )}

      {/* Detail Modal */}
      {detailGameId && (
        <div className="eval-modal-backdrop" onClick={handleClose}>
          <div className="eval-modal-container" onClick={e => e.stopPropagation()}
            style={{ padding: '20px 24px 24px' }}>
            <EvalDetailPanel
              initialGameId={detailGameId}
              gameList={detailList}
              role={role}
              userName={userName}
              hideRecordSections={false}
              onClose={handleClose}
              onNavigate={handleNavigate}
              onSaved={(fresh: EvalDetail) => {
                setData(prev => prev.map(d => d.game_id === fresh.game_id
                  ? { ...d, initial_conclusion: fresh.initial_conclusion, initial_note: fresh.initial_note, evaluate_date: fresh.evaluate_date, drive_link: fresh.drive_link }
                  : d
                ))
              }}
            />
          </div>
        </div>
      )}

    </div>
  )
}
