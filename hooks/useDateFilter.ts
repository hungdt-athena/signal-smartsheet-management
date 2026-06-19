import { useState, useRef } from 'react'
import { emptyValue } from '@/components/DateFilter'
import type { DateBasis, DateFilterValue, YearMonth } from '@/components/DateFilter'

// Bundles the date-filter state shared by every list view (Short List,
// Evaluations tab, Videos). First load sends month=auto; the server resolves the
// default month and echoes applied_month, which the caller locks in via setValue
// (guarded by suppressFetchRef so it doesn't trigger an extra fetch).
export function useDateFilter(defaultBasis: DateBasis) {
  const [value, setValue] = useState<DateFilterValue>(() => emptyValue(defaultBasis))
  const [autoMonth, setAutoMonth] = useState(true)
  const [availableMonths, setAvailableMonths] = useState<YearMonth[]>([])
  const suppressFetchRef = useRef(false)
  return { value, setValue, autoMonth, setAutoMonth, availableMonths, setAvailableMonths, suppressFetchRef }
}
