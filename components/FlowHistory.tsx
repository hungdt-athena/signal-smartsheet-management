'use client'
import { useState } from 'react'

interface FlowEntry {
  log_date: string
  flow_type: 'pull' | 'push'
  period: 'morning' | 'afternoon'
  total: number
  created_at: string
  detail: Record<string, number>
}

const PULL_LABELS: Record<string, string> = { ios: 'iOS', android: 'Android' }
const PUSH_ORDER = ['puzzle', 'arcade', 'simulation']

function toVNTime(iso: string) {
  return new Date(iso).toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit' })
}

function toVNDate(dateStr: string) {
  const d = new Date(dateStr + 'T00:00:00+07:00')
  return d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' })
}

function isToday(dateStr: string) {
  return dateStr === new Date().toISOString().slice(0, 10)
}

function EntryRow({ entry }: { entry: FlowEntry }) {
  const [open, setOpen] = useState(false)
  const isPull = entry.flow_type === 'pull'
  const periodLabel = entry.period === 'morning' ? 'Sáng' : 'Chiều'
  const typeLabel = isPull ? 'Pull' : 'Push'
  const badgeColor = isPull ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'
  const periodColor = entry.period === 'morning' ? 'text-amber-600' : 'text-indigo-600'
  const detailKeys = isPull ? Object.keys(entry.detail) : PUSH_ORDER.filter(k => k in entry.detail)

  return (
    <div className="border border-gray-100 rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-gray-50 transition-colors text-left"
      >
        <div className="flex items-center gap-2.5">
          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${badgeColor}`}>{typeLabel}</span>
          <span className={`text-sm font-medium ${periodColor}`}>{periodLabel}</span>
          <span className="text-xs text-gray-400">{toVNTime(entry.created_at)}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold text-gray-900">{entry.total.toLocaleString()} games</span>
          <span className={`text-gray-400 text-xs transition-transform ${open ? 'rotate-180' : ''}`}>▾</span>
        </div>
      </button>
      {open && (
        <div className="border-t border-gray-100 px-4 py-2.5 bg-gray-50 flex flex-wrap gap-4">
          {detailKeys.map(key => (
            <div key={key} className="text-sm">
              <span className="text-gray-400 capitalize">{isPull ? (PULL_LABELS[key] ?? key) : key}:</span>{' '}
              <span className="font-semibold text-gray-800">{entry.detail[key].toLocaleString()}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function FlowHistory({ entries }: { entries: FlowEntry[] }) {
  if (entries.length === 0) return <p className="text-sm text-gray-400">Chưa có dữ liệu.</p>

  // Group by log_date
  const byDate: Record<string, FlowEntry[]> = {}
  for (const e of entries) {
    if (!byDate[e.log_date]) byDate[e.log_date] = []
    byDate[e.log_date].push(e)
  }

  return (
    <div className="space-y-4">
      {Object.entries(byDate).map(([date, dayEntries]) => (
        <div key={date}>
          <p className="text-xs font-medium text-gray-400 mb-2">
            {isToday(date) ? 'Hôm nay' : toVNDate(date)}
          </p>
          <div className="space-y-1.5">
            {dayEntries.map(e => (
              <EntryRow key={`${e.flow_type}-${e.period}`} entry={e} />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
