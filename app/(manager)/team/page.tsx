'use client'
import { useState, useCallback, useEffect } from 'react'

// ── Types ────────────────────────────────────────────────────────────────────

interface InitialEvaluator {
  row_number: number
  name: string
  today_available: 'Yes' | 'No'
  game_platform: string
  game_category: string
}

interface FinalEvaluator {
  row_number: number
  name: string
}

// ── Shared helpers ────────────────────────────────────────────────────────────

function Btn({
  onClick, disabled, children, variant = 'default',
}: {
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
  variant?: 'default' | 'danger' | 'primary'
}) {
  const bg = variant === 'danger' ? '#b91c1c' : variant === 'primary' ? '#5A3E1B' : '#D4C4A0'
  const color = variant === 'default' ? '#5A3E1B' : '#fff'
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        background: bg, color, border: 'none', borderRadius: 7,
        padding: '3px 10px', fontSize: 12, fontWeight: 700,
        cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.55 : 1,
      }}
    >{children}</button>
  )
}

function SectionHeader({ title, onRefresh, refreshing }: { title: string; onRefresh: () => void; refreshing: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
      <p className="bean-section-label">{title}</p>
      <Btn onClick={onRefresh} disabled={refreshing}>
        <span style={{ display: 'inline-block', animation: refreshing ? 'spin 1s linear infinite' : 'none' }}>↻</span>
        {' '}{refreshing ? 'Loading...' : 'Refresh'}
      </Btn>
    </div>
  )
}

// ── Initial Evaluator Table ───────────────────────────────────────────────────

