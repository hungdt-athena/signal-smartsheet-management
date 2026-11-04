import { act, renderHook, waitFor } from '@testing-library/react'
import { useLazyRecordCodes, type LazyCodeRow } from '@/components/CodeChip'

type Resolver = (v: { ok: boolean; json: () => Promise<unknown> }) => void
let pending: { gameId: string; resolve: Resolver }[]

beforeEach(() => {
  pending = []
  global.fetch = jest.fn((url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url) !== '/api/evaluations/record-code' || init?.method !== 'POST') {
      throw new Error(`unexpected fetch ${url}`)
    }
    const { gameId } = JSON.parse(String(init.body))
    return new Promise((resolve) => { pending.push({ gameId, resolve: resolve as Resolver }) })
  }) as jest.Mock
})

const answer = async (i: number, code: string | null, ok = true) => {
  await act(async () => { pending[i].resolve({ ok, json: async () => ({ code }) }) })
}
const calledFor = () => (global.fetch as jest.Mock).mock.calls.map((c) => JSON.parse(String(c[1].body)).gameId)

const rows: LazyCodeRow[] = [
  { id: 1, game_id: 'gA', record_code: null, locked: true },
  { id: 2, game_id: 'gB', record_code: 'HAS234', locked: true },
  { id: 3, game_id: 'gC', record_code: null, locked: false },
  { id: 4, game_id: 'gD', locked: true },
]

describe('useLazyRecordCodes', () => {
  it('asks once per locked row without a code, one request at a time', async () => {
    const { result } = renderHook(() => useLazyRecordCodes(rows))
    await waitFor(() => expect(pending.length).toBe(1))
    expect(calledFor()).toEqual(['gA'])
    await answer(0, 'AAA234')
    await waitFor(() => expect(pending.length).toBe(2))
    expect(calledFor()).toEqual(['gA', 'gD'])
    await answer(1, 'DDD234')
    await waitFor(() => expect(result.current).toEqual({ 1: 'AAA234', 4: 'DDD234' }))
    // No call for the row that has a code (gB) or the draft row (gC).
    expect(calledFor()).toEqual(['gA', 'gD'])
  })

  it('does not retry a failed row, and asks nothing on rerender', async () => {
    const { result, rerender } = renderHook(({ r }) => useLazyRecordCodes(r), { initialProps: { r: rows } })
    await waitFor(() => expect(pending.length).toBe(1))
    await answer(0, null, false)
    await waitFor(() => expect(pending.length).toBe(2))
    await answer(1, null)
    rerender({ r: [...rows] })
    await act(async () => {})
    expect(calledFor()).toEqual(['gA', 'gD'])
    expect(result.current).toEqual({})
  })

  it('asks nothing when every row has a code or is a draft', async () => {
    renderHook(() => useLazyRecordCodes([rows[1], rows[2]]))
    await act(async () => {})
    expect(global.fetch).not.toHaveBeenCalled()
  })
})
