# Playtest Trends Tagging — design

Date: 2026-08-12

## Problem

Evaluators learn the most about a game while they are testing it, but the only place
to record a trend today is Signal Sense's Custom Field Tags dialog — a different app
most evaluators do not use. Trend knowledge therefore stays in evaluation notes and
never reaches the tag data that Signal Sense's browsing and filtering depend on.

We want evaluators to tag trends inside the evaluation modal at the moment they test
the game, without letting unreviewed tags land in Signal Sense. An admin reviews the
proposals first.

## Context

Both apps share one Neon database. This repo already joins `game_info`
(`lib/rescue-core.ts:111`), and Signal Sense's tag tables are directly reachable:

| Table | Role | Live size |
|---|---|---|
| `custom_field_definitions` | allowed field/value pairs | 351 active rows with `field_name = 'Trends'` |
| `custom_field_values` | a tag on a game | 13,456 Trends rows, 641 with a sub-value |
| `sub_value_definitions` | global sub-values | 2 rows: `Change Theme` (1), `Gameplay Variant` (2) |

Constraints that shape this design (verified on prod):

```
custom_field_values_created_by_fkey  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
custom_field_values_updated_by_fkey  FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
unique_game_field_value              UNIQUE (game_id, field_name, field_value)
```

Two consequences we design around rather than fight:

1. **`created_by` cannot hold free-text provenance.** The FK is enforced, and Signal
   Sense builds its custom-field tag history by joining `custom_field_values.created_by`
   to `users` — a bogus id renders blank. There is no free-text audit column on their
   side (`tag_history` is for publisher tagging only).
2. **A tag's identity is `(game, field_name, field_value)`; the sub-value is an
   attribute, not part of the identity.** Signal Sense's
   `customFieldValueRepository.ts:662` runs
   `ON CONFLICT (game_id, field_name, field_value) DO NOTHING`, an inference clause
   that requires a unique index on exactly those three columns. Widening the index to
   include `sub_value_id` would make that INSERT fail with
   `no unique or exclusion constraint matching the ON CONFLICT specification`, breaking
   their bulk-add. Their dialog agrees with this model: one row offers many values
   (multi-select) but a single Sub-Value dropdown for the whole row.

Confirmed with the user: one game never needs the same trend under two different
sub-values, so we keep Signal Sense's model and touch no schema outside our own table
(plus one system-account row, following the existing `signal_sense_user` precedent).

## Data model

Migration `035_playtest_tags.sql`:

```sql
CREATE TABLE playtest_tags (
  id            serial PRIMARY KEY,
  game_id       varchar(255) NOT NULL REFERENCES game_info(game_id) ON DELETE CASCADE,
  field_value   text NOT NULL,
  sub_value_id  integer REFERENCES sub_value_definitions(id),
  status        varchar(16) NOT NULL DEFAULT 'pending',
  tagged_by     varchar(255) NOT NULL,
  tagged_at     timestamp NOT NULL DEFAULT now(),
  confirmed_by  varchar(255),
  confirmed_at  timestamp,
  sync_result   varchar(16)
);

CREATE UNIQUE INDEX playtest_tags_pending_uniq
  ON playtest_tags (game_id, field_value) WHERE status = 'pending';
CREATE INDEX playtest_tags_status_idx ON playtest_tags (status, tagged_at DESC);

INSERT INTO users (id, first_name, last_name, email, is_active, password_hash)
VALUES ('playtest_sync', 'Signal Playtest', 'Sync', 'playtest-sync@athena.studio', false, NULL)
ON CONFLICT (id) DO NOTHING;
```

Notes:

- No `field_name` column. `'Trends'` is a constant (`TRENDS_FIELD`) in
  `lib/playtest-tags.ts`. Adding a second field name later is a migration, and that is
  the right time to pay for it.
- `status`: `pending` | `synced` | `rejected`. Rejected rows are kept for the audit
  trail, not deleted.
- `sync_result`: `inserted` | `duplicate` | `enriched` | `overwritten` | `kept`.
- `tagged_by` / `confirmed_by` hold `dashboard_users.email` — this app's identity, no FK
  into Signal Sense's `users`.
- The partial unique index lets a game accumulate history for the same value across
  rounds while blocking two live proposals for one value.

Attribution is two-tiered. Signal Sense receives only valid ids: both `created_by` and
`updated_by` are set to the `playtest_sync` system account, so tags arriving from
playtest are identifiable at a glance in their UI. The real provenance — who tagged,
who confirmed, when — lives in `playtest_tags` and is what the History view shows.

## Sync rules

`POST /api/playtest-tags/confirm` runs per pending tag of one game, in a single
transaction, comparing against `custom_field_values` rows for that game with
`field_name = 'Trends'`:

| Situation | Action | `sync_result` |
|---|---|---|
| Value not present | INSERT (`created_by` = `updated_by` = `playtest_sync`) | `inserted` |
| Value present, same sub-value | nothing | `duplicate` |
| Value present, their `sub_value_id` is NULL | UPDATE to fill the sub-value, set `updated_by` | `enriched` |
| Value present, their sub-value differs | nothing by default; admin may force | `conflict` → `overwritten` or `kept` |

