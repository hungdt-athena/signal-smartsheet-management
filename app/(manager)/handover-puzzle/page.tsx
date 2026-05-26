'use client'
import { useState, useCallback, useEffect } from 'react'
import { useSession } from 'next-auth/react'
import { StyledSelect } from '@/components/StyledSelect'

interface HandoverRow {
  row_index: number
  date: string
  evaluatorName: string
  startDate: string
  endDate: string
  sheetType: string
  status: string
}

interface Evaluator {
  row_number: number
  name: string
  today_available: 'Yes' | 'No'
  game_platform: string
}

function Btn({
  onClick, disabled, children, variant = 'default',
}: {
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
  variant?: 'default' | 'danger' | 'primary'
}) {
  const bg = variant === 'danger' ? '#b91c1c' : variant === 'primary' ? '#5A3E1B' : '#D4C4A0'
  const color = variant === 'default' ? '#5A3E1B' : '#fff'
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        background: bg, color, border: 'none', borderRadius: 7,
        padding: '3px 10px', fontSize: 12, fontWeight: 700,
        cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.55 : 1,
      }}
    >{children}</button>
  )
}

function StatusBadge({ status }: { status: string }) {
  const s = status.toLowerCase()
  const config = s === 'success'
    ? { bg: '#E8F5C8', color: '#3D6B00', label: 'Success' }
    : s === 'error'
    ? { bg: '#FEE2E2', color: '#b91c1c', label: 'Error' }
    : s === 'running'
    ? { bg: '#FEF9C3', color: '#854D0E', label: 'Running' }
    : { bg: '#F3F4F6', color: '#6B7280', label: status || 'Unknown' }

  return (
    <span style={{
      background: config.bg, color: config.color,
      padding: '2px 8px', borderRadius: 6, fontSize: 11, fontWeight: 700,
    }}>
      {config.label}
    </span>
  )
}

function isInRange(startDate: string, endDate: string): boolean {
  const today = new Date().toISOString().split('T')[0]
  return today >= startDate && today <= endDate
}

