/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => ({ sql: jest.fn() }))
jest.mock('next-auth', () => ({ getServerSession: jest.fn() }))
jest.mock('@/lib/auth', () => ({ authOptions: {} }))

import { GET, POST } from '@/app/api/evaluations/current-batch/route'
import { sql } from '@/lib/db'
import { getServerSession } from 'next-auth'

const sqlMock = sql as unknown as jest.Mock
const sessionMock = getServerSession as unknown as jest.Mock

let calls: { text: string; binds: unknown[] }[] = []

function db(config: { key: string; value: string | null }[]) {
  calls = []
  sqlMock.mockReset()
  sqlMock.mockImplementation((strings: unknown, ...binds: unknown[]) => {
    const text = Array.isArray(strings) ? (strings as string[]).join(' ') : ''
    calls.push({ text, binds })
    return Promise.resolve(text.includes('SELECT key, value') ? config : [])
  })
}

const post = (body: unknown) =>
  POST(new NextRequest('http://localhost/api/evaluations/current-batch', {
    method: 'POST', body: JSON.stringify(body),
  } as never))

describe('/api/evaluations/current-batch', () => {
  const realSkip = process.env.SKIP_AUTH
  beforeEach(() => {
    process.env.SKIP_AUTH = 'false'
    sessionMock.mockResolvedValue({ user: { name: 'HungDT', role: 'admin' } })
  })
  afterAll(() => { process.env.SKIP_AUTH = realSkip })

  it('GET returns the global value, ignoring a ?category=', async () => {
    db([
      { key: 'current_batch:puzzle', value: 'W1 Oct, 2026' },
      { key: 'current_batch', value: 'W2 Oct, 2026' },
    ])
    const res = await GET(new NextRequest('http://localhost/api/evaluations/current-batch?category=puzzle'))
    expect(await res.json()).toEqual({ current_batch: 'W2 Oct, 2026' })
  })

  it('POST writes the single global key, whatever category the caller sends', async () => {
    db([])
    const res = await post({ category: 'arcade', batch: 'W3 Oct, 2026' })
    expect(await res.json()).toEqual({ current_batch: 'W3 Oct, 2026' })
    const write = calls.find(c => c.text.includes('INSERT INTO app_config'))!
    expect(write.binds[0]).toBe('current_batch')
    expect(write.binds).toContain('W3 Oct, 2026')
    expect(JSON.stringify(write.binds)).not.toContain('arcade')
  })

  it('POST with no batch stores null, meaning "none"', async () => {
    db([])
    const res = await post({ batch: null })
    expect(await res.json()).toEqual({ current_batch: null })
    const write = calls.find(c => c.text.includes('INSERT INTO app_config'))!
    expect(write.binds[1]).toBeNull()
  })

  it('POST is refused for an evaluator', async () => {
    sessionMock.mockResolvedValue({ user: { name: 'PhuongNT1', role: 'evaluator' } })
    db([])
    const res = await post({ batch: 'W3 Oct, 2026' })
    expect(res.status).toBe(403)
    expect(calls.some(c => c.text.includes('INSERT INTO app_config'))).toBe(false)
  })

  it('POST is refused when not signed in', async () => {
    sessionMock.mockResolvedValue(null)
    db([])
    const res = await post({ batch: 'W3 Oct, 2026' })
    expect(res.status).toBe(401)
  })
})
