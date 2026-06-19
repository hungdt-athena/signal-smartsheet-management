'use client'
import { useEffect, useState, useCallback } from 'react'
import { BUCKETS, type Bucket } from '@/lib/buckets'

type Field = 'conclusion' | 'final_conclusion'

interface OptionRow { id: number; field: string; value: string; sort_order: number; active: boolean }

const FIELDS: { key: Field; label: string; note: string }[] = [
  { key: 'conclusion',       label: 'Initial Conclusion', note: "Evaluator's conclusion options" },
  { key: 'final_conclusion', label: 'Final Conclusion',   note: "Moderator triage verdicts (Short List)" },
]

export default function ConfigPage() {
  const [data, setData] = useState<Record<Field, OptionRow[]>>({ conclusion: [], final_conclusion: [] })
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/config?manage=1', { cache: 'no-store' })
      if (res.ok) {
        const json = await res.json()
        setData({ conclusion: json.conclusion ?? [], final_conclusion: json.final_conclusion ?? [] })
      }
    } catch { /* ignore */ }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { fetchData() }, [fetchData])

  const send = useCallback(async (method: string, body: unknown): Promise<boolean> => {
    setMessage(null)
    try {
      const res = await fetch('/api/config', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (res.ok) { await fetchData(); return true }
      const j = await res.json().catch(() => ({}))
      setMessage({ type: 'error', text: j.error ?? 'Request failed' })
      return false
    } catch {
      setMessage({ type: 'error', text: 'Network error' })
      return false
    }
  }, [fetchData])

  return (
    <div className="page">
      <div className="page-head">
        <h1 className="h-title">Config</h1>
        <button className="btn btn-sm" onClick={fetchData} disabled={loading}>
          <span className={loading ? 'spin' : ''}>↻</span>
          {loading ? '...' : 'Refresh'}
        </button>
      </div>

      {message && (
        <p className={message.type === 'success' ? 'msg-ok' : 'msg-err'} style={{ marginBottom: 10 }}>
          {message.text}
        </p>
      )}

      {FIELDS.map(f => (
        <ConfigSection
          key={f.key}
          label={f.label}
          note={f.note}
          options={data[f.key]}
          loading={loading}
          onAdd={value => send('POST', { field: f.key, value })}
          onRename={(id, value) => send('PATCH', { id, value })}
          onToggle={(id, active) => send('PATCH', { id, active })}
          onReorder={ids => send('PATCH', { field: f.key, ids })}
          onDelete={id => send('DELETE', { id })}
        />
      ))}

      <CategorySection />
    </div>
  )
}

function ConfigSection({
  label, note, options, loading, onAdd, onRename, onToggle, onReorder, onDelete,
}: {
  label: string
  note: string
  options: OptionRow[]
  loading: boolean
  onAdd: (value: string) => Promise<boolean>
  onRename: (id: number, value: string) => Promise<boolean>
  onToggle: (id: number, active: boolean) => Promise<boolean>
  onReorder: (ids: number[]) => Promise<boolean>
  onDelete: (id: number) => Promise<boolean>
}) {
  const [newValue, setNewValue] = useState('')
  const [adding, setAdding] = useState(false)

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    if (!newValue.trim()) return
    setAdding(true)
    if (await onAdd(newValue.trim())) setNewValue('')
    setAdding(false)
  }

  function move(i: number, dir: -1 | 1) {
    const j = i + dir
    if (j < 0 || j >= options.length) return
    const ids = options.map(o => o.id)
    ;[ids[i], ids[j]] = [ids[j], ids[i]]
    onReorder(ids)
  }

  const activeCount = options.filter(o => o.active).length

  return (
    <div className="card">
      <div className="card-head">
        <span className="card-label">{label}</span>
        <span className="card-note">{note} · {activeCount}/{options.length} active</span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {options.length === 0 && !loading && <p className="empty">No options yet</p>}
        {options.map((o, i) => (
          <OptionItem
            key={o.id}
            opt={o}
            isFirst={i === 0}
            isLast={i === options.length - 1}
            onUp={() => move(i, -1)}
            onDown={() => move(i, 1)}
            onRename={v => onRename(o.id, v)}
            onToggle={() => onToggle(o.id, !o.active)}
            onDelete={() => onDelete(o.id)}
          />
        ))}
      </div>

      <form onSubmit={handleAdd} style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <input
          className="input"
          style={{ flex: 1 }}
          value={newValue}
          onChange={e => setNewValue(e.target.value)}
          placeholder={`Add ${label.toLowerCase()} option…`}
        />
        <button type="submit" className="btn btn-primary btn-sm" disabled={adding || !newValue.trim()}>
          {adding ? '...' : 'Add'}
        </button>
      </form>
    </div>
  )
}

