# Global current batch + bulk batch move

Date: 2026-10-08. Status: design approved in chat, spec awaiting review.

## Why

1. **Current batch is stored per category** (`app_config` keys `current_batch:puzzle`,
   `:arcade`, `:simulation`). The team now runs one batch for every category group, so the
   per-category setting is wrong twice: a manager must set it three times, and a category
   that was never set (simulation today) silently has no batch, so evaluators there get
   "No active batch" and the missing-demo prompt ignores them.
2. **Batch is stamped when the evaluator saves.** When the new week starts before a manager
   has changed the current batch, every `List_Idea` saved in that gap is stamped with last
   week's batch. Fixing that today means opening each game. Managers need to move many
   games to the right batch in one action.

## Scope

In: one global current batch; a manager-only bulk "move to batch" in Short List.

Out (decided): suggesting a move automatically when the current batch changes; a history
table for moves (only `updated_by` / `updated_at`); one-click undo; any change to how a
single game's batch is edited in `EvalDetailPanel`.

## Part 1 — Global current batch

### Storage and reading

- One `app_config` row, key `current_batch`. The three `current_batch:<category>` keys go away.
- `lib/current-batch.ts` becomes the single reader:
  - `getCurrentBatch(): Promise<string | null>` — the global value.
  - The missing-demo route filters in SQL (`ge.batch = $current`), so no row-filtering helper is needed; `getCurrentBatches` and `onlyCurrentBatch` are removed.
- **Deploy-order safety.** If `current_batch` is absent, `getCurrentBatch()` falls back to the
  newest value (by `weekLabelOrder`) among legacy `current_batch:%` keys. Code that ships
  before the migration therefore never reports "no active batch" for the whole system.
  Once the migration has run, the fallback is dead code and can be deleted in a later commit.

### Setting it

- `POST /api/evaluations/current-batch` takes `{ batch }` only (manager-only, as today).
  `GET` takes no `category`. Both read/write the single `current_batch` key.
- The "Current batch" select in the Short List header (`app/(manager)/evaluations/page.tsx`)
  now sets the global value. Its options stay: this month's and next month's weeks via
  `weekBatches` (`components/EvalDetailPanel.tsx`), plus the current value if outside them.
- The youtube page only reads the value to pre-select its filter; it has no setter.

### Callers that change

| Caller | Today | After |
|---|---|---|
| `app/api/evaluations/current-batch/route.ts` | key per `category` | single key, no `category` |
| `app/api/evaluations/facets/route.ts` | reads `current_batch:${category}` | `getCurrentBatch()` |
| `app/api/evaluations/route.ts` (`current_batch`, `default_batch`) | reads `current_batch:${category}` | `getCurrentBatch()` |
| `app/api/evaluations/[gameId]/route.ts` | reads all `current_batch:%`, picks by category | `getCurrentBatch()` |
| `app/api/evaluations/missing-demo/route.ts` | `getCurrentBatches()` + `onlyCurrentBatch` | `getCurrentBatch()` and a SQL `ge.batch = $current` |
| Short List, youtube page, `EvalDetailPanel` | consume `current_batch` from the above | unchanged apart from the setter payload |

`category` stays a filter everywhere it already is; only the current batch stops depending on it.
`fallback to the newest older batch that has games` (`default_batch` logic) is unchanged.

### Data migration

`migrations/045_global_current_batch.sql`, applied by hand like earlier migrations:

1. If `current_batch` does not exist, insert it with the newest legacy value by week order
   (today: `W2 Oct, 2026` from puzzle; arcade is `W1 Oct, 2026`).
2. Delete the `current_batch:%` rows.

Prod on 2026-10-08 already had both `current_batch:puzzle` and `current_batch:arcade` at `W2 Oct, 2026`, so the migration changes no visible value.

## Part 2 — Bulk batch move

### Select mode (Short List, managers only)

- A **Select** button in the Short List toolbar. Pressing it reveals a checkbox column and a
  select-all box in the header ("all currently shown"). **Cancel** hides the column and clears
  the selection. Evaluators never see the button.
