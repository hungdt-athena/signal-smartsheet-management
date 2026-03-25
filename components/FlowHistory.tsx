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

const PULL_LABELS: Record<string, string> = { ios: '📱 iOS', android: '🤖 Android' }
const PUSH_ORDER = ['puzzle', 'arcade', 'simulation']
const PUSH_ICONS: Record<string, string> = { puzzle: '🧩', arcade: '🕹️', simulation: '🚗' }

function toVNTime(iso: string) {
  return new Date(iso).toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit' })
}

function isToday(dateStr: string) {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' }))
  return dateStr === `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}

function formatDateLabel(dateStr: string) {
  const [, m, d] = dateStr.split('-')
  return `${d}-${m}`
}

function EntryRow({ entry }: { entry: FlowEntry }) {
  const [open, setOpen] = useState(false)
  const isPull = entry.flow_type === 'pull'
  const periodLabel = entry.period === 'morning' ? 'Morning' : 'Afternoon'
  const detailKeys = isPull ? Object.keys(entry.detail) : PUSH_ORDER.filter(k => k in entry.detail)

  return (
    <div className="rounded-xl overflow-hidden" style={{ border: '2px solid #D4C4A0' }}>
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-4 py-2.5 transition-all text-left hover:opacity-90"
        style={{ background: '#EFE3C8' }}
      >
        <div className="flex items-center gap-2.5">
          <span className={isPull ? 'bean-badge-pull' : 'bean-badge-push'}>{isPull ? 'Pull' : 'Push'}</span>
          <span className="font-bold text-sm" style={{ color: '#2A1F08' }}>{periodLabel}</span>
          <span className="font-semibold text-xs" style={{ color: '#6B5A3A' }}>{toVNTime(entry.created_at)}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="font-extrabold text-sm" style={{ color: '#2A1F08' }}>{entry.total.toLocaleString()} games</span>
          <span className="text-xs font-bold" style={{ color: '#7A8C1E', display: 'inline-block', transition: 'transform 0.2s', transform: open ? 'rotate(180deg)' : 'none' }}>▾</span>
        </div>
      </button>
      {open && (
        <div className="px-4 py-3 flex flex-wrap gap-4" style={{ background: '#F5EDD8', borderTop: '2px solid #D4C4A0' }}>
          {detailKeys.map(key => (
            <div key={key} className="flex items-center gap-1.5 text-sm font-bold" style={{ color: '#2A1F08' }}>
              <span>{isPull ? '' : (PUSH_ICONS[key] ?? '')}</span>
              <span style={{ color: '#6B5A3A' }} className="capitalize">{isPull ? (PULL_LABELS[key] ?? key) : key + ' Sheet'}:</span>
              <span>{entry.detail[key].toLocaleString()}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function DateGroup({ date, entries }: { date: string; entries: FlowEntry[] }) {
  const [open, setOpen] = useState(isToday(date))
  const label = isToday(date) ? 'Today' : formatDateLabel(date)

  return (
    <div>
      {/* Date toggle row */}
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-2 mb-2 w-full text-left hover:opacity-80 transition-opacity"
      >
        <div className="bean-date-circle" style={{ width: 52, height: 30, borderRadius: 999, fontSize: '0.75rem' }}>
          {label}
        </div>
        <span className="text-xs font-bold" style={{ color: '#5A6A10' }}>
          {open ? '▾' : '▸'} {entries.length} entries
        </span>
      </button>
      {open && (
        <div className="space-y-1.5 mb-3 pl-1">
          {entries.map(e => <EntryRow key={`${e.flow_type}-${e.period}`} entry={e} />)}
        </div>
      )}
    </div>
  )
}

function HistoryTable({ title, entries, badge }: { title: string; entries: FlowEntry[]; badge: string }) {
  const byDate: Record<string, FlowEntry[]> = {}
  for (const e of entries) {
    if (!byDate[e.log_date]) byDate[e.log_date] = []
    byDate[e.log_date].push(e)
  }

  return (
    <div className="flex-1 min-w-0">
      <div className="flex items-center gap-2 mb-3">
        <span className={badge === 'pull' ? 'bean-badge-pull' : 'bean-badge-push'} style={{ fontSize: '0.75rem', padding: '3px 10px' }}>
          {title}
        </span>
      </div>
      {Object.keys(byDate).length === 0 ? (
        <p className="text-xs font-semibold" style={{ color: '#6B5A3A' }}>No data yet.</p>
      ) : (
        Object.entries(byDate).map(([date, dayEntries]) => (
          <DateGroup key={date} date={date} entries={dayEntries} />
        ))
      )}
    </div>
  )
}

export function FlowHistory({ entries }: { entries: FlowEntry[] }) {
  const pullEntries = entries.filter(e => e.flow_type === 'pull')
  const pushEntries = entries.filter(e => e.flow_type === 'push')

  return (
    <div className="flex gap-6">
      <HistoryTable title="Pull History" entries={pullEntries} badge="pull" />
      <div style={{ width: 2, background: '#D4C4A0', borderRadius: 1, flexShrink: 0 }} />
      <HistoryTable title="Push History" entries={pushEntries} badge="push" />
    </div>
  )
}