function InitialTable() {
  const [rows, setRows] = useState<InitialEvaluator[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // pending availability changes per row (row_number → pending value)
  const [pendingAvail, setPendingAvail] = useState<Record<number, 'Yes' | 'No'>>({})
  const [savingAvail, setSavingAvail] = useState<Set<number>>(new Set())

  // add-row form
  const [showAdd, setShowAdd] = useState(false)
  const [addForm, setAddForm] = useState({ name: '', today_available: 'Yes' as 'Yes' | 'No', game_platform: 'all', game_category: '' })
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState<Set<number>>(new Set())

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/team/initial', { cache: 'no-store' })
      if (!res.ok) throw new Error('Failed to load')
      setRows(await res.json())
    } catch {
      setError('Failed to load. Check webhook config.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  async function handleAvailConfirm(rowNum: number) {
    const value = pendingAvail[rowNum]
    if (!value) return
    setSavingAvail(s => new Set(Array.from(s).concat([rowNum])))
    try {
      const res = await fetch('/api/team/initial/availability', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ row_number: rowNum, today_available: value }),
      })
      if (!res.ok) throw new Error()
      setRows(r => r.map(ev => ev.row_number === rowNum ? { ...ev, today_available: value } : ev))
      setPendingAvail(p => { const n = { ...p }; delete n[rowNum]; return n })
    } catch {
      setError('Failed to update availability.')
    } finally {
      setSavingAvail(s => { const n = new Set(s); n.delete(rowNum); return n })
    }
  }

  async function handleRemove(rowNum: number) {
    setRemoving(s => new Set(Array.from(s).concat([rowNum])))
    try {
      const res = await fetch('/api/team/initial/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ row_number: rowNum }),
      })
      if (!res.ok) throw new Error()
      setRows(r => r.filter(ev => ev.row_number !== rowNum))
    } catch {
      setError('Failed to remove row.')
    } finally {
      setRemoving(s => { const n = new Set(s); n.delete(rowNum); return n })
    }
  }

  async function handleAdd() {
    if (!addForm.name.trim()) return
    setAdding(true)
    try {
      const res = await fetch('/api/team/initial/append', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(addForm),
      })
      if (!res.ok) throw new Error()
      setAddForm({ name: '', today_available: 'Yes', game_platform: '', game_category: '' })
      setShowAdd(false)
      // Refresh to get the new row with its row_number
      const freshRes = await fetch('/api/team/initial', { cache: 'no-store' })
      if (freshRes.ok) setRows(await freshRes.json())
    } catch {
      setError('Failed to add row.')
    } finally {
      setAdding(false)
    }
  }

  const thStyle: React.CSSProperties = { padding: '6px 10px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#6B5A3A', background: '#D4C4A0', borderBottom: '2px solid #C8B896' }
  const tdStyle: React.CSSProperties = { padding: '6px 10px', fontSize: 12, color: '#2A1F08', borderBottom: '1px solid #EFE3C8' }

  return (
    <div className="bean-card p-4">
      <SectionHeader title="Initial Evaluator" onRefresh={refresh} refreshing={loading} />
      {error && <p style={{ fontSize: 11, color: '#b91c1c', marginBottom: 6 }}>{error}</p>}

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr>
              <th style={thStyle}>Evaluator Name</th>
              <th style={thStyle}>Today Available</th>
              <th style={thStyle}>Game Platform</th>
              <th style={thStyle}>Game Category</th>
              <th style={{ ...thStyle, width: 80 }}></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && !loading && (
              <tr><td colSpan={5} style={{ ...tdStyle, color: '#9A8A6A', textAlign: 'center', padding: 16 }}>
                No data — click Refresh to load
              </td></tr>
            )}
            {loading && (
              <tr><td colSpan={5} style={{ ...tdStyle, color: '#9A8A6A', textAlign: 'center', padding: 16 }}>
                Loading...
              </td></tr>
            )}
            {!loading && rows.map(ev => {
              const pending = pendingAvail[ev.row_number]
              const currentDisplay = pending ?? ev.today_available
              const isDirty = pending !== undefined && pending !== ev.today_available
              const isSaving = savingAvail.has(ev.row_number)
              return (
                <tr key={ev.row_number} style={{ background: 'transparent' }}>
                  <td style={{ ...tdStyle, fontWeight: 600 }}>{ev.name}</td>
                  <td style={tdStyle}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <select
                        value={currentDisplay}
                        onChange={e => setPendingAvail(p => ({ ...p, [ev.row_number]: e.target.value as 'Yes' | 'No' }))}
                        style={{
                          border: `1px solid ${isDirty ? '#5A3E1B' : '#D4C4A0'}`,
                          borderRadius: 6, padding: '2px 6px', fontSize: 12,
                          background: currentDisplay === 'Yes' ? '#E8F5C8' : '#FEE2E2',
                          color: '#2A1F08', fontWeight: 600,
                        }}
                      >
                        <option value="Yes">Yes</option>
                        <option value="No">No</option>
                      </select>
                      {isDirty && (
                        <Btn onClick={() => handleAvailConfirm(ev.row_number)} disabled={isSaving} variant="primary">
                          {isSaving ? '...' : 'Confirm'}
                        </Btn>
                      )}
                    </div>
                  </td>
                  <td style={tdStyle}>{ev.game_platform || '—'}</td>
                  <td style={tdStyle}>{ev.game_category || '—'}</td>
                  <td style={tdStyle}>
                    <Btn onClick={() => handleRemove(ev.row_number)} disabled={removing.has(ev.row_number)} variant="danger">
                      {removing.has(ev.row_number) ? '...' : 'Remove'}
                    </Btn>
                  </td>
                </tr>
              )
            })}

            {/* Add-row inline form */}
            {showAdd && (
              <tr style={{ background: '#FAF5EC' }}>
                <td style={tdStyle}>
                  <input
                    value={addForm.name}
                    onChange={e => setAddForm(f => ({ ...f, name: e.target.value }))}
                    onKeyDown={e => { if (e.key === 'Enter') handleAdd() }}
                    placeholder="Name"
                    autoFocus
                    style={{ border: '1px solid #D4C4A0', borderRadius: 6, padding: '3px 7px', fontSize: 12, width: '100%' }}
                  />
                </td>
                <td style={tdStyle}>
                  <select
                    value={addForm.today_available}
                    onChange={e => setAddForm(f => ({ ...f, today_available: e.target.value as 'Yes' | 'No' }))}
                    style={{ border: '1px solid #D4C4A0', borderRadius: 6, padding: '3px 7px', fontSize: 12 }}
                  >
                    <option value="Yes">Yes</option>
                    <option value="No">No</option>
                  </select>
                </td>
                <td style={{ ...tdStyle, color: '#9A8A6A', fontSize: 11 }}>all</td>
                <td style={{ ...tdStyle, color: '#9A8A6A', fontSize: 11 }}>—</td>
                <td style={tdStyle}>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <Btn onClick={handleAdd} disabled={adding || !addForm.name.trim()} variant="primary">
                      {adding ? '...' : 'Add'}
                    </Btn>
                    <Btn onClick={() => { setShowAdd(false); setAddForm({ name: '', today_available: 'Yes', game_platform: 'all', game_category: '' }) }}>
                      ✕
                    </Btn>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {!showAdd && (
        <button
          onClick={() => setShowAdd(true)}
          style={{
            marginTop: 8, display: 'flex', alignItems: 'center', gap: 4,
            background: 'none', border: '1.5px dashed #D4C4A0', borderRadius: 7,
            padding: '4px 12px', fontSize: 12, fontWeight: 600, color: '#6B5A3A',
            cursor: 'pointer', width: '100%', justifyContent: 'center',
          }}
        >
          + Add row
        </button>
      )}
    </div>
  )
}

