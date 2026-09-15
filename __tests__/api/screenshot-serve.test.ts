/**
 * @jest-environment node
 */
jest.mock('@/lib/screenshot-store', () => {
  const actual = jest.requireActual('@/lib/screenshot-store')
  return { ...actual, readScreenshot: jest.fn() }
})
jest.mock('next-auth', () => ({ getServerSession: jest.fn() }))

import { GET } from '@/app/api/screenshots/[...path]/route'
import { readScreenshot } from '@/lib/screenshot-store'
import { getServerSession } from 'next-auth'

const readMock = readScreenshot as jest.Mock
const sessionMock = getServerSession as jest.Mock
const req = new Request('http://localhost/api/screenshots/game123/1-0.png')

function call(path: string[]) {
  return GET(req, { params: { path } })
}

describe('GET /api/screenshots/[...path]', () => {
  const realSkip = process.env.SKIP_AUTH
  beforeAll(() => { process.env.SKIP_AUTH = 'false' })
  afterAll(() => {
    if (realSkip === undefined) delete process.env.SKIP_AUTH
    else process.env.SKIP_AUTH = realSkip
  })

  beforeEach(() => {
    jest.clearAllMocks()
    sessionMock.mockResolvedValue({ user: { name: 'Mitt', role: 'evaluator' } })
  })

  // The Supabase bucket these replaced was public to anyone holding the link.
  it('refuses a signed-out request and never touches storage', async () => {
    sessionMock.mockResolvedValue(null)
    const res = await call(['game123', '1-0.png'])
    expect(res.status).toBe(401)
    expect(readMock).not.toHaveBeenCalled()
  })

  it('serves the bytes with the right type and an immutable, private cache', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    readMock.mockResolvedValue(bytes)

    const res = await call(['game123', '1717000000-0.png'])

    expect(res.status).toBe(200)
    expect(readMock).toHaveBeenCalledWith('screenshots/game123/1717000000-0.png')
    expect(res.headers.get('Content-Type')).toBe('image/png')
    expect(res.headers.get('Content-Length')).toBe('4')
    // private: these are readable by a signed-in user, so no shared cache may keep them.
    expect(res.headers.get('Cache-Control')).toBe('private, max-age=31536000, immutable')
    expect(Buffer.from(await res.arrayBuffer())).toEqual(bytes)
  })

  it('maps jpg and webp too', async () => {
    readMock.mockResolvedValue(Buffer.from([1]))
    expect((await call(['g', '1-0.jpg'])).headers.get('Content-Type')).toBe('image/jpeg')
    expect((await call(['g', '1-0.webp'])).headers.get('Content-Type')).toBe('image/webp')
  })

  it('404s a missing object rather than erroring', async () => {
    readMock.mockResolvedValue(null)
    expect((await call(['game123', 'nope.png'])).status).toBe(404)
  })

  it('refuses traversal without reading anything', async () => {
    for (const p of [['game123', '..', 'secrets.png'], ['..', 'etc', 'passwd.png'], ['game123', '', 'a.png']]) {
      const res = await call(p)
      expect(res.status).toBe(404)
    }
    expect(readMock).not.toHaveBeenCalled()
  })

  // Only the three types the upload path accepts may be served back: an object
  // name ending in .svg or .html must never come back as something a browser runs.
  it('refuses any extension outside png/jpeg/webp', async () => {
    for (const name of ['x.svg', 'x.html', 'x.json', 'noext']) {
      const res = await call(['game123', name])
      expect(res.status).toBe(404)
    }
    expect(readMock).not.toHaveBeenCalled()
  })

  it('500s when storage itself fails, instead of serving an empty image', async () => {
    readMock.mockRejectedValue(new Error('bucket down'))
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
    expect((await call(['game123', '1-0.png'])).status).toBe(500)
    spy.mockRestore()
  })
})
