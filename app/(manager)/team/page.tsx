'use client'
import { useState, useCallback, useEffect } from 'react'
import { StyledSelect } from '@/components/StyledSelect'

// ── Types ────────────────────────────────────────────────────────────────────

interface InitialEvaluator {
  row_number: number
  name: string
  today_available: 'Yes' | 'No'
  game_platform: string
  game_category: string
  weight: number
}

const WEIGHT_OPTS = [30, 50, 70, 100].map(w => ({ value: String(w), label: String(w) }))

interface FinalEvaluator {
  row_number: number
  name: string
}

// ── Initial Evaluator Table ───────────────────────────────────────────────────

function InitialTable() {
  const [rows, setRows] = useState<InitialEvaluator[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [pendingAvail, setPendingAvail] = useState<Record<number, 'Yes' | 'No'>>({})
  const [savingAvail, setSavingAvail] = useState<Set<number>>(new Set())

  const [pendingPlatform, setPendingPlatform] = useState<Record<number, string>>({})
  const [savingPlatform, setSavingPlatform] = useState<Set<number>>(new Set())

  const [pendingWeight, setPendingWeight] = useState<Record<number, number>>({})
  const [savingWeight, setSavingWeight] = useState<Set<number>>(new Set())

  const [showAdd, setShowAdd] = useState(false)
  const [addForm, setAddForm] = useState({ name: '', today_available: 'Yes' as 'Yes' | 'No', game_platform: 'all', game_category: '', weight: 100 })
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

  useEffect(() => { refresh() }, [refresh])

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

  async function handlePlatformConfirm(rowNum: number) {
    const value = pendingPlatform[rowNum]
    if (!value) return
    setSavingPlatform(s => new Set(Array.from(s).concat([rowNum])))
    try {
      const res = await fetch('/api/team/initial/platform', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ row_number: rowNum, game_platform: value }),
      })
      if (!res.ok) throw new Error()
      setRows(r => r.map(ev => ev.row_number === rowNum ? { ...ev, game_platform: value } : ev))
      setPendingPlatform(p => { const n = { ...p }; delete n[rowNum]; return n })
    } catch {
      setError('Failed to update platform.')
    } finally {
      setSavingPlatform(s => { const n = new Set(s); n.delete(rowNum); return n })
    }
  }

  async function handleWeightConfirm(rowNum: number) {
    const value = pendingWeight[rowNum]
    if (!value) return
    setSavingWeight(s => new Set(Array.from(s).concat([rowNum])))
    try {
      const res = await fetch('/api/team/initial/weight', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ row_number: rowNum, weight: value }),
      })
      if (!res.ok) throw new Error()
      setRows(r => r.map(ev => ev.row_number === rowNum ? { ...ev, weight: value } : ev))
      setPendingWeight(p => { const n = { ...p }; delete n[rowNum]; return n })
    } catch {
      setError('Failed to update weight.')
    } finally {
      setSavingWeight(s => { const n = new Set(s); n.delete(rowNum); return n })
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
      setAddForm({ name: '', today_available: 'Yes', game_platform: 'all', game_category: '', weight: 100 })
      setShowAdd(false)
      const freshRes = await fetch('/api/team/initial', { cache: 'no-store' })
      if (freshRes.ok) setRows(await freshRes.json())
    } catch {
      setError('Failed to add row.')
    } finally {
      setAdding(false)
    }
  }

  return (
    <div className="card">
      <div className="card-head">
        <span className="card-label">Initial Evaluator</span>
        <button className="btn btn-sm" onClick={refresh} disabled={loading}>
          <span className={loading ? 'spin' : ''}>↻</span>
          {loading ? 'Loading...' : 'Refresh'}
        </button>
      </div>
      {error && <p className="msg-err" style={{ marginBottom: 8 }}>{error}</p>}

      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>Evaluator Name</th>
              <th>Today Available</th>
              <th>Game Platform</th>
              <th>Game Category</th>
              <th style={{ width: 90 }}>Weight</th>
              <th style={{ width: 80 }}></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && !loading && (
              <tr><td colSpan={6} className="empty">No data — click Refresh to load</td></tr>
            )}
            {loading && (
              <tr><td colSpan={6} className="empty">Loading...</td></tr>
            )}
            {!loading && rows.map(ev => {
              const pending = pendingAvail[ev.row_number]
              const currentDisplay = pending ?? ev.today_available
              const isDirty = pending !== undefined && pending !== ev.today_available
              const isSaving = savingAvail.has(ev.row_number)
              return (
                <tr key={ev.row_number}>
                  <td className="cell-name">{ev.name}</td>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <StyledSelect
                        value={currentDisplay}
                        onChange={v => setPendingAvail(p => ({ ...p, [ev.row_number]: v as 'Yes' | 'No' }))}
                        options={[{ value: 'Yes', label: 'Yes' }, { value: 'No', label: 'No' }]}
                      />
                      {isDirty && (
                        <button className="btn btn-sm btn-primary"
                          onClick={() => handleAvailConfirm(ev.row_number)} disabled={isSaving}>
                          {isSaving ? '...' : 'Confirm'}
                        </button>
                      )}
                    </div>
                  </td>
                  <td>
                    {(() => {
                      const pendingP = pendingPlatform[ev.row_number]
                      const currentP = pendingP ?? ev.game_platform ?? 'all'
                      const isDirtyP = pendingP !== undefined && pendingP !== ev.game_platform
                      const isSavingP = savingPlatform.has(ev.row_number)
                      return (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <StyledSelect
                            value={currentP}
                            onChange={v => setPendingPlatform(p => ({ ...p, [ev.row_number]: v }))}
                            options={[{ value: 'all', label: 'all' }, { value: 'ios', label: 'ios' }, { value: 'android', label: 'android' }]}
                          />
                          {isDirtyP && (
                            <button className="btn btn-sm btn-primary"
                              onClick={() => handlePlatformConfirm(ev.row_number)} disabled={isSavingP}>
                              {isSavingP ? '...' : 'Confirm'}
                            </button>
                          )}
                        </div>
                      )
                    })()}
                  </td>
                  <td style={{ color: 'var(--faint)' }}>{ev.game_category || '—'}</td>
                  <td>
                    {(() => {
                      const pendingW = pendingWeight[ev.row_number]
                      const currentW = pendingW ?? ev.weight ?? 100
                      const isDirtyW = pendingW !== undefined && pendingW !== ev.weight
                      const isSavingW = savingWeight.has(ev.row_number)
                      return (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <StyledSelect
                            value={String(currentW)}
                            onChange={v => setPendingWeight(p => ({ ...p, [ev.row_number]: Number(v) }))}
                            options={WEIGHT_OPTS}
                          />
                          {isDirtyW && (
                            <button className="btn btn-sm btn-primary"
                              onClick={() => handleWeightConfirm(ev.row_number)} disabled={isSavingW}>
                              {isSavingW ? '...' : 'Confirm'}
                            </button>
                          )}
                        </div>
                      )
                    })()}
                  </td>
                  <td>
                    <button className="btn btn-sm btn-danger"
                      onClick={() => handleRemove(ev.row_number)} disabled={removing.has(ev.row_number)}>
                      {removing.has(ev.row_number) ? '...' : 'Remove'}
                    </button>
                  </td>
                </tr>
              )
            })}

            {showAdd && (
              <tr style={{ background: 'var(--accent-weak)' }}>
                <td>
                  <input className="input" style={{ fontSize: 12, padding: '4px 8px' }}
                    value={addForm.name}
                    onChange={e => setAddForm(f => ({ ...f, name: e.target.value }))}
                    onKeyDown={e => { if (e.key === 'Enter') handleAdd() }}
                    placeholder="Name"
                    autoFocus
                  />
                </td>
                <td>
                  <StyledSelect
                    value={addForm.today_available}
                    onChange={v => setAddForm(f => ({ ...f, today_available: v as 'Yes' | 'No' }))}
                    options={[{ value: 'Yes', label: 'Yes' }, { value: 'No', label: 'No' }]}
                  />
                </td>
                <td>
                  <StyledSelect
                    value={addForm.game_platform}
                    onChange={v => setAddForm(f => ({ ...f, game_platform: v }))}
                    options={[{ value: 'all', label: 'all' }, { value: 'ios', label: 'ios' }, { value: 'android', label: 'android' }]}
                  />
                </td>
                <td style={{ color: 'var(--faint)', fontSize: 12 }}>—</td>
                <td>
                  <StyledSelect
                    value={String(addForm.weight)}
                    onChange={v => setAddForm(f => ({ ...f, weight: Number(v) }))}
                    options={WEIGHT_OPTS}
                  />
                </td>
                <td>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button className="btn btn-sm btn-primary"
                      onClick={handleAdd} disabled={adding || !addForm.name.trim()}>
                      {adding ? '...' : 'Add'}
                    </button>
                    <button className="btn btn-sm"
                      onClick={() => { setShowAdd(false); setAddForm({ name: '', today_available: 'Yes', game_platform: 'all', game_category: '', weight: 100 }) }}>
                      ✕
                    </button>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {!showAdd && (
        <button className="add-row-btn" onClick={() => setShowAdd(true)}>
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

  useEffect(() => { refresh() }, [refresh])

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
      setAddName('')
      setShowAdd(false)
      const freshRes = await fetch('/api/team/final', { cache: 'no-store' })
      if (freshRes.ok) setRows(await freshRes.json())
    } catch {
      setError('Failed to add.')
    } finally {
      setAdding(false)
    }
  }

  return (
    <div className="card">
      <div className="card-head">
        <span className="card-label">Final Evaluator</span>
        <button className="btn btn-sm" onClick={refresh} disabled={loading}>
          <span className={loading ? 'spin' : ''}>↻</span>
          {loading ? 'Loading...' : 'Refresh'}
        </button>
      </div>
      {error && <p className="msg-err" style={{ marginBottom: 8 }}>{error}</p>}

      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>Evaluator Name</th>
              <th style={{ width: 80 }}></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && !loading && (
              <tr><td colSpan={2} className="empty">No data — click Refresh to load</td></tr>
            )}
            {loading && (
              <tr><td colSpan={2} className="empty">Loading...</td></tr>
            )}
            {!loading && rows.map(ev => (
              <tr key={ev.row_number}>
                <td className="cell-name">{ev.name}</td>
                <td>
                  <button className="btn btn-sm btn-danger"
                    onClick={() => handleRemove(ev.row_number)} disabled={removing.has(ev.row_number)}>
                    {removing.has(ev.row_number) ? '...' : 'Remove'}
                  </button>
                </td>
              </tr>
            ))}

            {showAdd && (
              <tr style={{ background: 'var(--accent-weak)' }}>
                <td>
                  <input className="input" style={{ fontSize: 12, padding: '4px 8px' }}
                    value={addName}
                    onChange={e => setAddName(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') handleAdd() }}
                    placeholder="Evaluator name"
                    autoFocus
                  />
                </td>
                <td>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button className="btn btn-sm btn-primary"
                      onClick={handleAdd} disabled={adding || !addName.trim()}>
                      {adding ? '...' : 'Add'}
                    </button>
                    <button className="btn btn-sm"
                      onClick={() => { setShowAdd(false); setAddName('') }}>✕</button>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {!showAdd && (
        <button className="add-row-btn" onClick={() => setShowAdd(true)}>
          + Add row
        </button>
      )}
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function TeamPage() {
  return (
    <div className="page">
      <div className="page-head">
        <h1 className="h-title">Team</h1>
      </div>
      <InitialTable />
      <FinalTable />
    </div>
  )
}
