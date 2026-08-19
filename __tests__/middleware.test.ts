jest.mock('next-auth/middleware', () => ({
  withAuth: jest.fn((fn: unknown) => fn),
}))

jest.mock('next/server', () => ({
  NextResponse: {
    redirect: jest.fn((url: URL) => ({ redirectedTo: String(url) })),
    next: jest.fn(() => ({ next: true })),
  },
}))

import middleware, { config } from '@/middleware'
import { NextResponse } from 'next/server'

const redirect = NextResponse.redirect as unknown as jest.Mock

/** A request as the middleware reads one: a path, a query and a role. */
function req(url: string, role: string | undefined) {
  const parsed = new URL(url, 'http://localhost')
  return {
    url: parsed.href,
    nextUrl: { pathname: parsed.pathname, searchParams: parsed.searchParams },
    nextauth: { token: role ? { role } : null },
  }
}

const run = (url: string, role: string | undefined) =>
  (middleware as unknown as (r: unknown) => unknown)(req(url, role))

/** Where the middleware sent this request, or null if it let it through. */
function wentTo(url: string, role: string | undefined): string | null {
  redirect.mockClear()
  run(url, role)
  return redirect.mock.calls.length ? String(redirect.mock.calls[0][0]) : null
}

describe('middleware config', () => {
  it('matches the pages it guards', () => {
    const matcher = config.matcher as string[]
    expect(matcher).toEqual(expect.arrayContaining(['/evaluations/:path*', '/team-ops/:path*']))
  })
})

// The sidebar hides these from non-admins; the middleware is what stops them
// being reached by URL anyway. The two lists have to agree, or a tab appears in
// the sidebar and bounces when clicked.
describe('middleware: evaluations tabs by role', () => {
  const realSkip = process.env.SKIP_AUTH
  beforeAll(() => { process.env.SKIP_AUTH = undefined })
  afterAll(() => { process.env.SKIP_AUTH = realSkip })

  it('keeps the in-development buckets admin-only', () => {
    expect(wentTo('/evaluations?cat=arcade', 'evaluator')).toContain('cat=puzzle')
    expect(wentTo('/evaluations?cat=simulation', 'evaluator')).toContain('cat=puzzle')
  })

  // Tagging is readable by evaluators: their own pending proposals, and the
  // history of what review made of them. Acting on a tag stays admin-only, in
  // the routes rather than here.
  it('lets an evaluator reach Tagging', () => {
    expect(wentTo('/evaluations?cat=tagging', 'evaluator')).toBeNull()
  })

  it('lets an admin reach everything', () => {
    expect(wentTo('/evaluations?cat=tagging', 'admin')).toBeNull()
    expect(wentTo('/evaluations?cat=arcade', 'admin')).toBeNull()
  })
})
