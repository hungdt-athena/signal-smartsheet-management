/* A batch is the team's name for a week, and the Performance tab used to filter by that
   NAME - which only ~5% of rows carry, nearly all of them shortlisted games. These tests
   lock the rule that replaced it: each batch has a stored start day (table `batches`),
   and it ends where the next one starts so consecutive batches tile the calendar whatever
   length the team ran them for. */
const rows: Array<Record<string, unknown>> = []
const sqlMock = jest.fn(async (..._a: unknown[]) => rows)
jest.mock('@/lib/db', () => ({ sql: (...a: unknown[]) => sqlMock(...a) }))

import { loadBatchSpans, resolveBatchSpan, clearBatchSpanCache } from '@/lib/report-batches'

const SPANS = [
  { batch: 'W4 Sep, 2026', from: '2026-09-21', to: '2026-09-23' },
  { batch: 'W3 Sep, 2026', from: '2026-09-14', to: '2026-09-21' },
  { batch: 'W2 Sep, 2026', from: '2026-09-07', to: '2026-09-14' },
]

beforeEach(() => {
  clearBatchSpanCache()
  sqlMock.mockClear()
  rows.length = 0
  rows.push(...SPANS)
})

it('resolves a label to the days it covers', async () => {
  expect(await resolveBatchSpan('W3 Sep, 2026')).toEqual({ batch: 'W3 Sep, 2026', from: '2026-09-14', to: '2026-09-21' })
})

it('returns null for a label it does not know, rather than an empty window', async () => {
  // An empty window would silently widen to all-time, which reads as a working page
  // showing the wrong numbers - the worst of the two failures.
  expect(await resolveBatchSpan('W9 Xxx, 2026')).toBeNull()
  expect(await resolveBatchSpan('')).toBeNull()
})

it('reads the stored start of each batch and ends it where the next one starts', async () => {
  // The tiling rule lives in SQL, so asserting it on mocked rows would only re-read the
  // fixture; pin the shape of the query instead. A batch's last ACTIVE day is not its
  // end - the team runs batches of 7, 11, 17 days and a quiet Friday would otherwise fall
  // through a crack between two windows. `lead()` makes them tile whatever the length.
  await loadBatchSpans()
  const text = (sqlMock.mock.calls[0][0] as unknown as string[]).join(' ')
  expect(text).toMatch(/FROM batches/)
  expect(text).toMatch(/lead\(starts_on\)\s+OVER\s+\(ORDER BY starts_on\)/)
  expect(text).toMatch(/Asia\/Ho_Chi_Minh/)    // the newest batch runs to today, VN time
  expect(text).toMatch(/starts_on \+ 1/)        // a batch scheduled for tomorrow never gets an inverted window
  expect(text).not.toMatch(/evaluate_date/)    // never inferred from the games any more
  expect(text).not.toMatch(/max\(/)
  const spans = await loadBatchSpans()
  const byAge = [...spans].sort((a, b) => a.from.localeCompare(b.from))
  for (let i = 1; i < byAge.length; i++) expect(byAge[i - 1].to).toBe(byAge[i].from)
})

it('asks the database once, then serves the rest from cache', async () => {
  // Spans change about once a week; a query per report load would be a round-trip to
  // us-east-2 for an answer that cannot have moved.
  await loadBatchSpans()
  await loadBatchSpans()
  await resolveBatchSpan('W2 Sep, 2026')
  expect(sqlMock).toHaveBeenCalledTimes(1)
  clearBatchSpanCache()
  await loadBatchSpans()
  expect(sqlMock).toHaveBeenCalledTimes(2)
})

it('shares one in-flight query between concurrent callers', async () => {
  const [a, b] = await Promise.all([loadBatchSpans(), loadBatchSpans()])
  expect(sqlMock).toHaveBeenCalledTimes(1)
  expect(a).toBe(b)
})

it('falls back to "no spans" instead of failing when the batches table is missing', async () => {
  // Migration 049 not applied yet: every batch becomes unresolvable and the Report falls
  // back to the label, as it does for the pre-July leftovers. It must not be cached, so
  // it heals once the table exists.
  const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
  sqlMock.mockRejectedValueOnce(new Error('relation "batches" does not exist'))
  expect(await loadBatchSpans()).toEqual([])
  expect(await loadBatchSpans()).toEqual(SPANS)
  expect(sqlMock).toHaveBeenCalledTimes(2)
  spy.mockRestore()
})
