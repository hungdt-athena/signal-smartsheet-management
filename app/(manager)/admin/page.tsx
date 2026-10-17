'use client'
import { useEffect, useState, useCallback } from 'react'
import { useSession } from 'next-auth/react'
import { StyledSelect } from '@/components/StyledSelect'
import { Modal } from '@/components/ui/Modal'
import { PageHeader, RefreshButton } from '@/components/ui/PageHeader'
import { ErrorState, SkeletonRows } from '@/components/ui/States'
import { toast } from '@/lib/toast'
import { fmtDateVN } from '@/lib/format-date'

type Role = 'admin' | 'moderator' | 'evaluator'

interface User {
  id: number
  email: string
  name: string
  role: Role
  title: string | null
  active: boolean
  created_at: string
}

interface Orphan { key: string; name: string; total: number; last_eval: string | null }

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
  // role and Deactivate are the admin's. The API enforces both.
  const isAdmin = session?.user?.role === 'admin'
  const [users, setUsers] = useState<User[]>([])
  const [loading, setLoading] = useState(false)
  const [syncing, setSyncing] = useState(false)

  // Evaluator audit: preview first (GET), then apply (POST). Nothing is written
  // until the admin has seen the list.
  const [orphans, setOrphans] = useState<Orphan[] | null>(null)
  const [auditing, setAuditing] = useState(false)
  // The user list could not be loaded. Row updates report through toasts instead.
  const [loadFailed, setLoadFailed] = useState(false)
  // The account waiting for the Deactivate confirmation.
  const [confirmDeactivate, setConfirmDeactivate] = useState<User | null>(null)

  const [newEmail, setNewEmail] = useState('')
  const [newName, setNewName] = useState('')
  const [newRole, setNewRole] = useState<Role>('evaluator')
  const [adding, setAdding] = useState(false)

  // Inline display-name editing: id of the row being edited + its draft value.
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editName, setEditName] = useState('')

  const fetchUsers = useCallback(async () => {
    setLoading(true)
    setLoadFailed(false)
    try {
      const res = await fetch('/api/admin/users', { cache: 'no-store' })
      if (res.ok) setUsers(await res.json())
      else setLoadFailed(true)
    } catch { setLoadFailed(true) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { fetchUsers() }, [fetchUsers])

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    if (!newEmail) return
    setAdding(true)
    try {
      const email = newEmail.endsWith('@athena.studio') ? newEmail : `${newEmail}@athena.studio`
      const res = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.toLowerCase(), name: newName || email.split('@')[0], role: newRole }),
      })
      if (res.ok) {
        toast.success(`Added ${email}`)
        setNewEmail('')
        setNewName('')
        setNewRole('evaluator')
        fetchUsers()
      } else {
        const body = await res.json().catch(() => ({}))
        toast.error(`Not added. ${body.error ?? 'Failed'}`)
      }
    } catch {
      toast.error('Not added. Network error.')
    } finally {
      setAdding(false)
    }
  }

  async function updateUser(id: number, patch: { role?: string; name?: string; title?: string; active?: boolean }) {
    try {
      const res = await fetch('/api/admin/users', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, ...patch }),
      })
      if (res.ok) fetchUsers()
      else {
        const body = await res.json().catch(() => ({}))
        toast.error(`Not saved. ${body.error ?? 'Failed to update'}`)
      }
    } catch {
      toast.error('Not saved. Network error.')
    }
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

  // Deactivating replaced deleting: the row and its history stay, but the person
  // cannot sign in and drops out of every evaluator dropdown and Config › People.
  function setActive(u: User, active: boolean) {
    if (!active) { setConfirmDeactivate(u); return }
    updateUser(u.id, { active })
  }

  async function runAudit(apply: boolean) {
    setAuditing(true)
    try {
      const res = await fetch('/api/admin/users/audit-evaluators', { method: apply ? 'POST' : 'GET' })
      const body = await res.json()
      if (!res.ok) { toast.error(body.error ?? 'Audit failed'); return }
      if (apply) {
        setOrphans(null)
        toast.success(body.created.length
          ? `Created ${body.created.length} deactivated account(s): ${body.created.join(', ')}`
          : 'Nothing to create')
        fetchUsers()
      } else {
        setOrphans(body.orphans)
        if (body.orphans.length === 0) toast.success('Every evaluator already has an account')
      }
    } catch {
      toast.error('Audit failed. Network error.')
    } finally {
      setAuditing(false)
    }
  }

  async function handleSync() {
    setSyncing(true)
    try {
      const res = await fetch('/api/admin/sync-evaluators', { method: 'POST' })
      if (res.ok) {
        const data = await res.json()
        toast.success(`Synced. ${data.added} new evaluators added, ${data.total} in the sheets.`)
        fetchUsers()
      } else {
        toast.error('Sync failed', { label: 'Try again', run: () => { void handleSync() } })
      }
    } catch {
      toast.error('Sync failed. Network error.', { label: 'Try again', run: () => { void handleSync() } })
    } finally {
      setSyncing(false)
    }
  }

  const active = users.filter(u => u.active !== false)
  const inactive = users.filter(u => u.active === false)

  return (
    <div className="page">
      <PageHeader
        title="Users Management"
        sub="Who can sign in, and what each person can do."
        actions={<>
          {isAdmin && (
            <button className="btn btn-sm" onClick={() => runAudit(false)} disabled={auditing}>
              {auditing ? 'Auditing…' : 'Audit evaluators'}
            </button>
          )}
          <button className="btn btn-sm" onClick={handleSync} disabled={syncing}>
            <span className={syncing ? 'spin' : ''} aria-hidden="true">↻</span>
            {syncing ? 'Syncing…' : 'Sync evaluators'}
          </button>
        </>}
      />

      <div className="card">
        <div className="card-head">
          <span className="card-label">Add user</span>
        </div>
        {orphans && orphans.length > 0 && (
          <div className="audit-box">
            <p>
              <b>{orphans.length}</b> evaluator name(s) have no user account. Creating them
              adds a <b>deactivated</b> account each — no sign-in, and they leave Config › People.
              Reactivate any that turn out to be current staff.
            </p>
            <ul>
              {orphans.map(o => (
                <li key={o.key}>
                  <span>{o.name}</span>
                  <span className="audit-meta">
                    {o.total.toLocaleString('en-US')} games · last{' '}
                    {o.last_eval ? fmtDateVN(o.last_eval) : 'never'}
                  </span>
                </li>
              ))}
            </ul>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-sm btn-ghost" onClick={() => setOrphans(null)}>Cancel</button>
              <button className="btn btn-sm btn-primary" onClick={() => runAudit(true)} disabled={auditing}>
                {auditing ? 'Creating…' : `Create ${orphans.length} deactivated account(s)`}
              </button>
            </div>
          </div>
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
            {adding ? 'Adding…' : 'Add user'}
          </button>
        </form>
      </div>

      {/* User List */}
      <div className="card">
        <div className="card-head">
          <span className="card-label">Users ({active.length})</span>
          <RefreshButton onClick={fetchUsers} loading={loading} />
        </div>
        {loadFailed && !loading && <ErrorState onRetry={fetchUsers}>Could not load users.</ErrorState>}

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
              {active.length === 0 && !loading && !loadFailed && (
                <tr><td colSpan={6} className="empty">No users yet. Add one above.</td></tr>
              )}
              {loading && users.length === 0 && <SkeletonRows widths={[200, 110, 120, 120, 70, 80]} rows={4} />}
              {active.map(u => {
                const isSuper = u.email === SUPER_ADMIN
                return (
                  <tr key={u.id}>
                    <td>
                      <span className="cell-name">{u.email}</span>
                      {isSuper && (
                        <span className="badge running" style={{ marginLeft: 6 }}>Super admin</span>
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
                          style={{ minWidth: 100 }}
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
                    <td style={{ color: 'var(--faint)', fontSize: 'var(--fs-12)' }}>
                      {fmtDateVN(u.created_at)}
                    </td>
                    <td>
                      {!isSuper && isAdmin && (
                        <button className="btn btn-sm btn-danger" onClick={() => setActive(u, false)}>
                          Deactivate
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

      {/* Deactivated accounts: their own table, not greyed rows mixed into the
          roster above. Nothing here can sign in, and none of them appear in an
          evaluator dropdown or in Config > People. */}
      {inactive.length > 0 && (
        <div className="card">
          <div className="card-head">
            <span className="card-label">Inactive ({inactive.length})</span>
            <span className="card-note">
              No sign-in, hidden from every evaluator dropdown and from Config › People.
              History and past evaluations are untouched.
            </span>
          </div>

          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Name</th>
                  <th>Title</th>
                  <th>Created</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {inactive.map(u => (
                  <tr key={u.id}>
                    <td><span className="cell-name">{u.email}</span></td>
                    <td>{u.name}</td>
                    <td style={{ color: 'var(--faint)', fontSize: 'var(--fs-12)' }}>{u.title || '—'}</td>
                    <td style={{ color: 'var(--faint)', fontSize: 'var(--fs-12)' }}>
                      {fmtDateVN(u.created_at)}
                    </td>
                    <td>
                      {isAdmin && (
                        <button className="btn btn-sm" onClick={() => setActive(u, true)}>
                          Activate
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {confirmDeactivate && (
        <Modal
          role="alertdialog"
          width={440}
          title={`Deactivate ${confirmDeactivate.name || confirmDeactivate.email}?`}
          onClose={() => setConfirmDeactivate(null)}
          footer={<>
            <button className="btn btn-sm btn-ghost" onClick={() => setConfirmDeactivate(null)}>Cancel</button>
            <button className="btn btn-sm btn-danger" onClick={() => {
              const u = confirmDeactivate
              setConfirmDeactivate(null)
              updateUser(u.id, { active: false })
            }}>Deactivate</button>
          </>}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 'var(--fs-13)' }}>
            <div>{confirmDeactivate.email} will not be able to sign in.</div>
            <div style={{ color: 'var(--muted)' }}>Their evaluations stay. You can activate the account again later.</div>
          </div>
        </Modal>
      )}
    </div>
  )
}
