'use client'
// The store switcher on a linked pair's Game Info card: icon + store name, the store id only in
// the tooltip. A store whose link is dead carries a red dot, like .store-ico.dead.
import type { PairStore } from '@/lib/eval-pairs'
import { StoreMark, storeTitle } from '@/components/ui/StoreIcons'

export function StoreTabs({ stores, selected, onSelect }: {
  stores: Pick<PairStore, 'os' | 'game_id' | 'dead' | 'is_active'>[]
  /** game_id of the store shown */
  selected: string
  onSelect: (gameId: string) => void
}) {
  return (
    <div className="store-tabs">
      {stores.map(s => {
        const on = s.game_id === selected
        return (
          <button key={s.game_id} type="button" className={`store-tab${on ? ' on' : ''}${s.dead ? ' dead' : ''}`}
            aria-pressed={on} title={storeTitle(s)} onClick={() => onSelect(s.game_id)}>
            <StoreMark os={s.os} size={12} />
            {s.os === 'ios' ? 'iOS' : 'Android'}
          </button>
        )
      })}
    </div>
  )
}
