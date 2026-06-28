'use client'
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { StyledSelect } from '@/components/StyledSelect'
import ManualScreenshotsCard, { type ManualScreenshotsHandle } from '@/components/ManualScreenshotsCard'
import { registerUnsavedGuard } from '@/lib/unsaved-guard'
import { buildYtMap, ytLookup } from '@/lib/ytb-match'
import { GameAlikeField } from '@/components/GameAlikeField'
import type { GameAlikeGame } from '@/components/weekly-feedback/types'
import QRCode from 'qrcode'

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
  drive_link: string | null
  drive_date: string | null
  youtube_link: string | null
  imported_at: string
  updated_at: string
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

// The Initial Conclusion an evaluator picks is just two outcomes: Bypass (drop) or
// List_Idea (keep → buckets into a weekly batch). Link_dead is set via the dead-link
// toggle, not this dropdown. Legacy sheet values still display (merged in below).
const INITIAL_CONCLUSION_OPTIONS = ['Bypass', 'List_Idea']

const CONCLUSION_COLORS: Record<string, string> = {
  'Bypass': 'error', 'M_ByPass': 'error', 'Skip': 'error', 'Link_dead': 'error',
  'Good': 'success', 'Conclusion': 'success',
  'List_Idea': 'success', 'Priority I': 'success', 'Priority II': 'success',
  'Priority III: Watchlist for next phase': 'running',
  'Priority IV: Idea': 'running', 'Watchlist for next milestone': 'running',
  'Need deeper testing': 'running', 'Wait for PlayTest': 'running',
  'Check Market Data': 'running', 'Need Direction': 'running',
}

function fmtDate(d: string | null) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: '2-digit' })
}

const MONTH_ABBR = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// Weekly batch labels for a month, e.g. weekBatches(2026, 6) →
// ['W1 Jun, 2026', 'W2 Jun, 2026', 'W3 Jun, 2026', 'W4 Jun, 2026'].
// month is 1-12. Matches column A of the IDEA_LIST sheet.
export function weekBatches(year: number, month: number): string[] {
  const m = MONTH_ABBR[month] || ''
  return [1, 2, 3, 4].map(w => `W${w} ${m}, ${year}`)
}

function fmtDateTime(d: string | null) {
  if (!d) return '—'
  return new Date(d).toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export async function fetchEvalByGameId(gameId: string): Promise<EvalDetail | null> {
  try {
    const res = await fetch(`/api/evaluations/${encodeURIComponent(gameId)}`)
    if (!res.ok) return null
    const json = await res.json()
    return json.data as EvalDetail
  } catch { return null }
}

function InfoField({ label, value, copyValue }: { label: string; value: string | null | undefined; copyValue?: string }) {
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
        <span>{value || '—'}</span>
        {copyValue && (
          <button onClick={copy} title={`Copy ${label}`}
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px', color: copied ? 'var(--good)' : 'var(--faint)', display: 'flex', alignItems: 'center', flexShrink: 0 }}>
            {copied ? '✓' : (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            )}
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
      <span className="label">File Name</span>
      <div style={{ display: 'flex', gap: 6 }}>
        <input className="input" readOnly value={name}
          style={{ flex: 1, minWidth: 0, fontSize: 12, fontFamily: 'var(--num)' }} />
        <button className="btn btn-sm" onClick={copy} title="Copy file name"
          style={{ flexShrink: 0, minWidth: 38, justifyContent: 'center' }}>
          {copied ? '✓' : (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          )}
        </button>
      </div>
    </div>
  )
}

function TitleCopyButton({ title }: { title: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(title)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* ignore */ }
  }
  return (
    <button onClick={copy} title="Copy title"
      style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px', color: copied ? 'var(--good)' : 'var(--faint)', display: 'flex', alignItems: 'center', flexShrink: 0 }}>
      {copied ? '✓' : (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </button>
  )
}

// Persistent save-state badge so it's always clear whether the form matches
// what's stored. Orange dot = pending edits; green check = in sync with server.
function ClearBtn({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} title="Clear this field"
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 3, background: 'none', border: 'none',
        cursor: 'pointer', fontSize: 11, fontWeight: 600, color: 'var(--faint)', padding: '0 2px',
      }}>
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M18 6L6 18M6 6l12 12" />
      </svg>
      Clear
    </button>
  )
}

