'use client'
import { useState } from 'react'

interface FlowEntry {
  flow_type: 'pull' | 'push'
  period: 'morning' | 'afternoon'
  total: number
  created_at: string
  detail: Record<string, number>
}

const PULL_DETAIL_LABELS: Record<string, string> = { ios: 'iOS', android: 'Android' }
const PUSH_DETAIL_ORDER = ['puzzle', 'arcade', 'simulation']

function toVNTime(iso: string) {
  return new Date(iso).toLocaleTimeString('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function EntryRow({ entry }: { entry: FlowEntry }) {
  const [open, setOpen] = useState(false)
  const isPull = entry.flow_type === 'pull'
  const periodLabel = entry.period === 'morning' ? 'Sáng' : 'Chiều'
  const typeLabel = isPull ? 'Pull' : 'Push'
  const badgeColor = isPull
    ? 'bg-blue-100 text-blue-700'
    : 'bg-purple-100 text-purple-700'
  const periodColor = entry.period === 'morning'
    ? 'text-amber-600'
    : 'text-indigo-600'

  const detailKeys = isPull
    ? Object.keys(entry.detail)
    : PUSH_DETAIL_ORDER.filter(k => k in entry.detail)

  return (
    <div className="border border-gray-100 rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-50 transition-colors text-left"
      >
        <div className="flex items-center gap-3">
          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${badgeColor}`}>{typeLabel}</span>
          <span className={`text-sm font-medium ${periodColor}`}>{periodLabel}</span>
          <span className="text-sm text-gray-500">{toVNTime(entry.created_at)}</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm font-bold text-gray-900">{entry.total.toLocaleString()} games</span>
          <span className={`text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`}>▾</span>
        </div>
      </button>

      {open && (
        <div className="border-t border-gray-100 px-4 py-3 bg-gray-50 flex flex-wrap gap-4">
          {detailKeys.map(key => (
            <div key={key} className="text-sm">
              <span className="text-gray-400 capitalize">
                {isPull ? (PULL_DETAIL_LABELS[key] ?? key) : key}:
              </span>{' '}
              <span className="font-semibold text-gray-800">{entry.detail[key].toLocaleString()}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function FlowHistory({ entries }: { entries: FlowEntry[] }) {
  if (entries.length === 0) {
    return <p className="text-sm text-gray-400">Chưa có dữ liệu hôm nay.</p>
  }
  return (
    <div className="space-y-2">
      {entries.map(e => (
        <EntryRow key={`${e.flow_type}-${e.period}`} entry={e} />
      ))}
    </div>
  )
}
