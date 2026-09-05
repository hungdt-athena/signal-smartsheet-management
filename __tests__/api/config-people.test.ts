/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => ({ sql: jest.fn() }))

import { GET, PATCH } from '@/app/api/config/people/route'
import { sql } from '@/lib/db'

const sqlMock = sql as unknown as jest.Mock

function req(body: unknown) {
  return new NextRequest('http://localhost/api/config/people', {
    method: 'PATCH', body: JSON.stringify(body),
  } as never)
}

// The route fires five reads in parallel; branch on SQL text so each gets its rows.
// The two app_config reads share identical SQL — the key is a bound parameter —
// so those branch on the argument instead.
function mockReads({ hidden = [] as string[], excluded = [] as string[],
                    users = [{ key: 'mitt', title: 'Fulltime', active: true }] } = {}) {
  sqlMock.mockImplementation((strings: string[], ...args: unknown[]) => {
    const text = strings.join(' ')
    if (text.includes('SELECT value') && text.includes('app_config')) {
      if (args[0] === 'people_config') return Promise.resolve([{ value: JSON.stringify({ hiddenInFilters: hidden }) }])
      if (args[0] === 'report_config') return Promise.resolve([{ value: JSON.stringify({ excluded }) }])
      return Promise.resolve([])
    }
    if (text.includes('evaluator_roster')) return Promise.resolve([{ key: 'mitt', name: 'MiTT' }])
    if (text.includes('game_evaluations')) return Promise.resolve([
      { key: 'mitt', name: 'MiTT', last_eval: '2026-09-05T00:00:00Z', recent: 12, total: 400 },
      { key: 'shortcut', name: 'Shortcut', last_eval: '2026-09-01T00:00:00Z', recent: 0, total: 24 },
      { key: 'oldguy', name: 'OldGuy', last_eval: '2026-04-01T00:00:00Z', recent: 0, total: 5 },
    ])
    if (text.includes('dashboard_users')) return Promise.resolve(users)
    if (text.includes('people_config')) return Promise.resolve([{ value: JSON.stringify({ hiddenInFilters: hidden }) }])
    if (text.includes('report_config')) return Promise.resolve([{ value: JSON.stringify({ excluded }) }])
    return Promise.resolve([])
  })
}

describe('/api/config/people', () => {
  const realSkip = process.env.SKIP_AUTH
  beforeAll(() => { process.env.SKIP_AUTH = 'true' })
  afterAll(() => { process.env.SKIP_AUTH = realSkip })
  beforeEach(() => sqlMock.mockReset())

  it('GET merges the roster with everyone who has ever evaluated', async () => {
    mockReads()
    const json = await (await GET()).json()
    expect(json.people.map((p: { key: string }) => p.key)).toEqual(['mitt', 'oldguy'])
    expect(json.staleDays).toBe(7)
  })

  it('GET never lists a system label — Shortcut is not a person to manage', async () => {
    mockReads()
    const json = await (await GET()).json()
    expect(json.people.map((p: { key: string }) => p.key)).not.toContain('shortcut')
    expect(json.noAccount).toBe(1)   // OldGuy, not Shortcut
  })

  it('GET defaults both flags to on', async () => {
    mockReads()
    const json = await (await GET()).json()
    const mitt = json.people.find((p: { key: string }) => p.key === 'mitt')
    expect(mitt.title).toBe('Fulltime')
    expect(mitt.inFilters).toBe(true)
    expect(mitt.inReport).toBe(true)
  })

  it('GET reflects the stored hidden / excluded keys', async () => {
    mockReads({ hidden: ['oldguy'], excluded: ['oldguy'] })
    const json = await (await GET()).json()
    const oldguy = json.people.find((p: { key: string }) => p.key === 'oldguy')
    expect(oldguy.inFilters).toBe(false)
    expect(oldguy.inReport).toBe(false)
  })

  it('PATCH inFilters=false writes the key into people_config', async () => {
    mockReads()
    await PATCH(req({ key: 'OldGuy', inFilters: false }))
    const write = sqlMock.mock.calls.find(c => (c[0] as string[]).join(' ').includes('INSERT INTO app_config'))!
    expect(write[1]).toBe('people_config')
    expect(JSON.parse(write[2] as string)).toEqual({ hiddenInFilters: ['oldguy'] })
  })

  it('PATCH inReport=false writes into report_config.excluded, not a second store', async () => {
    mockReads()
    await PATCH(req({ key: 'oldguy', inReport: false }))
    const write = sqlMock.mock.calls.find(c => (c[0] as string[]).join(' ').includes('INSERT INTO app_config'))!
    expect(write[1]).toBe('report_config')
    expect(JSON.parse(write[2] as string).excluded).toEqual(['oldguy'])
  })

  it('PATCH keys[] hides several people in one write', async () => {
    mockReads()
    await PATCH(req({ keys: ['MiTT', 'OldGuy'], inFilters: false }))
    const write = sqlMock.mock.calls.find(c => (c[0] as string[]).join(' ').includes('INSERT INTO app_config'))!
    expect(JSON.parse(write[2] as string)).toEqual({ hiddenInFilters: ['mitt', 'oldguy'] })
  })

  it('PATCH turning a flag back on removes the key', async () => {
    mockReads({ hidden: ['oldguy', 'thudt'] })
    await PATCH(req({ key: 'oldguy', inFilters: true }))
    const write = sqlMock.mock.calls.find(c => (c[0] as string[]).join(' ').includes('INSERT INTO app_config'))!
    expect(JSON.parse(write[2] as string)).toEqual({ hiddenInFilters: ['thudt'] })
  })

  it('GET leaves out a deactivated user entirely', async () => {
    mockReads({ users: [
      { key: 'mitt', title: 'Fulltime', active: true },
      { key: 'oldguy', title: null as unknown as string, active: false },
    ] })
    const json = await (await GET()).json()
    expect(json.people.map((p: { key: string }) => p.key)).toEqual(['mitt'])
  })

  it('GET counts names that evaluate but have no user account', async () => {
    mockReads()
    const json = await (await GET()).json()
    expect(json.people.find((p: { key: string }) => p.key === 'oldguy').hasAccount).toBe(false)
    expect(json.people.find((p: { key: string }) => p.key === 'mitt').hasAccount).toBe(true)
  })

  it('PATCH rejects a body with no key or no flag', async () => {
    mockReads()
    expect((await PATCH(req({ inFilters: false }))).status).toBe(400)
    expect((await PATCH(req({ key: 'mitt' }))).status).toBe(400)
  })
})