function SaveStatus({ dirty }: { dirty: boolean }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 999,
      color: dirty ? 'var(--warn)' : 'var(--good)',
      background: dirty ? 'var(--warn-weak)' : 'var(--good-weak)',
      border: `1px solid ${dirty ? 'var(--warn)' : 'var(--good)'}`,
    }}>
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

function ProgressTracker({ ev, yt5, yt20 }: { ev: EvalDetail; yt5?: string; yt20?: string }) {
  const recAssignees = Array.from(new Set([ev.record_5min_assignee, ev.record_20min_assignee].filter(Boolean)))
  // "Video Uploaded" tracks the 5/20-min report videos, which are now always
  // YouTube uploads (the demo drive link, ev.drive_link, belongs to the
  // evaluation step). Completed when a matching YouTube upload exists.
  const ytId = yt5 || yt20
  const steps: {
    label: string; completed: boolean; date?: string | null; assignee?: string | null; sub?: string | null; href?: string | null
  }[] = [
    { label: 'Assigned Playtest', completed: !!ev.initial_evaluator, date: ev.assigned_date, assignee: ev.initial_evaluator },
    { label: 'Evaluated', completed: !!ev.evaluate_date, date: ev.evaluate_date },
    { label: 'Final Conclusion', completed: !!ev.final_conclusion, sub: ev.final_conclusion },
    { label: 'Assigned Record Video', completed: recAssignees.length > 0, date: ev.record_5min_date || ev.record_20min_date, assignee: recAssignees.join(', ') || null },
    { label: 'Video Uploaded', completed: !!ytId, href: ytId ? `https://www.youtube.com/watch?v=${ytId}` : null }
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
                  <span style={{ fontSize: 11, fontWeight: 600, color: isCompleted ? 'var(--text)' : 'var(--muted)', marginTop: 1 }}>
                    👤 {step.assignee}
                  </span>
                )}
                {step.sub && (
                  <span style={{ fontSize: 11, fontWeight: 600, color: isCompleted ? 'var(--text)' : 'var(--muted)', marginTop: 1 }}>
                    {step.sub}
                  </span>
                )}
                {step.date && (
                  <span style={{ fontSize: 10, color: 'var(--faint)', marginTop: step.assignee || step.sub ? 1 : 2 }}>
                    {fmtDate(step.date)}
                  </span>
                )}
              </div>
            </div>

            {/* Connecting line */}
            {idx < steps.length - 1 && (
              <div style={{
                flex: 1,
                height: 2,
                background: isCompleted && steps[idx + 1].completed ? 'var(--good)' : isCompleted ? 'var(--accent-border)' : 'var(--track)',
                margin: '0 12px',
                minWidth: 16
              }} />
            )}
          </div>
        )
      })}
    </div>
  )
}

interface Props {
  initialGameId: string
  gameList: EvalListItem[]
  role: string | undefined
  userName: string
  readOnly?: boolean
  canAssignRecords?: boolean
  hideRecordSections?: boolean
  onNavigate?: (gameId: string) => void
  onSaved?: (ev: EvalDetail) => void
  onClose?: () => void
}

// Fetches the `ytb_uploaded` sheet once and builds the duration-aware
// title→youtubeId map (shared logic with the Record grid). The Record cards and
// the "Video Uploaded" milestone derive "recorded" live from this.
function useYtbUploads(): Map<string, string> {
  const [map, setMap] = useState<Map<string, string>>(new Map())
  useEffect(() => {
    fetch('/api/sheets/ytb-uploaded', { cache: 'no-store' })
      .then(r => r.ok ? r.json() : [])
      .then((rows: Array<{ gameTitle: string; youtubeId: string; duration: string }>) => setMap(buildYtMap(rows)))
      .catch(() => {})
  }, [])
  return map
}

