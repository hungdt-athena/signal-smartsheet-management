/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => ({ sql: jest.fn() }))

import { PUT } from '@/app/api/admin/users/route'
import { GET as auditGET, POST as auditPOST } from '@/app/api/admin/users/audit-evaluators/route'
import { sql } from '@/lib/db'

const sqlMock = sql as unknown as jest.Mock

function put(body: unknown) {
  return new NextRequest('http://localhost/api/admin/users', {
    method: 'PUT', body: JSON.stringify(body),
  } as never)
}

describe('deactivating a user', () => {
  const realSkip = process.env.SKIP_AUTH
  beforeAll(() => { process.env.SKIP_AUTH = 'true' })
  afterAll(() => { process.env.SKIP_AUTH = realSkip })
  beforeEach(() => sqlMock.mockReset())

  it('PUT { active: false } writes the flag', async () => {
    sqlMock.mockImplementation((strings: string[]) => {
      const text = strings.join(' ')
      if (text.includes('SELECT email, role')) return Promise.resolve([{ email: 'a@athena.studio', role: 'evaluator' }])
      return Promise.resolve([])
    })
    const res = await PUT(put({ id: 3, active: false }))
    expect(await res.json()).toEqual({ ok: true })
    const update = sqlMock.mock.calls.find(c => (c[0] as string[]).join(' ').includes('UPDATE dashboard_users'))!
    expect(update).toBeDefined()
    expect(update).toContain(false)
  })

  it('PUT rejects a non-boolean active', async () => {
    const res = await PUT(put({ id: 3, active: 'no' }))
    expect(res.status).toBe(400)
  })

  it('PUT refuses to deactivate the super admin', async () => {
    sqlMock.mockResolvedValue([{ email: 'hungdt@athena.studio', role: 'admin' }])
    const res = await PUT(put({ id: 1, active: false }))
    expect(res.status).toBe(403)
  })

  it('PUT still needs at least one field', async () => {
    const res = await PUT(put({ id: 3 }))
    expect(res.status).toBe(400)
  })
})

describe('audit-evaluators', () => {
  const realSkip = process.env.SKIP_AUTH
  beforeAll(() => { process.env.SKIP_AUTH = 'true' })
  afterAll(() => { process.env.SKIP_AUTH = realSkip })
  beforeEach(() => sqlMock.mockReset())

  const orphans = [
    { key: 'oldguy', name: 'OldGuy', total: 24, last_eval: '2026-09-01T00:00:00Z' },
    { key: 'exfree', name: 'ExFree', total: 5, last_eval: null },
  ]

  it('GET previews the names with no account and writes nothing', async () => {
    sqlMock.mockResolvedValue(orphans)
    const json = await (await auditGET()).json()
    expect(json.orphans).toHaveLength(2)
    expect(sqlMock.mock.calls.some(c => (c[0] as string[]).join(' ').includes('INSERT'))).toBe(false)
  })

  it('the orphan query matches on lower(name), not on email', async () => {
    sqlMock.mockResolvedValue([])
    await auditGET()
    const text = (sqlMock.mock.calls[0][0] as string[]).join(' ')
    expect(text).toContain('lower(du.name) = lower(ge.initial_evaluator)')
    expect(text).not.toContain('email')
  })

  it('the orphan query skips system labels — Shortcut never gets an account', async () => {
    sqlMock.mockResolvedValue([])
    await auditGET()
    const call = sqlMock.mock.calls[0]
    expect((call[0] as string[]).join(' ')).toContain('<> ALL(')
    expect(call).toContainEqual(['shortcut'])
  })

  it('POST creates every orphan as a deactivated account', async () => {
    sqlMock.mockImplementation((strings: string[]) => {
      const text = strings.join(' ')
      if (text.includes('INSERT INTO dashboard_users')) return Promise.resolve([{ id: 9 }])
      return Promise.resolve(orphans)
    })
    const json = await (await auditPOST()).json()
    expect(json.created).toEqual(['OldGuy', 'ExFree'])
    const insert = sqlMock.mock.calls.find(c => (c[0] as string[]).join(' ').includes('INSERT INTO dashboard_users'))!
    expect((insert[0] as string[]).join(' ')).toContain("'evaluator', false")
    expect(insert).toContain('oldguy@athena.studio')
  })

  it('POST reports a name it could not create rather than renaming someone else', async () => {
    sqlMock.mockImplementation((strings: string[]) => {
      const text = strings.join(' ')
      if (text.includes('INSERT INTO dashboard_users')) return Promise.resolve([])   // ON CONFLICT DO NOTHING
      return Promise.resolve(orphans)
    })
    const json = await (await auditPOST()).json()
    expect(json.created).toEqual([])
    expect(json.skipped).toEqual(['OldGuy', 'ExFree'])
  })
})