export default function HandoverPuzzlePage() {
  const { data: session } = useSession()
  const isAdmin = session?.user?.role === 'admin'
  const userName = session?.user?.name || ''

  const [history, setHistory] = useState<HandoverRow[]>([])
  const [evaluators, setEvaluators] = useState<Evaluator[]>([])
  const [loading, setLoading] = useState(false)
  const [loadingEvals, setLoadingEvals] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Form state — evaluator name locked for evaluator role
  const [selectedEvaluator, setSelectedEvaluator] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [sheetType, setSheetType] = useState('Puzzle smartsheet ID')
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  // Lock evaluator name for evaluator role
  useEffect(() => {
    if (!isAdmin && userName) setSelectedEvaluator(userName)
  }, [isAdmin, userName])

  const refreshHistory = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/handover-puzzle', { cache: 'no-store' })
      if (!res.ok) throw new Error('Failed to load')
      const data = await res.json()
      setHistory(data.reverse())
    } catch {
      setError('Failed to load handover history.')
    } finally {
      setLoading(false)
    }
  }, [])

  const loadEvaluators = useCallback(async () => {
    if (!isAdmin) return // evaluators don't need the list
    setLoadingEvals(true)
    try {
      const res = await fetch('/api/team/initial', { cache: 'no-store' })
      if (!res.ok) throw new Error('Failed to load')
      setEvaluators(await res.json())
    } catch {
      // Non-blocking error
    } finally {
      setLoadingEvals(false)
    }
  }, [isAdmin])

  useEffect(() => {
    refreshHistory()
    loadEvaluators()
  }, [refreshHistory, loadEvaluators])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!selectedEvaluator || !startDate || !endDate || !sheetType) return
    setSubmitting(true)
    setMessage(null)

    try {
      const res = await fetch('/api/handover-puzzle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          evaluator_name: selectedEvaluator,
          start_date: startDate,
          end_date: endDate,
          sheet_type: sheetType,
        }),
      })

      if (res.ok) {
        setMessage({ type: 'success', text: `Handover submitted for ${selectedEvaluator}. Games will be redistributed.` })
        setSelectedEvaluator('')
        setStartDate('')
        setEndDate('')
        setSheetType('Puzzle smartsheet ID')
        refreshHistory()
        loadEvaluators()
      } else {
        const body = await res.json()
        setMessage({ type: 'error', text: body.error ?? 'Submission failed' })
      }
    } catch {
      setMessage({ type: 'error', text: 'Network error' })
    } finally {
      setSubmitting(false)
    }
  }

  const thStyle: React.CSSProperties = { padding: '6px 10px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#6B5A3A', background: '#D4C4A0', borderBottom: '2px solid #C8B896' }
  const tdStyle: React.CSSProperties = { padding: '6px 10px', fontSize: 12, color: '#2A1F08', borderBottom: '1px solid #EFE3C8' }

  return (
    <div className="space-y-4 w-full">
      <h1 className="font-extrabold text-2xl" style={{ color: '#2A1F08' }}>Handover</h1>

      {/* Submit Form */}
      <div className="bean-card p-4">
        <p className="bean-section-label" style={{ marginBottom: 10 }}>Submit Handover Request</p>
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 12 }}>
            <div>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: '#6B5A3A', marginBottom: 4 }}>
                Evaluator Name
              </label>
              {isAdmin ? (
              <StyledSelect
                value={selectedEvaluator}
                onChange={setSelectedEvaluator}
                options={evaluators.map(ev => ({ value: ev.name, label: ev.name }))}
                placeholder={loadingEvals ? 'Loading...' : '-- Select --'}
                disabled={loadingEvals}
              />
              ) : (
              <input
                value={userName}
                disabled
                style={{
                  width: '100%', border: '1px solid #D4C4A0', borderRadius: 6,
                  padding: '6px 8px', fontSize: 12, background: '#EFE3C8', color: '#2A1F08', fontWeight: 600,
                }}
              />
              )}
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: '#6B5A3A', marginBottom: 4 }}>
                Start Date
              </label>
              <input
                type="date"
                value={startDate}
                onChange={e => setStartDate(e.target.value)}
                required
                style={{
                  width: '100%', border: '1px solid #D4C4A0', borderRadius: 6,
                  padding: '6px 8px', fontSize: 12, background: '#FAF5EC', color: '#2A1F08',
                }}
              />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: '#6B5A3A', marginBottom: 4 }}>
                End Date
              </label>
              <input
                type="date"
                value={endDate}
                onChange={e => setEndDate(e.target.value)}
                required
                style={{
                  width: '100%', border: '1px solid #D4C4A0', borderRadius: 6,
                  padding: '6px 8px', fontSize: 12, background: '#FAF5EC', color: '#2A1F08',
                }}
              />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: '#6B5A3A', marginBottom: 4 }}>
                Sheet Type
              </label>
              <StyledSelect
                value={sheetType}
                onChange={setSheetType}
                options={[
                  { value: 'Puzzle smartsheet ID', label: 'Puzzle' },
                  { value: 'Arcade smartsheet ID', label: 'Arcade' },
                  { value: 'Simulation smartsheet ID', label: 'Simulation' },
                ]}
              />
            </div>
          </div>

          {message && (
            <p style={{ fontSize: 12, color: message.type === 'success' ? '#3D6B00' : '#b91c1c', fontWeight: 600 }}>
              {message.text}
            </p>
          )}

          <div>
            <button
              type="submit"
              disabled={submitting || !selectedEvaluator || !startDate || !endDate}
              style={{
                background: '#5A3E1B', color: '#fff', border: 'none', borderRadius: 7,
                padding: '6px 16px', fontSize: 12, fontWeight: 700,
                cursor: submitting ? 'not-allowed' : 'pointer',
                opacity: (submitting || !selectedEvaluator || !startDate || !endDate) ? 0.55 : 1,
              }}
            >
              {submitting ? 'Submitting...' : 'Submit Handover'}
            </button>
          </div>
        </form>
      </div>

      {/* History Table */}
      <div className="bean-card p-4">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <p className="bean-section-label">Handover History</p>
          <Btn onClick={refreshHistory} disabled={loading}>
            <span style={{ display: 'inline-block', animation: loading ? 'spin 1s linear infinite' : 'none' }}>&#8635;</span>
            {' '}{loading ? 'Loading...' : 'Refresh'}
          </Btn>
        </div>

        {error && <p style={{ fontSize: 11, color: '#b91c1c', marginBottom: 6 }}>{error}</p>}

        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr>
                <th style={thStyle}>Date</th>
                <th style={thStyle}>Evaluator Name</th>
                <th style={thStyle}>Start Date</th>
                <th style={thStyle}>End Date</th>
                <th style={thStyle}>Sheet</th>
                <th style={thStyle}>Status</th>
                <th style={thStyle}>Active</th>
              </tr>
            </thead>
            <tbody>
              {history.length === 0 && !loading && (
                <tr><td colSpan={7} style={{ ...tdStyle, color: '#9A8A6A', textAlign: 'center', padding: 16 }}>
                  No handover records yet
                </td></tr>
              )}
              {loading && (
                <tr><td colSpan={7} style={{ ...tdStyle, color: '#9A8A6A', textAlign: 'center', padding: 16 }}>
                  Loading...
                </td></tr>
              )}
              {!loading && history.map(row => (
                <tr key={row.row_index}>
                  <td style={tdStyle}>{row.date}</td>
                  <td style={{ ...tdStyle, fontWeight: 600 }}>{row.evaluatorName}</td>
                  <td style={tdStyle}>{row.startDate}</td>
                  <td style={tdStyle}>{row.endDate}</td>
                  <td style={tdStyle}>
                    <span style={{ fontSize: 11, color: '#6B5A3A', fontWeight: 600 }}>
                      {row.sheetType?.replace(' smartsheet ID', '') || '—'}
                    </span>
                  </td>
                  <td style={tdStyle}><StatusBadge status={row.status} /></td>
                  <td style={tdStyle}>
                    {isInRange(row.startDate, row.endDate) ? (
                      <span style={{ background: '#FEF9C3', color: '#854D0E', padding: '2px 8px', borderRadius: 6, fontSize: 11, fontWeight: 700 }}>
                        On Leave
                      </span>
                    ) : (
                      <span style={{ fontSize: 11, color: '#9A8A6A' }}>--</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
