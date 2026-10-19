import { act, renderHook } from '@testing-library/react'

jest.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(window.location.search),
  usePathname: () => window.location.pathname,
}))

import { useSetUrlParams, useUrlState } from '@/lib/use-url-state'

// Next's patched history.replaceState only updates useSearchParams when the data it is
// given does NOT carry Next's own __NA mark. Writing with window.history.state (which
// does carry it) changed the URL but left the page on the old filter until a reload.
describe('lib/use-url-state', () => {
  beforeEach(() => { window.history.replaceState({ __NA: true }, '', '/evaluations?cat=short_list') })

  it('writes with null data so Next updates useSearchParams', () => {
    const spy = jest.spyOn(window.history, 'replaceState')
    const { result } = renderHook(() => useUrlState('bucket', 'puzzle'))
    act(() => { result.current[1]('arcade') })
    expect(spy).toHaveBeenLastCalledWith(null, '', '/evaluations?cat=short_list&bucket=arcade')
    spy.mockRestore()
  })

  it('drops the key when set back to its default, keeps the rest', () => {
    window.history.replaceState(null, '', '/evaluations?cat=short_list&bucket=arcade')
    const { result } = renderHook(() => useUrlState('bucket', 'puzzle'))
    act(() => { result.current[1]('puzzle') })
    expect(window.location.search).toBe('?cat=short_list')
  })

  it('sets several keys in one write, from the live URL', () => {
    const spy = jest.spyOn(window.history, 'replaceState')
    const { result } = renderHook(() => useSetUrlParams())
    act(() => { result.current({ batch: 'W2 Oct, 2026', ev: 'HuyDD' }) })
    act(() => { result.current({ ev: null }) })
    expect(window.location.search).toBe('?cat=short_list&batch=W2+Oct%2C+2026')
    expect(spy.mock.calls.every(c => c[0] === null)).toBe(true)
    spy.mockRestore()
  })
})
