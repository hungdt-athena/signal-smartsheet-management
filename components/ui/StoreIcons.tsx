'use client'
// Store marks for a linked game pair: one 28x28 cell per store, iOS first.
import type { PairStore } from '@/lib/eval-pairs'
import { APPLE_PATH, PLAY_PATH } from '@/components/ui/GameIcon'

export function StoreMark({ os, size = 12 }: { os: 'ios' | 'android'; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true"
      style={{ color: os === 'ios' ? 'var(--text)' : 'var(--good)', flexShrink: 0 }}>
      <path fill="currentColor" d={os === 'ios' ? APPLE_PATH : PLAY_PATH} />
    </svg>
  )
}

export function storeTitle(s: Pick<PairStore, 'os' | 'game_id' | 'dead' | 'is_active'>) {
  return `${s.os === 'ios' ? 'iOS' : 'Android'} · ${s.game_id}${s.dead ? ' · Link dead' : ''}${!s.is_active ? ' · Removed' : ''}`
}

export function StoresCell({ stores, asLinks = false }: { stores: PairStore[]; asLinks?: boolean }) {
  const ordered = [...stores].sort((a, b) => (a.os === b.os ? 0 : a.os === 'ios' ? -1 : 1))
  return (
    <div className="store-icons">
      {ordered.map(s => {
        const title = storeTitle(s)
        const cls = `store-ico${s.dead ? ' dead' : ''}${!s.is_active ? ' removed' : ''}`
        const mark = <StoreMark os={s.os} size={13} />
        return asLinks && s.app_link
          ? <a key={s.game_id} className={cls} href={s.app_link} target="_blank" rel="noreferrer" title={title} aria-label={title}
              onClick={e => e.stopPropagation()}>{mark}</a>
          : <span key={s.game_id} className={cls} title={title} aria-label={title}>{mark}</span>
      })}
    </div>
  )
}
