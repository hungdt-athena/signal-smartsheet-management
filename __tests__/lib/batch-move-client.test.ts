import { moveBatch, MAX_MOVE } from '@/lib/batch-move-client'

const TIMED_OUT = 'Timed out. The move may have gone through. Reload the list to check.'

const respond = (over: Partial<Response> & { json?: () => Promise<unknown> }) =>
  (global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({}), ...over }) as Response) as unknown as typeof fetch)

describe('moveBatch', () => {
  afterEach(() => jest.useRealTimers())

  it('caps one move at 500 games, the same number the route enforces', () => {
    expect(MAX_MOVE).toBe(500)
  })

  it('returns the moved count', async () => {
    respond({ json: async () => ({ moved: 3 }) })
    expect(await moveBatch([1, 2, 3], 'W2 Oct, 2026')).toEqual({ ok: true, moved: 3 })
  })

  it.each([[undefined], [null], ['3'], [-1], [2.5], [NaN], [Infinity], ['x']])(
    'sanitizes a moved value of %p to 0', async moved => {
      respond({ json: async () => ({ moved }) })
      expect(await moveBatch([1], 'W2 Oct, 2026')).toEqual({ ok: true, moved: 0 })
    })

  // A 2xx means the UPDATE committed. A body that cannot be read says nothing about HOW MANY
  // moved, so the count is unknown (null), never 0: 0 would read as "nothing was moved".
  it('a 2xx whose body does not parse is a success with an unknown count, not 0 and not a network error', async () => {
    respond({ json: async () => { throw new SyntaxError('bad json') } })
    expect(await moveBatch([1], 'W2 Oct, 2026')).toEqual({ ok: true, moved: null })
  })

  it('a 2xx whose body is JSON null or not an object has an unknown count too', async () => {
    respond({ json: async () => null })
    expect(await moveBatch([1], 'W2 Oct, 2026')).toEqual({ ok: true, moved: null })
    respond({ json: async () => 'moved' })
    expect(await moveBatch([1], 'W2 Oct, 2026')).toEqual({ ok: true, moved: null })
  })

  it('a 2xx whose body read is cut short by the 30 s timer has an unknown count, and the timer is cleared', async () => {
    jest.useFakeTimers()
    global.fetch = jest.fn(async (_u: RequestInfo | URL, init?: RequestInit) => ({
      ok: true,
      json: () => new Promise((_res, rej) => {
        init?.signal?.addEventListener('abort', () => rej(new DOMException('Aborted', 'AbortError')))
      }),
    }) as Response) as unknown as typeof fetch
    const p = moveBatch([1], 'W2 Oct, 2026')
    await jest.advanceTimersByTimeAsync(30_001)
    expect(await p).toEqual({ ok: true, moved: null })
    expect(jest.getTimerCount()).toBe(0)
  })

  it('returns the server error text, or a generic one when the body is unreadable', async () => {
    respond({ ok: false, json: async () => ({ error: 'Forbidden' }) })
    expect(await moveBatch([1], 'W2 Oct, 2026')).toEqual({ ok: false, error: 'Forbidden' })
    respond({ ok: false, json: async () => { throw new Error('x') } })
    expect(await moveBatch([1], 'W2 Oct, 2026')).toEqual({ ok: false, error: 'Request failed' })
  })

  it('a rejected fetch is a Network error', async () => {
    global.fetch = jest.fn(async () => { throw new TypeError('offline') }) as unknown as typeof fetch
    expect(await moveBatch([1], 'W2 Oct, 2026')).toEqual({ ok: false, error: 'Network error' })
  })

  it('gives up after 30 seconds instead of hanging forever', async () => {
    jest.useFakeTimers()
    global.fetch = jest.fn((_u: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_res, rej) => {
      init?.signal?.addEventListener('abort', () => rej(new DOMException('Aborted', 'AbortError')))
    })) as unknown as typeof fetch
    const p = moveBatch([1], 'W2 Oct, 2026')
    await jest.advanceTimersByTimeAsync(29_999)
    let settled = false
    p.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    await jest.advanceTimersByTimeAsync(2)
    expect(await p).toEqual({ ok: false, error: TIMED_OUT })
  })

  it('does not leave a timer behind after a normal answer', async () => {
    jest.useFakeTimers()
    respond({ json: async () => ({ moved: 1 }) })
    await moveBatch([1], 'W2 Oct, 2026')
    expect(jest.getTimerCount()).toBe(0)
  })
})