- Changing category, batch filter, date or any other filter clears the selection, so a move
  can never include rows that are no longer on screen.
- Row click behaviour is unchanged outside select mode; in select mode clicking a checkbox
  must not open the detail panel.

### Action bar

Shown only while at least one game is selected, fixed to the bottom of the table area:
`N selected · Move to [batch select] · Move · Cancel`. The batch select offers the same
options as the Current batch select. Move stays disabled until a batch is chosen.

### Confirmation

Pressing Move opens a confirm dialog: "Move N games to <batch>?". If any selected game has a
final conclusion the dialog adds "K of them already have a final conclusion and will move
too", because batch is also the week shown in the Record tab. No skip option: ticking a
locked game means the manager wants it moved.

### API

`POST /api/evaluations/batch-move` with `{ ids: number[], batch: string }`.

- Auth: admin or moderator only (`requireManager`). Others get 403.
- Validation: `ids` is a non-empty array of integers, de-duplicated, at most 500 (the Short
  List page size); `batch` is a non-empty string. Violations return 400 with a plain message.
- Effect: one statement,
  `UPDATE game_evaluations SET batch = $batch, updated_by = $actor, updated_at = NOW() WHERE id = ANY($ids)`.
  No filter on conclusion or final conclusion. Only the listed ids can change.
- Response: `{ moved: number }` (rows actually updated). After success the client reloads the
  list; moved games leaving the filtered batch is expected.
- `actor` is the session user's name, the same value `PATCH /api/evaluations` stamps.

## Testing

Written first, watched failing:

- `lib/current-batch`: global key wins; falls back to newest legacy key when absent; null when
  nothing is set. The missing-demo route filters in SQL (`ge.batch = $current`), so no
  row-filtering helper exists to test.
- `POST /api/evaluations/current-batch`: writes the single key, ignores any `category`, 403 for
  non-managers.
- Each reader in the table above: uses the global value (facets, list, `[gameId]`, missing-demo).
- `POST /api/evaluations/batch-move`: 403 for evaluator, 400 for empty/oversized/non-integer
  ids and blank batch, updates a game that has a final conclusion, never touches an id that was
  not sent, returns the moved count, stamps `updated_by`.
- Short List component: Select toggles the checkbox column; action bar appears only with a
  selection; filter change clears the selection; confirm dialog counts locked games; a checkbox
  click does not open the detail panel.

Verification before push: new tests green, `npm run typecheck`, a full `next build` in an
isolated dist dir (lint errors block Replit publish). The 9 suites already failing on
`origin/main` (`effort-sessions`, `evaluators`, `handover`, `reassign`, `users-active`,
`weekly-feedback-batches`, `weekly-feedback`, `workflows-trigger`, `people-config-db`) are
not part of this work and must be reported unchanged.

## Rollout

The order matters: the code now running on prod reads only the per-category keys
`current_batch:<category>`, and migration 045 deletes them. Applying 045 before the new build
is live leaves every evaluator on "No active batch", and `EvalDetailPanel` then sends no batch,
so every List_Idea saved in that window keeps `batch` NULL and drops out of the batch-filtered
Short List and the Record week.

1. Merge and push the code. It works before the migration thanks to the legacy fallback.
2. Republish on Replit and confirm the new build is live.
3. Run the migration's CTE as a plain SELECT to confirm the value it will pick, then apply
   migration 045 on prod by hand.
4. A manager sets the global current batch once and uses Select to move games stamped in a gap.

## Risks

- Bulk move can push finished games into another Record week. Mitigated by the confirmation
  line that counts them; there is no undo, so a wrong move is repaired by moving the same
  games back.
- `ge.batch` is a label, not a date window. The move changes the label only; nothing here
  derives a batch from dates.
- Anything outside this repo that reads `current_batch:<category>` directly (an n8n flow, a
  script) would break after the migration. A repo search found none, but n8n JSON that lives
  only in the cloud instance was not checked.
