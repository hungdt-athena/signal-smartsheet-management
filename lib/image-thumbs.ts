// Ask an app-store CDN for a small image instead of the original.
//
// A StoreKit screenshot is a phone-resolution PNG/JPEG -- roughly 1080x1920 and a
// few hundred KB. The Report's review table draws them 144px tall, twenty rows at a
// time, eight or more per row: fetching and decoding the originals is megabytes of
// transfer and a full-size decode per thumbnail, which is why the strips arrive late
// and stutter the scroll. Both stores serve resized copies from the same URL, so the
// fix is a string rewrite, not an image pipeline.
//
// Nothing here is load-bearing for correctness: every caller falls back to the
// original URL if the rewritten one fails (see ReviewTable's onError), and a URL that
// matches neither store -- a manually uploaded screenshot in Replit Object Storage,
// say -- is returned untouched.

// Google Play images (play-lh.googleusercontent.com, lh3.ggpht.com) carry their
// options in a trailing `=` segment: `=w526-h296`, `=s0`, `=w1080-h1920-rw`. Replace
// whatever is there with a height request. Matched narrowly -- `=` followed by
// letter/number groups only -- so a URL that ends in something else is left alone.
const GOOGLE_HOST = /(?:googleusercontent|ggpht)\.com/
const GOOGLE_OPTS = /=[a-z]+\d*(?:-[a-z]+\d*)*$/i

// Apple images (is1-ssl.mzstatic.com) carry the size in the last path segment:
// `/1242x2688bb.jpg`, `/230x0w.webp`. `<w>x0w` asks for that width, height auto.
const APPLE_HOST = /mzstatic\.com/
const APPLE_SIZE = /\/\d+x\d+[a-z]{0,3}\.(jpg|jpeg|png|webp)$/i

/**
 * A CDN-resized copy of `url` about `px` tall, or `url` unchanged when the host is
 * not one this knows how to ask. `px` should already include the device pixel ratio.
 */
export function thumbUrl(url: string | null | undefined, px: number): string {
  if (!url || url.includes('?')) return url || ''
  if (GOOGLE_HOST.test(url)) return `${url.replace(GOOGLE_OPTS, '')}=h${px}`
  // Apple takes a width; these are portrait screenshots, so a width of about half
  // the height covers them, and a landscape one simply comes back a little smaller
  // than its box rather than a little larger.
  if (APPLE_HOST.test(url)) return url.replace(APPLE_SIZE, `/${Math.round(px * 0.6)}x0w.$1`)
  return url
}
