import { saveCurrentBatch, loadCurrentBatchStart } from '@/lib/current-batch-client'

describe('saveCurrentBatch', () => {
  it('POSTs only the batch (no category) and resolves true on success', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true })
    global.fetch = fetchMock as unknown as typeof fetch
    expect(await saveCurrentBatch('W2 Oct, 2026')).toBe(true)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/evaluations/current-batch')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ batch: 'W2 Oct, 2026' })
  })

  it('sends null to clear the batch', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true })
    global.fetch = fetchMock as unknown as typeof fetch
    await saveCurrentBatch(null)
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ batch: null })
  })

  it('resolves false on a non-ok response and on a network error', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false }) as unknown as typeof fetch
    expect(await saveCurrentBatch('W2 Oct, 2026')).toBe(false)
    global.fetch = jest.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch
    expect(await saveCurrentBatch('W2 Oct, 2026')).toBe(false)
  })
})

describe('start time', () => {
  it('sends starts_at only when one is given', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true })
    global.fetch = fetchMock as unknown as typeof fetch
    await saveCurrentBatch('W3 Oct, 2026', '2026-10-14T09:30')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ batch: 'W3 Oct, 2026', starts_at: '2026-10-14T09:30' })
  })

  it('reads the current start, and null on anything else', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ current_batch: 'W3 Oct, 2026', starts_at: '2026-10-14T09:30' }) }) as unknown as typeof fetch
    expect(await loadCurrentBatchStart()).toBe('2026-10-14T09:30')
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ current_batch: null, starts_at: null }) }) as unknown as typeof fetch
    expect(await loadCurrentBatchStart()).toBeNull()
    global.fetch = jest.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch
    expect(await loadCurrentBatchStart()).toBeNull()
  })
})
