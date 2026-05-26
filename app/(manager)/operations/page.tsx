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
    <span className="inline-flex items-center gap-1.5 text-xs font-semibold px-2 py-0.5 rounded-full"
      style={{ background: running ? '#FEF3C7' : '#F3F4F6', color: running ? '#92400E' : '#9CA3AF' }}>
      <span className={`w-1.5 h-1.5 rounded-full inline-block ${running ? 'bg-amber-500 animate-pulse' : 'bg-gray-300'}`} />
      {running ? 'running' : 'idle'}
    </span>
  )
}

function LogBadge({ status }: { status: string }) {
  const ok = status.toLowerCase() === 'success'
  return (
    <span className={`text-xs font-bold px-1.5 py-0.5 rounded-full flex-shrink-0 ${ok ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
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
    <div className="bean-card p-3 flex flex-col h-full">
      <div className="flex items-center justify-between mb-2">
        <span className="bean-section-label" style={{ marginBottom: 0 }}>History</span>
        <button onClick={onRefresh} disabled={loading}
          className="flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-lg"
          style={{ background: '#D4C4A0', color: '#5A3E1B', border: 'none', cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.6 : 1 }}>
          <span className={loading ? 'inline-block animate-spin' : ''}>↻</span>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      <div style={{ overflowY: 'auto', maxHeight: 220 }}>
        {entries.length === 0 ? (
          <p className="text-xs text-center py-6" style={{ color: '#9CA3AF' }}>No history yet</p>
        ) : (
          byDate.map(([date, rows]) => {
            const [, dm, dd] = date.split('-')
            const isToday = date === today
            const successCount = rows.filter(r => r.status.toLowerCase() === 'success').length
            const failCount = rows.length - successCount
            return (
              <div key={date}>
                <div className="flex items-center gap-1.5 px-2 py-1 text-xs font-bold"
                  style={{ background: '#F0E8D6', color: '#8B6A3E', borderBottom: '1px solid #E8DCC8', position: 'sticky', top: 0 }}>
                  {dd}/{dm}
                  {isToday && (
                    <span className="px-1 py-0.5 rounded font-bold text-white"
                      style={{ background: '#7A8C1E', fontSize: '0.55rem' }}>TODAY</span>
                  )}
                  <span className="ml-auto font-normal flex items-center gap-2">
                    {successCount > 0 && <span className="text-green-600">✓ {successCount}</span>}
                    {failCount    > 0 && <span className="text-red-500">✗ {failCount}</span>}
                  </span>
                </div>
                {rows.map((r, i) => {
                  const note = formatNote(r.name, r.note)
                  return (
                    <div key={i} className="flex items-center gap-2 px-2 py-1.5 text-xs"
                      style={{ borderBottom: '1px solid #F5EDD8' }}>
                      <span className="font-mono text-gray-400 flex-shrink-0" style={{ fontSize: '0.6rem', minWidth: 30 }}>
                        {r.date.slice(11, 16)}
                      </span>
                      <span className="truncate font-medium" style={{ color: '#2A1F08', flex: 1 }}>{r.name}</span>
                      <LogBadge status={r.status} />
                      {note && (
                        <span className="flex-shrink-0 text-right" style={{ color: '#6B5A3A', fontSize: '0.65rem' }}>{note}</span>
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
    <div className="bean-card p-4 flex flex-col gap-0 h-full">
      <div className="flex items-center justify-between mb-3">
        <p className="bean-section-label" style={{ marginBottom: 0 }}>Die-Link</p>
        {disconnected ? (
          <span className="text-xs font-semibold px-2 py-0.5 rounded-full"
            style={{ background: '#FEE2E2', color: '#B91C1C' }}>⚡ disconnected</span>
        ) : anyRunning ? (
          <span className="text-xs font-semibold px-2 py-0.5 rounded-full flex items-center gap-1"
            style={{ background: '#FEF3C7', color: '#92400E' }}>
            <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse inline-block" />
            running
          </span>
        ) : null}
      </div>

      {/* Tabs */}
      <div className="flex gap-1.5 mb-4">
        {DIELINK_TABS.map((t, i) => (
          <button key={t.label} onClick={() => setActiveTab(i)}
            style={{
              flex: 1, padding: '5px 0', borderRadius: 7, fontSize: 12, fontWeight: 700,
              background: activeTab === i ? '#5A3E1B' : '#EFE3C8',
              color: activeTab === i ? '#fff' : '#5A3E1B',
              border: 'none', cursor: 'pointer',
              boxShadow: activeTab === i ? '0 1px 4px rgba(0,0,0,0.15)' : 'none',
            }}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Status row */}
      <div className="flex items-center gap-2 mb-3">
        {disconnected
          ? <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: '#F3F4F6', color: '#9CA3AF' }}>–</span>
          : <StatusDot status={status} />}
        <span className="text-xs font-semibold" style={{ color: '#2A1F08' }}>Delete {tab.label}</span>
      </div>

      {/* Sheet type buttons */}
      <div className="flex gap-2">
        {SHEET_TYPE_OPTIONS.map(({ label, value }) => {
          const key = `${tab.workflow}__${value}`
          const isTriggering = triggering === key
          const isActive     = activeKey === key
          const wasTriggered = triggered === key
          const isLoading    = isTriggering || isActive
          const isLocked     = isRunning || isLoading
          return (
            <button key={value}
              onClick={() => onTrigger(tab.workflow, value)}
              disabled={isLocked}
              style={{
                flex: 1, padding: '7px 4px', borderRadius: 8, fontSize: 11, fontWeight: 700,
                background: isLoading ? '#F59E0B' : wasTriggered ? '#7A8C1E' : isRunning ? '#EFE3C8' : '#D4C4A0',
                color: isLoading || wasTriggered ? '#fff' : '#2A1F08',
                border: '1.5px solid ' + (isLoading ? '#D97706' : '#C8B896'),
                opacity: isLocked && !isLoading ? 0.5 : 1,
                cursor: isLocked ? 'not-allowed' : 'pointer',
                transition: 'all 0.15s',
              }}>
              {isLoading
                ? <span className="inline-block animate-spin">↻</span>
                : wasTriggered ? `✓ ${label}`
                : label}
            </button>
          )
        })}
      </div>

      <p className="text-xs mt-3 text-right" style={{ color: '#9CA3AF' }}>
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
    <div className="bean-card p-4 flex flex-col gap-0 h-full">
      <div className="flex items-center justify-between mb-3">
        <p className="bean-section-label" style={{ marginBottom: 0 }}>{group.label}</p>
        {realtimeOk === false ? (
          <span className="text-xs font-semibold px-2 py-0.5 rounded-full"
            style={{ background: '#FEE2E2', color: '#B91C1C' }}>⚡ disconnected</span>
        ) : groupRunning ? (
          <span className="text-xs font-semibold px-2 py-0.5 rounded-full flex items-center gap-1"
            style={{ background: '#FEF3C7', color: '#92400E' }}>
            <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse inline-block" />
            running
          </span>
        ) : null}
      </div>

      <div className="divide-y" style={{ borderColor: '#E8DCC8' }}>
        {group.workflows.map(op => {
          const disconnected  = realtimeOk === false
          const status        = disconnected ? 'idle' : (statusMap[op.realtime] ?? 'idle')
          const isRunning     = status === 'running'
          const isTriggering  = triggering === op.workflow
          const wasTriggered  = triggered === op.workflow
          const isLocked      = isRunning || isTriggering
          return (
            <div key={op.workflow}
              className="flex items-center justify-between py-2.5 gap-2"
              style={{ background: isRunning ? '#FFFBEB' : 'transparent' }}>
              <div className="flex items-center gap-2 flex-1 min-w-0">
                {disconnected
                  ? <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: '#F3F4F6', color: '#9CA3AF' }}>–</span>
                  : <StatusDot status={status} />}
                <span className="text-xs font-semibold truncate" style={{ color: '#2A1F08' }}>{op.label}</span>
              </div>
              <button
                onClick={() => onTrigger(op.workflow)}
                disabled={isLocked}
                className="flex-shrink-0 text-xs font-bold px-2.5 py-1 rounded-lg transition-all"
                style={{
                  background: wasTriggered ? '#7A8C1E' : isRunning ? '#F59E0B' : '#D4C4A0',
                  color: wasTriggered || isRunning ? '#fff' : '#2A1F08',
                  border: '1.5px solid ' + (isRunning ? '#D97706' : '#5A6A10'),
                  opacity: isLocked ? 0.6 : 1,
                  cursor: isLocked ? 'not-allowed' : 'pointer',
                }}>
                {isTriggering ? <span className="inline-block animate-spin">↻</span>
                 : wasTriggered ? '✓'
                 : isRunning   ? '●'
                 : '▶'}
              </button>
            </div>
          )
        })}
        {onReassign && (
          <div className="flex items-center justify-between py-2.5 gap-2">
            <div className="flex items-center gap-2 flex-1 min-w-0">
              <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: '#EDE9FE', color: '#6D28D9', fontWeight: 700 }}>⇄</span>
              <span className="text-xs font-semibold truncate" style={{ color: '#2A1F08' }}>Re-assign</span>
            </div>
            <button
              onClick={onReassign}
              className="flex-shrink-0 text-xs font-bold px-2.5 py-1 rounded-lg transition-all"
              style={{
                background: '#7C3AED',
                color: '#fff',
                border: '1.5px solid #6D28D9',
                cursor: 'pointer',
              }}>
              ▶
            </button>
          </div>
        )}
      </div>

      <p className="text-xs mt-2 text-right" style={{ color: '#9CA3AF' }}>
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

  // Reset checked when evaluators load or selected evaluator changes
  useEffect(() => {
    const init: Record<string, boolean> = {}
    for (const ev of evaluators) {
      if (ev.name !== selectedEvaluator) {
        init[ev.name] = ev.today_available === 'Yes'
      }
    }
    setChecked(init)
  }, [evaluators, selectedEvaluator])

  // Reset form when modal opens
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

  const inputStyle: React.CSSProperties = {
    width: '100%', border: '1px solid #D4C4A0', borderRadius: 6,
    padding: '6px 8px', fontSize: 12, background: '#FAF5EC', color: '#2A1F08',
  }
  const labelStyle: React.CSSProperties = {
    display: 'block', fontSize: 11, fontWeight: 700, color: '#6B5A3A', marginBottom: 4,
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      {/* Backdrop */}
      <div onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.4)' }} />
      {/* Modal */}
      <div style={{ position: 'relative', background: '#FAF5EC', borderRadius: 12, padding: 24, width: 520, maxHeight: '85vh', overflowY: 'auto', boxShadow: '0 8px 32px rgba(0,0,0,0.2)', border: '2px solid #D4C4A0' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <h2 style={{ fontSize: 16, fontWeight: 800, color: '#2A1F08', margin: 0 }}>Re-assign Games</h2>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: '#9CA3AF', fontWeight: 700 }}>×</button>
        </div>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* Row 1: Evaluator + Sheet Type */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <label style={labelStyle}>Evaluator (re-assign from)</label>
              <StyledSelect
                value={selectedEvaluator}
                onChange={setSelectedEvaluator}
                options={evaluators.map(ev => ({ value: ev.name, label: ev.name }))}
                placeholder={loadingEvals ? 'Loading...' : '-- Select --'}
                disabled={loadingEvals}
              />
            </div>
            <div>
              <label style={labelStyle}>Sheet Type</label>
              <StyledSelect
                value={sheetType}
                onChange={v => setSheetType(v as SheetType)}
                options={SHEET_TYPE_OPTIONS.map(o => ({ value: o.value, label: o.label }))}
              />
            </div>
          </div>

          {/* Row 2: Date range */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <label style={labelStyle}>Start Date</label>
              <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)}
                required style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>End Date</label>
              <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)}
                required style={inputStyle} />
            </div>
          </div>

          {/* Evaluator checkboxes */}
          <div>
            <label style={{ ...labelStyle, marginBottom: 8 }}>
              Assign to ({selectedCount} selected)
            </label>
            {!selectedEvaluator ? (
              <p style={{ fontSize: 11, color: '#9CA3AF', fontStyle: 'italic' }}>Select an evaluator above first</p>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, maxHeight: 200, overflowY: 'auto', padding: 8, background: '#F5EDD8', borderRadius: 8, border: '1px solid #E8DCC8' }}>
                {filteredEvaluators.map(ev => (
                  <label key={ev.row_number} style={{
                    display: 'flex', alignItems: 'center', gap: 6, padding: '4px 6px', borderRadius: 6, fontSize: 12, cursor: 'pointer',
                    background: checked[ev.name] ? '#E8F5C8' : 'transparent',
                    transition: 'background 0.15s',
                  }}>
                    <input type="checkbox" checked={!!checked[ev.name]}
                      onChange={e => setChecked(prev => ({ ...prev, [ev.name]: e.target.checked }))}
                      style={{ accentColor: '#5A3E1B' }} />
                    <span style={{ fontWeight: 600, color: '#2A1F08' }}>{ev.name}</span>
                    <span style={{
                      fontSize: 9, fontWeight: 700, padding: '1px 4px', borderRadius: 4, marginLeft: 'auto',
                      background: ev.today_available === 'Yes' ? '#D1FAE5' : '#FEE2E2',
                      color: ev.today_available === 'Yes' ? '#065F46' : '#991B1B',
                    }}>
                      {ev.today_available === 'Yes' ? 'available' : 'unavailable'}
                    </span>
                    {ev.game_platform && ev.game_platform !== 'all' && (
                      <span style={{ fontSize: 9, fontWeight: 700, padding: '1px 4px', borderRadius: 4, background: '#E0E7FF', color: '#3730A3' }}>
                        {ev.game_platform}
                      </span>
                    )}
                  </label>
                ))}
              </div>
            )}
          </div>

          {message && (
            <p style={{ fontSize: 12, color: message.type === 'success' ? '#3D6B00' : '#b91c1c', fontWeight: 600 }}>
              {message.text}
            </p>
          )}

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" onClick={onClose}
              style={{ background: '#E8DCC8', color: '#5A3E1B', border: 'none', borderRadius: 7, padding: '6px 14px', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
              Cancel
            </button>
            <button type="submit"
              disabled={submitting || !selectedEvaluator || !startDate || !endDate || selectedCount === 0}
              style={{
                background: '#5A3E1B', color: '#fff', border: 'none', borderRadius: 7,
                padding: '6px 14px', fontSize: 12, fontWeight: 700,
                cursor: (submitting || !selectedEvaluator || !startDate || !endDate || selectedCount === 0) ? 'not-allowed' : 'pointer',
                opacity: (submitting || !selectedEvaluator || !startDate || !endDate || selectedCount === 0) ? 0.55 : 1,
              }}>
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

  // Clear activeKey once the workflow's realtime status transitions from running → idle
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
    <div className="space-y-4">
      <h1 className="font-extrabold text-2xl" style={{ color: '#2A1F08' }}>Operations</h1>

      {/* Die-Link row */}
      <div className="grid grid-cols-1 md:grid-cols-[2fr_3fr] gap-4 items-stretch">
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
        <div key={group.label} className="grid grid-cols-1 md:grid-cols-[2fr_3fr] gap-4 items-stretch">
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