// ── Final Evaluator Table ─────────────────────────────────────────────────────

function FinalTable() {
  const [rows, setRows] = useState<FinalEvaluator[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const [addName, setAddName] = useState('')
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState<Set<number>>(new Set())

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/team/final', { cache: 'no-store' })
      if (!res.ok) throw new Error('Failed to load')
      setRows(await res.json())
    } catch {
      setError('Failed to load. Check webhook config.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  async function handleRemove(rowNum: number) {
    setRemoving(s => new Set(Array.from(s).concat([rowNum])))
    try {
      const res = await fetch('/api/team/final/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ row_number: rowNum }),
      })
      if (!res.ok) throw new Error()
      setRows(r => r.filter(ev => ev.row_number !== rowNum))
    } catch {
      setError('Failed to remove.')
    } finally {
      setRemoving(s => { const n = new Set(s); n.delete(rowNum); return n })
    }
  }

  async function handleAdd() {
    if (!addName.trim()) return
    setAdding(true)
    try {
      const res = await fetch('/api/team/final/append', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: addName.trim() }),
      })
      if (!res.ok) throw new Error()
      // Note: row_number will be assigned by n8n/Google Sheets, we'll refresh to get it
      setAddName('')
      setShowAdd(false)
      // Refresh to get the new row with its row_number
      const freshRes = await fetch('/api/team/final', { cache: 'no-store' })
      if (freshRes.ok) setRows(await freshRes.json())
    } catch {
      setError('Failed to add.')
    } finally {
      setAdding(false)
    }
  }

  const thStyle: React.CSSProperties = { padding: '6px 10px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#6B5A3A', background: '#D4C4A0', borderBottom: '2px solid #C8B896' }
  const tdStyle: React.CSSProperties = { padding: '6px 10px', fontSize: 12, color: '#2A1F08', borderBottom: '1px solid #EFE3C8' }

  return (
    <div className="bean-card p-4">
      <SectionHeader title="Final Evaluator" onRefresh={refresh} refreshing={loading} />
      {error && <p style={{ fontSize: 11, color: '#b91c1c', marginBottom: 6 }}>{error}</p>}

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr>
              <th style={thStyle}>Evaluator Name</th>
              <th style={{ ...thStyle, width: 80 }}></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && !loading && (
              <tr><td colSpan={2} style={{ ...tdStyle, color: '#9A8A6A', textAlign: 'center', padding: 16 }}>
                No data — click Refresh to load
              </td></tr>
            )}
            {loading && (
              <tr><td colSpan={2} style={{ ...tdStyle, color: '#9A8A6A', textAlign: 'center', padding: 16 }}>
                Loading...
              </td></tr>
            )}
            {!loading && rows.map(ev => (
              <tr key={ev.row_number}>
                <td style={{ ...tdStyle, fontWeight: 600 }}>{ev.name}</td>
                <td style={tdStyle}>
                  <Btn onClick={() => handleRemove(ev.row_number)} disabled={removing.has(ev.row_number)} variant="danger">
                    {removing.has(ev.row_number) ? '...' : 'Remove'}
                  </Btn>
                </td>
              </tr>
            ))}

            {showAdd && (
              <tr style={{ background: '#FAF5EC' }}>
                <td style={tdStyle}>
                  <input
                    value={addName}
                    onChange={e => setAddName(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') handleAdd() }}
                    placeholder="Evaluator name"
                    autoFocus
                    style={{ border: '1px solid #D4C4A0', borderRadius: 6, padding: '3px 7px', fontSize: 12, width: '100%' }}
                  />
                </td>
                <td style={tdStyle}>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <Btn onClick={handleAdd} disabled={adding || !addName.trim()} variant="primary">
                      {adding ? '...' : 'Add'}
                    </Btn>
                    <Btn onClick={() => { setShowAdd(false); setAddName('') }}>✕</Btn>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {!showAdd && (
        <button
          onClick={() => setShowAdd(true)}
          style={{
            marginTop: 8, display: 'flex', alignItems: 'center', gap: 4,
            background: 'none', border: '1.5px dashed #D4C4A0', borderRadius: 7,
            padding: '4px 12px', fontSize: 12, fontWeight: 600, color: '#6B5A3A',
            cursor: 'pointer', width: '100%', justifyContent: 'center',
          }}
        >
          + Add row
        </button>
      )}
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function TeamPage() {
  return (
    <div className="space-y-4 w-full">
      <h1 className="font-extrabold text-2xl" style={{ color: '#2A1F08' }}>Team</h1>
      <InitialTable />
      <FinalTable />
    </div>
  )
}
