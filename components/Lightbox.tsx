'use client'
import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

// The full-size zoom that used to live only inside EvalDetailPanel (a useState +
// inline createPortal block, wired to ManualScreenshotsCard through an onExpand
// prop). Lifted out verbatim so a second screen -- the Individual tab's review
// table -- can open the same zoom instead of growing its own.
//
// `images` is optional and covers a case the simple {url, onClose} contract alone
// does not: EvalDetailPanel's zoom does not show one picture, it shows the whole
// StoreKit/manual strip with the clicked shot scrolled into view and highlighted,
// plus a distinct QR-code layout when `url` is a data: URI. Callers that only ever
// have one image (the review table) can omit `images` and get a single-image view.

export interface LightboxProps {
  url: string | null
  onClose: () => void
  /** Full strip to render, highlighting `url`. Defaults to `[url]` when omitted. */
  images?: string[]
}

export function Lightbox({ url, onClose, images }: LightboxProps): JSX.Element | null {
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  useEffect(() => {
    if (!url) return
    const onKey = (e: KeyboardEvent) => {
      // Same guard EvalDetailPanel's own key handler carries: a field owns its own
      // Escape (clearing a value, dismissing a suggestion list) before this does.
      // Practically unreachable behind a full-screen backdrop, kept for parity so the
      // two handlers cannot drift apart.
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [url, onClose])

  if (!mounted || !url) return null

  const isQr = url.startsWith('data:image/')
  const list = images && images.length > 0 ? images : [url]

  return createPortal(
    <div onClick={onClose} className="lightbox-backdrop">
      <div onClick={e => e.stopPropagation()}
        style={{ position: 'relative', maxWidth: '90vw', maxHeight: '90vh', display: 'flex', gap: 8, overflowX: 'auto', padding: 16, cursor: 'default' }}>
        {isQr ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', background: 'var(--surface)', padding: 24, borderRadius: 16, border: '1px solid var(--border)' }}>
            <img src={url} alt="QR Code Expanded"
              style={{ width: 280, height: 280, borderRadius: 12, border: '1px solid var(--border)' }} />
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', marginTop: 14 }}>
              Scan to download/test game
            </span>
          </div>
        ) : (
          list.map((u, i) => (
            <img key={i} src={u} alt={`Screenshot ${i + 1}`}
              style={{
                maxHeight: '85vh', borderRadius: 12, flexShrink: 0,
                border: u === url ? '3px solid var(--accent)' : '1px solid rgba(255,255,255,.2)',
                scrollMarginInline: 16,
              }}
              ref={el => { if (el && u === url) el.scrollIntoView?.({ behavior: 'instant', inline: 'center', block: 'nearest' }) }}
              onError={e => { e.currentTarget.style.display = 'none' }}
            />
          ))
        )}
      </div>
      <button onClick={onClose}
        style={{ position: 'fixed', top: 20, right: 20, background: 'rgba(0,0,0,.5)', border: 'none', color: '#fff', width: 40, height: 40, borderRadius: 20, fontSize: 20, cursor: 'pointer', display: 'grid', placeItems: 'center' }}>
        ✕
      </button>
    </div>,
    document.body
  )
}

/**
 * Convenience wrapper: one line to own the state (`open(url)`) plus the node to drop
 * into the tree, instead of a useState + <Lightbox/> pair at every call site.
 */
export function useLightbox(): { open: (url: string) => void; node: JSX.Element | null } {
  const [url, setUrl] = useState<string | null>(null)
  const open = useCallback((u: string) => setUrl(u), [])
  const close = useCallback(() => setUrl(null), [])
  const node = <Lightbox url={url} onClose={close} />
  return { open, node }
}
