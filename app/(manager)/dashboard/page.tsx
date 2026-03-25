'use client'
import { useEffect, useState, useRef } from 'react'
import { FlowHistory } from '@/components/FlowHistory'
import { SmartsheetCapacity } from '@/components/SmartsheetCapacity'

interface PullCheckpoint {
  total: number | null
  ios: number | null
  android: number | null
}

interface Stats {
  pull: {
    realtime: PullCheckpoint
    morning: PullCheckpoint
    afternoon: PullCheckpoint
    delta: PullCheckpoint | null
  }
  push: {
    puzzle: number | null
    arcade: number | null
    simulation: number | null
  }
  workflows: Array<{ workflow_name: string; status: string; created_at: string }>
}

function fmt(n: number | null | undefined) {
  return n == null ? '—' : n.toLocaleString()
}


function PullCard({ label, data, highlight }: { label: string; data: PullCheckpoint; highlight?: boolean }) {
  return (
    <div className={`rounded-lg border p-4 ${highlight ? 'bg-blue-50 border-blue-200' : 'bg-white border-gray-200'}`}>
      <p className="text-xs text-gray-500 mb-2">{label}</p>
      <p className={`text-2xl font-bold ${highlight ? 'text-blue-700' : 'text-gray-900'}`}>{fmt(data.total)}</p>
      <div className="flex gap-3 mt-1">
        <span className="text-xs text-gray-400">iOS {fmt(data.ios)}</span>
        <span className="text-xs text-gray-400">Android {fmt(data.android)}</span>
      </div>
    </div>
  )
}

export default function DashboardPage() {
  const [stats, setStats] = useState<Stats | null>(null)
  const [flowHistory, setFlowHistory] = useState<unknown[]>([])
  const [sheetStats, setSheetStats] = useState<unknown[]>([])
  const intervalRef = useRef<NodeJS.Timeout>()

  async function fetchData() {
    const [statsRes, historyRes, sheetsRes] = await Promise.all([
      fetch('/api/stats'),
      fetch('/api/flow-logs'),
      fetch('/api/smartsheet-sheets'),
    ])
    if (statsRes.ok) setStats(await statsRes.json())
    if (historyRes.ok) setFlowHistory(await historyRes.json())
    if (sheetsRes.ok) setSheetStats(await sheetsRes.json())
  }

  useEffect(() => {
    fetchData()
    intervalRef.current = setInterval(fetchData, 60000)
    return () => clearInterval(intervalRef.current)
  }, [])

  const pull = stats?.pull
  const push = stats?.push
  const pushTotal = (push?.puzzle ?? 0) + (push?.arcade ?? 0) + (push?.simulation ?? 0)

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-bold text-gray-900">Dashboard</h2>

      {/* Pull Section */}
      <div>
        <h3 className="text-sm font-medium text-gray-500 mb-3 uppercase tracking-wide">Pull — Games in DB today</h3>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          <PullCard label="Realtime" data={pull?.realtime ?? { total: null, ios: null, android: null }} highlight />
          <PullCard label="Morning" data={pull?.morning ?? { total: null, ios: null, android: null }} />
          <PullCard label="Afternoon" data={pull?.delta ?? { total: null, ios: null, android: null }} />
        </div>
      </div>

      {/* Push Section */}
      <div>
        <h3 className="text-sm font-medium text-gray-500 mb-3 uppercase tracking-wide">Push — Smartsheet today</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="rounded-lg border border-gray-200 bg-white p-4">
            <p className="text-xs text-gray-500 mb-2">Total pushed</p>
            <p className="text-2xl font-bold text-gray-900">{fmt(pushTotal || null)}</p>
          </div>
          {(['puzzle', 'arcade', 'simulation'] as const).map(sheet => (
            <div key={sheet} className="rounded-lg border border-gray-200 bg-white p-4">
              <p className="text-xs text-gray-500 mb-2 capitalize">{sheet}</p>
              <p className="text-2xl font-bold text-gray-900">{fmt(push?.[sheet])}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Smartsheet Capacity */}
      <SmartsheetCapacity
        sheets={sheetStats as Parameters<typeof SmartsheetCapacity>[0]['sheets']}
        onRefresh={fetchData}
      />

      {/* Games History */}
      <div>
        <h3 className="text-sm font-medium text-gray-500 mb-3 uppercase tracking-wide">Games History</h3>
        <FlowHistory entries={flowHistory as Parameters<typeof FlowHistory>[0]['entries']} />
      </div>

    </div>
  )
}
