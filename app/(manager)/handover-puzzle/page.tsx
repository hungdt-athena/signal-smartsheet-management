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

function StatusBadge({ status }: { status: string }) {
  const s = status.toLowerCase()
  const cls = s === 'success' ? 'success' : s === 'error' ? 'error' : s === 'running' ? 'running' : 'idle'
  const label = s === 'success' ? 'Success' : s === 'error' ? 'Error' : s === 'running' ? 'Running' : (status || 'Unknown')
  return <span className={`badge ${cls}`}>{label}</span>
}

function isInRange(startDate: string, endDate: string): boolean {
  const today = new Date().toISOString().split('T')[0]
  return today >= startDate && today <= endDate
}

export default function HandoverPuzzlePage() {
  const { data: session } = useSession()
  const isAdmin = session?.user?.role === 'admin' || session?.user?.role === 'moderator'
  const userName = session?.user?.name || ''

  const [history, setHistory] = useState<HandoverRow[]>([])
  const [evaluators, setEvaluators] = useState<Evaluator[]>([])
  const [loading, setLoading] = useState(false)
  const [loadingEvals, setLoadingEvals] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [selectedEvaluator, setSelectedEvaluator] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [sheetType, setSheetType] = useState('Puzzle smartsheet ID')
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

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
    if (!isAdmin) return
    setLoadingEvals(true)
    try {
      const res = await fetch('/api/team/initial', { cache: 'no-store' })
      if (!res.ok) throw new Error('Failed to load')
      setEvaluators(await res.json())
    } catch { /* non-blocking */ }
    finally { setLoadingEvals(false) }
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

  return (
    <div className="page">
      <div className="page-head">
        <h1 className="h-title">Handover</h1>
      </div>

      {/* Submit Form */}
      <div className="card">
        <div className="card-head">
          <span className="card-label">Submit Handover Request</span>
        </div>
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 12 }}>
            <div className="field">
              <span className="label">Evaluator Name</span>
              {isAdmin ? (
                <StyledSelect
                  value={selectedEvaluator}
                  onChange={setSelectedEvaluator}
                  options={evaluators.map(ev => ({ value: ev.name, label: ev.name }))}
                  placeholder={loadingEvals ? 'Loading...' : '-- Select --'}
                  disabled={loadingEvals}
                />
              ) : (
                <input value={userName} disabled className="input" />
              )}
            </div>
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
            <div className="field">
              <span className="label">Sheet Type</span>
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
            <p className={message.type === 'success' ? 'msg-ok' : 'msg-err'}>{message.text}</p>
          )}

          <div>
            <button type="submit" className="btn btn-primary"
              disabled={submitting || !selectedEvaluator || !startDate || !endDate}>
              {submitting ? 'Submitting...' : 'Submit Handover'}
            </button>
          </div>
        </form>
      </div>

      {/* History Table */}
      <div className="card">
        <div className="card-head">
          <span className="card-label">Handover History</span>
          <button className="btn btn-sm" onClick={refreshHistory} disabled={loading}>
            <span className={loading ? 'spin' : ''}>↻</span>
            {loading ? 'Loading...' : 'Refresh'}
          </button>
        </div>

        {error && <p className="msg-err" style={{ marginBottom: 8 }}>{error}</p>}

        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Date</th>
                <th>Evaluator Name</th>
                <th>Start Date</th>
                <th>End Date</th>
                <th>Sheet</th>
                <th>Status</th>
                <th>Active</th>
              </tr>
            </thead>
            <tbody>
              {history.length === 0 && !loading && (
                <tr><td colSpan={7} className="empty">No handover records yet</td></tr>
              )}
              {loading && (
                <tr><td colSpan={7} className="empty">Loading...</td></tr>
              )}
              {!loading && history.map(row => (
                <tr key={row.row_index}>
                  <td>{row.date}</td>
                  <td className="cell-name">{row.evaluatorName}</td>
                  <td>{row.startDate}</td>
                  <td>{row.endDate}</td>
                  <td>
                    <span className="pill muted" style={{ fontSize: 11 }}>
                      {row.sheetType?.replace(' smartsheet ID', '') || '—'}
                    </span>
                  </td>
                  <td><StatusBadge status={row.status} /></td>
                  <td>
                    {isInRange(row.startDate, row.endDate) ? (
                      <span className="badge running">On Leave</span>
                    ) : (
                      <span style={{ fontSize: 12, color: 'var(--faint)' }}>—</span>
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
