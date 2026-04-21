/**
 * @jest-environment node
 */
import { GET as getYears } from '@/app/api/flow-logs/years/route'
import { GET as getMonths } from '@/app/api/flow-logs/months/route'
import { GET as getMonth } from '@/app/api/flow-logs/month/route'
import { NextRequest } from 'next/server'
import { getServerSession } from 'next-auth'

jest.mock('@/lib/db', () => ({ sql: jest.fn() }))
jest.mock('next-auth', () => ({ getServerSession: jest.fn() }))

const { sql } = require('@/lib/db')

describe('GET /api/flow-logs/months', () => {
  it('returns 401 without manager session', async () => {
    ;(getServerSession as jest.Mock).mockResolvedValue(null)
    const res = await getMonths(new NextRequest('http://localhost/api/flow-logs/months?year=2026'))
    expect(res.status).toBe(401)
  })

  it('returns 400 when year param missing', async () => {
    ;(getServerSession as jest.Mock).mockResolvedValue({ user: { role: 'manager' } })
    const res = await getMonths(new NextRequest('http://localhost/api/flow-logs/months'))
    expect(res.status).toBe(400)
  })

  it('returns sorted month list for a year', async () => {
    ;(getServerSession as jest.Mock).mockResolvedValue({ user: { role: 'manager' } })
    sql.mockResolvedValue([{ month: 4 }, { month: 3 }])
    const res = await getMonths(new NextRequest('http://localhost/api/flow-logs/months?year=2026'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual([4, 3])
  })
})

describe('GET /api/flow-logs/month', () => {
  it('returns 401 without manager session', async () => {
    ;(getServerSession as jest.Mock).mockResolvedValue(null)
    const res = await getMonth(new NextRequest('http://localhost/api/flow-logs/month?year=2026&month=4'))
    expect(res.status).toBe(401)
  })

  it('returns 400 when params missing', async () => {
    ;(getServerSession as jest.Mock).mockResolvedValue({ user: { role: 'manager' } })
    const res = await getMonth(new NextRequest('http://localhost/api/flow-logs/month?year=2026'))
    expect(res.status).toBe(400)
  })

  it('groups rows into DayGroup array', async () => {
    ;(getServerSession as jest.Mock).mockResolvedValue({ user: { role: 'manager' } })
    sql.mockResolvedValue([
      { log_date: new Date('2026-04-21'), flow_type: 'pull', period: 'morning', sheet: null, platform: 'all', count: '100', created_at: '2026-04-21T04:00:00Z' },
      { log_date: new Date('2026-04-21'), flow_type: 'pull', period: 'morning', sheet: null, platform: 'ios', count: '40', created_at: '2026-04-21T04:00:00Z' },
      { log_date: new Date('2026-04-21'), flow_type: 'pull', period: 'morning', sheet: null, platform: 'android', count: '60', created_at: '2026-04-21T04:00:00Z' },
      { log_date: new Date('2026-04-21'), flow_type: 'push', period: 'morning', sheet: 'puzzle', platform: 'all', count: '50', created_at: '2026-04-21T03:30:00Z' },
    ])
    const res = await getMonth(new NextRequest('http://localhost/api/flow-logs/month?year=2026&month=4'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveLength(1)
    expect(body[0].log_date).toBe('2026-04-21')
    expect(body[0].entries).toHaveLength(2)
    const pullMorning = body[0].entries.find((e: { flow_type: string; period: string }) => e.flow_type === 'pull' && e.period === 'morning')
    expect(pullMorning.total).toBe(100)
    expect(pullMorning.detail).toEqual({ ios: 40, android: 60 })
    const pushMorning = body[0].entries.find((e: { flow_type: string; period: string }) => e.flow_type === 'push' && e.period === 'morning')
    expect(pushMorning.total).toBe(50)
    expect(pushMorning.detail).toEqual({ puzzle: 50 })
  })
})

describe('GET /api/flow-logs/years', () => {
  it('returns 401 without manager session', async () => {
    ;(getServerSession as jest.Mock).mockResolvedValue(null)
    const res = await getYears(new NextRequest('http://localhost/api/flow-logs/years'))
    expect(res.status).toBe(401)
  })

  it('returns sorted year list', async () => {
    ;(getServerSession as jest.Mock).mockResolvedValue({ user: { role: 'manager' } })
    sql.mockResolvedValue([{ year: 2026 }, { year: 2025 }])
    const res = await getYears(new NextRequest('http://localhost/api/flow-logs/years'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual([2026, 2025])
  })
})
