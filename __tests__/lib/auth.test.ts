import { authOptions } from '@/lib/auth'

jest.mock('@/lib/db', () => ({
  sql: jest.fn().mockImplementation(() => Promise.resolve([]))
}))

describe('authOptions', () => {
  it('has Google provider configured', () => {
    expect(authOptions.providers).toHaveLength(1)
    expect(authOptions.providers[0].id).toBe('google')
  })

  it('has callbacks defined', () => {
    expect(authOptions.callbacks?.signIn).toBeDefined()
    expect(authOptions.callbacks?.session).toBeDefined()
  })
})
