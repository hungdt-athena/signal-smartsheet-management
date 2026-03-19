'use client'
import { useState } from 'react'

interface TriggerResult {
  status: 'success' | 'error'
  summary?: Record<string, unknown>
  error_message?: string
}

interface TriggerButtonProps {
  label: string
  workflow: string
}

export function TriggerButton({ label, workflow }: TriggerButtonProps) {
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<TriggerResult | null>(null)

  async function handleClick() {
    setLoading(true)
    setResult(null)

    try {
      const res = await fetch('/api/workflows/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflow }),
      })

      if (!res.ok) {
        const body = await res.json()
        setResult({ status: 'error', error_message: body.error ?? 'Failed to trigger workflow' })
        setLoading(false)
        return
      }

      const { triggered_at } = await res.json()

      // Poll for result
      const poll = setInterval(async () => {
        const logRes = await fetch(`/api/logs?workflow=${workflow}&since=${triggered_at}`)
        const logs = await logRes.json()
        const done = logs.find((l: { status: string }) => l.status !== 'running')
        if (done) {
          clearInterval(poll)
          setResult({ status: done.status, summary: done.summary, error_message: done.error_message })
          setLoading(false)
        }
      }, 5000)

      // Stop polling after 10 minutes
      setTimeout(() => { clearInterval(poll); setLoading(false) }, 600000)
    } catch {
      setResult({ status: 'error', error_message: 'Network error' })
      setLoading(false)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <button
        onClick={handleClick}
        disabled={loading}
        className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white px-4 py-2 rounded-md text-sm font-medium"
      >
        {loading ? (
          <><span className="animate-spin">⟳</span> Running...</>
        ) : (
          <>▶ {label}</>
        )}
      </button>
      {result && (
        <p className={`text-xs ${result.status === 'success' ? 'text-green-600' : 'text-red-600'}`}>
          {result.status === 'success'
            ? `✓ Done — ${JSON.stringify(result.summary)}`
            : `✗ Error — ${result.error_message}`}
        </p>
      )}
    </div>
  )
}
