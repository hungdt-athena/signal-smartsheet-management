'use client'
import { useState, useEffect } from 'react'

interface SheetStats {
  sheet_name: string
  display_name: string | null
  sheet_id: string | null
  row_count: number | null
  col_count: number | null
  max_rows: number | null
  remaining: number | null
  updated_at: string | null
}

function SheetCard({ sheet, onSaveId, canEdit }: {
  sheet: SheetStats
  onSaveId: (name: string, id: string) => Promise<void>
  canEdit: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [idInput, setIdInput] = useState(sheet.sheet_id ?? '')
  const [saving, setSaving] = useState(false)

  function handleSaveClick() {
    if (!idInput || idInput === sheet.sheet_id) { setEditing(false); return }
    setConfirming(true)
  }

  async function handleConfirm() {
    setSaving(true)
    await onSaveId(sheet.sheet_name, idInput)
    setSaving(false)
    setEditing(false)
    setConfirming(false)
  }

  function handleCancel() {
    setConfirming(false)
    setEditing(false)
    setIdInput(sheet.sheet_id ?? '')
  }

  const rows = sheet.row_count ?? 0
  const max  = sheet.max_rows ?? 20000
  const remaining = sheet.remaining ?? max
  const pct  = max > 0 ? Math.min(100, (rows / max) * 100) : 0
  const isWarning = pct > 90
  const isAlert   = pct > 70 && !isWarning

  return (
    <div className="cap-row" style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      <div className="stat" style={{ flexDirection: 'column', gap: 10 }}>
        {/* Header */}
        <div>
          <span className="cap-name" style={{ textTransform: 'capitalize' }}>
            {sheet.sheet_name.charAt(0).toUpperCase() + sheet.sheet_name.slice(1)} Sheet
          </span>
          {sheet.display_name && (
            <p style={{ fontSize: 11, fontFamily: 'var(--num)', color: 'var(--faint)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              title={sheet.display_name}>
              {sheet.display_name}
            </p>
          )}

          {/* Sheet ID */}
          {confirming ? (
            <div style={{ marginTop: 8, borderRadius: 8, padding: '8px 10px', background: 'var(--warn-weak)', border: '1px solid var(--warn)' }}>
              <p style={{ fontSize: 11, fontWeight: 700, marginBottom: 4, color: 'var(--warn)' }}>Confirm update?</p>
              <p style={{ fontSize: 11, fontFamily: 'var(--num)', color: 'var(--bad)', marginBottom: 2 }}>- {sheet.sheet_id ?? '(none)'}</p>
              <p style={{ fontSize: 11, fontFamily: 'var(--num)', color: 'var(--good)', marginBottom: 8 }}>+ {idInput}</p>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="btn btn-sm btn-primary" onClick={handleConfirm} disabled={saving}>
                  {saving ? '...' : 'Confirm'}
                </button>
                <button className="btn btn-sm" onClick={handleCancel} disabled={saving}>Cancel</button>
              </div>
            </div>
          ) : editing ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
              <input className="input" style={{ fontSize: 12, fontFamily: 'var(--num)', padding: '4px 8px', width: 160 }}
                value={idInput}
                onChange={e => setIdInput(e.target.value)}
                placeholder="Sheet ID"
                autoFocus
                onKeyDown={e => e.key === 'Enter' && handleSaveClick()}
              />
              <button className="btn btn-sm btn-primary" onClick={handleSaveClick} disabled={!idInput}>Save</button>
              <button className="btn btn-sm" onClick={() => { setEditing(false); setIdInput(sheet.sheet_id ?? '') }}>Cancel</button>
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
              <span style={{ fontSize: 11, fontFamily: 'var(--num)', color: sheet.sheet_id ? 'var(--faint)' : 'var(--warn)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 160 }}>
                {sheet.sheet_id ?? 'No sheet ID'}
              </span>
              {canEdit && (
                <button className="btn-ghost" style={{ fontSize: 11, fontWeight: 600, padding: '1px 6px', borderRadius: 4, border: 'none', color: 'var(--accent)', cursor: 'pointer', background: 'none' }}
                  onClick={() => setEditing(true)}>
                  edit
                </button>
              )}
            </div>
          )}
        </div>

        {/* Stats */}
        {sheet.row_count != null ? (
          <>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
              <span className="stat-num" style={{ fontSize: 24 }}>{rows.toLocaleString()}</span>
              <span className="cap-meta">/ {max.toLocaleString()} rows · {sheet.col_count} cols</span>
            </div>
            <div className="cap-bar">
              <div className="cap-fill" style={{
                width: `${pct}%`,
                background: isWarning ? 'var(--bad)' : isAlert ? 'var(--warn)' : 'var(--accent)',
              }} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)' }}>
                Remaining: <span style={{ color: isWarning ? 'var(--bad)' : 'var(--good)' }}>{remaining.toLocaleString()}</span>
              </span>
              <span className="cap-pct">{pct.toFixed(1)}%</span>
            </div>
          </>
        ) : (
          <p style={{ fontSize: 12, color: 'var(--faint)', marginTop: 4 }}>No data — click Refresh</p>
        )}
      </div>
    </div>
  )
}

export function SmartsheetCapacity({ sheets, onRefresh, isAdmin = false }: {
  sheets: SheetStats[]
  onRefresh: () => void
  isAdmin?: boolean
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
    handleRefresh()
  }

  const lastUpdated = sheets_.find(s => s.updated_at)?.updated_at

  return (
    <div>
      <div className="card-head">
        <span className="card-label">Smartsheet Capacity</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {lastUpdated && (
            <span className="sync">
              Last: {new Date(lastUpdated).toLocaleTimeString('en-US', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
          <button className="btn btn-sm" onClick={handleRefresh} disabled={refreshing}>
            <span className={refreshing ? 'spin' : ''}>↻</span>
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 'var(--gap)' }}>
        {sheets_.map(s => (
          <SheetCard key={s.sheet_name} sheet={s} onSaveId={handleSaveId} canEdit={isAdmin} />
        ))}
      </div>
    </div>
  )
}
