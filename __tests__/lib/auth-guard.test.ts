/**
 * @jest-environment node
 */
jest.mock('next-auth', () => ({ getServerSession: jest.fn() }))
jest.mock('@/lib/auth', () => ({ authOptions: {} }))

import { requireAdmin, requireManager, requireRole } from '@/lib/auth-guard'
import { getServerSession } from 'next-auth'

const sessionMock = getServerSession as unknown as jest.Mock

describe('auth-guard tiers', () => {
  const realSkip = process.env.SKIP_AUTH
  beforeAll(() => { process.env.SKIP_AUTH = undefined })
  afterAll(() => { process.env.SKIP_AUTH = realSkip })

  it('requireManager accepts admin and moderator, rejects evaluator', async () => {
    sessionMock.mockResolvedValue({ user: { role: 'admin' } })
    expect(await requireManager()).toBeNull()
    sessionMock.mockResolvedValue({ user: { role: 'moderator' } })
    expect(await requireManager()).toBeNull()
    sessionMock.mockResolvedValue({ user: { role: 'evaluator' } })
    expect((await requireManager())?.status).toBe(403)
  })

  it('requireAdmin rejects moderator', async () => {
    sessionMock.mockResolvedValue({ user: { role: 'moderator' } })
    expect((await requireAdmin())?.status).toBe(403)
    sessionMock.mockResolvedValue({ user: { role: 'admin' } })
    expect(await requireAdmin()).toBeNull()
  })

  it('returns 401 with no session at all', async () => {
    sessionMock.mockResolvedValue(null)
    expect((await requireRole('admin'))?.status).toBe(401)
  })
})
