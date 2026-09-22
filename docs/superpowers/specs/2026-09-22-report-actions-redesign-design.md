# Report actions: one system across three tabs

Date: 2026-09-22
Status: approved design, not yet planned

## The problem

The Report tab carries thirteen action lines across Overview, Leaderboard and
Individual. Four stories are told more than once:

| Story | Overview | Leaderboard | Individual |
|---|---|---|---|
| Games sitting a long time | `holders` | `queue` | `stale` |
| Someone's bar is off | `quality` | `outlow` / `cal` / `outhigh` | `callow` / `calhigh` |
| Taking in more than clearing | `catchup` | - | `behind` |
| Not working | - | `idle` | `idle` |

Two different tabs both say "run Rescue", and they disagree about what they
mean: the Report calls a game stale at **8 days** (`STALE.days`), while Rescue
calls it stale at **14** (`rescue_config.staleDays`, admin-editable). The two
tabs point at different games while using the same word.

Every action also stops at naming a target. None of them says where to go to do
it, and none says what the reader gets if they do.

## Seven laws

1. **One altitude per tab.** Overview = the system. Leaderboard = person against
   person. Individual = one person.
2. **A story is concluded at exactly one altitude.** Other tabs may point at it
   with a button; they may not restate the conclusion.
3. **Overview may name a person only as the coordinate of some games, never as a
   judgement of that person.** "926 games are sitting with X, Y and Z" is a
   coordinate. "X judges carelessly" is a judgement and belongs on Leaderboard.
   This test is what keeps `holders` on Overview and moves `quality` off it.
4. **An action's button must be an operation the reader of that tab is allowed to
   run.** A contractor therefore never sees a Rescue button.
5. **Three lines per tab, still.** Sort by severity, then at most one line per
   topic, then the cheaper remedy wins a tie.
6. **No fallback actions.** Nothing crosses a threshold, nothing prints.
7. **When one problem has several ways out, print them in order of price**, and
   open every line after the first with "Or":
   **rebalance (free) -> raise the pace (effort) -> add people (money) -> drop work (loss)**

Law 7 is what makes the block feel like advice rather than a verdict: the
cheapest remedy is always read first.

## Lexicon

One concept, one word. Counted in `ReportView.tsx` before this change: queue
103, backlog 39, pile 22, waiting 25 - four words for one thing.

| Concept | Word | Banned |
|---|---|---|
| Unevaluated games held right now | **Backlog** | queue, pile, waiting games, stock |
| A game held past the configured threshold by one person | **Stale** | old work, aged, the tail, old games |
| Days a game sits with someone before judgement | **Days waiting** | turnaround, wait, time to evaluation |
| How long the backlog takes to drain | **Days to clear** | days of work in the pile |
| Kept after the initial judgement | **Shortlist rate** | survival, Survival |
| Reached Priority IV or Insight | **Hit rate** | Signal rate |
| Weighting for sample size | **Sample weight** | Credibility |

Two of these settle earlier decisions rather than making new ones:

