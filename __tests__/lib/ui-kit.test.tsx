import { act, fireEvent, render, screen } from '@testing-library/react'
import { conclusionBadgeClass, finalConclusionStyle, INITIAL_CHART_COLORS, FINAL_CHART_COLORS } from '@/lib/conclusion-badge'
import { fmtDateVN, fmtDateTimeVN } from '@/lib/format-date'
import { toast, subscribeToasts, dismissToast, type ToastItem } from '@/lib/toast'
import { FilterCount, ClearFilters } from '@/components/ui/FilterBar'
import { Seg } from '@/components/ui/Seg'

describe('conclusion colours: one map', () => {
  it('initial: Bypass is grey, red is left for Link_dead', () => {
    expect(conclusionBadgeClass('Bypass')).toBe('neutral')
    expect(conclusionBadgeClass('Playtest & Bypass')).toBe('neutral-strong')
    expect(conclusionBadgeClass('Link_dead')).toBe('error')
    expect(conclusionBadgeClass('List_Idea')).toBe('success')
    expect(conclusionBadgeClass('Stale_release')).toBe('idle')
    expect(conclusionBadgeClass(null)).toBe('neutral')
  })
  it('final: Not Found is dark grey, never green; unknown falls back to muted', () => {
    expect(finalConclusionStyle('Not Found').bg).toBe('var(--fc-notfound)')
    expect(finalConclusionStyle('Something new')).toEqual({ bg: 'var(--surface-3)', color: 'var(--muted)' })
  })
  it('charts keep initial and final Bypass apart', () => {
    expect(INITIAL_CHART_COLORS['Bypass']).not.toBe(FINAL_CHART_COLORS['Bypass'])
  })
})

describe('dates in Vietnam time', () => {
  it('formats in Asia/Ho_Chi_Minh whatever the machine zone', () => {
    // 17:30 UTC on 18 Oct is 00:30 on 19 Oct in Vietnam.
    expect(fmtDateVN('2026-10-18T17:30:00Z')).toBe('19/10/26')
    expect(fmtDateTimeVN('2026-10-18T17:30:00Z')).toBe('19/10/26 - 00:30')
    expect(fmtDateVN(null)).toBe('—')
    expect(fmtDateVN('not a date')).toBe('—')
  })
})

describe('toast store', () => {
  it('success hides after 3s; error stays until dismissed', () => {
    jest.useFakeTimers()
    let seen: ToastItem[] = []
    const off = subscribeToasts(i => { seen = i })
    toast.success('Saved')
    const errId = toast.error('Not saved')
    expect(seen.map(t => t.text)).toEqual(['Saved', 'Not saved'])
    act(() => { jest.advanceTimersByTime(3100) })
    expect(seen.map(t => t.text)).toEqual(['Not saved'])
    dismissToast(errId)
    expect(seen).toEqual([])
    off()
    jest.useRealTimers()
  })
})

describe('filter bar pieces', () => {
  it('count reads "N games" or "N of M games"', () => {
    const { rerender } = render(<FilterCount shown={214} total={214} />)
    expect(screen.getByText('214 games')).toBeTruthy()
    rerender(<FilterCount shown={38} total={1214} />)
    expect(screen.getByText('38 of 1,214 games')).toBeTruthy()
  })
  it('Clear filters only shows when a filter is on', () => {
    const onClear = jest.fn()
    const { rerender } = render(<ClearFilters visible={false} onClear={onClear} />)
    expect(screen.queryByText('Clear filters')).toBeNull()
    rerender(<ClearFilters visible onClear={onClear} />)
    fireEvent.click(screen.getByText('Clear filters'))
    expect(onClear).toHaveBeenCalled()
  })
  it('Seg marks the current option and reports a change', () => {
    const onChange = jest.fn()
    render(<Seg value="puzzle" onChange={onChange} ariaLabel="Category group"
      options={[{ value: 'puzzle', label: 'Puzzle', count: 12 }, { value: 'arcade', label: 'Arcade' }]} />)
    expect(screen.getByRole('button', { name: /Puzzle/ }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Arcade' }))
    expect(onChange).toHaveBeenCalledWith('arcade')
  })
})
