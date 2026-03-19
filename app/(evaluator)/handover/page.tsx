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
    <div className="space-y-8">
      <div>
        <h2 className="text-xl font-bold">Game List Handover</h2>
        <p className="text-gray-500 text-sm mt-1">Submit a request to redistribute your assigned games while you&apos;re unavailable.</p>
      </div>

      <form onSubmit={handleSubmit} className="bg-white rounded-lg border p-6 space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Evaluator Name</label>
          <input
            value={session?.user?.name ?? ''}
            disabled
            className="w-full border rounded-md px-3 py-2 text-sm bg-gray-50 text-gray-500"
          />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Start Date</label>
            <input
              type="date"
              value={startDate}
              onChange={e => setStartDate(e.target.value)}
              required
              className="w-full border rounded-md px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">End Date</label>
            <input
              type="date"
              value={endDate}
              onChange={e => setEndDate(e.target.value)}
              required
              className="w-full border rounded-md px-3 py-2 text-sm"
            />
          </div>
        </div>
        {message && (
          <p className={`text-sm ${message.type === 'success' ? 'text-green-600' : 'text-red-600'}`}>
            {message.text}
          </p>
        )}
        <button
          type="submit"
          disabled={submitting}
          className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white py-2 rounded-md text-sm font-medium"
        >
          {submitting ? 'Submitting...' : 'Submit Handover Request'}
        </button>
      </form>

      {history.length > 0 && (
        <div className="bg-white rounded-lg border p-6">
          <h3 className="font-medium mb-3">Handover History</h3>
          <ul className="space-y-2">
            {history.map(entry => (
              <li key={entry.id} className="flex justify-between text-sm border-b pb-2">
                <div>
                  <span className={entry.status === 'success' ? 'text-green-600' : entry.status === 'error' ? 'text-red-600' : 'text-yellow-600'}>
                    {entry.status === 'running' ? 'In Progress' : entry.status}
                  </span>
                  {entry.summary && (
                    <span className="text-gray-400 ml-2">· {entry.summary.games} games redistributed</span>
                  )}
                </div>
                <span className="text-gray-400">{new Date(entry.created_at).toLocaleDateString()}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
