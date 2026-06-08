'use client'
import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { StyledSelect } from '@/components/StyledSelect'

// ── Config ────────────────────────────────────────────────────────────────────

const SHEET_TYPE_OPTIONS = [
  { label: 'Puzzle',     value: 'Puzzle smartsheet ID'     },
  { label: 'Arcade',     value: 'Arcade smartsheet ID'     },
  { label: 'Simulation', value: 'Simulation smartsheet ID' },
] as const
type SheetType = typeof SHEET_TYPE_OPTIONS[number]['value']

const DIELINK_TABS = [
  { label: 'Blank',  workflow: 'delete_blank',  realtime: 'delete-blank'  },
  { label: 'Bypass', workflow: 'delete_bypass', realtime: 'delete-bypass' },
] as const

const STANDARD_GROUPS = [
  {
    label: 'Smartsheet',
    realtimeKeys: ['pull-ios', 'pull-android', 'push-smartsheet'],
    workflows: [
      { label: 'Pull iOS',        workflow: 'pull_ios',        realtime: 'pull-ios'        },
      { label: 'Pull Android',    workflow: 'pull_android',    realtime: 'pull-android'    },
      { label: 'Push Smartsheet', workflow: 'push_smartsheet', realtime: 'push-smartsheet' },
    ],
  },
  {
    label: 'Videos',
    realtimeKeys: ['upload-youtube'],
    workflows: [
      { label: 'Upload YouTube', workflow: 'upload_ytb', realtime: 'upload-youtube' },
    ],
  },
]

// ── Types ────────────────────────────────────────────────────────────────────

interface RealtimeRow { workflow: string; status: string }
interface LogRow      { date: string; name: string; status: string; note: string }
interface Evaluator   { row_number: number; name: string; today_available: 'Yes' | 'No'; game_platform: string }

// ── Helpers ──────────────────────────────────────────────────────────────────

function getTodayVN() {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' }))
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}

