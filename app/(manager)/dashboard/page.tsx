'use client'
import { useEffect, useState, useRef } from 'react'
import { useSession } from 'next-auth/react'
import { FlowHistory } from '@/components/FlowHistory'
import { SmartsheetCapacity } from '@/components/SmartsheetCapacity'

interface PullCheckpoint { total: number | null; ios: number | null; android: number | null }
interface Stats {
  pull: { realtime: PullCheckpoint; morning: PullCheckpoint; afternoon: PullCheckpoint; delta: PullCheckpoint | null }
  push: { puzzle: number | null; arcade: number | null; simulation: number | null }
  workflows: Array<{ workflow_name: string; status: string; created_at: string }>
}

function fmt(n: number | null | undefined) {
  return n == null ? '—' : n.toLocaleString()
}

function PullCard({ label, data, live }: { label: string; data: PullCheckpoint; live?: boolean }) {
  return (
    <div className={`stat${live ? ' hi' : ''}`}>
      <div className="stat-top">
        <span className="stat-label">{label}</span>
        {live && (
          <span className="stat-live"><span className="dot" /> Live</span>
        )}
      </div>
      <span className="stat-num">{fmt(data.total)}</span>
      <div className="stat-split">
        <span className="split"><i>iOS</i> {fmt(data.ios)}</span>
        <span className="split"><i>Android</i> {fmt(data.android)}</span>
      </div>
    </div>
  )
}

function PushCard({ label, value, accent }: { label: string; value: number | null; accent?: boolean }) {
  return (
    <div className={`pstat${accent ? ' accent' : ''}`}>
      <span className="pstat-label">{label}</span>
      <span className="pstat-num">{fmt(value)}</span>
    </div>
  )
}

export default function DashboardPage() {
  const { data: session } = useSession()
  const isAdmin = session?.user?.role === 'admin'
  const [stats, setStats] = useState<Stats | null>(null)
  const [sheetStats, setSheetStats] = useState<unknown[]>([])
  const [pullRefreshing, setPullRefreshing] = useState(false)
  const intervalRef = useRef<NodeJS.Timeout>()

  async function refreshPullLog() {
    setPullRefreshing(true)
    try {
      await fetch('/api/flow-logs/refresh', { method: 'POST' })
      await fetchData()
    } finally {
      setPullRefreshing(false)
    }
  }

  async function fetchData() {
    const [statsRes, sheetsRes] = await Promise.all([
      fetch('/api/stats', { cache: 'no-store' }),
      fetch('/api/smartsheet-sheets', { cache: 'no-store' }),
    ])
    if (statsRes.status === 401) {
      window.location.href = '/login'
      return
    }
    if (statsRes.ok) setStats(await statsRes.json())
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
    <div className="page">
      <div className="page-head">
        <h1 className="h-title">Game Ops Dashboard</h1>
      </div>

      {/* Pull Stats */}
      <div className="card">
        <div className="card-head">
          <span className="card-label">Pull Stats</span>
          <button className="btn btn-sm" onClick={refreshPullLog} disabled={pullRefreshing}>
            <span className={pullRefreshing ? 'spin' : ''}>↻</span>
            {pullRefreshing ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>
        <div className="stat-row">
          <PullCard label="Realtime"  data={pull?.realtime ?? { total: null, ios: null, android: null }} live />
          <PullCard label="Morning"   data={pull?.morning  ?? { total: null, ios: null, android: null }} />
          <PullCard label="Afternoon" data={pull?.delta    ?? { total: null, ios: null, android: null }} />
        </div>
      </div>

      {/* Push Stats */}
      <div className="card">
        <div className="card-head">
          <span className="card-label">Push Stats</span>
        </div>
        <div className="push-row">
          <PushCard label="Total"      value={pushTotal || null} accent />
          <PushCard label="Puzzle"     value={push?.puzzle ?? null} />
          <PushCard label="Arcade"     value={push?.arcade ?? null} />
          <PushCard label="Simulation" value={push?.simulation ?? null} />
        </div>
      </div>

      {/* Smartsheet Capacity */}
      <div className="card">
        <SmartsheetCapacity
          sheets={sheetStats as Parameters<typeof SmartsheetCapacity>[0]['sheets']}
          onRefresh={fetchData}
          isAdmin={isAdmin}
        />
      </div>

      {/* Games History */}
      <div className="card">
        <FlowHistory />
      </div>
    </div>
  )
}