function OptionItem({
  opt, isFirst, isLast, onUp, onDown, onRename, onToggle, onDelete,
}: {
  opt: OptionRow
  isFirst: boolean
  isLast: boolean
  onUp: () => void
  onDown: () => void
  onRename: (value: string) => void
  onToggle: () => void
  onDelete: () => void
}) {
  const [val, setVal] = useState(opt.value)
  // Keep local input synced when the row reorders / refetches.
  useEffect(() => { setVal(opt.value) }, [opt.value])

  function commit() {
    const v = val.trim()
    if (v && v !== opt.value) onRename(v)
    else setVal(opt.value)
  }

  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', opacity: opt.active ? 1 : 0.5 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        <button className="btn btn-ghost btn-sm" style={arrowStyle} disabled={isFirst} onClick={onUp} title="Move up">↑</button>
        <button className="btn btn-ghost btn-sm" style={arrowStyle} disabled={isLast} onClick={onDown} title="Move down">↓</button>
      </div>
      <input
        className="input"
        style={{ flex: 1 }}
        value={val}
        onChange={e => setVal(e.target.value)}
        onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
      />
      <button className="btn btn-sm" onClick={onToggle} title={opt.active ? 'Disable (hide from dropdowns)' : 'Enable'}>
        {opt.active ? 'On' : 'Off'}
      </button>
      <button className="btn btn-sm btn-danger" onClick={onDelete} title="Delete">✕</button>
    </div>
  )
}

const arrowStyle: React.CSSProperties = { padding: '0 6px', lineHeight: 1.1, minWidth: 22, height: 16, fontSize: 10 }

// ── Genre → Bucket section ─────────────────────────────────────────────────────

interface MappingRow { id: number; genre: string; category_group: string; active: boolean }

const BUCKET_LABELS: Record<Bucket, string> = {
  puzzle: 'Puzzle', arcade: 'Arcade', simulation: 'Simulation',
}

