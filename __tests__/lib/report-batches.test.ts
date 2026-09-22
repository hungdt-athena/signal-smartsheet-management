/* A batch is the team's name for a week, and the Performance tab used to filter by that
   NAME - which only ~5% of rows carry, nearly all of them shortlisted games. These tests
   lock the rule that replaced it: resolve the label to the days it covers, with the end
   of one batch being the start of the next so consecutive batches tile the calendar
   whatever length the team ran them for. */
const rows: Array<Record<string, unknown>> = []
const sqlMock = jest.fn(async (..._a: unknown[]) => rows)
jest.mock('@/lib/db', () => ({ sql: (...a: unknown[]) => sqlMock(...a) }))

import { loadBatchSpans, resolveBatchSpan, clearBatchSpanCache, BATCH_ERA_START } from '@/lib/report-batches'

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

it('ends each batch where the next one starts, rather than on its own last day', async () => {
  // This is the whole rule, and it lives in SQL, so asserting it on mocked rows would
  // only re-read the fixture. A batch's last ACTIVE day is not its end: the team runs
  // batches of 7, 11, 17 days and a quiet Friday would otherwise fall through a crack
  // between two windows. `lead()` makes them tile whatever the length.
  await loadBatchSpans()
  const text = (sqlMock.mock.calls[0][0] as unknown as string[]).join(' ')
  expect(text).toMatch(/lead\(f\)\s+OVER\s+\(ORDER BY f\)/)
  expect(text).toMatch(/CURRENT_DATE \+ 1/)   // the newest batch runs to today
  expect(text).not.toMatch(/max\(/)           // never "this batch's own last day"
  // the shape callers depend on
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

it('cuts off before the labels that are not in chronological order', async () => {
  // `W2 Aug, 2026` starts 15 May and `W1 Jul, 2026` starts 11 Jun in the real data:
  // leftovers from the Sheet -> Postgres migration. Reading those as weeks would file
  // all of May under "W2 Aug". The query filters them out, and the constant is the
  // single place that decision lives.
  expect(BATCH_ERA_START).toBe('2026-07-06')
  await loadBatchSpans()
  const text = sqlMock.mock.calls[0][0] as unknown as string[]
  expect(text.join(' ')).toMatch(/WHERE f >=/)
})
