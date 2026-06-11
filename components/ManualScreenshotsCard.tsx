'use client'
import { useState, useEffect, useRef, useCallback } from 'react'

const ACCEPTED = ['image/png', 'image/jpeg', 'image/webp']
const MAX_FILES = 10
const MAX_SIZE = 5 * 1024 * 1024

interface Staged { file: File; preview: string }

interface Props {
  gameId: string
  urls: string[]
  canEdit: boolean
  /** Reports the authoritative URL array after every save/delete. */
  onChange: (urls: string[]) => void
  onExpand: (url: string) => void
  onToast: (msg: string, err?: boolean) => void
}

export default function ManualScreenshotsCard({ gameId, urls, canEdit, onChange, onExpand, onToast }: Props) {
  const [staged, setStaged] = useState<Staged[]>([])
  const [saving, setSaving] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const stageFiles = useCallback((files: File[]) => {
    setStaged(prev => {
      const next = [...prev]
      for (const f of files) {
        if (!ACCEPTED.includes(f.type)) { onToast(`${f.name}: chỉ nhận PNG/JPEG/WebP`, true); continue }
        if (f.size > MAX_SIZE) { onToast(`${f.name}: vượt quá 5MB`, true); continue }
        if (next.length >= MAX_FILES) { onToast(`Tối đa ${MAX_FILES} ảnh mỗi lần lưu`, true); break }
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

  // Revoke object URLs on unmount.
  useEffect(() => () => { staged.forEach(s => URL.revokeObjectURL(s.preview)) }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const unstage = (preview: string) => {
    setStaged(prev => {
      const hit = prev.find(s => s.preview === preview)
      if (hit) URL.revokeObjectURL(hit.preview)
      return prev.filter(s => s.preview !== preview)
    })
  }

  const save = async () => {
    if (staged.length === 0 || saving) return
    setSaving(true)
    try {
      const form = new FormData()
      staged.forEach(s => form.append('files', s.file, s.file.name || 'pasted.png'))
      const res = await fetch(`/api/evaluations/${encodeURIComponent(gameId)}/screenshots`, {
        method: 'POST', body: form,
      })
      const json = await res.json()
      if (!res.ok) {
        onToast(json.error || 'Lưu ảnh thất bại', true)
      } else {
        onChange(json.urls || [])
        const failedNames = new Set((json.failed || []).map((f: { name: string }) => f.name))
        setStaged(prev => {
          prev.filter(s => !failedNames.has(s.file.name)).forEach(s => URL.revokeObjectURL(s.preview))
          return prev.filter(s => failedNames.has(s.file.name))
        })
        if (failedNames.size > 0) onToast(`${failedNames.size} ảnh lỗi — thử lưu lại`, true)
        else onToast('Đã lưu ảnh')
      }
    } catch { onToast('Network error', true) }
    setSaving(false)
  }

  const removeSaved = async (url: string) => {
    try {
      const res = await fetch(`/api/evaluations/${encodeURIComponent(gameId)}/screenshots`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      })
      const json = await res.json()
      if (!res.ok) onToast(json.error || 'Xoá thất bại', true)
      else { onChange(json.urls || []); onToast('Đã xoá ảnh') }
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
                <button onClick={() => removeSaved(url)} title="Xoá ảnh này"
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
              borderRadius: 10, padding: '18px 12px', textAlign: 'center', cursor: 'pointer',
              fontSize: 12, color: 'var(--muted)',
            }}>
            Dán ảnh (Ctrl+V), kéo thả, hoặc bấm để chọn — PNG/JPEG/WebP, ≤5MB
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
                    <button onClick={() => unstage(s.preview)} title="Bỏ ảnh này"
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
              <button className="btn btn-primary" onClick={save} disabled={saving}
                style={{ width: '100%', justifyContent: 'center', marginTop: 6 }}>
                {saving ? 'Đang lưu...' : `Save screenshots (${staged.length})`}
              </button>
            </>
          )}
        </>
      )}

      {!canEdit && urls.length === 0 && (
        <div style={{ fontSize: 12, color: 'var(--faint)', textAlign: 'center', padding: '12px 0' }}>
          Chưa có screenshot
        </div>
      )}
    </div>
  )
}