function formatNote(name: string, raw: string): string {
  const n = parseInt(raw, 10)
  if (name === 'delete-bypass' || name === 'delete-blank') {
    if (isNaN(n) || n === 0) return 'No links'
    return `${n} deleted`
  }
  if (name === 'upload-youtube') {
    if (isNaN(n)) return raw || ''
    return `${n} uploaded`
  }
  return ''
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StatusDot({ status }: { status: string }) {
  const running = status === 'running'
  return (
    <span className={`status-dot${running ? ' running' : ''}`}>
      <span className="sd" />
      {running ? 'running' : 'idle'}
    </span>
  )
}

function LogBadge({ status }: { status: string }) {
  const ok = status.toLowerCase() === 'success'
  return (
    <span className={`badge ${ok ? 'success' : 'error'}`}>
      {ok ? '✓' : '✗'}
    </span>
  )
}

// ── History Panel ─────────────────────────────────────────────────────────────

function HistoryPanel({ allRows, realtimeKeys, loading, onRefresh }: {
  allRows: LogRow[]
  realtimeKeys: string[]
  loading: boolean
  onRefresh: () => void
}) {
  const today = getTodayVN()

  const entries = useMemo(() =>
    allRows.filter(r => realtimeKeys.includes(r.name)),
    [allRows, realtimeKeys]
  )

  const byDate = useMemo(() => {
    const map: Record<string, LogRow[]> = {}
    for (const r of entries) {
      const d = r.date.slice(0, 10)
      ;(map[d] = map[d] || []).push(r)
    }
    return Object.entries(map).sort(([a], [b]) => b.localeCompare(a))
  }, [entries])

  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="card-head">
        <span className="card-label">History</span>
        <button className="btn btn-sm" onClick={onRefresh} disabled={loading}>
          <span className={loading ? 'spin' : ''}>↻</span>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      <div style={{ overflowY: 'auto', maxHeight: 240 }}>
        {entries.length === 0 ? (
          <p className="empty">No history yet</p>
        ) : (
          byDate.map(([date, rows]) => {
            const [, dm, dd] = date.split('-')
            const isToday = date === today
            const successCount = rows.filter(r => r.status.toLowerCase() === 'success').length
            const failCount = rows.length - successCount
            return (
              <div key={date}>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 6, padding: '5px 2px',
                  background: isToday ? 'var(--accent-weak)' : 'var(--surface-2)',
                  borderRadius: 6, marginBottom: 2,
                  borderBottom: '1px solid var(--border)',
                  position: 'sticky', top: 0,
                }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: isToday ? 'var(--accent-strong)' : 'var(--muted)', marginLeft: 2 }}>
                    {dd}/{dm}
                  </span>
                  {isToday && (
                    <span className="badge running" style={{ fontSize: 9, padding: '1px 5px' }}>TODAY</span>
                  )}
                  <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--faint)', display: 'flex', gap: 8 }}>
                    {successCount > 0 && <span style={{ color: 'var(--good)' }}>✓ {successCount}</span>}
                    {failCount    > 0 && <span style={{ color: 'var(--bad)' }}>✗ {failCount}</span>}
                  </span>
                </div>
                {rows.map((r, i) => {
                  const note = formatNote(r.name, r.note)
                  return (
                    <div key={i} style={{
                      display: 'grid', gridTemplateColumns: '40px 1fr auto auto',
                      alignItems: 'center', gap: 10, padding: '7px 2px',
                      borderBottom: '1px solid var(--border)',
                    }}>
                      <span className="ht-time">{r.date.slice(11, 16)}</span>
                      <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
                      <LogBadge status={r.status} />
                      {note && (
                        <span style={{ fontSize: 11, color: 'var(--faint)', textAlign: 'right' }}>{note}</span>
                      )}
                    </div>
                  )
                })}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

// ── Die-Link Card ─────────────────────────────────────────────────────────────

function DielinkCard({ statusMap, realtimeOk, triggering, triggered, activeKey, onTrigger, nowStr }: {
  statusMap: Record<string, string>
  realtimeOk: boolean | null
  triggering: string | null
  triggered: string | null
  activeKey: string | null
  onTrigger: (workflow: string, sheetType: SheetType) => void
  nowStr: string | null
}) {
  const [activeTab, setActiveTab] = useState(0)
  const tab = DIELINK_TABS[activeTab]

  const disconnected = realtimeOk === false
  const status = disconnected ? 'idle' : (statusMap[tab.realtime] ?? 'idle')
  const isRunning = status === 'running'
  const anyRunning = DIELINK_TABS.some(t => !disconnected && statusMap[t.realtime] === 'running')

  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12, height: '100%' }}>
      <div className="card-head" style={{ marginBottom: 0 }}>
        <span className="card-label">Die-Link</span>
        {disconnected ? (
          <span className="badge error">⚡ disconnected</span>
        ) : anyRunning ? (
          <span className="badge running"><span className="bdot" /> running</span>
        ) : null}
      </div>

      {/* Segmented tabs */}
      <div className="seg">
        {DIELINK_TABS.map((t, i) => (
          <button key={t.label} className={`seg-btn${activeTab === i ? ' active' : ''}`}
            onClick={() => setActiveTab(i)}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Status row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {disconnected
          ? <span className="badge neutral">–</span>
          : <StatusDot status={status} />}
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>Delete {tab.label}</span>
      </div>

      {/* Sheet type buttons */}
      <div style={{ display: 'flex', gap: 8 }}>
        {SHEET_TYPE_OPTIONS.map(({ label, value }) => {
          const key = `${tab.workflow}__${value}`
          const isTriggering = triggering === key
          const isActive     = activeKey === key
          const wasTriggered = triggered === key
          const isLoading    = isTriggering || isActive
          const isLocked     = isRunning || isLoading
          return (
            <button key={value}
              className={`trig${isLoading ? ' running' : wasTriggered ? ' done' : ''}`}
              style={{ flex: 1, opacity: isLocked && !isLoading ? 0.5 : 1 }}
              onClick={() => onTrigger(tab.workflow, value)}
              disabled={isLocked}>
              {isLoading
                ? <span className="spin">↻</span>
                : wasTriggered ? `✓ ${label}`
                : label}
            </button>
          )
        })}
      </div>

      <p style={{ fontSize: 11, textAlign: 'right', color: 'var(--faint)', marginTop: 'auto' }}>
        {nowStr ? `${nowStr} · 5s` : '…'}
      </p>
    </div>
  )
}

// ── Standard Group Card ───────────────────────────────────────────────────────

function StandardGroupCard({ group, statusMap, realtimeOk, triggering, triggered, onTrigger, nowStr, onReassign }: {
  group: typeof STANDARD_GROUPS[number]
  statusMap: Record<string, string>
  realtimeOk: boolean | null
  triggering: string | null
  triggered: string | null
  onTrigger: (workflow: string) => void
  nowStr: string | null
  onReassign?: () => void
}) {
  const groupRunning = group.workflows.some(w => statusMap[w.realtime] === 'running')
  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="card-head" style={{ marginBottom: 0 }}>
        <span className="card-label">{group.label}</span>
        {realtimeOk === false ? (
          <span className="badge error">⚡ disconnected</span>
        ) : groupRunning ? (
          <span className="badge running"><span className="bdot" /> running</span>
        ) : null}
      </div>

      <div style={{ flex: 1 }}>
        {group.workflows.map(op => {
          const disconnected  = realtimeOk === false
          const status        = disconnected ? 'idle' : (statusMap[op.realtime] ?? 'idle')
          const isRunning     = status === 'running'
          const isTriggering  = triggering === op.workflow
          const wasTriggered  = triggered === op.workflow
          const isLocked      = isRunning || isTriggering
          return (
            <div key={op.workflow} className="op-row"
              style={{ background: isRunning ? 'var(--warn-weak)' : 'transparent' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 }}>
                {disconnected
                  ? <span className="badge neutral">–</span>
                  : <StatusDot status={status} />}
                <span className="op-name" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{op.label}</span>
              </div>
              <button
                className={`trig${wasTriggered ? ' done' : isRunning ? ' running' : ''}`}
                onClick={() => onTrigger(op.workflow)}
                disabled={isLocked}
                style={{ opacity: isLocked && !isTriggering ? 0.6 : 1 }}>
                {isTriggering ? <span className="spin">↻</span>
                 : wasTriggered ? '✓'
                 : isRunning   ? '●'
                 : '▶'}
              </button>
            </div>
          )
        })}
        {onReassign && (
          <div className="op-row">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1 }}>
              <span className="badge neutral" style={{ background: 'var(--accent-weak)', color: 'var(--accent-strong)' }}>⇄</span>
              <span className="op-name">Re-assign</span>
            </div>
            <button className="trig" style={{ background: 'var(--accent)', color: '#fff', borderColor: 'var(--accent)' }}
              onClick={onReassign}>▶</button>
          </div>
        )}
      </div>

      <p style={{ fontSize: 11, textAlign: 'right', color: 'var(--faint)', marginTop: 8 }}>
        {nowStr ? `${nowStr} · 5s` : '…'}
      </p>
    </div>
  )
}

