'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import version from '@/version.json'
import { hasUnsavedWork, flushUnsavedWork } from '@/lib/unsaved-guard'

// The build id baked into THIS bundle at build time. After a deploy a still-open
// tab keeps its old value here while /api/version reports the new one → mismatch.
const BOOT_BUILD_ID = (version as { buildId: string }).buildId
const POLL_MS = 45_000
const NOTICE_SEEN_KEY = 'deploy_notice_seen'

/**
 * Watches for a new deploy and surfaces a non-blocking banner instead of force-
 * reloading. The evaluator chooses when to reload; their in-progress work is
 * flushed first (and a browser close/refresh is guarded too). Also relays an
 * optional admin broadcast (app_config `deploy_notice`). Mounted once in the root
 * layout. Renders nothing until there's something to show.
 */
export default function VersionWatcher() {
  const [updateReady, setUpdateReady] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [noticeSeen, setNoticeSeen] = useState(true)
  const [reloading, setReloading] = useState(false)
  const serverIdRef = useRef<string | null>(null)
  const snoozedIdRef = useRef<string | null>(null)
  const programmaticReload = useRef(false)

  const check = useCallback(async () => {
    try {
      const res = await fetch('/api/version', { cache: 'no-store' })
      if (!res.ok) return
      const json: { buildId?: string; notice?: string | null } = await res.json()
      if (json.buildId) {
        serverIdRef.current = json.buildId
        // 'dev' = unstamped local build → never nag during development.
        if (BOOT_BUILD_ID !== 'dev' && json.buildId !== BOOT_BUILD_ID && json.buildId !== snoozedIdRef.current) {
          setUpdateReady(true)
        }
      }
      const n = json.notice?.trim() || null
      setNotice(n)
      if (n) {
        let seen = false
        try { seen = localStorage.getItem(NOTICE_SEEN_KEY) === n } catch { /* private mode */ }
        setNoticeSeen(seen)
      } else {
        setNoticeSeen(true)
      }
    } catch { /* offline / transient — retry on the next tick */ }
  }, [])

  useEffect(() => {
    check()
    const id = setInterval(check, POLL_MS)
    // Evaluators leave the tab open for long stretches; re-check the instant they
    // come back so they catch a deploy without waiting out the poll interval.
    const onVisible = () => { if (document.visibilityState === 'visible') check() }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [check])

  // Native guard against an accidental close/refresh dropping in-progress edits.
  // Suppressed for our own post-flush reload (which has already saved everything).
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (!programmaticReload.current && hasUnsavedWork()) {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [])

  // A stale-chunk failure (a code-split JS file that 404s after a deploy) means a
  // new version is live while this tab runs old code — surface the banner rather
  // than let a navigation silently break.
  useEffect(() => {
    const onError = (e: Event) => {
      const ev = e as ErrorEvent & PromiseRejectionEvent
      const msg = String(ev.reason?.message || ev.message || ev.error?.message || '')
      if (/ChunkLoadError|Loading chunk|dynamically imported module/i.test(msg)) {
        setUpdateReady(true)
      }
    }
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onError)
    return () => {
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onError)
    }
  }, [])

  const reloadNow = async () => {
    setReloading(true)
    // Persist any in-progress edits first so the reload never loses work.
    try { if (hasUnsavedWork()) await flushUnsavedWork() } catch { /* reload regardless */ }
    programmaticReload.current = true
    window.location.reload()
  }

  // "Later": stop nagging for this exact build; a subsequent (newer) deploy re-arms.
  const snoozeUpdate = () => {
    snoozedIdRef.current = serverIdRef.current
    setUpdateReady(false)
  }

  const dismissNotice = () => {
    if (notice) { try { localStorage.setItem(NOTICE_SEEN_KEY, notice) } catch { /* private mode */ } }
    setNoticeSeen(true)
  }

  const showUpdate = updateReady
  const showNotice = !showUpdate && !!notice && !noticeSeen
  if (!showUpdate && !showNotice) return null

  return (
    <div
      role="status"
      style={{
        position: 'fixed', left: '50%', bottom: 18, transform: 'translateX(-50%)',
        zIndex: 9999, width: 'min(560px, calc(100vw - 32px))',
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '11px 14px', borderRadius: 12,
        background: 'var(--surface)', border: '1px solid var(--border)',
        boxShadow: 'var(--shadow-lg)', fontSize: 13.5, lineHeight: 1.4,
      }}
    >
      <span style={{ fontSize: 17, lineHeight: 1 }} aria-hidden>{showUpdate ? '🔄' : '📢'}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, color: 'var(--text)' }}>
          {showUpdate ? 'Đã có bản cập nhật mới' : 'Thông báo'}
        </div>
        <div style={{ color: 'var(--muted)', fontSize: 12.5, marginTop: 1 }}>
          {notice || 'Tải lại trang để dùng phiên bản mới nhất. Việc đang làm sẽ được lưu trước khi tải lại.'}
        </div>
      </div>
      {showUpdate ? (
        <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
          {!reloading && (
            <button className="btn" onClick={snoozeUpdate} style={{ fontSize: 12.5, padding: '6px 11px' }}>
              Để sau
            </button>
          )}
          <button
            className="btn btn-primary"
            onClick={reloadNow}
            disabled={reloading}
            style={{ fontSize: 12.5, padding: '6px 13px' }}
          >
            {reloading ? 'Đang lưu…' : 'Tải lại ngay'}
          </button>
        </div>
      ) : (
        <button className="btn" onClick={dismissNotice} style={{ fontSize: 12.5, padding: '6px 13px', flexShrink: 0 }}>
          Đã hiểu
        </button>
      )}
    </div>
  )
}
