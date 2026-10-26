'use client'
import { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef, type ReactNode } from 'react'
import { StyledSelect } from '@/components/StyledSelect'
import { BatchPicker } from '@/components/ui/BatchPicker'
import ManualScreenshotsCard, { type ManualScreenshotsHandle } from '@/components/ManualScreenshotsCard'
import { Lightbox } from '@/components/Lightbox'
import { EvalHistoryModal } from '@/components/EvalHistoryModal'
import type { HistoryEvent } from '@/lib/evaluation-history'
import { registerUnsavedGuard } from '@/lib/unsaved-guard'
import { UnsavedChangesDialog } from '@/components/UnsavedChangesDialog'
import { leaveDecision, type LeaveAction } from '@/lib/leave-decision'
import { unsavedFields } from '@/lib/unsaved-fields'
import { buildYtMap, ytLookup, recordBucketOf, extractYtId, type YtMatch } from '@/lib/ytb-match'
import { useConfig } from '@/hooks/useConfig'
import { prettyConclusion } from '@/lib/buckets'
import { conclusionBadgeClass, RECORD_STATUS_BADGE, type RecordStatus } from '@/lib/conclusion-badge'
import { fmtDateVN, fmtDateTimeVN } from '@/lib/format-date'
import { toast } from '@/lib/toast'
import { CloseButton } from '@/components/ui/CloseButton'
import { Switch } from '@/components/ui/Switch'
import { IconX } from '@/components/ui/SearchInput'
import { LockIcon, UserIcon } from '@/components/icons'
import { GameAlikeField } from '@/components/GameAlikeField'
import { type ReviewChange, type ReviewTag } from './TrendTagReview'
import { applyExistingChange, type ExistingTagChange } from './ExistingTrendTags'
import { TrendTagsField, type TrendTag, type ExistingTrendTag } from './TrendTagsField'
import type { GameAlikeGame } from '@/components/weekly-feedback/types'
import QRCode from 'qrcode'
import { isManagerRole } from '@/lib/roles'
import { startView, onVisibility, onInput, snapshot, restartAfterSave, type ViewTimer } from '@/lib/view-timer'
import type { LogContext } from '@/lib/evaluation-log'
import { GameIcon } from '@/components/ui/GameIcon'
import {
  EMPTY_NOTE_PARTS, NOTE_MIN_LEN, isLegacyNote, missingNoteParts, notePartsFromRow, notePartsRequirementError,
  type NoteParts,
} from '@/lib/eval-rules'

export interface EvalDetail {
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
  initial_gameplay?: string | null
  initial_game_over?: string | null
  initial_level_complete?: string | null
  initial_self_note?: string | null
  final_note: string | null
  game_alike: GameAlikeGame[] | null
  initial_conclusion: string | null
  final_conclusion: string | null
  batch: string | null
  current_batch?: string | null
  record_assignee: string | null
  record_assign_date: string | null
  record_5min_assignee: string | null
  record_5min_date: string | null
  record_5min_drive: string | null
  record_5min_drive_date: string | null
  record_20min_assignee: string | null
  record_20min_date: string | null
  record_20min_drive: string | null
  record_20min_drive_date: string | null
  record_confirmed_at: string | null
  final_conclusion_date: string | null
  drive_link: string | null
  drive_date: string | null
  youtube_link: string | null
  record_bucket: string | null
  // One round per bucket (migration 051): the game can be recorded 5 min in one
  // batch and 20 min in a later one, each with its own Confirm and video.
  record_5min_confirmed_at: string | null
  record_20min_confirmed_at: string | null
  youtube_5min_link: string | null
  youtube_20min_link: string | null
  youtube_5min_uploaded_local: string | null
  youtube_20min_uploaded_local: string | null
  imported_at: string
  updated_at: string
  updated_by: string | null
  title: string
  os: string
  app_link: string
  icon_url: string | null
  release_date: string | null
  screenshot_urls: string[] | null
  manual_screenshot_urls: string[] | null
  categories: string[] | null
  description: string | null
  subtitle: string | null
  content_rating: string | null
  publisher_name: string | null
  publisher_link: string | null
}

export interface EvalListItem { game_id: string; title: string }

// The Initial Conclusion an evaluator picks: Bypass (drop), List_Idea (keep →
// buckets into a weekly batch), or Playtest & Bypass (playtest first, then drop).
// Link_dead is set via the dead-link toggle, not this dropdown. Legacy sheet
// values still display (merged in below).
const INITIAL_CONCLUSION_OPTIONS = ['Bypass', 'List_Idea', 'Playtest & Bypass']


const MONTH_ABBR = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// Weekly batch labels for a month, e.g. weekBatches(2026, 6) →
// ['W1 Jun, 2026', 'W2 Jun, 2026', 'W3 Jun, 2026', 'W4 Jun, 2026'].
// month is 1-12. Matches column A of the IDEA_LIST sheet.
export function weekBatches(year: number, month: number): string[] {
  const m = MONTH_ABBR[month] || ''
  return [1, 2, 3, 4].map(w => `W${w} ${m}, ${year}`)
}

/** `category` picks the row when a game has one in more than one genre, each
 *  assigned to someone else. Without it the server prefers the caller's own row. */
export async function fetchEvalByGameId(gameId: string, category?: string): Promise<EvalDetail | null> {
  try {
    const qs = category ? `?${new URLSearchParams({ category })}` : ''
    const res = await fetch(`/api/evaluations/${encodeURIComponent(gameId)}${qs}`)
    if (!res.ok) return null
    const json = await res.json()
    return json.data as EvalDetail
  } catch { return null }
}

/** What GET /api/playtest-tags?gameId= answers with: the game's pending proposals
 *  and the Trends tags Signal Sense already carries for it. */
export interface TrendTagsPayload {
  pending: ReviewTag[]
  existing: ExistingTrendTag[]
}

export async function fetchTrendTags(gameId: string): Promise<TrendTagsPayload> {
  const res = await fetch(`/api/playtest-tags?gameId=${encodeURIComponent(gameId)}`)
  if (!res.ok) throw new Error('failed')
  const d = await res.json()
  return { pending: d.pending || [], existing: d.existing || [] }
}

const CopyIcon = ({ size }: { size: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
)

function InfoField({ label, value, copyValue, icon }: { label: string; value: string | null | undefined; copyValue?: string; icon?: ReactNode }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    if (!copyValue) return
    try {
      await navigator.clipboard.writeText(copyValue)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* ignore */ }
  }
  return (
    <div>
      <div className="label" style={{ marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 5 }}>
        {icon}
        <span>{value || '—'}</span>
        {copyValue && (
          <button type="button" onClick={copy} title={`Copy ${label}`} aria-label={copied ? 'Copied' : `Copy ${label}`}
            className={`copy-btn${copied ? ' done' : ''}`}>
            {copied ? '✓' : <CopyIcon size={12} />}
          </button>
        )}
      </div>
    </div>
  )
}

// Recording file name convention: <title>_<assignee>_<5|20>mins
function recFileName(title: string, assignee: string, mins: 5 | 20): string {
  return `${title}_${assignee}_${mins}mins`
}

function FileNameField({ name }: { name: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(name)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* ignore */ }
  }
  return (
    <div className="field" style={{ paddingTop: 8, borderTop: '1px solid var(--border)' }}>
      <span className="label">File name</span>
      <div style={{ display: 'flex', gap: 6 }}>
        <input className="input" readOnly value={name}
          style={{ flex: 1, minWidth: 0, fontSize: 12, fontFamily: 'var(--num)' }} />
        <button type="button" className="btn btn-sm" onClick={copy} title="Copy file name" aria-label={copied ? 'Copied' : 'Copy file name'}
          style={{ flexShrink: 0, minWidth: 38, justifyContent: 'center' }}>
          {copied ? '✓' : <CopyIcon size={13} />}
        </button>
      </div>
    </div>
  )
}

/** `label` names what is copied, for the tooltip and screen readers. */
function TitleCopyButton({ title, label = 'title' }: { title: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(title)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* ignore */ }
  }
  return (
    <button type="button" onClick={copy} title={`Copy ${label}`} aria-label={copied ? 'Copied' : `Copy ${label}`}
      className={`copy-btn${copied ? ' done' : ''}`}>
      {copied ? '✓' : <CopyIcon size={13} />}
    </button>
  )
}

// Persistent save-state badge so it's always clear whether the form matches
// what's stored. Orange dot = pending edits; green check = in sync with server.
/** One row of the Gameplay brief: a borderless textarea that grows with its text. */
function BriefRow({ label, value, onChange, placeholder, minRows, disabled, missing }: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder: string
  minRows: number
  disabled: boolean
  /** Why the row blocks Save, shown on its right; undefined when it does not. */
  missing?: string
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [value])
  return (
    <label className="note-brief-row">
      <span className="note-brief-head">
        {label}
        {missing && <span className="req">{missing}</span>}
      </span>
      <textarea ref={ref} rows={minRows} value={value} placeholder={placeholder} disabled={disabled}
        onChange={e => onChange(e.target.value)} />
    </label>
  )
}

/** One part of the initial note: label, optional faint hint, textarea, error line. */
function NoteBox({ label, hint, value, onChange, placeholder, rows, disabled, warn, error }: {
  label: string
  hint?: string
  value: string
  onChange: (v: string) => void
  placeholder: string
  rows: number
  disabled: boolean
  warn?: boolean
  error?: string
}) {
  return (
    <div className="field" style={{ minWidth: 0 }}>
      <span className="label">
        {label}
        {hint && <span style={{ marginLeft: 6, fontWeight: 500, color: 'var(--faint)' }}>{hint}</span>}
      </span>
      <textarea
        className="input"
        rows={rows}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        style={{ resize: 'vertical', fontSize: 13, ...(warn ? { borderColor: 'var(--warn)' } : {}) }}
      />
      {error && <div style={{ fontSize: 11, color: 'var(--warn)', marginTop: 4 }}>{error}</div>}
    </div>
  )
}

