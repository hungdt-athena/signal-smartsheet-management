import { useState, useRef } from 'react'
import { emptyValue } from '@/components/DateFilter'
import type { DateBasis, DateFilterValue, YearMonth } from '@/components/DateFilter'

// Bundles the date-filter state shared by every list view (Short List,
// Evaluations tab, Videos). First load sends month=auto; the server resolves the
// default month and echoes applied_month, which the caller locks in via setValue
// (guarded by suppressFetchRef so it doesn't trigger an extra fetch).
//
// initialAutoMonth=false starts on "All time" instead: used by views that slice
// with their own dimension (e.g. Short List groups by batch) and don't want the
// month to narrow the result on open.
export function useDateFilter(defaultBasis: DateBasis, initialAutoMonth = true) {
  const [value, setValue] = useState<DateFilterValue>(() => emptyValue(defaultBasis))
  const [autoMonth, setAutoMonth] = useState(initialAutoMonth)
  const [availableMonths, setAvailableMonths] = useState<YearMonth[]>([])
  const suppressFetchRef = useRef(false)
  return { value, setValue, autoMonth, setAutoMonth, availableMonths, setAvailableMonths, suppressFetchRef }
}
