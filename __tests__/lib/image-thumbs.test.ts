import { thumbUrl } from '@/lib/image-thumbs'

// The review table draws StoreKit screenshots 144px tall and loads twenty rows of
// them at once. Fetching the 1080x1920 originals for that is megabytes of transfer
// and a full-size decode each; both stores will serve a resized copy from the same
// URL. These pin the rewrite -- and, just as importantly, pin that anything this
// does not recognise is handed back untouched, because every caller treats the
// result as a best effort and falls back to the original on error.
describe('thumbUrl', () => {
  it('replaces Google Play size options with a height request', () => {
    expect(thumbUrl('https://play-lh.googleusercontent.com/AbC123=w526-h296', 320))
      .toBe('https://play-lh.googleusercontent.com/AbC123=h320')
    expect(thumbUrl('https://play-lh.googleusercontent.com/AbC123=s0', 320))
      .toBe('https://play-lh.googleusercontent.com/AbC123=h320')
    expect(thumbUrl('https://lh3.ggpht.com/AbC123=w1080-h1920-rw', 128))
      .toBe('https://lh3.ggpht.com/AbC123=h128')
  })

  it('adds the option when a Google URL carries none', () => {
    expect(thumbUrl('https://play-lh.googleusercontent.com/AbC123', 320))
      .toBe('https://play-lh.googleusercontent.com/AbC123=h320')
  })

  it('rewrites the size segment of an Apple image, keeping its format', () => {
    expect(thumbUrl('https://is1-ssl.mzstatic.com/image/thumb/x/1242x2688bb.jpg', 320))
      .toBe('https://is1-ssl.mzstatic.com/image/thumb/x/192x0w.jpg')
    expect(thumbUrl('https://is1-ssl.mzstatic.com/image/thumb/x/230x0w.webp', 320))
      .toBe('https://is1-ssl.mzstatic.com/image/thumb/x/192x0w.webp')
  })

  it('leaves alone anything it does not recognise', () => {
    // A manually uploaded screenshot (Replit Object Storage) is not a store CDN.
    const manual = 'https://storage.example.com/bucket/shot-1.png'
    expect(thumbUrl(manual, 320)).toBe(manual)
    // A query string means the URL is doing something this does not model.
    const query = 'https://play-lh.googleusercontent.com/AbC123?v=2'
    expect(thumbUrl(query, 320)).toBe(query)
    expect(thumbUrl(null, 320)).toBe('')
    expect(thumbUrl(undefined, 320)).toBe('')
  })

  it('does not mistake a path ending for a Google option segment', () => {
    // No `=` at all: nothing to strip, the option is appended.
    const u = 'https://play-lh.googleusercontent.com/a/b/c'
    expect(thumbUrl(u, 96)).toBe(`${u}=h96`)
  })
})
