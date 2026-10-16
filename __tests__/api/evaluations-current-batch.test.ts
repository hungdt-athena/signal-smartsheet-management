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
let batchStart: string | null = '2026-10-14T09:30'

function db(config: { key: string; value: string | null }[]) {
  calls = []
  sqlMock.mockReset()
  sqlMock.mockImplementation((strings: unknown, ...binds: unknown[]) => {
    const text = Array.isArray(strings) ? (strings as string[]).join(' ') : ''
    calls.push({ text, binds })
    if (text.includes('SELECT key, value')) return Promise.resolve(config)
    // the batch's own start day: the upsert returns it, the read-back selects it
    if (text.includes('INSERT INTO batches')) return Promise.resolve([{ starts_at: batchStart }])
    if (text.includes('FROM batches')) return Promise.resolve(batchStart ? [{ starts_at: batchStart }] : [])
    return Promise.resolve([])
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
    expect(await res.json()).toEqual({ current_batch: 'W2 Oct, 2026', starts_at: '2026-10-14T09:30' })
  })

  it('POST writes the single global key, whatever category the caller sends', async () => {
    db([])
    const res = await post({ category: 'arcade', batch: 'W3 Oct, 2026' })
    expect(await res.json()).toEqual({ current_batch: 'W3 Oct, 2026', starts_at: '2026-10-14T09:30' })
    const write = calls.find(c => c.text.includes('INSERT INTO app_config'))!
    expect(write.binds[0]).toBe('current_batch')
    expect(write.binds).toContain('W3 Oct, 2026')
    expect(JSON.stringify(write.binds)).not.toContain('arcade')
  })

  it('POST with no batch stores null, meaning "none"', async () => {
    db([])
    const res = await post({ batch: null })
    expect(await res.json()).toEqual({ current_batch: null, starts_at: null })
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

describe('/api/evaluations/current-batch start time', () => {
  const realSkip = process.env.SKIP_AUTH
  beforeEach(() => {
    process.env.SKIP_AUTH = 'false'
    sessionMock.mockResolvedValue({ user: { name: 'HungDT', role: 'admin' } })
    batchStart = '2026-10-14T09:30'
  })
  afterAll(() => { process.env.SKIP_AUTH = realSkip })
  const upsert = () => calls.find(c => c.text.includes('INSERT INTO batches'))!

  it('a new batch starts NOW unless a time is given (the switch happens mid-day)', async () => {
    db([])
    await post({ batch: 'W4 Oct, 2026' })
    expect(upsert().text).toMatch(/COALESCE\(\$\d*\s*::timestamp AT TIME ZONE 'Asia\/Ho_Chi_Minh', NOW\(\)\)|NOW\(\)/)
    expect(upsert().text).toMatch(/Asia\/Ho_Chi_Minh/)
    expect(upsert().binds).toContain('W4 Oct, 2026')
    expect(upsert().binds).toContain(null)               // no start given -> server default / keep
  })

  it('stores the time the manager picked, read as Vietnam time', async () => {
    db([])
    const res = await post({ batch: 'W4 Oct, 2026', starts_at: '2026-10-21T09:15' })
    expect(res.status).toBe(200)
    expect(upsert().binds).toContain('2026-10-21T09:15')
    expect(upsert().text).toMatch(/::timestamp AT TIME ZONE 'Asia\/Ho_Chi_Minh'/)
  })

  it('keeps starts_on in step with starts_at for a build that still reads it', async () => {
    db([])
    await post({ batch: 'W4 Oct, 2026', starts_at: '2026-10-21T09:15' })
    expect(upsert().text).toMatch(/starts_on/)
  })

  it('writes the start BEFORE the current batch, so a refused start changes nothing', async () => {
    db([])
    await post({ batch: 'W4 Oct, 2026', starts_at: '2026-10-21T09:15' })
    const order = calls.map(c => (c.text.includes('INSERT INTO batches') ? 'batches' : c.text.includes('INSERT INTO app_config') ? 'config' : ''))
      .filter(Boolean)
    expect(order).toEqual(['batches', 'config'])
  })

  it('answers 409 and leaves the current batch alone when another batch starts at that moment', async () => {
    db([])
    sqlMock.mockImplementation((strings: unknown, ...binds: unknown[]) => {
      const text = Array.isArray(strings) ? (strings as string[]).join(' ') : ''
      calls.push({ text, binds })
      if (text.includes('INSERT INTO batches')) return Promise.reject(Object.assign(new Error('dup'), { code: '23505' }))
      return Promise.resolve([])
    })
    const res = await post({ batch: 'W4 Oct, 2026', starts_at: '2026-10-14T09:30' })
    expect(res.status).toBe(409)
    expect(calls.some(c => c.text.includes('INSERT INTO app_config'))).toBe(false)
  })

  it.each([['2026-02-31T09:00'], ['2026-10-14'], ['2026-10-14 09:30'], ['2026-10-14T25:00'], ['2026-10-14T09:30:00Z'], [20261014], [true]])('400 and no write for starts_at %j', async at => {
    db([])
    const res = await post({ batch: 'W4 Oct, 2026', starts_at: at })
    expect(res.status).toBe(400)
    expect(calls.some(c => c.text.includes('INSERT INTO'))).toBe(false)
  })

  it('clearing the batch does not touch `batches`', async () => {
    db([])
    await post({ batch: null })
    expect(calls.some(c => c.text.includes('INSERT INTO batches'))).toBe(false)
  })
})

describe('POST /api/evaluations/current-batch validation', () => {
  const realSkip = process.env.SKIP_AUTH
  beforeEach(() => {
    process.env.SKIP_AUTH = 'false'
    sessionMock.mockResolvedValue({ user: { name: 'HungDT', role: 'admin' } })
  })
  afterAll(() => { process.env.SKIP_AUTH = realSkip })

  const wrote = () => calls.some(c => c.text.includes('INSERT INTO app_config'))
  const raw = (body: string) =>
    POST(new NextRequest('http://localhost/api/evaluations/current-batch', { method: 'POST', body } as never))

  // A request that is not clearly "set X" or "clear" must never clear the batch for everyone.
  it.each([
    ['empty object', {}],
    ['array', []],
    ['string', 'str'],
    ['number', 5],
    ['only a category', { category: 'arcade' }],
    ['batch is an object', { batch: {} }],
    ['batch is a number', { batch: 5 }],
    ['batch is a boolean', { batch: true }],
    ['batch is false', { batch: false }],
    ['batch is 0', { batch: 0 }],
    ['batch is an array', { batch: ['W2 Oct, 2026'] }],
    ['not a label', { batch: 'next week' }],
    ['lowercase label', { batch: 'w2 oct, 2026' }],
    ['week 5', { batch: 'W5 Oct, 2026' }],
    ['41 chars', { batch: 'W2 Oct, 2026' + ' '.repeat(10) + 'x'.repeat(19) }],
    ['control character', { batch: 'W2 Oct, 2026\u0000' }],
  ])('400 and no write: %s', async (_name, body) => {
    db([])
    const res = await post(body)
    expect(res.status).toBe(400)
    expect(typeof (await res.json()).error).toBe('string')
    expect(wrote()).toBe(false)
  })

  it.each([['null body', 'null'], ['invalid JSON', '{nope'], ['empty body', '']])('400 and no write: %s', async (_n, body) => {
    db([])
    const res = await raw(body)
    expect(res.status).toBe(400)
    expect(wrote()).toBe(false)
  })

  it.each([[null], [''], ['  ']])('clears the batch for %j', async value => {
    db([])
    const res = await post({ batch: value })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ current_batch: null, starts_at: null })
    expect(calls.find(c => c.text.includes('INSERT INTO app_config'))!.binds[1]).toBeNull()
  })

  it('stores the trimmed label', async () => {
    db([])
    const res = await post({ batch: '  W3 Oct, 2026\n' })
    expect(await res.json()).toEqual({ current_batch: 'W3 Oct, 2026', starts_at: '2026-10-14T09:30' })
    expect(calls.find(c => c.text.includes('INSERT INTO app_config'))!.binds).toContain('W3 Oct, 2026')
  })
})
