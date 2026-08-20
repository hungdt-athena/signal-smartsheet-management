'use client'
import { useEffect, useState, useCallback } from 'react'
import { useSession } from 'next-auth/react'
import { StyledSelect } from '@/components/StyledSelect'

type Role = 'admin' | 'moderator' | 'evaluator'

interface User {
  id: number
  email: string
  name: string
  role: Role
  title: string | null
  created_at: string
}

const SUPER_ADMIN = 'hungdt@athena.studio'

const ROLE_OPTIONS: { value: Role; label: string }[] = [
  { value: 'admin', label: 'Admin' },
  { value: 'moderator', label: 'Moderator' },
  { value: 'evaluator', label: 'Evaluator' },
]

// What a moderator may hand out. Inviting an admin is how a moderator would
// otherwise route around not being able to change a role; the API refuses it
// too, this only keeps the option out of sight.
const MOD_ROLE_OPTIONS = ROLE_OPTIONS.filter(o => o.value !== 'admin')

// Job classification (independent of the access role) — drives the Report
// title filter. '' = not set.
const TITLE_OPTIONS = [
  { value: '', label: '—' },
  { value: 'Admin', label: 'Admin' },
  { value: 'Fulltime', label: 'Fulltime' },
  { value: 'Freelancer', label: 'Freelancer' },
  { value: 'Recorder', label: 'Recorder' },
]

