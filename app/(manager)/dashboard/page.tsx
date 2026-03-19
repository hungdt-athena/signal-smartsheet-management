'use client'
import { useEffect, useState, useRef } from 'react'
import { StatsCard } from '@/components/StatsCard'
import { ActivityFeed } from '@/components/ActivityFeed'

export default function DashboardPage() {
  const [stats, setStats] = useState<Record<string, unknown> | null>(null)
  const [logs, setLogs] = useState<unknown[]>([])
  const intervalRef = useRef<NodeJS.Timeout>()

  async function fetchData() {
    const [statsRes, logsRes] = await Promise.all([
      fetch('/api/stats'),
      fetch('/api/logs'),
    ])
    if (statsRes.ok) setStats(await statsRes.json())
    if (logsRes.ok) setLogs(await logsRes.json())
  }

  useEffect(() => {
    fetchData()
    intervalRef.current = setInterval(fetchData, 60000)
    return () => clearInterval(intervalRef.current)
  }, [])

  const today = (stats as { today?: Record<string, number> })?.today ?? {}
  const workflows = (stats as { workflows?: unknown[] })?.workflows ?? []

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-bold">Dashboard</h2>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatsCard label="Pulled Today" value={today.games_pulled ?? 0} />
        <StatsCard label="Pushed Today" value={today.games_pushed ?? 0} />
        <StatsCard label="Total Imported" value={today.total ?? 0} sub={`iOS: ${today.ios ?? 0} · Android: ${today.android ?? 0}`} />
        <StatsCard label="By Category" value={`P:${today.puzzle ?? 0} A:${today.arcade ?? 0} S:${today.sim ?? 0}`} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-white rounded-lg border p-4">
          <h3 className="font-medium mb-3">Workflow Status</h3>
          <ul className="space-y-2">
            {(workflows as Array<{ workflow_name: string; status: string; created_at: string }>).map(w => (
              <li key={w.workflow_name} className="flex justify-between text-sm">
                <span className="text-gray-600">{w.workflow_name}</span>
                <span className={w.status === 'success' ? 'text-green-600' : w.status === 'error' ? 'text-red-600' : 'text-yellow-600'}>
                  {w.status}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="bg-white rounded-lg border p-4">
          <h3 className="font-medium mb-3">Recent Activity</h3>
          <ActivityFeed logs={logs as Parameters<typeof ActivityFeed>[0]['logs']} />
        </div>
      </div>
    </div>
  )
}