A `conflict` tag is not synced by a plain Confirm. The card surfaces it and the admin
either passes its id in `overwrite[]` — UPDATE their sub-value, `sync_result = 'overwritten'`,
`status = 'synced'` — or leaves it, meaning Signal Sense's existing value wins:
`sync_result = 'kept'`, `status = 'rejected'`, since nothing was written. Either way the
row leaves Pending.

`duplicate` rows end at `status = 'synced'`: the tag the evaluator proposed is present in
Signal Sense, which is the outcome they wanted, even though no write happened.

The decision logic lives in `lib/playtest-tags.ts` as a pure function
`classifyTag(pending, existing)` returning the action, so it is unit-testable in jest
alongside `lib/report.ts`.

## UI

### Evaluation modal (`components/EvalDetailPanel.tsx`)

A new `field` directly below **Game Alike**, inside the same card, with no save button
of its own — it sets `dirty` and rides the existing Save / auto-save flow.

```
Trends Tags
┌──────────────────────────────────────────────┐
│ Already in Signal Sense:  [Balatro · Change Theme]  [Backpack]
├──────────────────────────────────────────────┤
│ [Ball Flow 3D ▾]  [Gameplay Variant ▾]   ✕   │
│ [Balatro ▾]       ⚠ already in Signal Sense  ✕
│ + Add trend                                   │
└──────────────────────────────────────────────┘
```

- Existing Signal Sense tags render first, read-only, so an evaluator does not re-tag
  what is already there.
- The value combobox searches the 351 active Trends definitions. Typing a new value is
  not allowed; new trends are created in Signal Sense by an admin.
- Sub-value select: `-- None --` / `Change Theme` / `Gameplay Variant`.
- New component `components/TrendTagsField.tsx`, built on the chip + search pattern of
  `components/GameAlikeField.tsx`.
- Permission: reuse the existing `canEditGameAlike` gate — the game's evaluator or an
  admin, never frozen by stage locks.

### Tagging subtab

Sidebar entry `/evaluations?cat=tagging` in `app/(manager)/layout.tsx`, dispatched
beside `cat=short_list` at `app/(manager)/evaluations/page.tsx:922`. Admin only.

**Pending** — one card per game (title, publisher, evaluator, link to open the modal).
Each row inside is an editable tag: value combobox, sub-value select, `✕` to reject, a
badge naming who tagged it. Conflict rows show the Signal Sense sub-value and an
Overwrite toggle. Footer: **Confirm game**. A **Confirm all** action covers the cards
with no conflicts.

**History** — flat read-only table of `synced` and `rejected` rows: game, value,
sub-value, tagged by, confirmed by, `sync_result`, dates. Filters: tagger and date
range. Paged.

## API

Next route handlers using `sql` from `lib/db.ts`.

| Route | Behaviour |
|---|---|
| `GET /api/trends/options` | active Trends values + sub-values; in-memory cache with TTL |
| `GET /api/playtest-tags?gameId=` | that game's pending tags plus its live Signal Sense Trends tags |
| `PUT /api/playtest-tags` | replace the whole pending set for one game; called from the modal's `save()` |
| `GET /api/playtest-tags/pending` | grouped by game, with conflict flags; admin only |
| `POST /api/playtest-tags/confirm` | `{ gameId, overwrite: number[] }`; applies the sync rules in one transaction |
| `POST /api/playtest-tags/reject` | `{ ids }` → `status = 'rejected'` |
| `GET /api/playtest-tags/history` | paged history with filters |

`PUT /api/playtest-tags` authorises with the same rule as the modal field: the game's
evaluator or an admin. Every other route under `/api/playtest-tags` except the `gameId`
read is admin only (`requireManager` from `lib/auth-guard.ts`).

## Error handling

- Confirm runs in one transaction per game; a failure leaves every tag of that game
  `pending` and returns which tag failed.
- A `field_value` no longer active in `custom_field_definitions` when Confirm runs is
  rejected with a clear message rather than inserted — the definition list is Signal
  Sense's to own.
- A `game_id` deleted from `game_info` takes its `playtest_tags` rows with it (cascade).
- `GET /api/trends/options` failure disables the combobox with a retry rather than
  rendering an empty list that looks like "no trends exist".

## Testing

Jest, following `__tests__/lib` and `__tests__/api`:

- `classifyTag` across all five outcomes, including sub-value NULL vs set vs differing.
- Confirm route: mixed batch (one insert, one duplicate, one enrich, one conflict) leaves
  correct `status`/`sync_result` and writes exactly the expected `custom_field_values`
  rows.
- Confirm with `overwrite[]` updates only the listed ids.
- `PUT /api/playtest-tags` replace semantics: removing a tag from the payload deletes
  the pending row; re-adding a previously rejected value creates a fresh pending row.
- Authorisation: an evaluator cannot PUT tags for another evaluator's game, and cannot
  reach the pending/confirm routes.

## Out of scope

- Creating new Trends values or sub-values from this app.
- Editing or removing tags that already exist in Signal Sense, except filling a NULL
  sub-value or an explicit Overwrite during Confirm.
- Any field name other than `Trends`.
- Notifying evaluators of confirm/reject outcomes.
