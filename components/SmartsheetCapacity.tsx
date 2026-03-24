'use client'
import { useState } from 'react'

interface SheetStats {
  sheet_name: string
  sheet_id: string | null
  row_count: number | null
  col_count: number | null
  max_rows: number | null
  remaining: number | null
  updated_at: string | null
}

function ProgressBar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0
  const color = pct > 90 ? 'bg-red-500' : pct > 70 ? 'bg-amber-400' : 'bg-emerald-500'
  return (
    <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden mt-2">
      <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
    </div>
  )
}

function SheetRow({ sheet, onSaveId }: {
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

  return (
    <div className="p-4 border border-gray-100 rounded-lg">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-sm font-semibold capitalize text-gray-800">{sheet.sheet_name}</span>
            {sheet.updated_at && (
              <span className="text-xs text-gray-400">
                updated {new Date(sheet.updated_at).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit' })}
              </span>
            )}
          </div>

          {/* Sheet ID */}
          {editing ? (
            <div className="flex items-center gap-2 mb-2">
              <input
                className="text-xs font-mono border border-blue-300 rounded px-2 py-1 w-48 focus:outline-none focus:ring-1 focus:ring-blue-400"
                value={idInput}
                onChange={e => setIdInput(e.target.value)}
                placeholder="Sheet ID"
                autoFocus
              />
              <button onClick={handleSave} disabled={saving || !idInput}
                className="text-xs px-2 py-1 bg-blue-600 text-white rounded disabled:opacity-50">
                {saving ? '...' : 'Save'}
              </button>
              <button onClick={() => { setEditing(false); setIdInput(sheet.sheet_id ?? '') }}
                className="text-xs text-gray-400 hover:text-gray-600">Cancel</button>
            </div>
          ) : (
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xs font-mono text-gray-400">
                {sheet.sheet_id ? sheet.sheet_id : <span className="text-amber-500">No sheet ID set</span>}
              </span>
              <button onClick={() => setEditing(true)} className="text-xs text-blue-500 hover:text-blue-700">edit</button>
            </div>
          )}

          {/* Stats */}
          {sheet.row_count != null ? (
            <>
              <div className="flex items-baseline gap-1">
                <span className="text-xl font-bold text-gray-900">{rows.toLocaleString()}</span>
                <span className="text-xs text-gray-400">/ {max.toLocaleString()} rows</span>
                <span className="text-xs text-gray-400 ml-2">· {sheet.col_count} cols</span>
              </div>
              <ProgressBar value={rows} max={max} />
              <div className="flex gap-4 mt-1.5">
                <span className="text-xs text-gray-500">
                  Remaining: <span className={`font-semibold ${remaining < 1000 ? 'text-red-600' : 'text-emerald-600'}`}>
                    {remaining.toLocaleString()}
                  </span>
                </span>
                <span className="text-xs text-gray-400">
                  {(rows / max * 100).toFixed(1)}% used
                </span>
              </div>
            </>
          ) : (
            <p className="text-xs text-gray-400 mt-1">No data yet — click Refresh</p>
          )}
        </div>
      </div>
    </div>
  )
}

export function SmartsheetCapacity({ sheets, onRefresh }: {
  sheets: SheetStats[]
  onRefresh: () => void
}) {
  const [refreshing, setRefreshing] = useState(false)
  const [sheets_, setSheets] = useState(sheets)

  async function handleRefresh() {
    setRefreshing(true)
    try {
      await fetch('/api/smartsheet-sheets/refresh', { method: 'POST' })
      // Poll until updated_at changes (max 20s)
      const before = sheets_[0]?.updated_at
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 2000))
        const res = await fetch('/api/smartsheet-sheets')
        if (res.ok) {
          const data = await res.json()
          if (data[0]?.updated_at !== before) {
            setSheets(data)
            break
          }
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
        <h3 className="text-sm font-medium text-gray-500 uppercase tracking-wide">Smartsheet Capacity</h3>
        <div className="flex items-center gap-3">
          {lastUpdated && (
            <span className="text-xs text-gray-400">
              Last: {new Date(lastUpdated).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="text-xs px-3 py-1.5 bg-white border border-gray-200 rounded-md hover:bg-gray-50 disabled:opacity-50 flex items-center gap-1.5"
          >
            <span className={refreshing ? 'animate-spin' : ''}>↻</span>
            {refreshing ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {sheets_.map(s => (
          <SheetRow key={s.sheet_name} sheet={s} onSaveId={handleSaveId} />
        ))}
      </div>
    </div>
  )
}
