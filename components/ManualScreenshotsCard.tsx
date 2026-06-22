'use client'
import { useState, useEffect, useRef, useCallback, forwardRef, useImperativeHandle } from 'react'

const ACCEPTED = ['image/png', 'image/jpeg', 'image/webp']
const MAX_FILES = 10
const MAX_SIZE = 5 * 1024 * 1024

interface Staged { file: File; preview: string }

/** Imperative handle so a parent (e.g. the eval panel's unified Save button)
 *  can flush staged uploads as part of its own save instead of a second click. */
export interface ManualScreenshotsHandle {
  /** Upload any staged screenshots. Resolves true when all succeeded (or none staged). */
  flush: () => Promise<boolean>
  hasStaged: () => boolean
}

interface Props {
  gameId: string
  urls: string[]
  canEdit: boolean
  /** Reports the authoritative URL array after every save/delete.
   *  Carries the gameId so late responses can't be misattributed after navigation. */
  onChange: (gameId: string, urls: string[]) => void
  onExpand: (url: string) => void
  onToast: (msg: string, err?: boolean) => void
  /** When true, the parent owns saving (folds staged uploads into its Save button +
   *  auto-save): hide the standalone Save button and just report the staged count. */
  deferSave?: boolean
  /** Notifies the parent how many screenshots are staged (drives its dirty state). */
  onStagedChange?: (count: number) => void
}

