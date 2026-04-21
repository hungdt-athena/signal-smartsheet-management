/**
 * @jest-environment node
 */
import { GET as getYears } from '@/app/api/flow-logs/years/route'
import { NextRequest } from 'next/server'
import { getServerSession } from 'next-auth'

jest.mock('@/lib/db', () => ({ sql: jest.fn() }))
jest.mock('next-auth', () => ({ getServerSession: jest.fn() }))

const { sql } = require('@/lib/db')

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
