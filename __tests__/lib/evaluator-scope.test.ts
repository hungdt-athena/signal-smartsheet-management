import { resolveEvaluatorScope } from '@/lib/evaluations-filters'
import type { Session } from 'next-auth'

// The "evaluators only ever see their own rows" rule lives HERE and nowhere else.
//
// The Evaluate and Short List clients used to also pin `evaluator=<their name>` on
// every request. That was decorative -- this function overrides it for them either way
// -- and it cost a real dependency on useSession() having resolved, which duplicated
// both first-load requests the moment it did. Removing it makes the server the only
// enforcer, so these tests are what keep the rule honest.

const session = (role: string, name: string): Session => ({
  user: { id: 1, email: `${name}@athena.studio`, name, role },
  expires: '',
} as unknown as Session)

const params = (qs: string) => new URLSearchParams(qs)

describe('resolveEvaluatorScope', () => {
  const OLD_ENV = process.env.SKIP_AUTH
  afterEach(() => { process.env.SKIP_AUTH = OLD_ENV })

  it('lets a manager filter by whoever they picked', () => {
    expect(resolveEvaluatorScope(params('evaluator=KhangNA'), session('admin', 'HungDT')))
      .toBe('KhangNA')
    expect(resolveEvaluatorScope(params('evaluator=KhangNA'), session('moderator', 'HungDT')))
      .toBe('KhangNA')
  })

  it('gives a manager the whole team when they picked nobody', () => {
    expect(resolveEvaluatorScope(params(''), session('admin', 'HungDT'))).toBe('')
  })

  it('pins an evaluator to their own name, whatever the client sent', () => {
    // The client no longer sends this at all; a crafted request still gets scoped.
    expect(resolveEvaluatorScope(params('evaluator=HungDT'), session('evaluator', 'KhangNA')))
      .toBe('KhangNA')
    expect(resolveEvaluatorScope(params(''), session('evaluator', 'KhangNA')))
      .toBe('KhangNA')
  })

  it('matches nothing rather than everything for a name-less non-manager', () => {
    // The sentinel is the safe direction: no name must never mean "all rows".
    const scope = resolveEvaluatorScope(params('evaluator=HungDT'), null)
    expect(scope.trim()).toBe('__no_evaluator__')
    expect(scope).not.toBe('')
  })

  it('opens up only under SKIP_AUTH, which is local dev', () => {
    process.env.SKIP_AUTH = 'true'
    expect(resolveEvaluatorScope(params('evaluator=KhangNA'), null)).toBe('KhangNA')
    expect(resolveEvaluatorScope(params(''), null)).toBe('')
  })
})