function CategorySection() {
  const [data, setData] = useState<Record<Bucket, MappingRow[]>>({ puzzle: [], arcade: [], simulation: [] })
  const [loading, setLoading] = useState(false)

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/config/categories?manage=1', { cache: 'no-store' })
      if (res.ok) {
        const json = await res.json()
        setData({ puzzle: json.puzzle ?? [], arcade: json.arcade ?? [], simulation: json.simulation ?? [] })
      }
    } catch { /* ignore */ }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { fetchData() }, [fetchData])

  async function send(method: string, body: unknown): Promise<boolean> {
    const res = await fetch('/api/config/categories', {
      method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    if (res.ok) { await fetchData(); return true }
    return false
  }

  return (
    <div className="card">
      <div className="card-head">
        <span className="card-label">Genre → Bucket</span>
        <span className="card-note">Which game genres feed each evaluation bucket</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {BUCKETS.map(b => (
          <BucketGroup
            key={b}
            label={BUCKET_LABELS[b]}
            rows={data[b]}
            loading={loading}
            onAdd={genre => send('POST', { genre, category_group: b })}
            onToggle={(id, active) => send('PATCH', { id, active })}
            onDelete={id => send('DELETE', { id })}
          />
        ))}
      </div>
    </div>
  )
}

function BucketGroup({
  label, rows, loading, onAdd, onToggle, onDelete,
}: {
  label: string
  rows: MappingRow[]
  loading: boolean
  onAdd: (genre: string) => Promise<boolean>
  onToggle: (id: number, active: boolean) => Promise<boolean>
  onDelete: (id: number) => Promise<boolean>
}) {
  const [newValue, setNewValue] = useState('')
  const [warn, setWarn] = useState(false)
  const [checking, setChecking] = useState(false)
  const [dragId, setDragId] = useState<number | null>(null)
  const [overCol, setOverCol] = useState<'used' | 'archived' | null>(null)

  const used = rows.filter(r => r.active)
  const archived = rows.filter(r => !r.active)

  async function attemptAdd() {
    const g = newValue.trim()
    if (!g) return
    setChecking(true)
    try {
      const res = await fetch(`/api/config/categories?check=${encodeURIComponent(g)}`, { cache: 'no-store' })
      const exists = res.ok ? (await res.json()).exists : true
      if (!exists && !warn) { setWarn(true); return }  // first attempt: show warning, require confirm
      if (await onAdd(g)) { setNewValue(''); setWarn(false) }
    } finally { setChecking(false) }
  }

  // Drop into a column → set the dragged mapping's active state to match the column.
  function dropInto(targetActive: boolean) {
    const id = dragId
    setDragId(null); setOverCol(null)
    if (id == null) return
    const row = rows.find(r => r.id === id)
    if (row && row.active !== targetActive) onToggle(id, targetActive)
  }

  function column(title: string, items: MappingRow[], targetActive: boolean, key: 'used' | 'archived') {
    return (
      <div
        className={'genre-col' + (overCol === key ? ' drag-over' : '')}
        onDragOver={e => { e.preventDefault(); setOverCol(key) }}
        onDragLeave={() => setOverCol(c => (c === key ? null : c))}
        onDrop={() => dropInto(targetActive)}
      >
        <div className="genre-col-head">{title} <span className="genre-col-count">{items.length}</span></div>
        <div className="genre-col-body">
          {items.length === 0 && !loading && <span className="empty" style={{ fontSize: 11 }}>Drop here</span>}
          {items.map(r => (
            <span
              key={r.id}
              className="chip chip-drag"
              draggable
              onDragStart={() => setDragId(r.id)}
              onDragEnd={() => { setDragId(null); setOverCol(null) }}
            >
              <span className="chip-grip" aria-hidden>⠿</span>
              {r.genre}
              <button className="chip-x" title="Delete" onClick={() => onDelete(r.id)}>✕</button>
            </span>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div>
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6, color: 'var(--faint)' }}>
        {label} <span style={{ fontWeight: 400 }}>· {used.length} used / {archived.length} archived</span>
      </div>
      <div className="genre-cols">
        {column('Used', used, true, 'used')}
        {column('Archived', archived, false, 'archived')}
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
        <input className="input" style={{ flex: 1 }} value={newValue}
          onChange={e => { setNewValue(e.target.value); setWarn(false) }}
          onKeyDown={e => { if (e.key === 'Enter') attemptAdd() }}
          placeholder={`Add genre to ${label.toLowerCase()}…`} />
        <button className="btn btn-primary btn-sm" disabled={checking || !newValue.trim()} onClick={attemptAdd}>
          {checking ? '...' : warn ? 'Add anyway' : 'Add'}
        </button>
      </div>
      {warn && (
        <p className="msg-err" style={{ marginTop: 6, fontSize: 11 }}>
          ⚠️ “{newValue.trim()}” was never seen in the game database — check the spelling, or click “Add anyway”.
        </p>
      )}
    </div>
  )
}