export default function EvalDetailPanel({ initialGameId, gameList, role, userName, readOnly, canAssignRecords, hideRecordSections, onNavigate, onSaved, onClose }: Props) {
  const ytMap = useYtbUploads()
  const [currentGameId, setCurrentGameId] = useState(initialGameId)
  const [ev, setEv] = useState<EvalDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState<{ msg: string; err?: boolean } | null>(null)

  const [note, setNote] = useState('')
  const [finalNote, setFinalNote] = useState('')
  const [gameAlike, setGameAlike] = useState<GameAlikeGame[]>([])
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

  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [expandedImg, setExpandedImg] = useState<string | null>(null)
  const [mounted, setMounted] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [autoSave, setAutoSave] = useState(false)
  const [confirmClearAll, setConfirmClearAll] = useState(false)

  useEffect(() => {
    setMounted(true)
    // Auto-save preference is remembered per browser/user.
    try { setAutoSave(localStorage.getItem('eval:autoSave') === '1') } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    try { localStorage.setItem('eval:autoSave', autoSave ? '1' : '0') } catch { /* ignore */ }
  }, [autoSave])

  const cacheRef = useRef<Map<string, EvalDetail>>(new Map())

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
    QRCode.toDataURL(appLink, {
      width: 200, margin: 2, color: { dark: '#1a1c22', light: '#ffffff' },
    }).then(url => {
      if (qrGenRef.current === gen) setQrDataUrl(url)
    }).catch(() => {
      if (qrGenRef.current === gen) setQrDataUrl(null)
    })
  }, [])

  const applyData = useCallback((data: EvalDetail) => {
    setEv(data)
    setNote(data.initial_note || '')
    setFinalNote(data.final_note || '')
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
    generateQR(data.app_link)
  }, [generateQR])

  const loadGame = useCallback(async (gameId: string) => {
    const cached = cacheRef.current.get(gameId)
    if (cached) {
      applyData(cached)
      setLoading(false)
    } else {
      setLoading(true)
    }
    const data = await fetchEvalByGameId(gameId)
    if (!data) return
    cacheRef.current.set(gameId, data)
    applyData(data)
    setLoading(false)
  }, [applyData])

  const goTo = useCallback((gameId: string) => {
    setCurrentGameId(gameId)
    onNavigate?.(gameId)
  }, [onNavigate])

  const goPrev = useCallback(() => {
    if (!hasNav) return
    const idx = currentIdx === 0 ? gameList.length - 1 : currentIdx - 1
    goTo(gameList[idx].game_id)
  }, [hasNav, currentIdx, gameList, goTo])

  const goNext = useCallback(() => {
    if (!hasNav) return
    const idx = currentIdx === gameList.length - 1 ? 0 : currentIdx + 1
    goTo(gameList[idx].game_id)
  }, [hasNav, currentIdx, gameList, goTo])

  useEffect(() => { loadGame(currentGameId) }, [currentGameId, loadGame])

  useEffect(() => {
    if (!hasNav) return
    const prefetchIdx = [
      currentIdx === 0 ? gameList.length - 1 : currentIdx - 1,
      currentIdx === gameList.length - 1 ? 0 : currentIdx + 1,
    ]
    prefetchIdx.forEach(idx => {
      const gid = gameList[idx].game_id
      if (!cacheRef.current.has(gid)) {
        fetchEvalByGameId(gid).then(data => { if (data) cacheRef.current.set(gid, data) })
      }
    })
  }, [currentIdx, hasNav, gameList])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return
      if (e.key === 'ArrowLeft') { e.preventDefault(); goPrev() }
      if (e.key === 'ArrowRight') { e.preventDefault(); goNext() }
      if (e.key === 'Escape') {
        if (expandedImg) setExpandedImg(null)
        else if (fullscreen) setFullscreen(false)
        else onClose?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [goPrev, goNext, expandedImg, fullscreen, onClose])

  const showToast = (msg: string, err = false) => {
    setToast({ msg, err })
    setTimeout(() => setToast(null), 3000)
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
  const isManager = role === 'admin' || role === 'moderator'
  // Evaluation content (conclusion/note/drive) — admin or the assigned evaluator.
  const canEditEval = !readOnly && (isAdmin || ev?.initial_evaluator === userName)
  // Final Note is a manager-only field (admin or moderator).
  const canEditFinalNote = !readOnly && isManager
  // Recording drive links — admin or the assigned recorder for that duration.
  const canEdit5 = !readOnly && (isAdmin || ev?.record_5min_assignee === userName)
  const canEdit20 = !readOnly && (isAdmin || ev?.record_20min_assignee === userName)
  // 5/20-min recordings are always YouTube uploads, matched live (title + duration).
  const yt5 = ev ? ytLookup(ytMap, ev.title, '5min') : undefined
  const yt20 = ev ? ytLookup(ytMap, ev.title, '20min') : undefined
  // Once confirmed, the recorder is locked — no reassigning.
  const recordConfirmed = !!ev?.record_confirmed_at
  // Re-assigning recorders is a manager action (admin or moderator), enabled per-context.
  const canEditAssignee = !readOnly && isManager && !!canAssignRecords
  // Any editable surface → show the save button.
  const canEdit = canEditEval || canEdit5 || canEdit20 || canEditAssignee || canEditFinalNote
  // The eval editor's Save button also flushes staged screenshots, so staged
  // shots count as unsaved work for it (the card hides its own button then).
  const needsSave = dirty || (canEditEval && stagedShots > 0)

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

  const save = async () => {
    if (!ev || !canEdit) return
    setSaving(true)
    try {
      // Flush staged screenshots first so one Save persists both. Silent success —
      // the eval PATCH below shows the single "Saved" toast; the refetch picks up
      // the new screenshot URLs from the server.
      if (canEditEval) await screenshotRef.current?.flush()
      const body: Record<string, unknown> = { id: ev.id }
      if (canEditEval) {
        // Always send these so an emptied field clears the column (see PATCH handler).
        body.initial_note = note
        body.initial_conclusion = conclusion
        // Batch only applies to List_Idea games. Managers pick freely; evaluators
        // are forced into the team's current batch (set by a manager).
        if (conclusion === 'List_Idea') {
          const effBatch = isManager ? batch : (ev.current_batch || '')
          if (effBatch && effBatch !== (ev.batch || '')) body.batch = effBatch
        }
        body.drive_link = driveLink
        body.game_alike = gameAlike
      }
      if (canEditFinalNote) body.final_note = finalNote
      if (canEdit5 && drive5 && drive5 !== ev.record_5min_drive) body.record_5min_drive = drive5
      if (canEdit20 && drive20 && drive20 !== ev.record_20min_drive) body.record_20min_drive = drive20
      if (canEditAssignee && rec5Assignee && rec5Assignee !== (ev.record_5min_assignee || '')) body.record_5min_assignee = rec5Assignee
      if (canEditAssignee && rec20Assignee && rec20Assignee !== (ev.record_20min_assignee || '')) body.record_20min_assignee = rec20Assignee
      const res = await fetch('/api/evaluations', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const err = await res.json()
        showToast(err.error || 'Failed', true)
      } else {
        showToast('Saved')
        const fresh = await fetchEvalByGameId(ev.game_id)
        if (fresh) {
          cacheRef.current.set(ev.game_id, fresh)
          applyData(fresh)
          onSaved?.(fresh)
        }
      }
    } catch { showToast('Network error', true) }
    setSaving(false)
  }

  // Auto-save: when enabled, persist edits ~800ms after the user stops changing
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
  }), [])

  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!autoSave || !needsSave || saving || !canEdit) return
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current)
    autoSaveTimer.current = setTimeout(() => { saveRef.current() }, 1500)
    return () => { if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSave, needsSave, saving, canEdit, currentGameId, note, conclusion, driveLink, deadLink, batch, drive5, drive20, rec5Assignee, rec20Assignee, stagedShots])

  const clearField = (f: 'note' | 'conclusion' | 'drive') => {
    if (!canEditEval) return
    if (f === 'note') setNote('')
    else if (f === 'conclusion') { setConclusion(''); setDeadLink(false) }
    else if (f === 'drive') setDriveLink('')
    setDirty(true)
  }

  const clearAll = () => {
    if (!canEditEval) return
    if (!confirmClearAll) {
      setConfirmClearAll(true)
      setTimeout(() => setConfirmClearAll(false), 3000)
      return
    }
    setNote(''); setConclusion(''); setDeadLink(false); setDriveLink(''); setBatch('')
    setDirty(true); setConfirmClearAll(false)
  }

  if (loading && !ev) return <div style={{ padding: 40, textAlign: 'center', color: 'var(--faint)' }}>Loading...</div>
  if (!ev) return <div style={{ padding: 40, textAlign: 'center', color: 'var(--faint)' }}>Not found</div>

  const screenshots = ev.screenshot_urls || []
  const manualShots = ev.manual_screenshot_urls || []
  // Manual uploads: admin/moderator or the assigned evaluator (matches the API rule).
  const canEditShots = !readOnly && (isManager || ev.initial_evaluator === userName)
  const cats = ev.categories || []

  return (
    <>
      {/* Marker: when present, the parent .eval-modal-container expands to fill the
          viewport via a :has() rule in globals.css (no prop plumbing needed). */}
      {fullscreen && <div className="eval-fs-on" hidden />}
      {/* Top bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        {onClose && (
          <button className="btn btn-sm btn-ghost" onClick={onClose}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        )}

        {hasNav && (
          <>
            <button className="btn btn-sm" onClick={goPrev} title="Previous (←)">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 18l-6-6 6-6" />
              </svg>
            </button>
            <div style={{ width: 240, flexShrink: 0 }}>
              <StyledSelect
                value={currentGameId}
                onChange={v => goTo(v)}
                options={gameList.map(g => ({ value: g.game_id, label: g.title }))}
              />
            </div>
            <button className="btn btn-sm" onClick={goNext} title="Next (→)">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 18l6-6-6-6" />
              </svg>
            </button>
            <span style={{ fontSize: 11, color: 'var(--faint)', whiteSpace: 'nowrap' }}>{currentIdx + 1} / {gameList.length}</span>
          </>
        )}

        <div style={{ flex: 1 }} />
        {ev.initial_conclusion && (
          <span className={`badge ${CONCLUSION_COLORS[ev.initial_conclusion] || 'neutral'}`} style={{ fontSize: 12, padding: '4px 12px' }}>
            {ev.initial_conclusion}
          </span>
        )}
        {canEdit && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, whiteSpace: 'nowrap', marginRight: 2 }}
            title="Auto-save changes as you edit">
            <span style={{ fontSize: 12, fontWeight: 600, color: autoSave ? 'var(--accent)' : 'var(--faint)' }}>Auto-save</span>
            <label className="switch">
              <input type="checkbox" checked={autoSave} onChange={e => setAutoSave(e.target.checked)} />
              <span className="slider"></span>
            </label>
          </div>
        )}
        <button className="btn btn-sm btn-ghost" onClick={() => setFullscreen(v => !v)}
          title={fullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen'}>
          {fullscreen ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 3v4a1 1 0 0 1-1 1H3M21 8h-4a1 1 0 0 1-1-1V3M3 16h4a1 1 0 0 1 1 1v4M16 21v-4a1 1 0 0 1 1-1h4" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3" />
            </svg>
          )}
        </button>
      </div>

      {/* Progress Tracker */}
      <ProgressTracker ev={ev} yt5={yt5} yt20={yt20} />

      {/* Main layout: 2 columns */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 16, alignItems: 'start' }}>
        {/* Left column */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Game card */}
          <div className="card" style={{ margin: 0 }}>
            <div className="card-head">
              <span className="card-label">Game Info</span>
            </div>

            <div style={{ display: 'flex', gap: 16, marginBottom: 16 }}>
              {ev.icon_url ? (
                <img src={ev.icon_url} alt="" width={56} height={56}
                  style={{ borderRadius: 12, flexShrink: 0, border: '1px solid var(--border)' }} />
              ) : (
                <div style={{ width: 56, height: 56, borderRadius: 12, background: 'var(--surface-3)', flexShrink: 0 }} />
              )}
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
                  <TitleCopyButton title={ev.game_id} />
                  <span>·</span>
                  <span style={{ textTransform: 'capitalize' }}>{ev.category_group}</span>
                </div>
                {ev.subtitle && <div style={{ fontSize: 12, color: 'var(--faint)', marginBottom: 5 }}>{ev.subtitle}</div>}
                <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                  <span className="pill muted" style={{ fontSize: 10 }}>{ev.os?.toUpperCase()}</span>
                  {cats.map((c, i) => (
                    <span key={i} className="pill tag" style={{ fontSize: 10 }}>{c}</span>
                  ))}
                  {ev.content_rating && <span className="pill muted" style={{ fontSize: 10 }}>{ev.content_rating}</span>}
                </div>
              </div>
            </div>

            {/* Info grid with QR */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: '10px 10px' }}>
              <InfoField label="Publisher" value={ev.publisher_name} copyValue={ev.publisher_name || ''} />
              <InfoField label="Evaluator" value={ev.initial_evaluator} />
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
                    <img src={qrDataUrl} alt="QR Link" width={120} height={120} style={{ borderRadius: 8 }} />
                  ) : (
                    <div style={{ width: 120, height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <span className="spin" style={{ display: 'inline-block', width: 16, height: 16 }}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--faint)" strokeWidth="2">
                          <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                        </svg>
                      </span>
                    </div>
                  )}
                  <span style={{ fontSize: 9.5, fontWeight: 700, color: 'var(--muted)', marginTop: 8, textTransform: 'uppercase', letterSpacing: '0.5px', whiteSpace: 'nowrap' }}>
                    Scan to download
                  </span>
                </div>
              ) : <div />}
              <InfoField label="Genre" value={[ev.genre_1, ev.genre_2].filter(Boolean).join(' / ') || '—'} />
              <InfoField label="Assigned" value={fmtDate(ev.assigned_date)} />
              <InfoField label="Release Date" value={fmtDate(ev.release_date)} copyValue={ev.release_date ? fmtDate(ev.release_date) : ''} />
              <InfoField label="Evaluated" value={fmtDateTime(ev.evaluate_date)} />
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
            <div className="card" style={{ margin: 0 }}>
              <div className="card-head">
                <span className="card-label">Description</span>
              </div>
              <div
                style={{ fontSize: 12.5, lineHeight: 1.6, color: 'var(--muted)', maxHeight: 300, overflowY: 'auto' }}
                dangerouslySetInnerHTML={{ __html: ev.description }}
              />
            </div>
          )}
        </div>

        {/* Right: Evaluation form */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="card" style={{ margin: 0 }}>
            <div className="card-head">
              <span className="card-label">Evaluation</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginLeft: 'auto' }}>
                {canEditEval && (
                  <button onClick={clearAll}
                    title="Clear all evaluation fields"
                    style={{
                      background: 'none', border: 'none', cursor: 'pointer', fontSize: 11.5, fontWeight: 600,
                      padding: '2px 6px', borderRadius: 6,
                      color: confirmClearAll ? 'var(--bad)' : 'var(--faint)',
                    }}>
                    {confirmClearAll ? 'Click to confirm' : 'Clear all'}
                  </button>
                )}
                {canEdit && <SaveStatus dirty={needsSave} />}
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {canEditEval && (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', background: 'var(--surface-2)', borderRadius: 10, border: '1px solid var(--border)', marginBottom: 4 }}>
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    <span style={{ fontWeight: 600, fontSize: 13, color: deadLink ? 'var(--bad)' : 'var(--text)' }}>
                      Dead link status
                    </span>
                    <span style={{ fontSize: 11, color: 'var(--faint)' }}>Mark game store link as invalid</span>
                  </div>
                  <label className="switch">
                    <input type="checkbox" checked={deadLink} onChange={e => toggleDeadLink(e.target.checked)} />
                    <span className="slider"></span>
                  </label>
                </div>
              )}

              <div className="field">
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span className="label">Initial Conclusion</span>
                  {canEditEval && conclusion && !deadLink && <ClearBtn onClick={() => clearField('conclusion')} />}
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
                  placeholder="Select conclusion..."
                  options={(() => {
                    const opts = [...INITIAL_CONCLUSION_OPTIONS]
                    if (conclusion && conclusion !== 'Link_dead' && !opts.includes(conclusion)) opts.unshift(conclusion)
                    return opts.map(c => ({ value: c, label: c }))
                  })()}
                  disabled={!canEditEval || deadLink}
                />
              </div>

              {/* Batch picker — only for List_Idea games, to bucket them into a
                  weekly batch for the Short List. Managers pick freely; evaluators
                  are forced into the team's current batch (set by a manager). */}
              {conclusion === 'List_Idea' && (
                <div className="field">
                  <span className="label">Batch (week)</span>
                  {isManager ? (
                    <StyledSelect
                      value={batch}
                      onChange={v => { setBatch(v); setDirty(true) }}
                      placeholder="Select batch..."
                      options={(() => {
                        const now = new Date()
                        const opts = weekBatches(now.getFullYear(), now.getMonth() + 1)
                        const cur = ev.current_batch
                        const merged = [...opts]
                        if (cur && !merged.includes(cur)) merged.unshift(cur)
                        if (batch && !merged.includes(batch)) merged.unshift(batch)
                        return [{ value: '', label: '— none —' }, ...merged.map(b => ({ value: b, label: b }))]
                      })()}
                      disabled={!canEditEval}
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

              <div className="field">
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span className="label">Initial Note</span>
                  {canEditEval && note && <ClearBtn onClick={() => clearField('note')} />}
                </div>
                <textarea
                  className="input"
                  rows={3}
                  value={note}
                  onChange={e => { setNote(e.target.value); setDirty(true) }}
                  placeholder="Evaluation note..."
                  disabled={!canEditEval}
                  style={{ resize: 'vertical', fontSize: 13 }}
                />
              </div>

              <div className="field">
                <span className="label">Game Alike</span>
                <GameAlikeField value={gameAlike} onChange={g => { setGameAlike(g); setDirty(true) }} disabled={!canEditEval} />
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
                  placeholder={canEditFinalNote ? 'Final note (managers only)…' : 'Final note (managers only)'}
                  disabled={!canEditFinalNote}
                  style={{ resize: 'vertical', fontSize: 13 }}
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

              {ev.youtube_link && (
                <div className="field">
                  <span className="label">YouTube Link</span>
                  <a href={ev.youtube_link} target="_blank" rel="noopener"
                    style={{ fontSize: 13, color: 'var(--accent)', wordBreak: 'break-all' }}>
                    {ev.youtube_link}
                  </a>
                </div>
              )}

              {canEditEval && (
                <button className={`btn ${needsSave ? 'btn-primary' : ''}`} onClick={save} disabled={saving || !needsSave}
                  style={{
                    width: '100%', justifyContent: 'center', marginTop: 2, gap: 6,
                    ...(needsSave ? {} : { color: 'var(--good)', borderColor: 'var(--good)', background: 'var(--good-weak)' }),
                  }}>
                  {saving ? 'Saving...' : needsSave ? (autoSave ? 'Save now' : 'Save Evaluation') : (
                    <>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                      {autoSave ? 'Auto-save on — saved' : 'Saved — no changes'}
                    </>
                  )}
                </button>
              )}
            </div>
          </div>

          {/* Record Video — 5 min */}
          {!hideRecordSections && (ev.record_5min_assignee || canEditAssignee) && (
            <div className="card" style={{ margin: 0 }}>
              <div className="card-head">
                <span className="card-label">Record 5 min</span>
                {yt5
                  ? <a className="badge success yt-link" href={`https://www.youtube.com/watch?v=${yt5}`} target="_blank" rel="noopener noreferrer" title="Open on YouTube" style={{ fontSize: 10, textDecoration: 'none' }}>▶ Recorded</a>
                  : ev.record_5min_assignee
                    ? <span className="badge running" style={{ fontSize: 10 }}>Recording</span>
                    : <span className="badge idle" style={{ fontSize: 10 }}>Unassigned</span>}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                  {canEditAssignee && !recordConfirmed ? (
                    <div className="field">
                      <span className="label">Assignee</span>
                      <StyledSelect value={rec5Assignee}
                        onChange={v => { setRec5Assignee(v); setDirty(true) }}
                        placeholder="—" options={recOpts} />
                    </div>
                  ) : (
                    <InfoField label="Assignee" value={recordConfirmed && ev.record_5min_assignee ? `🔒 ${ev.record_5min_assignee}` : ev.record_5min_assignee} />
                  )}
                  <InfoField label="Assigned" value={fmtDate(ev.record_5min_date)} />
                </div>
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
          {!hideRecordSections && (ev.record_20min_assignee || canEditAssignee) && (
            <div className="card" style={{ margin: 0 }}>
              <div className="card-head">
                <span className="card-label">Record 20 min</span>
                {yt20
                  ? <a className="badge success yt-link" href={`https://www.youtube.com/watch?v=${yt20}`} target="_blank" rel="noopener noreferrer" title="Open on YouTube" style={{ fontSize: 10, textDecoration: 'none' }}>▶ Recorded</a>
                  : ev.record_20min_assignee
                    ? <span className="badge running" style={{ fontSize: 10 }}>Recording</span>
                    : <span className="badge idle" style={{ fontSize: 10 }}>Unassigned</span>}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                  {canEditAssignee && !recordConfirmed ? (
                    <div className="field">
                      <span className="label">Assignee</span>
                      <StyledSelect value={rec20Assignee}
                        onChange={v => { setRec20Assignee(v); setDirty(true) }}
                        placeholder="—" options={recOpts} />
                    </div>
                  ) : (
                    <InfoField label="Assignee" value={recordConfirmed && ev.record_20min_assignee ? `🔒 ${ev.record_20min_assignee}` : ev.record_20min_assignee} />
                  )}
                  <InfoField label="Assigned" value={fmtDate(ev.record_20min_date)} />
                </div>
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

          {/* Save button for record changes */}
          {!hideRecordSections && (ev.record_5min_assignee || ev.record_20min_assignee || canEditAssignee) && (canEdit5 || canEdit20 || canEditAssignee) && (
            <button className={`btn ${dirty ? 'btn-primary' : ''}`} onClick={save} disabled={saving || !dirty}
              style={{
                width: '100%', justifyContent: 'center', gap: 6,
                ...(dirty ? {} : { color: 'var(--good)', borderColor: 'var(--good)', background: 'var(--good-weak)' }),
              }}>
              {saving ? 'Saving...' : dirty ? 'Save Changes' : (
                <>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  Saved — no changes
                </>
              )}
            </button>
          )}

          {/* Timestamps */}
          <div className="card" style={{ margin: 0, opacity: 0.7 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--faint)' }}>
                <span>Imported</span><span>{fmtDateTime(ev.imported_at)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--faint)' }}>
                <span>Updated</span><span>{fmtDateTime(ev.updated_at)}</span>
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
      {mounted && expandedImg && createPortal(
        <div onClick={() => setExpandedImg(null)} className="lightbox-backdrop">
          <div onClick={e => e.stopPropagation()}
            style={{ position: 'relative', maxWidth: '90vw', maxHeight: '90vh', display: 'flex', gap: 8, overflowX: 'auto', padding: 16, cursor: 'default' }}>
            {expandedImg.startsWith('data:image/') ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', background: 'var(--surface)', padding: 24, borderRadius: 16, border: '1px solid var(--border)' }}>
                <img src={expandedImg} alt="QR Code Expanded"
                  style={{ width: 280, height: 280, borderRadius: 12, border: '1px solid var(--border)' }} />
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', marginTop: 14 }}>
                  Scan to download/test game
                </span>
              </div>
            ) : (
              (screenshots.length > 0 ? screenshots : manualShots).map((url, i) => (
                <img key={i} src={url} alt={`Screenshot ${i + 1}`}
                  style={{
                    maxHeight: '85vh', borderRadius: 12, flexShrink: 0,
                    border: url === expandedImg ? '3px solid var(--accent)' : '1px solid rgba(255,255,255,.2)',
                    scrollMarginInline: 16,
                  }}
                  ref={el => { if (el && url === expandedImg) el.scrollIntoView({ behavior: 'instant', inline: 'center', block: 'nearest' }) }}
                  onError={e => { e.currentTarget.style.display = 'none' }}
                />
              ))
            )}
          </div>
          <button onClick={() => setExpandedImg(null)}
            style={{ position: 'fixed', top: 20, right: 20, background: 'rgba(0,0,0,.5)', border: 'none', color: '#fff', width: 40, height: 40, borderRadius: 20, fontSize: 20, cursor: 'pointer', display: 'grid', placeItems: 'center' }}>
            ✕
          </button>
        </div>,
        document.body
      )}

      {/* Toast */}
      {toast && (
        <div className="toast-wrap">
          <div className={`toast${toast.err ? ' err' : ''}`}>{toast.msg}</div>
        </div>
      )}
    </>
  )
}
