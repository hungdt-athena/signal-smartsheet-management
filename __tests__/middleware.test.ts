jest.mock('next-auth/middleware', () => ({
  withAuth: jest.fn((fn: unknown) => fn),
}))

jest.mock('next/server', () => ({
  NextResponse: {
    redirect: jest.fn(),
    next: jest.fn(),
  },
}))

import { config } from '@/middleware'

describe('middleware config', () => {
  it('matches manager routes', () => {
    const matcher = config.matcher as string[]
    expect(matcher.some(m => m.includes('dashboard'))).toBe(true)
  })
})
