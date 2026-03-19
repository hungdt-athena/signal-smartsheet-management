'use client'
import { useEffect, useState } from 'react'
import { EvaluatorTable } from '@/components/EvaluatorTable'

export default function TeamPage() {
  const [evaluators, setEvaluators] = useState([])
  const [loading, setLoading] = useState(true)

  async function fetchEvaluators() {
    const res = await fetch('/api/evaluators')
    if (res.ok) setEvaluators(await res.json())
    setLoading(false)
  }

  async function handleToggle(id: number, isAvailable: boolean) {
    await fetch(`/api/evaluators/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_available: isAvailable }),
    })
    fetchEvaluators()
  }

  useEffect(() => { fetchEvaluators() }, [])

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-bold">Team</h2>
      <div className="bg-white rounded-lg border p-6">
        {loading ? (
          <p className="text-gray-400 text-sm">Loading evaluators...</p>
        ) : (
          <EvaluatorTable evaluators={evaluators} onToggle={handleToggle} />
        )}
      </div>
    </div>
  )
}