function ClearBtn({ onClick }: { onClick: () => void }) {
  return (
    // A text-size action inside a field's label row, so .field-clear and not .btn-sm:
    // a 28px button would make the row grow the moment the field gets a value.
    <button type="button" onClick={onClick} title="Clear this field" className="field-clear">
      <IconX size={11} />
      Clear
    </button>
  )
}

function SaveStatus({ dirty }: { dirty: boolean }) {
  return (
    <span className={`badge ${dirty ? 'running' : 'success'}`}>
      {dirty ? (
        <>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--warn)' }} />
          Unsaved changes
        </>
      ) : (
        <>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
          Saved
        </>
      )}
    </span>
  )
}

function ProgressTracker({ ev, yt5, yt20, uploadedAt }: { ev: EvalDetail; yt5?: string; yt20?: string; uploadedAt?: string | null }) {
  const recAssignees = Array.from(new Set([ev.record_5min_assignee, ev.record_20min_assignee].filter(Boolean)))
  // "Video Uploaded" tracks the 5/20-min report videos, which are now always
  // YouTube uploads (the demo drive link, ev.drive_link, belongs to the
  // evaluation step). Completed when a matching YouTube upload exists.
  const ytId = yt5 || yt20
  // `connector` is a label drawn on the line AFTER this step — the conclusion
  // that drove the transition (initial → final, final → recording).
  const steps: {
    label: string; completed: boolean; date?: string | null; assignee?: string | null; connector?: string | null; href?: string | null
  }[] = [
    { label: 'Playtest Assigned', completed: !!ev.initial_evaluator, date: ev.assigned_date, assignee: ev.initial_evaluator },
    { label: 'Initial Evaluation', completed: !!ev.evaluate_date, date: ev.evaluate_date, connector: ev.initial_conclusion },
    { label: 'Final Evaluation', completed: !!ev.final_conclusion, date: ev.final_conclusion_date, assignee: ev.final_evaluator, connector: ev.final_conclusion },
    { label: 'Recording Assigned', completed: recAssignees.length > 0, date: ev.record_5min_date || ev.record_20min_date, assignee: recAssignees.join(', ') || null },
    { label: 'Video Uploaded', completed: !!ytId, href: ytId ? `https://www.youtube.com/watch?v=${ytId}` : null, date: uploadedAt }
  ]

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      background: 'var(--surface-2)',
      borderRadius: 12,
      border: '1px solid var(--border)',
      padding: '12px 20px',
      marginBottom: 16
    }}>
      {steps.map((step, idx) => {
        const isCompleted = step.completed
        const isPrevCompleted = idx === 0 || steps[idx - 1].completed
        const isCurrent = !isCompleted && isPrevCompleted
        
        let color = 'var(--faint)'
        let bg = 'var(--surface-3)'
        let border = '1px solid var(--border-strong)'
        
        if (isCompleted) {
          color = 'var(--good)'
          bg = 'var(--good-weak)'
          border = '1.5px solid var(--good)'
        } else if (isCurrent) {
          color = 'var(--accent)'
          bg = 'var(--accent-weak)'
          border = '1.5px solid var(--accent)'
        }

        return (
          <div key={idx} style={{ display: 'flex', alignItems: 'center', flex: idx < steps.length - 1 ? 1 : 'none' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {/* Step bubble */}
              <div style={{
                width: 24,
                height: 24,
                borderRadius: '50%',
                background: bg,
                border: border,
                color: color,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 11,
                fontWeight: 700,
                flexShrink: 0
              }}>
                {isCompleted ? (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                ) : (
                  idx + 1
                )}
              </div>

              {/* Step info */}
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {step.href && isCompleted ? (
                  <a href={step.href} target="_blank" rel="noopener noreferrer" title="Open on YouTube"
                    className="yt-link"
                    style={{ fontSize: 12, fontWeight: 600, color: 'var(--good)', textDecoration: 'none' }}>
                    ▶ {step.label}
                  </a>
                ) : (
                  <span style={{ fontSize: 12, fontWeight: isCurrent || isCompleted ? 600 : 500, color: isCurrent ? 'var(--text)' : isCompleted ? 'var(--muted)' : 'var(--faint)' }}>
                    {step.label}
                  </span>
                )}
                {step.assignee && (
                  <span style={{ fontSize: 11, fontWeight: 600, color: isCompleted ? 'var(--text)' : 'var(--muted)', marginTop: 1, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <UserIcon />{step.assignee}
                  </span>
                )}
                {step.date && (
                  <span style={{ fontSize: 11, color: 'var(--faint)', marginTop: step.assignee ? 1 : 2 }}>
                    {fmtDateVN(step.date)}
                  </span>
                )}
              </div>
            </div>

            {/* Connecting line — carries the transition's conclusion as a chip */}
            {idx < steps.length - 1 && (
              <div style={{ flex: 1, margin: '0 12px', minWidth: 24, position: 'relative', display: 'flex', alignItems: 'center' }}>
                <div style={{
                  flex: 1,
                  height: 2,
                  background: isCompleted && steps[idx + 1].completed ? 'var(--good)' : isCompleted ? 'var(--accent-border)' : 'var(--track)',
                }} />
                {step.connector && (
                  <span style={{
                    position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)',
                    fontSize: 11, fontWeight: 700, letterSpacing: '0.3px', whiteSpace: 'nowrap',
                    color: isCompleted ? 'var(--good)' : 'var(--muted)',
                    background: 'var(--surface-2)', padding: '1px 6px', borderRadius: 5,
                  }}>
                    {prettyConclusion(step.connector)}
                  </span>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// Same four states and badges as the Record tab (lib/conclusion-badge.ts):
// uploaded → Recorded, no recorder → Pending, recorder confirmed → Recording,
// recorder picked but not confirmed → Draft.
function recordStatusOf(youtubeId: string | undefined, assignee: string | null, confirmed: boolean): RecordStatus {
  if (youtubeId) return 'recorded'
  if (!assignee) return 'pending'
  return confirmed ? 'recording' : 'draft'
}

function RecordBadge({ status, youtubeId }: { status: RecordStatus; youtubeId?: string }) {
  const b = RECORD_STATUS_BADGE[status]
  if (status === 'recorded' && youtubeId) {
    return (
      <a className={`badge ${b.cls} yt-link`} href={`https://www.youtube.com/watch?v=${youtubeId}`} target="_blank" rel="noopener noreferrer"
        title="Open on YouTube" style={{ textDecoration: 'none' }}>▶ {b.label}</a>
    )
  }
  return <span className={`badge ${b.cls}`}>{b.label}</span>
}

interface Props {
  initialGameId: string
  gameList: EvalListItem[]
  /** The genre of the list the panel was opened from. A game can have a row in
   *  two genres, assigned to two people; this is how the panel opens the row the
   *  list showed and not the other one. */
  category?: string
  role: string | undefined
  userName: string
  readOnly?: boolean
  canAssignRecords?: boolean
  hideRecordSections?: boolean
  /** Show the Final Conclusion card. Only the Short List (moderator triage)
   *  surfaces it; the Evaluate panel and other views hide it. */
  showFinalConclusion?: boolean
  /** Which screen hosts the panel; stored on each evaluation_log row so panel time can
   *  be split by screen. Required so a new mount cannot forget it. */
  logContext: LogContext
  onNavigate?: (gameId: string) => void
  onSaved?: (ev: EvalDetail) => void
  onClose?: () => void
}

// Builds the duration-aware title→youtubeId map (shared logic with the Record
// grid). The Record cards and the "Video Uploaded" milestone derive "recorded"
// from this.
//
// Reads the Postgres mirror, NOT the sheet. Every panel open used to trigger a
// full Google Sheets read (300-1500ms, quota-limited) for data that only changes
// long after this screen matters — recording happens after final conclusion, so
// a mirror minutes behind is indistinguishable from live here. The Record tab,
// which actually edits these rows, still talks to the sheet directly.
function useYtbUploads(): Map<string, YtMatch> {
  const [map, setMap] = useState<Map<string, YtMatch>>(new Map())
  useEffect(() => {
    fetch('/api/ytb-uploads', { cache: 'no-store' })
      .then(r => r.ok ? r.json() : [])
      .then((rows: Array<{ gameTitle: string; youtubeId: string; duration: string; time: string }>) => setMap(buildYtMap(rows)))
      .catch(() => {})
  }, [])
  return map
}

export default function EvalDetailPanel({ initialGameId, gameList, category, role, userName, readOnly, canAssignRecords, hideRecordSections, showFinalConclusion, logContext, onNavigate, onSaved, onClose }: Props) {
  const ytMap = useYtbUploads()
  const [currentGameId, setCurrentGameId] = useState(initialGameId)
  // How long the current game has been on screen (evaluation_log.view_s). A ref, not
  // state: it changes on every input and must never re-render the panel.
  const viewRef = useRef<ViewTimer>(startView(initialGameId, Date.now(), false))
  const currentGameIdRef = useRef(currentGameId)
  currentGameIdRef.current = currentGameId
  // The game whose data the form currently shows (set in applyData). Differs from
  // currentGameId while the next game is still loading.
  const shownGameRef = useRef<string | null>(null)
  useEffect(() => {
    viewRef.current = startView(currentGameId, Date.now(), document.hidden)
  }, [currentGameId])
  useEffect(() => {
    const onVis = () => { viewRef.current = onVisibility(viewRef.current, document.hidden, Date.now()) }
    const onAny = () => { viewRef.current = onInput(viewRef.current, Date.now()) }
    let lastMove = 0
    const onMove = () => { const n = Date.now(); if (n - lastMove < 1000) return; lastMove = n; onAny() }
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('pointerdown', onAny)
    window.addEventListener('keydown', onAny)
    window.addEventListener('wheel', onAny, { passive: true })
    window.addEventListener('pointermove', onMove, { passive: true })
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('pointerdown', onAny)
      window.removeEventListener('keydown', onAny)
      window.removeEventListener('wheel', onAny)
      window.removeEventListener('pointermove', onMove)
    }
  }, [])
  const [ev, setEv] = useState<EvalDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const [noteParts, setNoteParts] = useState<NoteParts>(EMPTY_NOTE_PARTS)
  const setNotePart = (k: keyof NoteParts, v: string) => setNoteParts(p => ({ ...p, [k]: v }))
  const [finalNote, setFinalNote] = useState('')
  const [finalConclusion, setFinalConclusion] = useState('')
  const [gameAlike, setGameAlike] = useState<GameAlikeGame[]>([])
  const [trendTags, setTrendTags] = useState<TrendTag[]>([])
  const [existingTrends, setExistingTrends] = useState<ExistingTrendTag[]>([])
  // The same pending tags in full (who proposed, conflict verdict), for the
  // manager review rows. `trendTags` stays the plain editable list the save PUT
  // replaces; these two must not be merged, or reviewing would dirty the form.
  const [pendingReview, setPendingReview] = useState<ReviewTag[]>([])
  const [trendOptions, setTrendOptions] = useState<string[]>([])
  // Category groups each trend is defined for; with the game's own group they let
  // the pickers open on that group's trends instead of all ~360.
  const [trendCategoryGroups, setTrendCategoryGroups] = useState<Record<string, string[]> | undefined>(undefined)
  const [trendSubValues, setTrendSubValues] = useState<{ id: number; name: string }[]>([])
  const [trendOptionsError, setTrendOptionsError] = useState(false)
  const [trendTagsError, setTrendTagsError] = useState(false)
  // The game whose tags are actually on screen, set only after a successful
  // load. save() refuses to PUT while this does not match the displayed game:
  // the PUT is a destructive replace, so sending the empty initial state would
  // wipe pending proposals the user never saw.
  const trendTagsLoadedFor = useRef<string | null>(null)
  const trendTagsGen = useRef(0)
  // One game's tags, kept alongside the panel's detail cache and filled by the same
  // neighbour prefetch. Before this, Prev/Next always waited a full round-trip for
  // the Trends section even when the game itself was already cached.
  const trendTagsCacheRef = useRef<Map<string, TrendTagsPayload>>(new Map())
  const [conclusion, setConclusion] = useState('')
  const [batch, setBatch] = useState('')
  const [driveLink, setDriveLink] = useState('')
  const [drive5, setDrive5] = useState('')
  const [drive20, setDrive20] = useState('')
  const [rec5Assignee, setRec5Assignee] = useState('')
  const [rec20Assignee, setRec20Assignee] = useState('')
  const [recorders, setRecorders] = useState<string[]>([])
  const [deadLink, setDeadLink] = useState(false)
  const [dirty, setDirty] = useState(false)
  // Manual screenshots staged in the child card. Folded into the unified save so
  // there's no separate "Save screenshots" click (and auto-save picks them up).
  const screenshotRef = useRef<ManualScreenshotsHandle>(null)
  const [stagedShots, setStagedShots] = useState(0)
  // Staged shots keep `needsSave` true when an upload fails, which would otherwise
  // make auto-save re-fire every 1.5s forever against a storage backend that is
  // down. Latched on failure, cleared the moment the staged set changes (or a
  // manual Save succeeds), so retrying stays the user's call.
  const shotsFailedRef = useRef(false)

  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [expandedImg, setExpandedImg] = useState<string | null>(null)
  // History modal, keyed to the game it was opened on so Prev/Next never shows another game's list.
  const [history, setHistory] = useState<{ gameId: string; events: HistoryEvent[] | null; logReady: boolean; error: boolean } | null>(null)
  const [fullscreen, setFullscreen] = useState(false)
  const [autoSave, setAutoSave] = useState(false)
  const [confirmClearAll, setConfirmClearAll] = useState(false)

  useEffect(() => {
    // Auto-save preference is remembered per browser/user.
    try { setAutoSave(localStorage.getItem('eval:autoSave') === '1') } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    try { localStorage.setItem('eval:autoSave', autoSave ? '1' : '0') } catch { /* ignore */ }
  }, [autoSave])

  const cacheRef = useRef<Map<string, EvalDetail>>(new Map())
  // Which loadGame call owns the screen, and whether the form has unsaved edits.
  // Both are read inside async callbacks that would otherwise close over a stale
  // render's values.
  const loadGameGen = useRef(0)
  const dirtyRef = useRef(false)

  // Mirror `dirty` into a ref so loadGame's late-arriving revalidation can see the
  // current value rather than the one captured when it started.
  useEffect(() => { dirtyRef.current = dirty }, [dirty])

  // Leaving the game on screen (Next, Prev, the picker, ✕, Esc, a click outside) with
  // edits nobody saved. `requestLeaveRef` is assigned every render, after save() exists,
  // so the navigation callbacks above it never close over a stale form.
  const [leave, setLeave] = useState<{ action: LeaveAction; fields: string[]; proceed: () => void } | null>(null)
  const [leaveSaving, setLeaveSaving] = useState(false)
  const requestLeaveRef = useRef<(action: LeaveAction, proceed: () => void) => void>((_, proceed) => proceed())
  // Set by the Trends field, cleared with the form: that field has no loaded baseline to diff.
  const trendsTouchedRef = useRef(false)

  useEffect(() => {
    setCurrentGameId(initialGameId)
  }, [initialGameId])

  const currentIdx = useMemo(() => gameList.findIndex(g => g.game_id === currentGameId), [gameList, currentGameId])
  const hasNav = gameList.length > 1 && currentIdx !== -1

  const qrGenRef = useRef(0)
  const generateQR = useCallback((appLink: string | null) => {
    const gen = ++qrGenRef.current
    setQrDataUrl(null)
    if (!appLink) return
    // Hex on purpose: the QR is drawn to a canvas (no CSS variables there) and must stay
    // dark-on-white whatever the theme, or phones cannot scan it.
    QRCode.toDataURL(appLink, {
      width: 200, margin: 2, color: { dark: '#1a1c22', light: '#ffffff' },
    }).then(url => {
      if (qrGenRef.current === gen) setQrDataUrl(url)
    }).catch(() => {
      if (qrGenRef.current === gen) setQrDataUrl(null)
    })
  }, [])

  const applyData = useCallback((data: EvalDetail) => {
    shownGameRef.current = data.game_id
    setEv(data)
    setNoteParts(notePartsFromRow(data))
    setFinalNote(data.final_note || '')
    setFinalConclusion(data.final_conclusion || '')
    setGameAlike(Array.isArray(data.game_alike) ? data.game_alike : [])
    const c = data.initial_conclusion || ''
    setConclusion(c)
    setDeadLink(c === 'Link_dead')
    setBatch(data.batch || '')
    setDriveLink(data.drive_link || '')
    setDrive5(data.record_5min_drive || '')
    setDrive20(data.record_20min_drive || '')
    setRec5Assignee(data.record_5min_assignee || '')
    setRec20Assignee(data.record_20min_assignee || '')
    setDirty(false)
    trendsTouchedRef.current = false
    generateQR(data.app_link)
  }, [generateQR])

  const loadGame = useCallback(async (gameId: string) => {
    const gen = ++loadGameGen.current
    const cached = cacheRef.current.get(gameId)
    if (cached) {
      applyData(cached)
      setLoading(false)
    } else {
      setLoading(true)
    }
    const data = await fetchEvalByGameId(gameId, category)
    if (!data) return
    cacheRef.current.set(gameId, data)
    // Drop a response for a game we have already navigated away from. Holding
    // Next/ArrowRight fires these faster than they come back, and without this the
    // slowest one wins: an earlier game's data lands on top of the visible one.
    if (loadGameGen.current !== gen) return
    // A cached game is already on screen. Re-applying an identical payload is a
    // second full form reset for no visible change -- it clears `dirty`, resets every
    // field and blanks the QR while it regenerates, ~half a second after the user
    // moved on and possibly started typing. Apply the fresh copy only when it says
    // something different, and never over edits in progress.
    if (cached) {
      if (dirtyRef.current) return
      if (JSON.stringify(data) === JSON.stringify(cached)) return
    }
    applyData(data)
    setLoading(false)
  }, [applyData, category])

  const goTo = useCallback((gameId: string) => {
    setCurrentGameId(gameId)
    onNavigate?.(gameId)
  }, [onNavigate])

  const goPrev = useCallback(() => {
    if (!hasNav) return
    const idx = currentIdx === 0 ? gameList.length - 1 : currentIdx - 1
    requestLeaveRef.current('prev', () => goTo(gameList[idx].game_id))
  }, [hasNav, currentIdx, gameList, goTo])

  const goNext = useCallback(() => {
    if (!hasNav) return
    const idx = currentIdx === gameList.length - 1 ? 0 : currentIdx + 1
    requestLeaveRef.current('next', () => goTo(gameList[idx].game_id))
  }, [hasNav, currentIdx, gameList, goTo])

  useEffect(() => { loadGame(currentGameId) }, [currentGameId, loadGame])

  // Loads the fixed Trends catalog once, and again on demand via the retry
  // button `TrendTagsField` shows when this fails. A failure must not look
  // like "no trends exist" — it's surfaced as `trendOptionsError` so the field
  // can render a distinct, retryable message instead of an empty combobox.
  const loadTrendOptions = useCallback(() => {
    setTrendOptionsError(false)
    fetch('/api/trends/options')
      .then(r => { if (!r.ok) throw new Error('failed'); return r.json() })
      .then(d => { setTrendOptions(d.values || []); setTrendCategoryGroups(d.categoryGroups); setTrendSubValues(d.subValues || []) })
      .catch(() => { setTrendOptionsError(true) })
  }, [])

  useEffect(() => { loadTrendOptions() }, [loadTrendOptions])

  // Load one game's tags. The generation counter keeps a late response for a game
  // we navigated away from from overwriting the visible state (mirroring
  // `updateManualShots`) and also covers the retry, which re-runs this outside the
  // effect. A failure is recorded rather than swallowed: `trendTagsLoadedFor`
  // stays unset, which blocks the destructive PUT, and `trendTagsError` tells the
  // user why the field went read-only.
  const applyTrendTags = useCallback((gameId: string, d: TrendTagsPayload) => {
    setTrendTags((d.pending || []).map(p => ({ field_value: p.field_value, sub_value_id: p.sub_value_id })))
    setPendingReview(d.pending || [])
    setExistingTrends(d.existing || [])
    setTrendTagsError(false)
    trendTagsLoadedFor.current = gameId
  }, [])

  const loadTrendTags = useCallback((gameId: string, force = false) => {
    const gen = ++trendTagsGen.current
    // Cache hit: the neighbour prefetch below already has this game's tags, so the
    // section renders filled in the same frame instead of blanking for a round-trip.
    // Serving it and stopping is deliberate -- a background re-read would land on an
    // editable list (`trendTags`) and could wipe whatever the user staged meanwhile.
    // A stale entry is not a risk: every write path drops the game's entry.
    const cached = force ? undefined : trendTagsCacheRef.current.get(gameId)
    if (cached) {
      applyTrendTags(gameId, cached)
      return
    }
    trendTagsLoadedFor.current = null
    setTrendTags([]); setPendingReview([]); setExistingTrends([]); setTrendTagsError(false)
    fetchTrendTags(gameId)
      .then(d => {
        trendTagsCacheRef.current.set(gameId, d)
        if (trendTagsGen.current !== gen) return
        applyTrendTags(gameId, d)
      })
      .catch(() => { if (trendTagsGen.current === gen) setTrendTagsError(true) })
  }, [applyTrendTags])

  // A review action changes the pending set behind the form, so the editable
  // list has to follow it: a confirmed tag left in the list would be proposed all
  // over again on the next save, and a corrected tag would be reverted to the
  // version the form still remembers.
  //
  // Applied from the response rather than by re-reading the game. The re-read was
  // a second round trip on every click -- confirm, reject, and each pick inside
  // an edit -- and the click's own response already says what changed. Anything
  // the user has staged and not saved is untouched either way.
  const onTagReviewed = useCallback((change: ReviewChange) => {
    const { tag } = change
    // The cached copy describes the tags as they were before this review; drop it so
    // navigating away and back re-reads rather than restoring the pre-review list.
    trendTagsCacheRef.current.delete(tag.game_id)
    if (change.kind === 'edited') {
      setPendingReview(prev => prev.map(p => (p.id === tag.id ? tag : p)))
      setTrendTags(prev => prev.map(t => (t.field_value === change.previous
        ? { field_value: tag.field_value, sub_value_id: tag.sub_value_id } : t)))
      return
    }
    setPendingReview(prev => prev.filter(p => p.id !== tag.id))
    setTrendTags(prev => prev.filter(t => t.field_value !== tag.field_value))
    // A confirmed tag is now one of the game's Signal Sense trends, and the modal
    // shows that list right below. A rejected one is simply gone.
    if (change.landed) {
      setExistingTrends(prev => prev.some(e => e.field_value === tag.field_value)
        ? prev.map(e => (e.field_value === tag.field_value
          ? { ...e, sub_value_id: tag.sub_value_id, sub_value_name: tag.sub_value_name } : e))
        // created_by is what the section reads to decide whether to name a
        // person: a tag that just landed was written by this app's sync account.
        : [...prev, {
          field_value: tag.field_value, sub_value_id: tag.sub_value_id,
          sub_value_name: tag.sub_value_name, created_by: 'playtest_sync', created_by_name: null,
        }])
    }
  }, [])

  // A manager changed a tag that was already in Signal Sense. Nothing else in
  // the form depends on that list, so the section is all that moves -- and it
  // moves from the response, not from a re-read.
  const onExistingChanged = useCallback((change: ExistingTagChange) => {
    trendTagsCacheRef.current.delete(currentGameId)
    setExistingTrends(prev => applyExistingChange(prev, change))
  }, [currentGameId])

  useEffect(() => {
    loadTrendTags(currentGameId)
    // Bump the generation on unmount / game change so an in-flight response is
    // dropped instead of landing on the next game.
    return () => { trendTagsGen.current++ }
  }, [currentGameId, loadTrendTags])

  useEffect(() => {
    if (!hasNav) return
    const prefetchIdx = [
      currentIdx === 0 ? gameList.length - 1 : currentIdx - 1,
      currentIdx === gameList.length - 1 ? 0 : currentIdx + 1,
    ]
    prefetchIdx.forEach(idx => {
      const gid = gameList[idx].game_id
      if (!cacheRef.current.has(gid)) {
        fetchEvalByGameId(gid, category).then(data => { if (data) cacheRef.current.set(gid, data) })
      }
      // The Trends section is a second request on the same navigation, and it used to
      // be the one Prev/Next actually waited on: the game itself was prefetched, its
      // tags never were. Warm both or neither.
      if (!trendTagsCacheRef.current.has(gid)) {
        fetchTrendTags(gid)
          .then(d => { trendTagsCacheRef.current.set(gid, d) })
          .catch(() => { /* the real load will surface the failure */ })
      }
    })
  }, [currentIdx, hasNav, gameList, category])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A dialog stacked on the panel (Trends tags) already took this key.
      if (e.defaultPrevented) return
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return
      // A popup open: Esc closes it, arrows do not move to another game underneath.
      if (leave) { if (e.key === 'Escape' && !leaveSaving) setLeave(null); return }
      if (history) { if (e.key === 'Escape') setHistory(null); return }
      if (e.key === 'ArrowLeft') { e.preventDefault(); goPrev() }
      if (e.key === 'ArrowRight') { e.preventDefault(); goNext() }
      if (e.key === 'Escape') {
        if (expandedImg) setExpandedImg(null)
        else if (fullscreen) setFullscreen(false)
        else requestLeaveRef.current('close', () => onClose?.())
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [goPrev, goNext, expandedImg, history, leave, leaveSaving, fullscreen, onClose])

  // Fetched on open only; opening a game never pays for it.
  const openHistory = (gameId: string) => {
    setHistory({ gameId, events: null, logReady: true, error: false })
    fetch(`/api/evaluations/${encodeURIComponent(gameId)}/history`)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: { events: HistoryEvent[]; log_ready: boolean }) =>
        setHistory(h => (h && h.gameId === gameId ? { ...h, events: d.events, logReady: d.log_ready } : h)))
      .catch(() => setHistory(h => (h && h.gameId === gameId ? { ...h, error: true } : h)))
  }

  // Results go to the app-wide toaster (bottom-right), same messages as before.
  const showToast = (msg: string, err = false) => {
    if (err) toast.error(msg)
    else toast.success(msg)
  }

  const updateManualShots = (gameId: string, urls: string[]) => {
    // A late response for a game we've navigated away from must not touch
    // the displayed state; refresh that game's cache entry instead.
    const cached = cacheRef.current.get(gameId)
    if (cached) cacheRef.current.set(gameId, { ...cached, manual_screenshot_urls: urls })
    setEv(prev => {
      if (!prev || prev.game_id !== gameId) return prev
      const next = { ...prev, manual_screenshot_urls: urls }
      cacheRef.current.set(gameId, next)
      return next
    })
  }

  const isAdmin = role === 'admin'
  const isManager = isManagerRole(role)
  // Evaluation content (conclusion/note/drive) — a manager or the assigned evaluator.
  const canEditEval = !readOnly && (isManager || ev?.initial_evaluator === userName)
  // Game Alike and Trends tags are a manager's to edit on any game — this is the
  // flag they hang off, kept separate from the final fields below. Before
  // moderator existed the two were the same check, and folding them back
  // together would quietly take tagging away from moderators.
  const canEditManagerFields = !readOnly && isManager
  // Final Note + Final Conclusion are the last word on a game: admin only.
  const canEditFinalNote = !readOnly && isAdmin
  // Game Alike is editable by the evaluator OR a manager, in any stage.
  const canEditGameAlike = canEditEval || canEditManagerFields
  // Progress-stage locks freeze only the *conclusion decisions* — notes, game
  // alike and demo link stay editable per their base permission.
  //   final conclusion set → Initial Conclusion frozen (clear it to unlock)
  //   recorder assigned     → Final Conclusion frozen (remove/reassign in Record tab)
  const initialLocked = !!ev?.final_conclusion
  const finalLocked = !!(ev?.record_5min_assignee || ev?.record_20min_assignee)
  const canEditInitialConc = canEditEval && !initialLocked
  const canEditFinalConc = canEditFinalNote && !finalLocked
  // Recording drive links — a manager or the assigned recorder for that duration.
  const canEdit5 = !readOnly && (isManager || ev?.record_5min_assignee === userName)
  const canEdit20 = !readOnly && (isManager || ev?.record_20min_assignee === userName)
  // 5/20-min recordings are always YouTube uploads, matched live (title + duration).
  const m5 = ev ? ytLookup(ytMap, ev.title, '5min') : undefined
  const m20 = ev ? ytLookup(ytMap, ev.title, '20min') : undefined
  // Each bucket shows its own round's video. The live lookup only matches by
  // title; near matches (typo, dropped subtitle) need every Record game at once,
  // so they come from the link the reconcile stored for that bucket, which also
  // keeps a finished round's video after the game moved to the other bucket.
  // The bucket the game is in now prefers the live match (fresh, as the Record
  // tab). A bucket it is not in takes the live match only for a round it really
  // had (a recorder): a same-title game on the other OS has its own videos. A card
  // only appears for a round this row has (recorder or stored video), never for a
  // title match alone: the Android twin of a recorded iOS game is not recorded.
  const ownBucket = ev ? recordBucketOf(ev) : '5min'
  const stored5 = extractYtId(ev?.youtube_5min_link) || undefined
  const stored20 = extractYtId(ev?.youtube_20min_link) || undefined
  const yt5 = ownBucket === '5min' ? (m5?.id || stored5) : (stored5 || (ev?.record_5min_assignee ? m5?.id : undefined))
  const yt20 = ownBucket === '20min' ? (m20?.id || stored20) : (stored20 || (ev?.record_20min_assignee ? m20?.id : undefined))
  // When the recording was uploaded (sheet `time`), for the "Video Uploaded" step.
  const timeOf = (yt: string | undefined, live: YtMatch | undefined, stored: string | null | undefined) =>
    !yt ? null : live?.id === yt ? live.time : (stored || null)
  const ytUploadedAt = timeOf(yt5, m5, ev?.youtube_5min_uploaded_local) || timeOf(yt20, m20, ev?.youtube_20min_uploaded_local)
  // Once a bucket is confirmed, its recorder is locked — no reassigning.
  const confirmed5 = !!ev?.record_5min_confirmed_at
  const confirmed20 = !!ev?.record_20min_confirmed_at
  // Final conclusion options (managed from the Config tab).
  const { final_conclusion: finalConclusionOptions } = useConfig()
  // Re-assigning recorders is a manager action, enabled per-context.
  const canEditAssignee = !readOnly && isManager && !!canAssignRecords
  // Any editable surface → show the save button.
  const canEdit = canEditEval || canEdit5 || canEdit20 || canEditAssignee
    || canEditManagerFields || canEditFinalNote
  // The eval editor's Save button also flushes staged screenshots, so staged
  // shots count as unsaved work for it (the card hides its own button then).
  const needsSave = dirty || (canEditEval && stagedShots > 0)
  // A written note has to be a real note, on every save — reopening a game whose
  // stored note is short blocks Save until it is filled in, even when the edit is
  // to some other field. Link_dead is exempt.
  // List_Idea needs the three gameplay parts, every other conclusion a Self Note;
  // a List_Idea game noted before the four-part split keeps the whole-note rule.
  const noteRule = { parts: noteParts, conclusion, legacy: !!ev && isLegacyNote(ev) }
  const noteError = canEditEval ? notePartsRequirementError(noteRule) : null
  const missingParts = canEditEval ? missingNoteParts(noteRule) : []
  const noteTooShort = !!noteError
  // Who gets the Save bar: anyone who can change something on this panel, in this
  // context (final conclusion only shows on Short List, record cards only where the
  // host shows them).
  const recordEditable = !hideRecordSections && !!ev
    && !!(ev.record_5min_assignee || ev.record_20min_assignee || canEditAssignee)
    && (canEdit5 || canEdit20 || canEditAssignee)
  const showSaveBar = canEditGameAlike || (showFinalConclusion && canEditFinalNote) || recordEditable

  // Names of the fields that differ from what was loaded: shown next to Save, and in
  // the "unsaved changes" popup when leaving.
  const currentUnsavedFields = (): string[] => {
    if (!ev) return []
    const fields = unsavedFields(
      { noteParts, conclusion, batch, driveLink, gameAlike, finalNote, finalConclusion, drive5, drive20, rec5Assignee, rec20Assignee },
      {
        noteParts: notePartsFromRow(ev), initial_conclusion: ev.initial_conclusion, batch: ev.batch, drive_link: ev.drive_link,
        game_alike: ev.game_alike, final_note: ev.final_note, final_conclusion: ev.final_conclusion,
        record_5min_drive: ev.record_5min_drive, record_20min_drive: ev.record_20min_drive,
        record_5min_assignee: ev.record_5min_assignee, record_20min_assignee: ev.record_20min_assignee,
      },
      { trendsTouched: trendsTouchedRef.current, stagedShots },
    )
    return fields.length > 0 ? fields : ['Other changes']
  }
  const pendingFields = needsSave ? currentUnsavedFields() : []

  useEffect(() => {
    if (!canEditAssignee) return
    fetch('/api/team/recorders').then(r => r.ok ? r.json() : []).then(setRecorders).catch(() => {})
  }, [canEditAssignee])

  const recOpts = [{ value: '', label: '—' }, ...recorders.map(r => ({ value: r, label: r }))]

  const toggleDeadLink = (checked: boolean) => {
    setDeadLink(checked)
    if (checked) setConclusion('Link_dead')
    else if (conclusion === 'Link_dead') setConclusion('')
    setDirty(true)
  }

  // Resolves true only when everything this click meant to persist is persisted (the
  // evaluation and any staged screenshots), so a caller can tell if it may move on.
  const save = async (): Promise<boolean> => {
    if (!ev || !canEdit) return false
    // Taken now, before any await: Prev/Next stay enabled while the screenshot flush
    // and tag PUT run, so by PATCH time the timer may belong to the next game.
    const snap = snapshot(viewRef.current, ev.game_id, Date.now())
    if (noteError) {
      showToast(noteError, true)
      return false
    }
    let saved = false
    setSaving(true)
    try {
      // Flush staged screenshots first so one Save persists both. Silent success —
      // the eval PATCH below shows the single "Saved" toast; the refetch picks up
      // the new screenshot URLs from the server. A failure here must survive that
      // toast: the card's own error message is about to be overwritten, and the
      // refetch renders server state with none of the staged shots in it, so
      // swallowing the result reports "Saved" over screenshots that never landed.
      const shotsOk = canEditEval && screenshotRef.current?.hasStaged()
        ? await screenshotRef.current.flush()
        : true
      shotsFailedRef.current = !shotsOk
      // Trends tags are their own resource (they stage for admin review, they are not
      // evaluation columns), so they save alongside the eval rather than inside it.
      // Only PUT what we actually loaded: the endpoint replaces the game's whole
      // pending set, so sending the empty state of a failed or still-in-flight
      // load would silently delete the evaluator's proposals.
      if (canEditGameAlike && trendTagsLoadedFor.current === ev.game_id) {
        const tagRes = await fetch('/api/playtest-tags', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ game_id: ev.game_id, tags: trendTags }),
        })
        if (!tagRes.ok) {
          const err = await tagRes.json().catch(() => ({}))
          showToast(err.error || 'Failed to save trend tags', true)
          setSaving(false)
          return false
        }
        // The pending set just changed; the cached copy is the pre-save one.
        trendTagsCacheRef.current.delete(ev.game_id)
      }
      const body: Record<string, unknown> = { id: ev.id }
      if (canEditEval) {
        // Always send these so an emptied field clears the column (see PATCH handler).
        body.initial_note_parts = noteParts
        body.drive_link = driveLink
        // Initial Conclusion (+ batch) freezes once a final conclusion exists.
        if (canEditInitialConc) {
          body.initial_conclusion = conclusion
          // Batch only applies to List_Idea games. Managers pick freely; evaluators
          // are forced into the team's current batch (set by a manager).
          if (conclusion === 'List_Idea') {
            const effBatch = isManager ? batch : (ev.current_batch || '')
            if (effBatch && effBatch !== (ev.batch || '')) body.batch = effBatch
          }
        }
      }
      // Game Alike: evaluator or manager, never frozen by a stage lock.
      if (canEditGameAlike) body.game_alike = gameAlike
      if (canEditFinalNote) body.final_note = finalNote
      if (canEditFinalConc && finalConclusion !== (ev.final_conclusion || '')) body.final_conclusion = finalConclusion
      if (canEdit5 && drive5 && drive5 !== ev.record_5min_drive) body.record_5min_drive = drive5
      if (canEdit20 && drive20 && drive20 !== ev.record_20min_drive) body.record_20min_drive = drive20
      if (canEditAssignee && rec5Assignee && rec5Assignee !== (ev.record_5min_assignee || '')) body.record_5min_assignee = rec5Assignee
      if (canEditAssignee && rec20Assignee && rec20Assignee !== (ev.record_20min_assignee || '')) body.record_20min_assignee = rec20Assignee
      if (snap) Object.assign(body, { view_s: snap.view_s, hidden_s: snap.hidden_s, idle_s: snap.idle_s, context: logContext })
      const res = await fetch('/api/evaluations', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const err = await res.json()
        showToast(err.error || 'Failed', true)
      } else {
        // The evaluation itself is saved either way; only the wording changes, so
        // a screenshot outage can never make an evaluator think their note was lost.
        if (shotsOk) showToast('Saved')
        else showToast('Evaluation saved — screenshots failed to upload', true)
        saved = shotsOk
        trendsTouchedRef.current = false
        if (snap) viewRef.current = restartAfterSave(viewRef.current, snap, document.hidden)
        const fresh = await fetchEvalByGameId(ev.game_id, category)
        if (fresh) {
          cacheRef.current.set(ev.game_id, fresh)
          // The user may have pressed Next while this save was in flight; painting the
          // saved game now would put its data under the new game's id.
          if (currentGameIdRef.current === ev.game_id) applyData(fresh)
          // Old game still on screen and already saved: clear dirty so auto-save does not fire again.
          else if (shownGameRef.current === ev.game_id) setDirty(false)
          onSaved?.(fresh)
        }
      }
    } catch { showToast('Network error', true) }
    setSaving(false)
    return saved
  }

  // Reset (recording → draft): un-confirm so a manager can pick a different
  // recorder. Only offered on the bucket the game is in, while confirmed and not
  // yet recorded (no YouTube): the route resets that bucket's Confirm.
  const resetRecordConfirm = async () => {
    if (!ev) return
    try {
      const res = await fetch('/api/evaluations/confirm-records', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [ev.id], unset: true }),
      })
      if (!res.ok) { showToast('Failed to reset', true); return }
      const fresh = await fetchEvalByGameId(ev.game_id, category)
      if (fresh) {
        cacheRef.current.set(ev.game_id, fresh)
        if (currentGameIdRef.current === ev.game_id) applyData(fresh)
        onSaved?.(fresh)
      }
    } catch { showToast('Network error', true) }
  }

  // Auto-save: when enabled, persist edits ~1.5s after the user stops changing
  // fields. A ref keeps the effect pointed at the latest save() closure without
  // re-arming the timer on every render. Switching games / unmounting clears the
  // pending timer (applyData resets dirty=false, so a stale save can't fire).
  const saveRef = useRef(save)
  saveRef.current = save

  // Expose this panel's unsaved state to the global deploy-reload guard so a
  // version refresh (and a browser close/refresh) flushes — never silently drops —
  // in-progress edits. Registered once; reads live state through refs.
  const needsSaveRef = useRef(false)
  needsSaveRef.current = canEdit && needsSave
  useEffect(() => registerUnsavedGuard({
    isDirty: () => needsSaveRef.current,
    flush: () => saveRef.current(),
    // A click on the backdrop closes the panel from outside; it asks through here.
    requestLeave: proceed => requestLeaveRef.current('close', proceed),
  }), [])

  // What leaving does with unsaved edits (see lib/leave-decision.ts). With auto-save on
  // the edit is saved first, because moving off the game clears the 1.5s timer and would
  // lose it; with auto-save off the user is asked.
  requestLeaveRef.current = (action, proceed) => {
    const decision = leaveDecision({ dirty: canEdit && needsSave, autoSave, saving })
    if (decision === 'go' || !ev) { proceed(); return }
    if (decision === 'save-then-go') { void saveRef.current().then(ok => { if (ok) proceed() }); return }
    setLeave({ action, proceed, fields: currentUnsavedFields() })
  }

  const leaveSave = async () => {
    if (!leave) return
    const pending = leave
    setLeaveSaving(true)
    const ok = await saveRef.current()
    setLeaveSaving(false)
    setLeave(null)
    // Not saved (validation, network): stay on the game; save() already toasted why.
    if (ok) pending.proceed()
  }
  const leaveDiscard = () => {
    const pending = leave
    setLeave(null)
    pending?.proceed()
  }

  // Declared before the auto-save effect so a changed staging set clears the latch
  // in the same commit, letting the next edit try the upload again.
  useEffect(() => { shotsFailedRef.current = false }, [stagedShots])

  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!autoSave || !needsSave || saving || !canEdit || noteTooShort) return
    if (shotsFailedRef.current) return
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current)
    autoSaveTimer.current = setTimeout(() => { saveRef.current() }, 1500)
    return () => { if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSave, needsSave, saving, canEdit, noteTooShort, currentGameId, noteParts, conclusion, driveLink, deadLink, batch, finalNote, finalConclusion, drive5, drive20, rec5Assignee, rec20Assignee, stagedShots, trendTags])

  const clearField = (f: 'conclusion' | 'drive') => {
    if (!canEditEval) return
    if (f === 'conclusion') { setConclusion(''); setDeadLink(false) }
    else if (f === 'drive') setDriveLink('')
    setDirty(true)
  }

  const clearAll = () => {
    if (!canEditInitialConc) return
    if (!confirmClearAll) {
      setConfirmClearAll(true)
      setTimeout(() => setConfirmClearAll(false), 3000)
      return
    }
    setNoteParts(EMPTY_NOTE_PARTS); setConclusion(''); setDeadLink(false); setDriveLink(''); setBatch('')
    setDirty(true); setConfirmClearAll(false)
  }

  if (loading && !ev) return <div style={{ padding: 40, textAlign: 'center', color: 'var(--faint)' }}>Loading…</div>
  if (!ev) return <div style={{ padding: 40, textAlign: 'center', color: 'var(--faint)' }}>Not found</div>

  const screenshots = ev.screenshot_urls || []
  const manualShots = ev.manual_screenshot_urls || []
  // Manual uploads: admin or the assigned evaluator (matches the API rule).
  const canEditShots = !readOnly && (isManager || ev.initial_evaluator === userName)
  const cats = ev.categories || []

  return (
    <>
      {/* Marker: when present, the parent .eval-modal-container expands to fill the
          viewport via a :has() rule in globals.css (no prop plumbing needed). */}
      {fullscreen && <div className="eval-fs-on" hidden />}
      {/* Top bar: game navigation on the left, state and window controls on the
          right, the close X last (where every other dialog has it). */}
      <div className="eval-topbar">
        {hasNav && (
          <>
            <button className="btn btn-sm" onClick={goPrev} title="Previous (←)" aria-label="Previous game">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M15 18l-6-6 6-6" />
              </svg>
            </button>
            <div style={{ width: 240, flexShrink: 0 }}>
              <StyledSelect
                value={currentGameId}
                onChange={v => requestLeaveRef.current('jump', () => goTo(v))}
                options={gameList.map(g => ({ value: g.game_id, label: g.title }))}
                ariaLabel="Go to game"
              />
            </div>
            <button className="btn btn-sm" onClick={goNext} title="Next (→)" aria-label="Next game">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M9 18l6-6-6-6" />
              </svg>
            </button>
            <span style={{ fontSize: 11, color: 'var(--faint)', whiteSpace: 'nowrap' }}>{currentIdx + 1} / {gameList.length}</span>
          </>
        )}

        <div style={{ flex: 1 }} />
        {ev.initial_conclusion && (
          <span className={`badge ${conclusionBadgeClass(ev.initial_conclusion)}`}>
            {prettyConclusion(ev.initial_conclusion)}
          </span>
        )}
        {canEdit && (
          <Switch checked={autoSave} onChange={setAutoSave} label="Auto-save" title="Auto-save changes as you edit" />
        )}
        <button className="btn btn-sm btn-ghost" onClick={() => setFullscreen(v => !v)}
          title={fullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen'} aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}>
          {fullscreen ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M8 3v4a1 1 0 0 1-1 1H3M21 8h-4a1 1 0 0 1-1-1V3M3 16h4a1 1 0 0 1 1 1v4M16 21v-4a1 1 0 0 1 1-1h4" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3" />
            </svg>
          )}
        </button>
        {onClose && <CloseButton onClick={() => requestLeaveRef.current('close', onClose)} />}
      </div>

      {/* Progress Tracker */}
      <ProgressTracker ev={ev} yt5={yt5} yt20={yt20} uploadedAt={ytUploadedAt} />

      {/* Main layout: 2 columns */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 460px', gap: 16, alignItems: 'stretch' }}>
        {/* Left column — normal flow so the grid row is max(own content, right
            column). Right column tall → the Description card fills the leftover
            height and scrolls inside; right column short → the row grows so the
            full Description is always shown (never clipped). */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
          {/* Game card */}
          <div className="card" style={{ margin: 0 }}>
            <div className="card-head">
              <span className="card-label">Game Info</span>
            </div>

            <div style={{ display: 'flex', gap: 16, marginBottom: 16 }}>
              {/* alignSelf: in this flex row the default `stretch` would stretch the icon
                  to the text column's height. */}
              <span style={{ alignSelf: 'flex-start' }}><GameIcon src={ev.icon_url} os={ev.os} size={56} /></span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 4, lineHeight: 1.3, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  {ev.app_link ? (
                    <a href={ev.app_link} target="_blank" rel="noopener"
                      style={{ color: 'var(--accent)', textDecoration: 'none', display: 'inline' }}>
                      {ev.title}
                      {' '}
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
                        strokeLinecap="round" strokeLinejoin="round" style={{ display: 'inline-block', verticalAlign: 'middle', opacity: 0.7, marginLeft: 4 }}>
                        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3" />
                      </svg>
                    </a>
                  ) : ev.title}
                  <TitleCopyButton title={ev.title} />
                </div>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 5, display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                  <span style={{ wordBreak: 'break-all' }}>{ev.game_id}</span>
                  <TitleCopyButton title={ev.game_id} label="game ID" />
                </div>
                {ev.subtitle && <div style={{ fontSize: 12, color: 'var(--faint)', marginBottom: 5 }}>{ev.subtitle}</div>}
                <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                  {/* Labels, not chips anyone can click: .badge (see C3). */}
                  <span className="badge neutral">{ev.os?.toUpperCase()}</span>
                  {cats.map((c, i) => (
                    <span key={i} className="badge info">{c}</span>
                  ))}
                  {ev.content_rating && <span className="badge neutral">{ev.content_rating}</span>}
                </div>
              </div>
            </div>

            {/* Info grid with QR */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: '10px 10px' }}>
              <InfoField label="Publisher" value={ev.publisher_name} copyValue={ev.publisher_name || ''} />
              <InfoField label="Assigned" value={fmtDateVN(ev.assigned_date)} />
              {ev.app_link ? (
                <div 
                  onClick={() => qrDataUrl && setExpandedImg(qrDataUrl)}
                  title="Click to zoom QR Code"
                  style={{
                    gridRow: 'span 3',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: 'var(--surface-2)',
                    padding: '14px',
                    borderRadius: 12,
                    border: '1.5px dashed var(--border-strong)',
                    marginLeft: 10,
                    cursor: 'pointer',
                    transition: 'all 0.2s'
                  }}>
                  {qrDataUrl ? (
                    <img src={qrDataUrl} alt="QR Link" width={140} height={140} style={{ borderRadius: 8 }} />
                  ) : (
                    <div style={{ width: 140, height: 140, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <span className="spin" style={{ display: 'inline-block', width: 16, height: 16 }}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--faint)" strokeWidth="2">
                          <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                        </svg>
                      </span>
                    </div>
                  )}
                  <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', marginTop: 8, textTransform: 'uppercase', letterSpacing: '0.5px', whiteSpace: 'nowrap' }}>
                    Scan to download
                  </span>
                </div>
              ) : <div />}
              <InfoField label="Release Date" value={fmtDateVN(ev.release_date)} copyValue={ev.release_date ? fmtDateVN(ev.release_date) : ''} />
              <InfoField label="Initial Evaluated" value={ev.evaluate_date ? `${fmtDateTimeVN(ev.evaluate_date)}${ev.initial_evaluator ? ` · ${ev.initial_evaluator}` : ''}` : '—'} />
              <InfoField label="Genre" value={[ev.genre_1, ev.genre_2].filter(Boolean).join(' / ') || '—'} />
              <InfoField label="Final Evaluated" value={ev.final_conclusion_date ? `${fmtDateTimeVN(ev.final_conclusion_date)}${ev.final_evaluator ? ` · ${ev.final_evaluator}` : ''}` : '—'} />
            </div>

          </div>

          {/* StoreKit screenshots */}
          {screenshots.length > 0 && (
            <div className="card" style={{ margin: 0 }}>
              <div className="card-head">
                <span className="card-label">StoreKit ({screenshots.length})</span>
                <button className="btn btn-sm btn-ghost" onClick={() => setExpandedImg(screenshots[0])}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
                  </svg>
                  Expand
                </button>
              </div>
              <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 4 }}>
                {screenshots.map((url, i) => (
                  <img key={i} src={url} alt={`Screenshot ${i + 1}`}
                    onClick={() => setExpandedImg(url)}
                    className="screenshot-item"
                    style={{ height: 220, borderRadius: 10, flexShrink: 0, border: '1px solid var(--border)', cursor: 'pointer' }}
                    loading="lazy"
                    onError={e => { e.currentTarget.style.display = 'none' }} />
                ))}
              </div>
            </div>
          )}

          {/* Manual screenshots — only when StoreKit hasn't arrived */}
          {screenshots.length === 0 && (
            <ManualScreenshotsCard
              key={ev.game_id}
              ref={screenshotRef}
              gameId={ev.game_id}
              urls={manualShots}
              canEdit={canEditShots}
              onChange={updateManualShots}
              onExpand={setExpandedImg}
              onToast={showToast}
              deferSave={canEditEval}
              onStagedChange={setStagedShots}
            />
          )}

          {/* Description */}
          {ev.description && (
            <div className="card" style={{ margin: 0, flex: '1 1 auto', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
              <div className="card-head">
                <span className="card-label">Description</span>
              </div>
              <div
                style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--muted)', flex: 1, minHeight: 0, overflowY: 'auto' }}
                dangerouslySetInnerHTML={{ __html: ev.description }}
              />
            </div>
          )}
        </div>

        {/* Right: Evaluation form */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="card" style={{ margin: 0 }}>
            <div className="card-head">
              <span className="card-label">Initial Evaluation</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginLeft: 'auto' }}>
                {canEditInitialConc && (
                  // Two clicks: the first arms it (red, for 3s), the second clears.
                  <button type="button" onClick={clearAll}
                    title="Clear all evaluation fields"
                    className={`btn btn-sm ${confirmClearAll ? 'btn-danger' : 'btn-ghost'}`}>
                    {confirmClearAll ? 'Clear all?' : 'Clear all'}
                  </button>
                )}
                {canEdit && <SaveStatus dirty={needsSave} />}
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div className="field">
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <span className="label">Initial Conclusion</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    {canEditInitialConc && conclusion && !deadLink && <ClearBtn onClick={() => clearField('conclusion')} />}
                    {canEditInitialConc && (
                      <Switch checked={deadLink} onChange={toggleDeadLink} label="Dead link" title="Mark the store link as invalid" />
                    )}
                  </div>
                </div>
                <StyledSelect
                  value={conclusion}
                  onChange={v => {
                    setConclusion(v)
                    setDeadLink(v === 'Link_dead')
                    // List_Idea auto-fills the batch with the team's current batch
                    // (managers can still change it; evaluators see it forced below).
                    if (v === 'List_Idea' && isManager && !batch) setBatch(ev.current_batch || '')
                    setDirty(true)
                  }}
                  placeholder="Select a conclusion…"
                  options={(() => {
                    const opts = [...INITIAL_CONCLUSION_OPTIONS]
                    if (conclusion && conclusion !== 'Link_dead' && !opts.includes(conclusion)) opts.unshift(conclusion)
                    return opts.map(c => ({ value: c, label: prettyConclusion(c) }))
                  })()}
                  disabled={!canEditInitialConc || deadLink}
                />
              </div>

              {/* Batch picker — only for List_Idea games, to bucket them into a
                  weekly batch for the Short List. Managers pick freely; evaluators
                  are forced into the team's current batch (set by a manager). */}
              {conclusion === 'List_Idea' && (
                <div className="field">
                  <span className="label">Batch (week)</span>
                  {isManager ? (
                    <BatchPicker
                      value={batch}
                      onChange={v => { setBatch(v); setDirty(true) }}
                      placeholder="Select a batch…"
                      batches={(() => {
                        const now = new Date()
                        const opts = weekBatches(now.getFullYear(), now.getMonth() + 1)
                        const cur = ev.current_batch
                        const merged = [...opts]
                        if (cur && !merged.includes(cur)) merged.unshift(cur)
                        if (batch && !merged.includes(batch)) merged.unshift(batch)
                        return merged
                      })()}
                      current={ev.current_batch || null}
                      // The "— none —" choice the old dropdown had: '' clears the batch.
                      allowAll allLabel="No batch" allowMonth={false}
                      ariaLabel="Batch" width="100%"
                      disabled={!canEditInitialConc}
                    />
                  ) : ev.current_batch ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: 'var(--accent-weak)', border: '1px solid var(--accent-border)', borderRadius: 8 }}>
                      <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--accent)' }}>{ev.current_batch}</span>
                      <span style={{ fontSize: 11, color: 'var(--muted)' }}>· current batch (auto-assigned)</span>
                    </div>
                  ) : (
                    <div style={{ fontSize: 12, color: 'var(--warn)', padding: '8px 12px', background: 'var(--warn-weak)', borderRadius: 8 }}>
                      No active batch — ask a manager to set the current batch.
                    </div>
                  )}
                </div>
              )}

              {/* Initial note, in four parts (see NoteParts in lib/eval-rules). */}
              <NoteBox label="Self Note" rows={2}
                hint={conclusion === 'List_Idea' ? 'optional' : 'required'}
                value={noteParts.self_note} onChange={v => { setNotePart('self_note', v); setDirty(true) }}
                placeholder="Why this conclusion, what stood out"
                disabled={!canEditEval} warn={missingParts.includes('self_note')}
                error={missingParts.includes('self_note')
                  ? `At least ${NOTE_MIN_LEN} characters (${noteParts.self_note.trim().length}/${NOTE_MIN_LEN})`
                  : undefined} />
              {/* Gameplay brief — List_Idea only. Hidden for other conclusions but
                  never cleared, so switching away and back loses nothing. */}
              {conclusion === 'List_Idea' && (() => {
                const why = (k: keyof NoteParts, minLen?: number) => {
                  if (!missingParts.includes(k)) return undefined
                  const n = noteParts[k].trim().length
                  return minLen && n > 0 ? `At least ${minLen} characters (${n}/${minLen})` : 'Required'
                }
                return (
                  <div className="field">
                    <span className="label">Gameplay brief</span>
                    <div className={`note-brief${canEditEval ? '' : ' disabled'}`}>
                      <BriefRow label="Gameplay" minRows={2} disabled={!canEditEval}
                        value={noteParts.gameplay} onChange={v => { setNotePart('gameplay', v); setDirty(true) }}
                        placeholder="Control + how objects react, e.g. tap to shoot, blocks drop into the queue"
                        missing={why('gameplay', NOTE_MIN_LEN)} />
                      <BriefRow label="The game is over when…" minRows={1} disabled={!canEditEval}
                        value={noteParts.game_over} onChange={v => { setNotePart('game_over', v); setDirty(true) }}
                        placeholder="something runs out of space or moves" missing={why('game_over')} />
                      <BriefRow label="The level is complete when…" minRows={1} disabled={!canEditEval}
                        value={noteParts.level_complete} onChange={v => { setNotePart('level_complete', v); setDirty(true) }}
                        placeholder="something is cleared" missing={why('level_complete')} />
                    </div>
                  </div>
                )
              })()}

              <div style={{ borderTop: '1px solid var(--border)' }} />

              <div className="field">
                <span className="label">Game Alike</span>
                <GameAlikeField value={gameAlike} onChange={g => { setGameAlike(g); setDirty(true) }} disabled={!canEditGameAlike} />
              </div>

              <div className="field">
                <span className="label">Trends Tags</span>
                <TrendTagsField
                  gameId={currentGameId}
                  value={trendTags}
                  existing={existingTrends}
                  options={trendOptions}
                  categoryGroups={trendCategoryGroups}
                  categoryGroup={ev?.category_group}
                  subValues={trendSubValues}
                  onChange={next => { setTrendTags(next); trendsTouchedRef.current = true; setDirty(true) }}
                  disabled={!canEditGameAlike}
                  optionsError={trendOptionsError}
                  onRetryOptions={loadTrendOptions}
                  loadError={trendTagsError}
                  onRetryLoad={() => loadTrendTags(currentGameId, true)}
                  review={pendingReview}
                  canReview={isManager}
                  onReviewed={onTagReviewed}
                  onExistingChanged={onExistingChanged}
                />
              </div>

              <div className="field">
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span className="label">Demo Video (Drive)</span>
                  {canEditEval && driveLink && <ClearBtn onClick={() => clearField('drive')} />}
                </div>
                <input
                  className="input"
                  type="url"
                  value={driveLink}
                  onChange={e => { setDriveLink(e.target.value); setDirty(true) }}
                  placeholder="https://drive.google.com/..."
                  disabled={!canEditEval}
                />
                {ev.drive_link && (
                  <a href={ev.drive_link} target="_blank" rel="noopener"
                    style={{ fontSize: 12, color: 'var(--accent)', wordBreak: 'break-all' }}>
                    Open demo video
                  </a>
                )}
              </div>

            </div>
          </div>

          {/* Final Conclusion — only surfaced in the Short List (triage); hidden
              in the Evaluate panel and other views. Editable by admins only:
              moderators triage everything else but do not write the last word on
              a game. Read-only for everyone else. */}
          {showFinalConclusion && (
          <div className="card" style={{ margin: 0 }}>
              <div className="card-head">
                <span className="card-label">Final Conclusion</span>
                {canEditFinalNote ? (
                  <SaveStatus dirty={needsSave} />
                ) : (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--faint)' }}>
                    <LockIcon /> Admin only
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div className="field">
                  <span className="label">Final Conclusion</span>
                  <StyledSelect
                    value={finalConclusion}
                    onChange={v => { setFinalConclusion(v); setDirty(true) }}
                    placeholder="Select a final conclusion…"
                    options={(() => {
                      const opts = [...finalConclusionOptions]
                      if (finalConclusion && !opts.includes(finalConclusion)) opts.unshift(finalConclusion)
                      return [{ value: '', label: '— Not set —' }, ...opts.map(c => ({ value: c, label: c }))]
                    })()}
                    disabled={!canEditFinalConc}
                  />
                </div>

                <div className="field">
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span className="label">Final Note</span>
                    {canEditFinalNote && finalNote && <ClearBtn onClick={() => { setFinalNote(''); setDirty(true) }} />}
                  </div>
                  <textarea
                    className="input"
                    rows={3}
                    value={finalNote}
                    onChange={e => { setFinalNote(e.target.value); setDirty(true) }}
                    placeholder={canEditFinalNote ? 'Final note (admin only)…' : 'Final note (admin only)'}
                    disabled={!canEditFinalNote}
                    style={{ resize: 'vertical', fontSize: 13 }}
                  />
                </div>

              </div>
          </div>
          )}

          {/* Record Video — 5 min */}
          {!hideRecordSections && (ev.record_5min_assignee || canEditAssignee || stored5) && (
            <div className="card" style={{ margin: 0 }}>
              <div className="card-head">
                <span className="card-label">Record 5 min</span>
                <RecordBadge status={recordStatusOf(yt5, ev.record_5min_assignee, confirmed5)} youtubeId={yt5} />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                  {canEditAssignee && !confirmed5 ? (
                    <div className="field">
                      <span className="label">Assignee</span>
                      <StyledSelect value={rec5Assignee}
                        onChange={v => { setRec5Assignee(v); setDirty(true) }}
                        placeholder="—" options={recOpts} />
                    </div>
                  ) : (
                    <InfoField label="Assignee" value={ev.record_5min_assignee} icon={confirmed5 && ev.record_5min_assignee ? <LockIcon /> : undefined} />
                  )}
                  <InfoField label="Assigned" value={fmtDateVN(ev.record_5min_date)} />
                </div>
                {canEditAssignee && confirmed5 && !yt5 && ownBucket === '5min' && (
                  <button className="btn btn-sm btn-ghost" onClick={resetRecordConfirm}
                    style={{ alignSelf: 'flex-start' }}>
                    ↺ Reset — un-confirm to reassign
                  </button>
                )}
                {rec5Assignee && <FileNameField name={recFileName(ev.title, rec5Assignee, 5)} />}
                <div className="field" style={{ paddingTop: 8, borderTop: '1px solid var(--border)' }}>
                  <span className="label">YouTube Link</span>
                  {yt5
                    ? <a className="yt-link" href={`https://www.youtube.com/watch?v=${yt5}`} target="_blank" rel="noopener noreferrer" style={{ fontSize: 13, color: 'var(--accent)' }}>▶ youtu.be/{yt5}</a>
                    : <span style={{ fontSize: 13, color: 'var(--faint)' }}>Not uploaded yet</span>}
                </div>
              </div>
            </div>
          )}

          {/* Record Video — 20 min */}
          {!hideRecordSections && (ev.record_20min_assignee || canEditAssignee || stored20) && (
            <div className="card" style={{ margin: 0 }}>
              <div className="card-head">
                <span className="card-label">Record 20 min</span>
                <RecordBadge status={recordStatusOf(yt20, ev.record_20min_assignee, confirmed20)} youtubeId={yt20} />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                  {canEditAssignee && !confirmed20 ? (
                    <div className="field">
                      <span className="label">Assignee</span>
                      <StyledSelect value={rec20Assignee}
                        onChange={v => { setRec20Assignee(v); setDirty(true) }}
                        placeholder="—" options={recOpts} />
                    </div>
                  ) : (
                    <InfoField label="Assignee" value={ev.record_20min_assignee} icon={confirmed20 && ev.record_20min_assignee ? <LockIcon /> : undefined} />
                  )}
                  <InfoField label="Assigned" value={fmtDateVN(ev.record_20min_date)} />
                </div>
                {canEditAssignee && confirmed20 && !yt20 && ownBucket === '20min' && (
                  <button className="btn btn-sm btn-ghost" onClick={resetRecordConfirm}
                    style={{ alignSelf: 'flex-start' }}>
                    ↺ Reset — un-confirm to reassign
                  </button>
                )}
                {rec20Assignee && <FileNameField name={recFileName(ev.title, rec20Assignee, 20)} />}
                <div className="field" style={{ paddingTop: 8, borderTop: '1px solid var(--border)' }}>
                  <span className="label">YouTube Link</span>
                  {yt20
                    ? <a className="yt-link" href={`https://www.youtube.com/watch?v=${yt20}`} target="_blank" rel="noopener noreferrer" style={{ fontSize: 13, color: 'var(--accent)' }}>▶ youtu.be/{yt20}</a>
                    : <span style={{ fontSize: 13, color: 'var(--faint)' }}>Not uploaded yet</span>}
                </div>
              </div>
            </div>
          )}

          {/* One Save for the whole panel. There used to be a button in each card
              (initial evaluation, final conclusion, record), but all of them ran the
              same save() and wrote every changed field, so an admin on Short List or a
              manager on Evaluate saw two buttons that did one thing. It sits below the
              last card, not pinned. The note rule still blocks it. */}
          {showSaveBar && (
            <div className="eval-savebar">
              <span className="eval-savebar-note" aria-live="polite">
                {saving ? '' : noteTooShort && needsSave ? (noteError ?? '')
                  : needsSave ? `Unsaved: ${pendingFields.join(', ')}`
                  : autoSave ? 'Auto-save is on' : 'All changes saved'}
              </span>
              <button className={`btn ${needsSave ? 'btn-primary' : ''}`} onClick={save} disabled={saving || !needsSave || noteTooShort}>
                {saving ? 'Saving…' : needsSave ? (autoSave ? 'Save now' : 'Save') : 'Saved'}
              </button>
            </div>
          )}

          {/* Timestamps */}
          <div className="card" style={{ margin: 0, opacity: 0.7 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--faint)' }}>
                <span>Imported</span><span>{fmtDateTimeVN(ev.imported_at)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--faint)' }}>
                <span>Updated</span>
                <span>{fmtDateTimeVN(ev.updated_at)}{ev.updated_by ? ` · by ${ev.updated_by}` : ''}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11, color: 'var(--faint)' }}>
                <span>History</span>
                <button className="btn btn-sm btn-link" onClick={() => openHistory(ev.game_id)}>
                  View
                </button>
              </div>
            </div>
          </div>

          {/* Bottom nav */}
          {hasNav && (
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-sm" onClick={goPrev} style={{ flex: 1, justifyContent: 'center' }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M15 18l-6-6 6-6" />
                </svg>
                Prev
              </button>
              <button className="btn btn-sm btn-primary" onClick={goNext} style={{ flex: 1, justifyContent: 'center' }}>
                Next
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 18l6-6-6-6" />
                </svg>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Screenshot overlay */}
      <Lightbox
        url={expandedImg}
        onClose={() => setExpandedImg(null)}
        images={screenshots.length > 0 ? screenshots : manualShots}
      />

      {history && ev && history.gameId === ev.game_id && (
        <EvalHistoryModal events={history.events} logReady={history.logReady} error={history.error}
          onClose={() => setHistory(null)} onRetry={() => openHistory(history.gameId)} />
      )}

      {leave && ev && (
        <UnsavedChangesDialog action={leave.action} fields={leave.fields} saving={leaveSaving}
          saveBlockedReason={noteTooShort ? noteError : null}
          onSave={leaveSave} onDiscard={leaveDiscard} onStay={() => setLeave(null)} />
      )}

    </>
  )
}
