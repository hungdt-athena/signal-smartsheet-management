'use client'
import { useEffect, useState, useCallback } from 'react'
import { StyledSelect } from '@/components/StyledSelect'

interface User {
  id: number
  email: string
  name: string
  role: 'admin' | 'evaluator'
  created_at: string
}

const SUPER_ADMIN = 'hungdt@athena.studio'

export default function AdminPage() {
  const [users, setUsers] = useState<User[]>([])
  const [loading, setLoading] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState<string | null>(null)

  // Add user form
  const [newEmail, setNewEmail] = useState('')
  const [newName, setNewName] = useState('')
  const [newRole, setNewRole] = useState<'admin' | 'evaluator'>('evaluator')
  const [adding, setAdding] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

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

  async function handleRoleChange(id: number, role: string) {
    try {
      const res = await fetch('/api/admin/users', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, role }),
      })
      if (res.ok) fetchUsers()
      else {
        const body = await res.json()
        alert(body.error ?? 'Failed to update role')
      }
    } catch { /* ignore */ }
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

  const inputStyle: React.CSSProperties = {
    border: '1px solid #D4C4A0', borderRadius: 6,
    padding: '6px 8px', fontSize: 12, background: '#FAF5EC', color: '#2A1F08',
  }
  const thStyle: React.CSSProperties = {
    padding: '6px 10px', textAlign: 'left', fontSize: 11, fontWeight: 700,
    color: '#6B5A3A', background: '#D4C4A0', borderBottom: '2px solid #C8B896',
  }
  const tdStyle: React.CSSProperties = {
    padding: '6px 10px', fontSize: 12, color: '#2A1F08', borderBottom: '1px solid #EFE3C8',
  }

  return (
    <div className="space-y-4 w-full">
      <h1 className="font-extrabold text-2xl" style={{ color: '#2A1F08' }}>Admin</h1>

      {/* Add User + Sync */}
      <div className="bean-card p-4">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <p className="bean-section-label" style={{ marginBottom: 0 }}>Add User</p>
          <button onClick={handleSync} disabled={syncing}
            style={{
              background: '#7A8C1E', color: '#fff', border: 'none', borderRadius: 7,
              padding: '5px 12px', fontSize: 11, fontWeight: 700,
              cursor: syncing ? 'not-allowed' : 'pointer', opacity: syncing ? 0.6 : 1,
            }}>
            {syncing ? 'Syncing...' : 'Sync Evaluators'}
          </button>
        </div>

        {syncResult && (
          <p style={{ fontSize: 11, color: '#5A6A10', marginBottom: 8, fontWeight: 600 }}>{syncResult}</p>
        )}

        <form onSubmit={handleAdd} style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 140 }}>
            <label style={{ display: 'block', fontSize: 10, fontWeight: 700, color: '#6B5A3A', marginBottom: 2 }}>Email</label>
            <input
              value={newEmail} onChange={e => setNewEmail(e.target.value)}
              placeholder="user@athena.studio"
              required style={{ ...inputStyle, width: '100%' }}
            />
          </div>
          <div style={{ minWidth: 100 }}>
            <label style={{ display: 'block', fontSize: 10, fontWeight: 700, color: '#6B5A3A', marginBottom: 2 }}>Name</label>
            <input
              value={newName} onChange={e => setNewName(e.target.value)}
              placeholder="Display name"
              style={{ ...inputStyle, width: '100%' }}
            />
          </div>
          <div style={{ minWidth: 90 }}>
            <label style={{ display: 'block', fontSize: 10, fontWeight: 700, color: '#6B5A3A', marginBottom: 2 }}>Role</label>
            <StyledSelect
              value={newRole}
              onChange={v => setNewRole(v as 'admin' | 'evaluator')}
              options={[{ value: 'evaluator', label: 'Evaluator' }, { value: 'admin', label: 'Admin' }]}
            />
          </div>
          <button type="submit" disabled={adding || !newEmail}
            style={{
              background: '#5A3E1B', color: '#fff', border: 'none', borderRadius: 7,
              padding: '6px 14px', fontSize: 12, fontWeight: 700,
              cursor: (adding || !newEmail) ? 'not-allowed' : 'pointer',
              opacity: (adding || !newEmail) ? 0.55 : 1,
            }}>
            {adding ? '...' : 'Add'}
          </button>
        </form>

        {message && (
          <p style={{ fontSize: 11, marginTop: 8, color: message.type === 'success' ? '#3D6B00' : '#b91c1c', fontWeight: 600 }}>
            {message.text}
          </p>
        )}
      </div>

      {/* User List */}
      <div className="bean-card p-4">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <p className="bean-section-label" style={{ marginBottom: 0 }}>Users ({users.length})</p>
          <button onClick={fetchUsers} disabled={loading}
            style={{
              background: '#D4C4A0', color: '#5A3E1B', border: 'none', borderRadius: 7,
              padding: '3px 10px', fontSize: 11, fontWeight: 700,
              cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.6 : 1,
            }}>
            {loading ? '...' : 'Refresh'}
          </button>
        </div>

        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={thStyle}>Email</th>
                <th style={thStyle}>Name</th>
                <th style={thStyle}>Role</th>
                <th style={thStyle}>Created</th>
                <th style={thStyle}></th>
              </tr>
            </thead>
            <tbody>
              {users.length === 0 && !loading && (
                <tr><td colSpan={5} style={{ ...tdStyle, textAlign: 'center', color: '#9A8A6A', padding: 16 }}>No users</td></tr>
              )}
              {loading && (
                <tr><td colSpan={5} style={{ ...tdStyle, textAlign: 'center', color: '#9A8A6A', padding: 16 }}>Loading...</td></tr>
              )}
              {!loading && users.map(u => {
                const isSuper = u.email === SUPER_ADMIN
                return (
                  <tr key={u.id}>
                    <td style={tdStyle}>
                      <span style={{ fontWeight: 600 }}>{u.email}</span>
                      {isSuper && (
                        <span style={{ fontSize: 9, fontWeight: 700, marginLeft: 6, padding: '1px 4px', borderRadius: 4, background: '#FEF3C7', color: '#92400E' }}>
                          SUPER
                        </span>
                      )}
                    </td>
                    <td style={tdStyle}>{u.name}</td>
                    <td style={tdStyle}>
                      <StyledSelect
                        value={u.role}
                        disabled={isSuper}
                        onChange={v => handleRoleChange(u.id, v)}
                        options={[{ value: 'admin', label: 'admin' }, { value: 'evaluator', label: 'evaluator' }]}
                      />
                    </td>
                    <td style={{ ...tdStyle, fontSize: 11, color: '#9A8A6A' }}>
                      {u.created_at ? new Date(u.created_at).toLocaleDateString() : '—'}
                    </td>
                    <td style={tdStyle}>
                      {!isSuper && (
                        <button onClick={() => handleDelete(u.id, u.email)}
                          style={{
                            background: 'none', border: 'none', color: '#b91c1c',
                            fontSize: 11, fontWeight: 700, cursor: 'pointer',
                          }}>
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