// ── Re-assign Modal ──────────────────────────────────────────────────────────

function ReassignModal({ open, onClose, evaluators, loadingEvals }: {
  open: boolean
  onClose: () => void
  evaluators: Evaluator[]
  loadingEvals: boolean
}) {
  const [selectedEvaluator, setSelectedEvaluator] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [sheetType, setSheetType] = useState<SheetType>('Puzzle smartsheet ID')
  const [checked, setChecked] = useState<Record<string, boolean>>({})
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  useEffect(() => {
    const init: Record<string, boolean> = {}
    for (const ev of evaluators) {
      if (ev.name !== selectedEvaluator) {
        init[ev.name] = ev.today_available === 'Yes'
      }
    }
    setChecked(init)
  }, [evaluators, selectedEvaluator])

  useEffect(() => {
    if (open) {
      setSelectedEvaluator('')
      setStartDate('')
      setEndDate('')
      setSheetType('Puzzle smartsheet ID')
      setMessage(null)
    }
  }, [open])

  const filteredEvaluators = evaluators.filter(ev => ev.name !== selectedEvaluator)
  const selectedCount = filteredEvaluators.filter(ev => checked[ev.name]).length

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!selectedEvaluator || !startDate || !endDate) return
    const selected = filteredEvaluators.filter(ev => checked[ev.name]).map(ev => ev.name)
    if (selected.length === 0) return

    setSubmitting(true)
    setMessage(null)
    try {
      const res = await fetch('/api/operations/reassign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          evaluator_name: selectedEvaluator,
          start_date: startDate,
          end_date: endDate,
          sheet_type: sheetType,
          selected_evaluators: selected,
        }),
      })
      if (res.ok) {
        const data = await res.json()
        setMessage({ type: data.status === 'success' ? 'success' : 'error', text: data.status === 'success' ? `Re-assigned games from ${selectedEvaluator} to ${selected.length} evaluators.` : 'Re-assign completed with errors.' })
      } else {
        const body = await res.json()
        setMessage({ type: 'error', text: body.error ?? 'Failed' })
      }
    } catch {
      setMessage({ type: 'error', text: 'Network error' })
    } finally {
      setSubmitting(false)
    }
  }

  if (!open) return null

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">Re-assign Games</span>
          <button className="x-btn" onClick={onClose} type="button">✕</button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            {/* Row 1: Evaluator + Sheet Type */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div className="field">
                <span className="label">Evaluator (re-assign from)</span>
                <StyledSelect
                  value={selectedEvaluator}
                  onChange={setSelectedEvaluator}
                  options={evaluators.map(ev => ({ value: ev.name, label: ev.name }))}
                  placeholder={loadingEvals ? 'Loading...' : '-- Select --'}
                  disabled={loadingEvals}
                />
              </div>
              <div className="field">
                <span className="label">Sheet Type</span>
                <StyledSelect
                  value={sheetType}
                  onChange={v => setSheetType(v as SheetType)}
                  options={SHEET_TYPE_OPTIONS.map(o => ({ value: o.value, label: o.label }))}
                />
              </div>
            </div>

            {/* Row 2: Date range */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div className="field">
                <span className="label">Start Date</span>
                <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)}
                  required className="input" />
              </div>
              <div className="field">
                <span className="label">End Date</span>
                <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)}
                  required className="input" />
              </div>
            </div>

            {/* Evaluator checkboxes */}
            <div className="field">
              <span className="label">Assign to ({selectedCount} selected)</span>
              {!selectedEvaluator ? (
                <p style={{ fontSize: 12, color: 'var(--faint)', fontStyle: 'italic' }}>Select an evaluator above first</p>
              ) : (
                <div className="check-grid">
                  {filteredEvaluators.map(ev => (
                    <label key={ev.row_number} className={`check-item${checked[ev.name] ? ' on' : ''}`}>
                      <input type="checkbox" checked={!!checked[ev.name]}
                        onChange={e => setChecked(prev => ({ ...prev, [ev.name]: e.target.checked }))} />
                      <span style={{ fontWeight: 600, flex: 1 }}>{ev.name}</span>
                      <span className={`pill ${ev.today_available === 'Yes' ? 'on' : 'off'}`} style={{ fontSize: 10 }}>
                        {ev.today_available === 'Yes' ? 'avail' : 'away'}
                      </span>
                      {ev.game_platform && ev.game_platform !== 'all' && (
                        <span className="pill tag" style={{ fontSize: 10 }}>{ev.game_platform}</span>
                      )}
                    </label>
                  ))}
                </div>
              )}
            </div>

            {message && (
              <p className={message.type === 'success' ? 'msg-ok' : 'msg-err'}>{message.text}</p>
            )}
          </div>

          <div className="modal-foot">
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary"
              disabled={submitting || !selectedEvaluator || !startDate || !endDate || selectedCount === 0}>
              {submitting ? 'Submitting...' : 'Re-assign'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function OperationsPage() {
  const [triggering, setTriggering]         = useState<string | null>(null)
  const [triggered, setTriggered]           = useState<string | null>(null)
  const [activeKey, setActiveKey]           = useState<string | null>(null)
  const [realtimeRows, setRealtimeRows]     = useState<RealtimeRow[]>([])
  const [realtimeOk, setRealtimeOk]         = useState<boolean | null>(null)
  const [logRows, setLogRows]               = useState<LogRow[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [realtimeAt, setRealtimeAt]         = useState<Date | null>(null)
  const prevStatusRef                       = useRef<Record<string, string>>({})
  const [reassignOpen, setReassignOpen]     = useState(false)
  const [evaluators, setEvaluators]         = useState<Evaluator[]>([])
  const [loadingEvals, setLoadingEvals]     = useState(false)

  const fetchRealtime = useCallback(async () => {
    try {
      const res = await fetch('/api/operations/realtime', { cache: 'no-store' })
      if (res.ok) {
        setRealtimeRows(await res.json())
        setRealtimeAt(new Date())
        setRealtimeOk(true)
      } else {
        setRealtimeOk(false)
      }
    } catch {
      setRealtimeOk(false)
    }
  }, [])

  const fetchHistory = useCallback(async () => {
    setHistoryLoading(true)
    try {
      const res = await fetch('/api/operations/history?limit=200', { cache: 'no-store' })
      if (res.ok) setLogRows(await res.json())
    } catch { /* ignore */ }
    finally { setHistoryLoading(false) }
  }, [])

  const loadEvaluators = useCallback(async () => {
    setLoadingEvals(true)
    try {
      const res = await fetch('/api/team/initial', { cache: 'no-store' })
      if (res.ok) setEvaluators(await res.json())
    } catch { /* ignore */ }
    finally { setLoadingEvals(false) }
  }, [])

  function openReassignModal() {
    setReassignOpen(true)
    loadEvaluators()
  }

  useEffect(() => {
    fetchRealtime()
    fetchHistory()
    const rt = setInterval(fetchRealtime, 5000)
    const ht = setInterval(fetchHistory, 60000)
    return () => { clearInterval(rt); clearInterval(ht) }
  }, [fetchRealtime, fetchHistory])

  async function handleTrigger(workflow: string, sheetType?: SheetType) {
    const key = sheetType ? `${workflow}__${sheetType}` : workflow
    setTriggering(key)
    setActiveKey(key)
    setTriggered(null)
    try {
      await fetch('/api/workflows/trigger', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflow, ...(sheetType ? { sheet_type: sheetType } : {}) }),
      })
      setTriggered(key)
    } finally {
      setTriggering(null)
      setTimeout(() => setTriggered(t => t === key ? null : t), 2500)
    }
  }

  const statusMap = useMemo(() =>
    Object.fromEntries(realtimeRows.map(r => [r.workflow, r.status])),
  [realtimeRows])

  useEffect(() => {
    if (!activeKey) return
    const [wf] = activeKey.split('__')
    const rtKey = wf.replace(/_/g, '-')
    const wasRunning = prevStatusRef.current[rtKey] === 'running'
    const nowIdle    = statusMap[rtKey] === 'idle' || (!statusMap[rtKey] && wasRunning)
    if (wasRunning && nowIdle) setActiveKey(null)
    prevStatusRef.current = { ...statusMap }
  }, [statusMap, activeKey])

  const nowStr = realtimeAt
    ? realtimeAt.toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : null

  return (
    <div className="page">
      <div className="page-head">
        <h1 className="h-title">Operations</h1>
      </div>

      {/* Die-Link row */}
      <div className="grid-ops">
        <DielinkCard
          statusMap={statusMap}
          realtimeOk={realtimeOk}
          triggering={triggering}
          triggered={triggered}
          activeKey={activeKey}
          onTrigger={(wf, st) => handleTrigger(wf, st)}
          nowStr={nowStr}
        />
        <HistoryPanel
          allRows={logRows}
          realtimeKeys={['delete-blank', 'delete-bypass']}
          loading={historyLoading}
          onRefresh={fetchHistory}
        />
      </div>

      {/* Smartsheet + Videos rows */}
      {STANDARD_GROUPS.map(group => (
        <div key={group.label} className="grid-ops">
          <StandardGroupCard
            group={group}
            statusMap={statusMap}
            realtimeOk={realtimeOk}
            triggering={triggering}
            triggered={triggered}
            onTrigger={wf => handleTrigger(wf)}
            nowStr={nowStr}
            onReassign={group.label === 'Smartsheet' ? openReassignModal : undefined}
          />
          <HistoryPanel
            allRows={logRows}
            realtimeKeys={group.realtimeKeys}
            loading={historyLoading}
            onRefresh={fetchHistory}
          />
        </div>
      ))}

      <ReassignModal
        open={reassignOpen}
        onClose={() => setReassignOpen(false)}
        evaluators={evaluators}
        loadingEvals={loadingEvals}
      />
    </div>
  )
}
