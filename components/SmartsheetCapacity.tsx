'use client'
import { useState, useEffect } from 'react'

interface SheetStats {
  sheet_name: string
  sheet_id: string | null
  row_count: number | null
  col_count: number | null
  max_rows: number | null
  remaining: number | null
  updated_at: string | null
}

const SHEET_IMGS: Record<string, string> = {
  puzzle:     '/stickers/puzzle-capacity-card.png',
  arcade:     '/stickers/arcade-capacity-card.png',
  simulation: '/stickers/simulation-capacity-card.png',
}

function SheetCard({ sheet, onSaveId }: {
  sheet: SheetStats
  onSaveId: (name: string, id: string) => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [idInput, setIdInput] = useState(sheet.sheet_id ?? '')
  const [saving, setSaving] = useState(false)

  async function handleSave() {
    setSaving(true)
    await onSaveId(sheet.sheet_name, idInput)
    setSaving(false)
    setEditing(false)
  }

  const rows = sheet.row_count ?? 0
  const max = sheet.max_rows ?? 20000
  const remaining = sheet.remaining ?? max
  const pct = max > 0 ? Math.min(100, (rows / max) * 100) : 0
  const isWarning = pct > 90
  const isAlert = pct > 70 && !isWarning

  return (
    <div className="bean-card-inner p-4 relative overflow-hidden" style={{ minHeight: 160 }}>
      {/* Sticker — top right */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={SHEET_IMGS[sheet.sheet_name] ?? ''} alt=""
        className="absolute right-1 top-1 w-20 h-20 object-contain pointer-events-none select-none"
        style={{ opacity: 0.92 }} />

      {/* Header */}
      <div className="mb-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-extrabold text-base capitalize" style={{ color: '#2A1F08' }}>
            {sheet.sheet_name.charAt(0).toUpperCase() + sheet.sheet_name.slice(1)} Sheet
          </span>
          {sheet.updated_at && (
            <span className="text-xs font-semibold" style={{ color: '#7A8C1E' }}>
              updated {new Date(sheet.updated_at).toLocaleTimeString('en-US', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
        </div>

        {/* Sheet ID */}
        {editing ? (
          <div className="flex items-center gap-2 mt-1.5">
            <input
              className="text-xs font-mono rounded-lg px-2 py-1 w-40 focus:outline-none"
              style={{ border: '2px solid #7A8C1E', background: '#F5EDD8', color: '#2A1F08' }}
              value={idInput}
              onChange={e => setIdInput(e.target.value)}
              placeholder="Sheet ID"
              autoFocus
            />
            <button onClick={handleSave} disabled={saving || !idInput}
              className="text-xs font-bold px-2 py-1 rounded-lg disabled:opacity-40"
              style={{ background: '#7A8C1E', color: '#fff' }}>
              {saving ? '…' : 'Save'}
            </button>
            <button onClick={() => { setEditing(false); setIdInput(sheet.sheet_id ?? '') }}
              className="text-xs font-bold" style={{ color: '#6B5A3A' }}>Cancel</button>
          </div>
        ) : (
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-xs font-mono truncate max-w-[140px]" style={{ color: sheet.sheet_id ? '#6B5A3A' : '#C47A20' }}>
              {sheet.sheet_id ?? 'No sheet ID'}
            </span>
            <button onClick={() => setEditing(true)}
              className="text-xs font-bold underline" style={{ color: '#7A8C1E' }}>edit</button>
          </div>
        )}
      </div>

      {/* Stats */}
      {sheet.row_count != null ? (
        <>
          <div className="flex items-baseline gap-1">
            <span className="font-extrabold" style={{ fontSize: '1.8rem', color: '#3A6010', lineHeight: 1 }}>
              {rows.toLocaleString()}
            </span>
            <span className="text-xs font-semibold" style={{ color: '#6B5A3A' }}>
              / {max.toLocaleString()} rows · {sheet.col_count} cols
            </span>
          </div>
          <div className="bean-progress">
            <div className="bean-progress-fill"
              style={{ width: `${pct}%`, background: isWarning ? '#C0392B' : isAlert ? '#E67E22' : undefined }} />
          </div>
          <div className="flex justify-between items-center">
            <span className="text-xs font-bold" style={{ color: '#2A1F08' }}>
              Remaining: <span style={{ color: isWarning ? '#C0392B' : '#3A6010' }}>{remaining.toLocaleString()}</span>
            </span>
            <span className="text-xs font-bold" style={{ color: '#6B5A3A' }}>{pct.toFixed(1)}% used</span>
          </div>
        </>
      ) : (
        <p className="text-xs font-semibold mt-2" style={{ color: '#6B5A3A' }}>No data — click Refresh</p>
      )}
    </div>
  )
}

export function SmartsheetCapacity({ sheets, onRefresh }: {
  sheets: SheetStats[]
  onRefresh: () => void
}) {
  const [refreshing, setRefreshing] = useState(false)
  const [sheets_, setSheets] = useState(sheets)
  useEffect(() => { if (sheets.length > 0) setSheets(sheets) }, [sheets])

  async function handleRefresh() {
    setRefreshing(true)
    try {
      await fetch('/api/smartsheet-sheets/refresh', { method: 'POST' })
      const before = sheets_[0]?.updated_at
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 2000))
        const res = await fetch('/api/smartsheet-sheets')
        if (res.ok) {
          const data = await res.json()
          if (data[0]?.updated_at !== before) { setSheets(data); break }
        }
      }
    } finally {
      setRefreshing(false)
      onRefresh()
    }
  }

  async function handleSaveId(sheetName: string, sheetId: string) {
    await fetch('/api/smartsheet-sheets', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sheet_name: sheetName, sheet_id: sheetId }),
    })
    setSheets(prev => prev.map(s => s.sheet_name === sheetName ? { ...s, sheet_id: sheetId } : s))
  }

  const lastUpdated = sheets_.find(s => s.updated_at)?.updated_at

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <p className="bean-section-label">Smartsheet Capacity</p>

        <div className="flex items-center gap-3">
          {lastUpdated && (
            <span className="text-xs font-semibold" style={{ color: '#5C3D1E' }}>
              Last: {new Date(lastUpdated).toLocaleTimeString('en-US', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
          <button onClick={handleRefresh} disabled={refreshing}
            className="text-xs font-bold px-3 py-1.5 rounded-xl disabled:opacity-50 flex items-center gap-1.5 transition-all hover:opacity-80"
            style={{ background: '#EFE3C8', border: '2px solid #7A8C1E', color: '#2A1F08' }}>
            <span className={refreshing ? 'inline-block animate-spin' : ''}>↻</span>
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {sheets_.map(s => (
          <SheetCard key={s.sheet_name} sheet={s} onSaveId={handleSaveId} />
        ))}
      </div>
    </div>
  )
}