const ManualScreenshotsCard = forwardRef<ManualScreenshotsHandle, Props>(function ManualScreenshotsCard(
  { gameId, urls, canEdit, onChange, onExpand, onToast, deferSave = false, onStagedChange }, ref,
) {
  const [staged, setStaged] = useState<Staged[]>([])
  const [saving, setSaving] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const stageFiles = useCallback((files: File[]) => {
    setStaged(prev => {
      const next = [...prev]
      for (const f of files) {
        if (!ACCEPTED.includes(f.type)) { onToast(`${f.name}: only PNG/JPEG/WebP allowed`, true); continue }
        if (f.size > MAX_SIZE) { onToast(`${f.name}: larger than 5MB`, true); continue }
        if (next.length >= MAX_FILES) { onToast(`Max ${MAX_FILES} images per save`, true); break }
        next.push({ file: f, preview: URL.createObjectURL(f) })
      }
      return next
    })
  }, [onToast])

  // Ctrl+V paste — active while this card is mounted, except when typing in a field.
  useEffect(() => {
    if (!canEdit) return
    const onPaste = (e: ClipboardEvent) => {
      const t = e.target
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return
      const files = Array.from(e.clipboardData?.files ?? []).filter(f => f.type.startsWith('image/'))
      if (files.length > 0) { e.preventDefault(); stageFiles(files) }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [canEdit, stageFiles])

  // Revoke object URLs on unmount (via ref — a deps-empty cleanup would
  // close over the first render's empty array and never revoke anything).
  const stagedRef = useRef<Staged[]>([])
  stagedRef.current = staged
  useEffect(() => () => { stagedRef.current.forEach(s => URL.revokeObjectURL(s.preview)) }, [])

  const unstage = (preview: string) => {
    setStaged(prev => {
      const hit = prev.find(s => s.preview === preview)
      if (hit) URL.revokeObjectURL(hit.preview)
      return prev.filter(s => s.preview !== preview)
    })
  }

  // Keep the parent's dirty/save state in sync with how many shots are staged.
  useEffect(() => { onStagedChange?.(staged.length) }, [staged.length, onStagedChange])

  // Upload staged screenshots. `silent` suppresses the success toast so a unified
  // parent save (eval + screenshots) can show a single "Saved" message instead.
  const uploadStaged = useCallback(async (silent = false): Promise<boolean> => {
    if (staged.length === 0 || saving) return true
    setSaving(true)
    let ok = false
    try {
      const form = new FormData()
      // Unique per-entry names: pasted files are all "image.png", and the
      // failed[] response matches by name.
      const uploadName = (s: Staged, i: number) => `${i}-${s.file.name || 'pasted.png'}`
      staged.forEach((s, i) => form.append('files', s.file, uploadName(s, i)))
      const res = await fetch(`/api/evaluations/${encodeURIComponent(gameId)}/screenshots`, {
        method: 'POST', body: form,
      })
      const json = await res.json()
      if (!res.ok) {
        onToast(json.error || 'Failed to save screenshots', true)
      } else {
        onChange(gameId, json.urls || [])
        const failedNames = new Set((json.failed || []).map((f: { name: string }) => f.name))
        setStaged(prev => {
          prev.filter((s, i) => !failedNames.has(uploadName(s, i))).forEach(s => URL.revokeObjectURL(s.preview))
          return prev.filter((s, i) => failedNames.has(uploadName(s, i)))
        })
        if (failedNames.size > 0) onToast(`${failedNames.size} image(s) failed — try saving again`, true)
        else { ok = true; if (!silent) onToast('Screenshots saved') }
      }
    } catch { onToast('Network error', true) }
    setSaving(false)
    return ok
  }, [staged, saving, gameId, onChange, onToast])

  useImperativeHandle(ref, () => ({
    flush: () => uploadStaged(true),
    hasStaged: () => staged.length > 0,
  }), [uploadStaged, staged.length])

  const removeSaved = async (url: string) => {
    try {
      const res = await fetch(`/api/evaluations/${encodeURIComponent(gameId)}/screenshots`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      })
      const json = await res.json()
      if (!res.ok) onToast(json.error || 'Failed to delete', true)
      else { onChange(gameId, json.urls || []); onToast('Screenshot deleted') }
    } catch { onToast('Network error', true) }
  }

  return (
    <div className="card" style={{ margin: 0 }}>
      <div className="card-head">
        <span className="card-label">
          Screenshots <span className="pill muted" style={{ fontSize: 9, marginLeft: 6 }}>manual</span>
          {urls.length > 0 && ` (${urls.length})`}
        </span>
        {urls.length > 0 && (
          <button className="btn btn-sm btn-ghost" onClick={() => onExpand(urls[0])}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
            </svg>
            Expand
          </button>
        )}
      </div>

      {urls.length > 0 && (
        <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 4, marginBottom: canEdit ? 10 : 0 }}>
          {urls.map((url, i) => (
            <div key={url} style={{ position: 'relative', flexShrink: 0 }}>
              <img src={url} alt={`Manual screenshot ${i + 1}`}
                onClick={() => onExpand(url)}
                className="screenshot-item"
                style={{ height: 220, borderRadius: 10, border: '1px solid var(--border)', cursor: 'pointer' }}
                loading="lazy"
                onError={e => { e.currentTarget.style.display = 'none' }} />
              {canEdit && (
                <button onClick={() => removeSaved(url)} title="Delete this screenshot"
                  style={{
                    position: 'absolute', top: 6, right: 6, width: 24, height: 24, borderRadius: 12,
                    background: 'rgba(0,0,0,.55)', color: '#fff', border: 'none', cursor: 'pointer',
                    display: 'grid', placeItems: 'center', fontSize: 13, lineHeight: 1,
                  }}>
                  ✕
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {canEdit && (
        <>
          {/* Full dropzone with hint when empty; compact add button once images exist. */}
          <div
            onClick={() => fileInputRef.current?.click()}
            onDragOver={e => { e.preventDefault(); setDragOver(true) }}
            onDragLeave={() => setDragOver(false)}
            onDrop={e => {
              e.preventDefault(); setDragOver(false)
              stageFiles(Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/')))
            }}
            style={{
              border: `1.5px dashed ${dragOver ? 'var(--accent)' : 'var(--border-strong)'}`,
              background: dragOver ? 'var(--accent-weak)' : 'var(--surface-2)',
              borderRadius: 10, textAlign: 'center', cursor: 'pointer',
              fontSize: 12, color: 'var(--muted)',
              padding: urls.length === 0 ? '18px 12px' : '7px 12px',
            }}>
            {urls.length === 0
              ? 'Paste (Ctrl+V), drag & drop, or click to choose — PNG/JPEG/WebP, ≤5MB'
              : '+ Add more'}
            <input ref={fileInputRef} type="file" multiple accept={ACCEPTED.join(',')}
              style={{ display: 'none' }}
              onChange={e => {
                stageFiles(Array.from(e.target.files ?? []))
                e.target.value = ''
              }} />
          </div>

          {staged.length > 0 && (
            <>
              <div style={{ display: 'flex', gap: 8, overflowX: 'auto', padding: '10px 0 4px' }}>
                {staged.map(s => (
                  <div key={s.preview} style={{ position: 'relative', flexShrink: 0 }}>
                    <img src={s.preview} alt={s.file.name}
                      style={{ height: 120, borderRadius: 8, border: '1.5px dashed var(--warn)' }} />
                    <button onClick={() => unstage(s.preview)} title="Remove from staging" disabled={saving}
                      style={{
                        position: 'absolute', top: 4, right: 4, width: 20, height: 20, borderRadius: 10,
                        background: 'rgba(0,0,0,.55)', color: '#fff', border: 'none', cursor: 'pointer',
                        display: 'grid', placeItems: 'center', fontSize: 11, lineHeight: 1,
                      }}>
                      ✕
                    </button>
                  </div>
                ))}
              </div>
              {deferSave ? (
                <p style={{ fontSize: 11.5, color: 'var(--faint)', textAlign: 'center', margin: '8px 0 0' }}>
                  {staged.length} pending — will be saved with the evaluation
                </p>
              ) : (
                <button className="btn btn-primary" onClick={() => uploadStaged(false)} disabled={saving}
                  style={{ width: '100%', justifyContent: 'center', marginTop: 6 }}>
                  {saving ? 'Saving...' : `Save screenshots (${staged.length})`}
                </button>
              )}
            </>
          )}
        </>
      )}

      {!canEdit && urls.length === 0 && (
        <div style={{ fontSize: 12, color: 'var(--faint)', textAlign: 'center', padding: '12px 0' }}>
          No screenshots yet
        </div>
      )}
    </div>
  )
})

export default ManualScreenshotsCard
