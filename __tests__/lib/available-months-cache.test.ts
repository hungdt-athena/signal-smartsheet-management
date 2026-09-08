import {
  buildFilters, clearAvailableMonthsCache, loadAvailableMonths, monthsCacheKey, pickerDateExpr,
} from '@/lib/evaluations-filters'
import { sql } from '@/lib/db'

// month=auto cannot build its date range until it knows which months have data, so that
// read runs BEFORE the batch that needs the range -- a serialized round-trip to a
// database on the other side of the planet, paid by the rows request and the facets
// request of the same page load, for the same answer.
//
// The cache is what removes it. These tests are about the round-trip, so they count
// calls to sql rather than timing anything.

jest.mock('@/lib/db', () => ({ sql: jest.fn() }))

const sqlMock = sql as unknown as jest.Mock
const MONTHS = [{ year: 2026, month: 9 }, { year: 2026, month: 8 }]

const f = buildFilters(new URLSearchParams(''), '', 'assigned')
const picker = pickerDateExpr('assigned')

const load = (key?: string) =>
  loadAvailableMonths('puzzle', picker, f.evaluatorFilter, key)


describe('loadAvailableMonths caching', () => {
  beforeEach(() => {
    sqlMock.mockReset()
    sqlMock.mockResolvedValue(MONTHS)
    // The cache lives for the life of the module, which is the point of it -- and the
    // reason each case has to start from empty rather than inherit the last one's entries.
    clearAvailableMonthsCache()
  })

  it('reads once and serves the rest of the page load from memory', async () => {
    const key = monthsCacheKey('puzzle', 'assigned', '')
    // The rows request and the facets request, as they arrive on one page open.
    expect(await load(key)).toEqual(MONTHS)
    expect(await load(key)).toEqual(MONTHS)
    expect(sqlMock).toHaveBeenCalledTimes(1)
  })

  it('never serves one evaluator the month list of another', async () => {
    // The list is scoped by evaluator, so the key has to be too -- an evaluator sees
    // only the months they have games in.
    await load(monthsCacheKey('puzzle', 'assigned', 'KhangNA'))
    await load(monthsCacheKey('puzzle', 'assigned', 'HuyDD'))
    expect(sqlMock).toHaveBeenCalledTimes(2)
  })

  it('keeps category and date basis apart', async () => {
    await load(monthsCacheKey('puzzle', 'assigned', ''))
    await load(monthsCacheKey('arcade', 'assigned', ''))
    // Short List reads the evaluated basis; it is a different list of months.
    await load(monthsCacheKey('puzzle', 'evaluated', ''))
    expect(sqlMock).toHaveBeenCalledTimes(3)
    // ...and each of those is now cached in its own right.
    await load(monthsCacheKey('arcade', 'assigned', ''))
    expect(sqlMock).toHaveBeenCalledTimes(3)
  })

  it('still reads every time when no key is given', async () => {
    // No key means no caching — the opt-in is explicit so a caller that needs a live
    // answer can have one.
    await load()
    await load()
    expect(sqlMock).toHaveBeenCalledTimes(2)
  })

  it('goes back to the database once the entry is stale', async () => {
    const key = monthsCacheKey('puzzle', 'assigned', 'staleness')
    const now = jest.spyOn(Date, 'now')
    now.mockReturnValue(0)
    await load(key)
    now.mockReturnValue(59_000)
    await load(key)
    expect(sqlMock).toHaveBeenCalledTimes(1) // still inside the 60s TTL
    now.mockReturnValue(61_000)
    await load(key)
    expect(sqlMock).toHaveBeenCalledTimes(2)
    now.mockRestore()
  })
})
