// components/GenreToggles.tsx — which genres receive new games, above the roster.
//
// A genre only receives games when it is switched on AND somebody is available
// for it, so the table shows both halves side by side: the switch says what was
// asked for, the "Ready today" column says whether it can happen. When the two
// disagree the row expands to name the fix, because "no one available" on its own
// leaves the reader guessing.
//
// Presentational — the write leaves through onToggle, like RosterTable.
'use client'
import { Fragment } from 'react'
import { BUCKET_LABELS } from '@/components/RosterTable'
import type { Bucket } from '@/lib/buckets'
import type { GenreTarget } from '@/lib/genre-config'

export function GenreToggles({ genres, canEdit, onToggle }: {
  genres: GenreTarget[]
  canEdit: boolean
  onToggle: (bucket: Bucket, enabled: boolean) => void
}) {
  return (
    <div className="card genre-card">
      <div className="card-head">
        <span className="card-label">Genres receiving new games today</span>
      </div>
      <div className="tbl-wrap">
        <table className="tbl genre-tbl">
          <thead>
            <tr>
              <th style={{ width: 160 }}>Genre</th>
              <th style={{ width: 180 }}>Ready today</th>
              <th>New games</th>
            </tr>
          </thead>
          <tbody>
            {genres.map(g => {
              const stuck = g.enabled && g.available === 0
              const label = BUCKET_LABELS[g.bucket]
              return (
                <Fragment key={g.bucket}>
                  <tr>
                    <td className="genre-name">{label}</td>
                    <td className={g.available > 0 ? '' : 'genre-none'}>
                      {g.available > 0
                        ? `${g.available} evaluator${g.available === 1 ? '' : 's'}`
                        : 'no one available'}
                    </td>
                    <td>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={g.enabled}
                        aria-label={`New ${label} games`}
                        disabled={!canEdit}
                        className={`sw${g.enabled ? ' sw-on' : ''}${stuck ? ' sw-stuck' : ''}`}
                        onClick={() => onToggle(g.bucket, !g.enabled)}
                      >
                        <span className="sw-track" aria-hidden="true"><span className="sw-knob" /></span>
                        <span className="sw-text">{g.enabled ? 'On' : 'Off'}</span>
                      </button>
                    </td>
                  </tr>
                  {stuck && (
                    <tr className="genre-warn-row">
                      <td />
                      <td colSpan={2}>
                        <div role="alert" className="genre-warn">
                          Nothing will be pushed. Mark someone available for {label} below.
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
      {!canEdit && <p className="genre-note">Only an admin can change this.</p>}
    </div>
  )
}
