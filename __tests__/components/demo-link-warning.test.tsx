import { render, screen, act } from '@testing-library/react'
import { DemoLinkWarning, demoLinkWarningText, CHECK_DELAY_MS } from '@/components/DemoLinkWarning'

const LINK = 'https://drive.google.com/file/d/1RkrD1SUgo_g2vCD3rxOAJw5LB5fBIaTx/view'
const OTHER = 'https://drive.google.com/file/d/1ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ/view'

const mismatch = {
  status: 'mismatch', fileName: 'Ocean Crown.mp4', expected: { code: 'QD6SF3', title: 'Pocket Front PVP' },
}
const respond = (body: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) })

let fetchMock: jest.Mock
beforeEach(() => {
  jest.useFakeTimers()
  fetchMock = jest.fn(() => respond(mismatch))
  global.fetch = fetchMock as unknown as typeof fetch
})
afterEach(() => { jest.useRealTimers() })

async function wait(ms: number) {
  await act(async () => { jest.advanceTimersByTime(ms) })
  await act(async () => { await Promise.resolve() })
}

describe('demoLinkWarningText', () => {
  it('names the code and the title', () => {
    expect(demoLinkWarningText('Ocean Crown.mp4', { code: 'QD6SF3', title: 'Pocket Front PVP' }))
      .toBe('Tên file là "Ocean Crown.mp4", không khớp mã QD6SF3 hay tên game "Pocket Front PVP". Kiểm tra lại link.')
  })
  it('leaves out the code when the game has none', () => {
    expect(demoLinkWarningText('Ocean Crown.mp4', { code: null, title: 'Pocket Front PVP' }))
      .toBe('Tên file là "Ocean Crown.mp4", không khớp tên game "Pocket Front PVP". Kiểm tra lại link.')
  })
})

describe('DemoLinkWarning', () => {
  it('shows the warning for a mismatch after the debounce, with one request', async () => {
    render(<DemoLinkWarning gameId="g1" value={LINK} savedValue="" />)
    await wait(CHECK_DELAY_MS - 50)
    expect(fetchMock).not.toHaveBeenCalled()
    await wait(60)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/evaluations/check-demo-link')
    expect(JSON.parse(init.body)).toEqual({ gameId: 'g1', link: LINK })
    expect(screen.getByRole('status').textContent).toContain('không khớp mã QD6SF3')
  })

  it('shows nothing for ok or unknown', async () => {
    fetchMock.mockImplementationOnce(() => respond({ status: 'ok', fileName: 'Pocket Front PVP.mp4' }))
    const { container, rerender } = render(<DemoLinkWarning gameId="g1" value={LINK} savedValue="" />)
    await wait(CHECK_DELAY_MS + 10)
    expect(container.textContent).toBe('')
    fetchMock.mockImplementationOnce(() => respond({ status: 'unknown' }))
    rerender(<DemoLinkWarning gameId="g1" value={OTHER} savedValue="" />)
    await wait(CHECK_DELAY_MS + 10)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(container.textContent).toBe('')
  })

  it('clears the warning when the value changes or is emptied', async () => {
    const { container, rerender } = render(<DemoLinkWarning gameId="g1" value={LINK} savedValue="" />)
    await wait(CHECK_DELAY_MS + 10)
    expect(container.textContent).not.toBe('')
    rerender(<DemoLinkWarning gameId="g1" value={LINK + 'x'} savedValue="" />)
    expect(container.textContent).toBe('')
    rerender(<DemoLinkWarning gameId="g1" value={LINK} savedValue="" />)
    rerender(<DemoLinkWarning gameId="g1" value="" savedValue="" />)
    expect(container.textContent).toBe('')
  })

  it('keeps the warning after the link is saved (value unchanged)', async () => {
    const { container, rerender } = render(<DemoLinkWarning gameId="g1" value={LINK} savedValue="" />)
    await wait(CHECK_DELAY_MS + 10)
    rerender(<DemoLinkWarning gameId="g1" value={LINK} savedValue={LINK} />)
    expect(container.textContent).toContain('Ocean Crown.mp4')
  })

  it('does not call on every keystroke', async () => {
    const { rerender } = render(<DemoLinkWarning gameId="g1" value="https://d" savedValue="" />)
    for (const v of ['https://dr', 'https://dri', LINK]) {
      await wait(100)
      rerender(<DemoLinkWarning gameId="g1" value={v} savedValue="" />)
    }
    await wait(CHECK_DELAY_MS + 10)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not check an existing saved link, text that is not a URL, or a row without a game', async () => {
    const { rerender } = render(<DemoLinkWarning gameId="g1" value={LINK} savedValue={LINK} />)
    await wait(CHECK_DELAY_MS + 10)
    rerender(<DemoLinkWarning gameId="g1" value="not a link" savedValue="" />)
    await wait(CHECK_DELAY_MS + 10)
    rerender(<DemoLinkWarning gameId="" value={OTHER} savedValue="" />)
    await wait(CHECK_DELAY_MS + 10)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('shows nothing when the request fails', async () => {
    fetchMock.mockImplementation(() => Promise.reject(new Error('offline')))
    const { container } = render(<DemoLinkWarning gameId="g1" value={LINK} savedValue="" />)
    await wait(CHECK_DELAY_MS + 10)
    expect(container.textContent).toBe('')
  })
})
