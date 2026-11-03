import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { ShortListExportDialog, ShortListExportButton } from '@/components/ShortListExportDialog'

const LABELS = ['W4 Oct, 2026', 'W3 Oct, 2026']
// jsdom has no Response: hand back the few members the dialog reads.
function res(body: unknown, status = 200, headers: Record<string, string> = { 'content-type': 'application/json' }) {
  return {
    ok: status < 400, status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
    blob: async () => new Blob(['xx']),
  } as unknown as Response
}
let counts = { insight: 8, priorityIV: 21 }
let postRes: () => Promise<Response>
const fetchMock = jest.fn()

beforeEach(() => {
  counts = { insight: 8, priorityIV: 21 }
  postRes = async () => res({ url: 'https://docs.google.com/presentation/d/d1/edit', warnings: ['Icon not loaded: Game B'] })
  fetchMock.mockReset()
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (!init || init.method !== 'POST') {
      return Promise.resolve(res({ labels: LABELS, counts: url.includes('pick=') ? counts : null }))
    }
    return postRes()
  })
  ;(global as any).fetch = fetchMock
})

const open = (defaultPick = 'W3 Oct, 2026') => render(<ShortListExportDialog onClose={() => {}} defaultPick={defaultPick} />)

it('shows the count for the chosen games', async () => {
  open()
  expect(await screen.findByText('8 Insight · 21 Priority IV')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Insight' }))
  expect(await screen.findByText('8 Insight')).toBeInTheDocument()
})

it('disables Export when the period has no games', async () => {
  counts = { insight: 0, priorityIV: 0 }
  open()
  expect(await screen.findByText('No games in this period')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Export' })).toBeDisabled()
})

it('falls back to the newest batch when the default pick cannot be exported', async () => {
  open('W3 Feb, 2026')
  await screen.findByText('8 Insight · 21 Priority IV')
  expect(fetchMock.mock.calls.some(c => String(c[0]).includes(encodeURIComponent('W4 Oct, 2026')))).toBe(true)
})

it('posts the choices and shows the Open file link', async () => {
  open()
  await screen.findByText('8 Insight · 21 Priority IV')
  fireEvent.click(screen.getByRole('button', { name: 'Export' }))
  const link = await screen.findByRole('link', { name: 'Open file' })
  expect(link).toHaveAttribute('href', 'https://docs.google.com/presentation/d/d1/edit')
  expect(link).toHaveAttribute('target', '_blank')
  expect(screen.getByText('Icon not loaded: Game B')).toBeInTheDocument()
  const post = fetchMock.mock.calls.find(c => c[1]?.method === 'POST')!
  expect(JSON.parse(post[1].body)).toEqual({ pick: 'W3 Oct, 2026', types: ['insight', 'priority_iv'], format: 'slides' })
})

it('downloads the xlsx', async () => {
  postRes = async () => res(null, 200, { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'content-disposition': "attachment; filename*=UTF-8''Oct%202026%20W3%20Report.xlsx" })
  const createObjectURL = jest.fn(() => 'blob:x')
  ;(URL as any).createObjectURL = createObjectURL
  ;(URL as any).revokeObjectURL = jest.fn()
  const onClose = jest.fn()
  render(<ShortListExportDialog onClose={onClose} defaultPick="W3 Oct, 2026" />)
  await screen.findByText('8 Insight · 21 Priority IV')
  fireEvent.click(screen.getByRole('button', { name: 'xlsx' }))
  fireEvent.click(screen.getByRole('button', { name: 'Export' }))
  await waitFor(() => expect(createObjectURL).toHaveBeenCalled())
  expect((createObjectURL.mock.calls[0] as unknown[])[0]).toBeInstanceOf(Blob)
  await waitFor(() => expect(onClose).toHaveBeenCalled())
})

it('shows the server error and keeps the choices', async () => {
  postRes = async () => res({ error: 'The caller does not have permission' }, 500)
  open()
  await screen.findByText('8 Insight · 21 Priority IV')
  fireEvent.click(screen.getByRole('button', { name: 'Google Sheets' }))
  fireEvent.click(screen.getByRole('button', { name: 'Export' }))
  expect(await screen.findByText('The caller does not have permission')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Google Sheets' })).toHaveAttribute('aria-pressed', 'true')
})

it('hides Export for an evaluator', () => {
  const { container } = render(<ShortListExportButton role="evaluator" defaultPick="W3 Oct, 2026" />)
  expect(container).toBeEmptyDOMElement()
  render(<ShortListExportButton role="moderator" defaultPick="W3 Oct, 2026" />)
  expect(screen.getByRole('button', { name: 'Export' })).toBeInTheDocument()
})
