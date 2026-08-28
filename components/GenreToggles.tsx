// components/GenreToggles.tsx — the genre switches above the roster.
//
// A genre only runs when it is switched on AND somebody is available for it, so
// each chip shows both halves: switching arcade on while nobody is marked
// available changes nothing today, and the chip has to say so rather than look
// live. Presentational — the write leaves through onToggle, like RosterTable.
'use client'
import { BUCKET_LABELS } from '@/components/RosterTable'
import type { Bucket } from '@/lib/buckets'
import type { GenreTarget } from '@/lib/genre-config'

export function GenreToggles({ genres, canEdit, onToggle }: {
  genres: GenreTarget[]
  canEdit: boolean
  onToggle: (bucket: Bucket, enabled: boolean) => void
}) {
  return (
    <div className="genre-toggles">
      <span className="card-label">Genres pushed today</span>
      <div className="genre-chips">
        {genres.map(g => {
          const state = !g.enabled ? 'off' : g.active ? 'on' : 'warn'
          return (
            <button
              key={g.bucket}
              type="button"
              className={`genre-chip genre-chip-${state}`}
              aria-pressed={g.enabled}
              disabled={!canEdit}
              title={canEdit ? 'Admin only: turn this genre on or off' : 'Only an admin can change this'}
              onClick={() => onToggle(g.bucket, !g.enabled)}
            >
              <span className="genre-chip-name">{BUCKET_LABELS[g.bucket]}</span>
              <span className="genre-chip-state">
                {!g.enabled
                  ? 'Off'
                  : g.available > 0
                    ? `${g.available} available`
                    : 'No one available'}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
