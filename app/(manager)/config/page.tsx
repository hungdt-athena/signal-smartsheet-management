'use client'
import { useEffect, useState, useCallback, useMemo } from 'react'
import { BUCKETS, type Bucket } from '@/lib/buckets'
import { OptionRows } from '@/components/OptionRows'
import { PeopleSection } from '@/components/config/PeopleSection'

type Field = 'conclusion' | 'final_conclusion'

interface OptionRow { id: number; field: string; value: string; sort_order: number; active: boolean }
type UsageMap = Record<string, Record<string, number>>

const FIELDS: { key: Field; label: string; note: string }[] = [
  { key: 'conclusion',       label: 'Initial Conclusion', note: "Evaluator's conclusion options" },
  { key: 'final_conclusion', label: 'Final Conclusion',   note: 'Moderator triage verdicts (Short List)' },
]

export default function ConfigPage() {
  const [data, setData] = useState<Record<Field, OptionRow[]>>({ conclusion: [], final_conclusion: [] })
  const [usage, setUsage] = useState<UsageMap>({})
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/config?manage=1', { cache: 'no-store' })
      if (res.ok) {
        const json = await res.json()
        setData({ conclusion: json.conclusion ?? [], final_conclusion: json.final_conclusion ?? [] })
        setUsage(json.usage ?? {})
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

      <PeopleSection />

      <div className="cfg-grid">
        {FIELDS.map(f => (
          <ConfigSection
            key={f.key}
            label={f.label}
            note={f.note}
            options={data[f.key]}
            usage={usage[f.key]}
            loading={loading}
            onAdd={value => send('POST', { field: f.key, value })}
            onRename={(id, value) => send('PATCH', { id, value })}
            onToggle={(id, active) => send('PATCH', { id, active })}
            onReorder={ids => send('PATCH', { field: f.key, ids })}
            onDelete={id => send('DELETE', { id })}
          />
        ))}
      </div>

      <CategorySection />
    </div>
  )
}

function ConfigSection({
  label, note, options, usage, loading, onAdd, onRename, onToggle, onReorder, onDelete,
}: {
  label: string
  note: string
  options: OptionRow[]
  usage?: Record<string, number>
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

  const activeCount = options.filter(o => o.active).length

  const items = useMemo(() => options.map(o => {
    const n = usage?.[o.value.toLowerCase()]
    return {
      id: o.id,
      label: o.value,
      active: o.active,
      usage: n ? `${n.toLocaleString('en-US')} games` : undefined,
    }
  }), [options, usage])

  return (
    <div className="card">
      <div className="card-head">
        <span className="card-label">{label}</span>
        <span className="card-note">
          {note} · {activeCount}/{options.length} on · ▲▼ to reorder, click a name to rename
        </span>
      </div>

      <OptionRows
        items={items}
        loading={loading}
        onToggle={(id, active) => { onToggle(id, active) }}
        onReorder={ids => { onReorder(ids) }}
        onRename={(id, value) => { onRename(id, value) }}
        onDelete={id => { onDelete(id) }}
      />

      <form onSubmit={handleAdd} className="cfg-add">
        <input
          className="input"
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

// ── Genre → Sub-genre section ─────────────────────────────────────────────────────

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
        <span className="card-label">Genre → Sub-genre</span>
        <span className="card-note">Which game genres feed each evaluation bucket · order does not matter here, so no ▲▼</span>
      </div>
      <div className="cfg-grid cfg-grid-3">
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

  const used = rows.filter(r => r.active)

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

  return (
    <div className="cfg-bucket">
      <div className="cfg-bucket-head">
        {label} <span>· {used.length} on / {rows.length - used.length} off</span>
      </div>
      <OptionRows
        items={rows.map(r => ({ id: r.id, label: r.genre, active: r.active }))}
        loading={loading}
        emptyText="No sub-genre yet"
        onToggle={(id, active) => { onToggle(id, active) }}
        onDelete={id => { onDelete(id) }}
      />
      <div className="cfg-add">
        <input className="input" value={newValue}
          onChange={e => { setNewValue(e.target.value); setWarn(false) }}
          onKeyDown={e => { if (e.key === 'Enter') attemptAdd() }}
          placeholder={`Add to ${label.toLowerCase()}…`} />
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
