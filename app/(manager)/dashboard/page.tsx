'use client'
import { useEffect, useState, useRef } from 'react'
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

function PullCard({ label, data, img, highlight }: { label: string; data: PullCheckpoint; img: string; highlight?: boolean }) {
  return (
    <div className="bean-card-inner flex flex-col justify-between relative overflow-hidden" style={{
      minHeight: 140,
      padding: '12px 14px',
      ...(highlight ? { borderColor: '#5A6A10', background: '#E8F5C8' } : {})
    }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={img} alt="" className="absolute right-1 bottom-1 w-20 h-20 object-contain pointer-events-none select-none" />
      <span className="font-extrabold text-sm relative z-10" style={{ color: '#2A1F08' }}>{label}</span>
      <p className="bean-number relative z-10" style={{ fontSize: '2rem', ...(highlight ? { color: '#3A6010' } : {}) }}>{fmt(data.total)}</p>
      <div className="flex gap-3 relative z-10">
        <span className="text-xs font-semibold" style={{ color: '#6B5A3A' }}>iOS {fmt(data.ios)}</span>
        <span className="text-xs font-semibold" style={{ color: '#6B5A3A' }}>Android {fmt(data.android)}</span>
      </div>
    </div>
  )
}

function PushCard({ label, value, img }: { label: string; value: number | null; img: string }) {
  return (
    <div className="bean-card-inner flex flex-col justify-between relative overflow-hidden" style={{ minHeight: 140, padding: '12px 14px' }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={img} alt="" className="absolute right-1 bottom-1 w-20 h-20 object-contain pointer-events-none select-none" />
      <span className="font-extrabold text-sm relative z-10" style={{ color: '#2A1F08' }}>{label}</span>
      <p className="bean-number relative z-10" style={{ fontSize: '2rem' }}>{fmt(value)}</p>
    </div>
  )
}

export default function DashboardPage() {
  const [stats, setStats] = useState<Stats | null>(null)
  const [flowHistory, setFlowHistory] = useState<unknown[]>([])
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
    <div className="space-y-4 w-full">

      {/* Title */}
      <h1 className="font-extrabold text-2xl" style={{ color: '#2A1F08' }}>Game Ops Dashboard</h1>

      {/* Pull + Push */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

        {/* Pull */}
        <div className="bean-card p-4">
          <div className="flex items-center justify-between mb-3">
            <p className="bean-section-label">Pull Stats</p>
            <button
              onClick={refreshPullLog}
              disabled={pullRefreshing}
              className="flex items-center gap-1 text-xs font-semibold px-2 py-1 rounded-lg transition-all"
              style={{ background: '#D4C4A0', color: '#5A3E1B', opacity: pullRefreshing ? 0.6 : 1 }}
            >
              <span className={pullRefreshing ? 'inline-block animate-spin' : 'inline-block'}>↻</span>
              {pullRefreshing ? 'Refreshing...' : 'Refresh'}
            </button>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <PullCard label="Realtime"  data={pull?.realtime ?? { total: null, ios: null, android: null }} img="/stickers/realtime-card.png" highlight />
            <PullCard label="Morning"   data={pull?.morning  ?? { total: null, ios: null, android: null }} img="/stickers/morning-card.png" />
            <PullCard label="Afternoon" data={pull?.delta    ?? { total: null, ios: null, android: null }} img="/stickers/afternoon-card.png" />
          </div>
        </div>

        {/* Push */}
        <div className="bean-card p-4">
          <p className="bean-section-label mb-3">Push Stats</p>
          <div className="grid grid-cols-4 gap-2">
            <PushCard label="Total pushed"     value={pushTotal || null}        img="/stickers/realtime-card.png" />
            <PushCard label="Puzzle Sheet"     value={push?.puzzle ?? null}     img="/stickers/puzzle-push.png" />
            <PushCard label="Arcade Sheet"     value={push?.arcade ?? null}     img="/stickers/arcade-push.png" />
            <PushCard label="Simulation Sheet" value={push?.simulation ?? null} img="/stickers/simulation-push.png" />
          </div>
        </div>
      </div>

      {/* Smartsheet Capacity */}
      <div className="bean-card p-4">
        <SmartsheetCapacity
          sheets={sheetStats as Parameters<typeof SmartsheetCapacity>[0]['sheets']}
          onRefresh={fetchData}
        />
      </div>

      {/* Games History */}
      <div className="bean-card p-4">
        <p className="bean-section-label mb-3">Games History</p>
        <FlowHistory entries={flowHistory as Parameters<typeof FlowHistory>[0]['entries']} />
      </div>

    </div>
  )
}