export default function AdminPage() {
  const { data: session } = useSession()
  // Moderators share this page: they invite people and fix display names, but
  // role and Remove are the admin's. The API enforces both.
  const isAdmin = session?.user?.role === 'admin'
  const [users, setUsers] = useState<User[]>([])
  const [loading, setLoading] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState<string | null>(null)

  const [newEmail, setNewEmail] = useState('')
  const [newName, setNewName] = useState('')
  const [newRole, setNewRole] = useState<Role>('evaluator')
  const [adding, setAdding] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  // Inline display-name editing: id of the row being edited + its draft value.
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editName, setEditName] = useState('')

  const fetchUsers = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/admin/users', { cache: 'no-store' })
      if (res.ok) setUsers(await res.json())
    } catch { /* ignore */ }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { fetchUsers() }, [fetchUsers])

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    if (!newEmail) return
    setAdding(true)
    setMessage(null)
    try {
      const email = newEmail.endsWith('@athena.studio') ? newEmail : `${newEmail}@athena.studio`
      const res = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.toLowerCase(), name: newName || email.split('@')[0], role: newRole }),
      })
      if (res.ok) {
        setMessage({ type: 'success', text: `Added ${email}` })
        setNewEmail('')
        setNewName('')
        setNewRole('evaluator')
        fetchUsers()
      } else {
        const body = await res.json()
        setMessage({ type: 'error', text: body.error ?? 'Failed' })
      }
    } catch {
      setMessage({ type: 'error', text: 'Network error' })
    } finally {
      setAdding(false)
    }
  }

  async function updateUser(id: number, patch: { role?: string; name?: string; title?: string }) {
    try {
      const res = await fetch('/api/admin/users', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, ...patch }),
      })
      if (res.ok) fetchUsers()
      else {
        const body = await res.json()
        alert(body.error ?? 'Failed to update')
      }
    } catch { /* ignore */ }
  }

  function startEditName(u: User) {
    setEditingId(u.id)
    setEditName(u.name)
  }
  function commitEditName(u: User) {
    const name = editName.trim()
    setEditingId(null)
    if (name && name !== u.name) updateUser(u.id, { name })
  }

  async function handleDelete(id: number, email: string) {
    if (!confirm(`Remove ${email}?`)) return
    try {
      const res = await fetch('/api/admin/users', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      })
      if (res.ok) fetchUsers()
      else {
        const body = await res.json()
        alert(body.error ?? 'Failed to delete')
      }
    } catch { /* ignore */ }
  }

  async function handleSync() {
    setSyncing(true)
    setSyncResult(null)
    try {
      const res = await fetch('/api/admin/sync-evaluators', { method: 'POST' })
      if (res.ok) {
        const data = await res.json()
        setSyncResult(`Synced: ${data.added} new evaluators added (${data.total} total in sheets)`)
        fetchUsers()
      } else {
        setSyncResult('Sync failed')
      }
    } catch {
      setSyncResult('Network error')
    } finally {
      setSyncing(false)
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <h1 className="h-title">Admin</h1>
      </div>

      {/* Add User + Sync */}
      <div className="card">
        <div className="card-head">
          <span className="card-label">Add User</span>
          <button className="btn btn-sm btn-primary" onClick={handleSync} disabled={syncing}>
            <span className={syncing ? 'spin' : ''}>↻</span>
            {syncing ? 'Syncing...' : 'Sync Evaluators'}
          </button>
        </div>

        {syncResult && (
          <p className="msg-ok" style={{ marginBottom: 10 }}>{syncResult}</p>
        )}

        <form onSubmit={handleAdd} style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div className="field" style={{ flex: 1, minWidth: 140 }}>
            <span className="label">Email</span>
            <input className="input"
              value={newEmail} onChange={e => setNewEmail(e.target.value)}
              placeholder="user@athena.studio"
              required
            />
          </div>
          <div className="field" style={{ minWidth: 100 }}>
            <span className="label">Name</span>
            <input className="input"
              value={newName} onChange={e => setNewName(e.target.value)}
              placeholder="Display name"
            />
          </div>
          <div className="field" style={{ minWidth: 100 }}>
            <span className="label">Role</span>
            <StyledSelect
              value={newRole}
              onChange={v => setNewRole(v as Role)}
              options={isAdmin ? ROLE_OPTIONS : MOD_ROLE_OPTIONS}
            />
          </div>
          <button type="submit" className="btn btn-primary" disabled={adding || !newEmail}>
            {adding ? '...' : 'Add'}
          </button>
        </form>

        {message && (
          <p className={message.type === 'success' ? 'msg-ok' : 'msg-err'} style={{ marginTop: 8 }}>
            {message.text}
          </p>
        )}
      </div>

      {/* User List */}
      <div className="card">
        <div className="card-head">
          <span className="card-label">Users ({users.length})</span>
          <button className="btn btn-sm" onClick={fetchUsers} disabled={loading}>
            <span className={loading ? 'spin' : ''}>↻</span>
            {loading ? '...' : 'Refresh'}
          </button>
        </div>

        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Email</th>
                <th>Name</th>
                <th>Role</th>
                <th>Title</th>
                <th>Created</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {users.length === 0 && !loading && (
                <tr><td colSpan={6} className="empty">No users</td></tr>
              )}
              {loading && (
                <tr><td colSpan={6} className="empty">Loading...</td></tr>
              )}
              {!loading && users.map(u => {
                const isSuper = u.email === SUPER_ADMIN
                return (
                  <tr key={u.id}>
                    <td>
                      <span className="cell-name">{u.email}</span>
                      {isSuper && (
                        <span className="badge running" style={{ fontSize: 9, padding: '1px 5px', marginLeft: 6 }}>SUPER</span>
                      )}
                    </td>
                    <td>
                      {editingId === u.id ? (
                        <input className="input" autoFocus
                          value={editName}
                          onChange={e => setEditName(e.target.value)}
                          onBlur={() => commitEditName(u)}
                          onKeyDown={e => {
                            if (e.key === 'Enter') commitEditName(u)
                            if (e.key === 'Escape') setEditingId(null)
                          }}
                          style={{ minWidth: 100, padding: '3px 6px' }}
                        />
                      ) : (
                        <span onClick={() => startEditName(u)} title="Click to edit display name"
                          style={{ cursor: 'pointer', borderBottom: '1px dashed var(--faint)' }}>
                          {u.name}
                        </span>
                      )}
                    </td>
                    <td>
                      <StyledSelect
                        value={u.role}
                        disabled={isSuper || !isAdmin}
                        onChange={v => updateUser(u.id, { role: v })}
                        options={isAdmin ? ROLE_OPTIONS : MOD_ROLE_OPTIONS}
                      />
                    </td>
                    <td>
                      <StyledSelect
                        value={u.title || ''}
                        onChange={v => updateUser(u.id, { title: v })}
                        options={TITLE_OPTIONS}
                      />
                    </td>
                    <td style={{ color: 'var(--faint)', fontSize: 12 }}>
                      {u.created_at ? new Date(u.created_at).toLocaleDateString() : '—'}
                    </td>
                    <td>
                      {!isSuper && isAdmin && (
                        <button className="btn btn-sm btn-danger"
                          onClick={() => handleDelete(u.id, u.email)}>
                          Remove
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
