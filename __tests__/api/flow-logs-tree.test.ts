/**
 * @jest-environment node
 */
import { GET as getYears } from '@/app/api/flow-logs/years/route'
import { GET as getMonths } from '@/app/api/flow-logs/months/route'
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
