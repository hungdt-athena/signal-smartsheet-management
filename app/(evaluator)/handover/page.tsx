'use client'
import { useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'

interface HandoverEntry {
  id: number
  status: string
  summary?: { from: string; to: string[]; games: number }
  created_at: string
}

export default function HandoverPage() {
  const { data: session } = useSession()
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [history, setHistory] = useState<HandoverEntry[]>([])

  async function fetchHistory() {
    const res = await fetch('/api/handover')
    if (res.ok) setHistory(await res.json())
  }

  useEffect(() => { fetchHistory() }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setMessage(null)

    const res = await fetch('/api/handover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ start_date: startDate, end_date: endDate }),
    })

    if (res.ok) {
      setMessage({ type: 'success', text: 'Handover request submitted. Your games will be redistributed shortly.' })
      setStartDate('')
      setEndDate('')
      fetchHistory()
    } else {
      const body = await res.json()
      setMessage({ type: 'error', text: body.error ?? 'Submission failed' })
    }
    setSubmitting(false)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div>
        <h2 style={{ fontSize: 18, fontWeight: 700, color: 'var(--text)', margin: 0 }}>Game List Handover</h2>
        <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>
          Submit a request to redistribute your assigned games while you&apos;re unavailable.
        </p>
      </div>

      <div className="card">
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="field">
            <span className="label">Evaluator Name</span>
            <input
              value={session?.user?.name ?? ''}
              disabled
              className="input"
            />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div className="field">
              <span className="label">Start Date</span>
              <input
                type="date"
                value={startDate}
                onChange={e => setStartDate(e.target.value)}
                required
                className="input"
              />
            </div>
            <div className="field">
              <span className="label">End Date</span>
              <input
                type="date"
                value={endDate}
                onChange={e => setEndDate(e.target.value)}
                required
                className="input"
              />
            </div>
          </div>
          {message && (
            <p className={message.type === 'success' ? 'msg-ok' : 'msg-err'}>{message.text}</p>
          )}
          <button type="submit" className="btn btn-primary" disabled={submitting}
            style={{ width: '100%', justifyContent: 'center' }}>
            {submitting ? 'Submitting...' : 'Submit Handover Request'}
          </button>
        </form>
      </div>

      {history.length > 0 && (
        <div className="card">
          <div className="card-head">
            <span className="card-label">Handover History</span>
          </div>
          <div>
            {history.map(entry => {
              const statusCls = entry.status === 'success' ? 'success' : entry.status === 'error' ? 'error' : 'running'
              return (
                <div key={entry.id} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '10px 2px', borderBottom: '1px solid var(--border)',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span className={`badge ${statusCls}`}>
                      {entry.status === 'running' ? 'In Progress' : entry.status}
                    </span>
                    {entry.summary && (
                      <span style={{ fontSize: 12, color: 'var(--faint)' }}>
                        · {entry.summary.games} games redistributed
                      </span>
                    )}
                  </div>
                  <span style={{ fontSize: 12, color: 'var(--faint)' }}>
                    {new Date(entry.created_at).toLocaleDateString()}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