- **Backlog wins** - decided in Individual redesign round 2 ("doi waiting/queue
  -> backlog ca 3 tab") and never finished; `queue` still appears 103 times.
- **Stale wins** over "old work" because Stale is the word printed on the screen
  the button navigates to (the Rescue panel's own column header). Standing rule:
  **the destination screen's word wins.**

Once "waiting" is no longer a name for the pile, the column label "Days waiting"
has exactly one meaning.

Scope of the rename: **screen text only.** Code identifiers (`survivalRate`,
`signalRate`) stay as they are, so the diff stays reviewable.

## Tab ownership

| Tab | Question | The reader decides | Operation it links to |
|---|---|---|---|
| Overview | Can the team get through what is in front of it? | the system: add people, raise the pace, rebalance the whole backlog, drop the oldest games | **Rescue** (whole bucket) |
| Leaderboard | Where do people differ from each other? | who to talk to | **Reassign** (one named person) |
| Individual | What should this person change next week? | one person's own habits | none - only jumps to evidence |

The Rescue/Reassign split is not invented for this design. `lib/rescue-core.ts`
scans the whole bucket and picks both sides itself; `lib/reassign-core.ts` moves
one named person's games to people you choose. The two altitudes already exist
in the code.

## Overview - the system (admin)

| key | topic | Line | Button |
|---|---|---|---|
|  `rebalance` NEW | age | Move N stale games from X, Y, Z to the M people with a clear desk | **Open Rescue** |
| `holders` changed | age | Fires only when no one qualifies as a receiver: put those N games at the front of the next assign run | jump to Backlog by age |
| `tail` NEW | age | The N games in the oldest band (15+ days) will never be reached at this order - front of the queue, or drop them | jump to card |
| `catchup` rewritten | growth | Each person adds K games a day (74 -> 86) to break even on intake | **See who is under the pace** -> Leaderboard |
| `capacity` rewritten | speed | Or add P people for a week - clear by 30 Sep, the most expensive of the three | **Open Assign preview** |
| `pace` kept | speed | Find what changed in the working day before adding people | jump to People working |
| `notriage` kept | quality | Ask a moderator to triage this window's shortlist | jump to funnel |
| `quality` REMOVED | - | moves to Leaderboard entirely (law 3) | - |

`rebalance`, `catchup` and `capacity` are three answers to one problem and are
printed in that order by law 7.

Removing `quality` leaves the Quality topic with `notriage` only. That is a
system action - work stuck at a gate - so the headline -> chip -> KPI -> action
chain keeps its Quality link.

## Leaderboard - person against person (admin)

The only home for calibration at team altitude.

| key | Change |
|---|---|
| `outlow` / `cal` / `outhigh` | unchanged; absorbs what Overview gives up |
| `queue` | drop the words "Run Rescue"; becomes **Reassign X's backlog**, button opens Reassign with X selected |
| `stuck`, `conc`, `idle`, `picks` | unchanged |
| "who is under the pace" | **no new action.** Overview asked the question; Leaderboard answers with its table. Add a focus target so Overview's button lands on the Games per day column, sorted ascending, with the under-pace rows flashed. |

## Individual - admin reading someone else

**No action about moving games.** That is a person-against-person decision and
was already concluded on Leaderboard (law 2).

Keeps: `stale` (rewritten as coaching, not as a move), `behind`, `callow`,
`calhigh`, `rec`. Drops `idle` (duplicate of Leaderboard).

## Individual - a contractor reading themselves

`canSeeTeam` is false for an evaluator, so `SELF_TABS` leaves them Individual
alone. Everything that helps them adjust has to fit in this one tab, and each
line must be doable **alone, this week, without anyone's permission**.

Every line carries **both references**: their own previous window, and the team.

| key | Line | Threshold reads |
|---|---|---|
| `oldfirst` | 34 of your 120 games have gone stale (past the team threshold), oldest 41. Start each day with the 5 oldest - stale games gone in 7 days | own backlog |
| `bar` | You keep 3% where the team keeps 9%. Over 420 games that is about 25 games dropped that nobody downstream ever saw again - send your last 5 bypasses to a moderator | **team** |
| `rhythm` | You were out 4 of 13 days. On the days you worked you cleared 90 - the problem is days, not speed | **own previous window** |
| `flood` | You took 210 and cleared 140 this week; 70 joined your backlog - say so early and some can be moved | own previous window |
| `video` | N recordings confirmed over 7 days ago with no upload | - |
| `up` | The one good-news line, printed only when an improvement crosses its own threshold | own previous window |

Design decisions taken here, stated so they can be overruled:

- **Both references are always displayed; the trigger is not always the same
  one.** Output and rhythm trigger against the person's own previous window - a
  freelancer working three sessions a week should not be red for that. The bar
  triggers against the team, because a bar that is not shared makes the data
  unusable.
- **`up` does not break law 6**: it has its own threshold, and it never displaces
  a red line from the cap of three.

## Navigation contract

A button must deliver what its sentence promised: the right screen, configured
the way the sentence described, with the named rows flashed.

| Button | Destination | Configured | Flashed |
|---|---|---|---|
| Open Rescue | `/team-ops?tab=rescue` | nothing passed - see below | the source and receiver rows the action named |
| Open Assign preview | `/team-ops?tab=assign` | - | the roster block |
| See who is under the pace | `/team-ops?tab=performance&rtab=leaderboard&focus=perday` | table sorted by Games per day ascending | the under-pace rows |
| Reassign X | `/team-ops?tab=reassign&from=X` | X selected as the source | X's row |
| Contractor jumps | same tab | - | the evidence card |

**`staleDays` is deliberately not passed in the URL.** `POST /api/operations/rescue`
with `action: 'scan'` **persists the config it is given**, so a Report button
carrying `staleDays=8` would silently rewrite the admin's saved Rescue settings.
The direction is reversed instead: **the Report speaks the tool's configured
number.** One source of truth, `app_config.rescue_config`.

## Data and API

### `rescue` block in the report payload (admin only)

`app/api/report/route.ts` gains a top-level `rescue` block built from
`loadRescueConfig()` + `scanRoster()` + `classifyRoster()`:

```
rescue: {
  staleDays: number
  sources:   Array<{ name: string; stale: number; movable: number }>
  receivers: Array<{ name: string; pending: number; evaluatedRecent: number }>
  movableTotal: number
}
```

**Top level, not inside `pipeline`.** The scan reads "now" and has no window in
it at all - the same mistake `stock` was hoisted out of on 2026-09-21. It is sent
on every view, including batch. Its query runs in parallel with the existing
ones; see [[app-db-region-latency]] - the cost is one round trip, not the query.

### One definition of stale

- `STALE.days = 8` is deleted. Everything that says "stale" reads
  `rescue.staleDays`.
- The age bands on the charts (0-3 / 4-7 / 8-14 / 15+) stay fixed. **A band is a
  ruler; `staleDays` is a threshold. Never derive one from the other.**
- A contractor gets no `rescue` block (Rescue is admin-only), so the server also
  returns a `staleCount` for the self person, computed with the same
  `staleDays` - one extra filter on the existing `backlogBy` query. Without it
  the contractor's line would quietly go back to band language and we would have
  two numbers again.

### URL state for the Report's inner tab

`tab` is `useState('')` today, so nothing can link into Leaderboard. Add `rtab`
and `focus` as search params, synced both ways. This also makes any Report view
shareable, which it is not today.

## Layout - option C

Three equal cards in a grid, chosen over a split row and a vertical stack.

- `grid-template-columns: repeat(3, 1fr)`, 10px gap, `align-items: stretch`.
- Each card is a column: topic kicker / the move / the evidence / hairline /
  the payoff / the button, with the button block pushed down by `margin-top:auto`
  so the three buttons line up however tall the cards are.
- Severity keeps the existing left border and tint (`--bad` / `--warn`).
- The payoff line is new: 11.5px, weight 600, green, prefixed with an arrow.
  It says what the reader gets, in days or a date.
- Below 900px the grid collapses to one column.

The known cost of C: the evidence line wraps to four or five lines in a narrow
card. Evidence copy is written to a 150-character budget.

## Verification

Per [[report-redesign-pattern]], nothing else has caught this class of bug:
render the **real production payload** through jsdom and read the output back as
text - headline, chips, every KPI, every action, every ReadNote, word count.

Specific cases that must be in the fixture set:

- a batch window (`pipeline` null) - `rescue` and `stock` must both survive
- a window where the scan finds sources but **no receivers** - `rebalance` must
  not print, `holders` must
- a contractor payload (`canSeeTeam` false) - no `rescue` block, `staleCount`
  present, no operation buttons rendered
- a healthy window - the block prints nothing at all (law 6)
- `rescue_config.staleDays` set to something other than 8 - no sentence anywhere
  still says 8

Grep gates after the rename: `queue`, `pile` and `waiting` must not appear in
screen text, and `Signal rate` and `Credibility` must be gone.

## Out of scope

- Moving thresholds into `report_config` with who-set-it and when. `staleDays`
  now comes from `rescue_config`, which is a step toward it; the rest stay in
  code.
- Any action that asks for the intake to be made smaller. Push windows are
  admin-editable now, but the standing rule holds: this tab talks about what the
  team can move.
- A contractor button that files a request to have work moved. Rejected as a new
  backend (request table, approval surface, notifications) for this pass.
- Renaming code identifiers.

## Open

- Where the implementation lands. The Report redesign is currently **uncommitted
  in the main checkout**, not in the `main-3` worktree this spec was written in.
