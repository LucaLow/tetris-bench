# Tetris Bench rules, contract and method (tetris-bench@3)

This is the normative document for Tetris Bench. Where the website, the README or a code comment disagrees with it, this document wins; where this document disagrees with the engine, the engine is wrong and gets fixed under a new protocol identifier. The site lives at [lowndes.dev/tetris-bench](https://www.lowndes.dev/tetris-bench). The engine, harness, adapters, rating code, runner and tests are public at [LucaLow/tetris-bench](https://github.com/LucaLow/tetris-bench).

Every rule that changes how a game is played, asked, clocked, capped, seeded or rated is part of the protocol identifier `tetris-bench@3`. Changing any of them requires a new identifier and a fresh field. Visual changes, new adapters and new hosted models do not.

## 0. In one paragraph

Tetris Bench makes decision models (a random baseline, three classic heuristics, and hosted language models and classifiers) play Tetris by choosing where each piece lands. The harness works out every legal landing spot, simulates each one a single step ahead, and shows the same list to every brain. The brain answers with one placement. **IQ** pauses the clock while the brain thinks, so only judgement counts. **Blitz** runs the clock: the piece keeps falling while the brain thinks, and a slow answer arrives to a lower piece, fewer options and fewer points. The headline number is the **mean IQ score over thirty fixed seeds**, with a 95% interval from those seeds. It is not a general-intelligence score, it is not a rating of the model's own Tetris engine, and a quick three-seed run proves nothing.

## 1. Glossary

| Term | Meaning |
|---|---|
| **Brain** | Anything that answers the question "where does this piece go?". Local brains run in the runner process; hosted brains are called over HTTP through an adapter. |
| **Adapter** | The thin piece of code that turns a `AgentInput` into a brain's native request and the reply into an `AgentAnswer`. |
| **Protocol / ruleset** | The frozen identifier `tetris-bench@3`. Engine rules, clocks, caps, seeds and rating method all live under it. |
| **Seed** | A string such as `seed-07`. It is hashed (FNV-1a) into the xorshift32 generator that shuffles the seven-bag, so the piece sequence is fixed for the whole game. Official seeds are `seed-01` … `seed-30`; quick runs use `seed-01` … `seed-03`. Seeds are public: they support reproduction, not held-out evaluation. |
| **IQ** | Mode with gravity paused while the brain answers. Each question has a 20 s timeout. The only mode that feeds the headline number. |
| **Blitz** | Mode with gravity running. There is no fixed cap: the deadline is the moment the falling piece locks. |
| **Tick** | One question asked of the brain: one loop iteration of the harness. A hold consumes a tick without locking a piece. Gravity steps in Blitz do not consume ticks. |
| **Gravity step** | The piece moving down one row (or locking if it cannot). Happens once per gravity interval in Blitz, never in IQ. |
| **Placement** | `{ x, rotation }`: the piece's bounding-box column and its rotation. The engine moves the piece there at its current height and hard-drops it. |
| **Candidate** | One legal placement together with its simulated outcome: the board after the drop and any clears, lines cleared, points, top-out flag and board features. |
| **Choice** | The required part of an answer: a probability distribution over candidates. The highest-probability placement is played. |
| **Noul / hold** | The optional yes/no part of an answer: swap the active piece into the hold slot instead of placing it. The name comes from System One's question types. |
| **Score / risk** | The optional numeric part of an answer: the brain's probability (0 to 1) that the game tops out within the next ten pieces. Feeds calibration only. Not to be confused with the game score. |
| **Stale** | An answer whose `stateHash` is not the one the question carried. Discarded. |
| **Unreachable** (Blitz) | A late answer naming a placement the fallen piece can no longer reach, or one that no longer produces the board the brain was shown. Discarded, not a strike. |
| **Locked by gravity** (Blitz) | The piece locked before an answer arrived. The call is aborted. Not a strike. |
| **Late placement** (Blitz) | A placement accepted after one or more gravity steps. |
| **Unusable decision** | `invalid`, `stale`, `error` or `timeout`. Three in a row end the game as `adapter-failure` in either mode. |
| **Top-out** | Game over: a piece cannot spawn, or a locked piece has a cell above the board. |
| **Piece cap / tick cap** | Games also stop at 500 locked pieces or 10,000 ticks. |
| **Calibration** | Mean squared error of the optional ten-piece top-out forecasts that could be resolved. |
| **Unpriced call** | A call to a hosted brain that returned no numeric `costUsd` (aborted calls included). Shown beside the known cost, never folded into it. |
| **Recording** | The on-disk form of a game: seed plus an ordered event log, from which every board is rebuilt and checked by re-simulation. |
| **Official / quick** | An official run covers all thirty seeds at the frozen caps and can be published. A quick run covers three seeds and is provisional: it shows per-seed scores and no interval. |

## 2. Game rules

The engine is `lib/tetris-bench/engine.ts`; its fixtures in `scripts/tetris-bench/engine.test.ts` are the executable reference. `RULESET = 'tetris-bench@3'`.

### 2.1 Board and coordinates

Plain language: the board is ten columns wide and twenty rows tall. Rows are numbered from the top. A piece is described by where its bounding box sits, which is why `x` can be negative.

| Convention | Rule |
|---|---|
| Grid | `grid[row][col]`, 20 rows × 10 columns. Row 0 is the top visible row, row 19 the floor. Column 0 is the left wall. A cell is `null` (empty) or a piece letter `I O T S Z J L`. Over the wire to hosted models a row is rendered as ten `#`/`.` characters. |
| Piece box | Every rotation of a piece is drawn inside a fixed box: 4×4 for `I` and `O`, 3×3 for the others. Cell offsets `[dx, dy]` are measured from the box's top-left corner, `dy` downwards. |
| `x` | The board column of the box's **left edge**, not of the leftmost filled cell. A cell lands on board column `x + dx`. Negative `x` and `x > 7` are therefore normal. |
| `y` | The board row of the box's **top edge**. The engine allows `y ≥ −4`; cells with `y + dy < 0` sit above the visible board. |
| `rotation` | `0 1 2 3` = that many quarter-turns **clockwise** from spawn orientation (SRS states 0, R, 2, L). `O` looks the same in all four. |
| Spawn | `x = 3`, `y = −1`, `rotation = 0`. The `I` occupies row 0 columns 3 to 6. `O` occupies rows −1..0 columns 4 and 5. `T S Z J L` occupy rows −1..0 columns 3 to 5 with their top row above the board. This is one to two rows lower than the Guideline, so effective headroom is about two rows less. |
| Legal `x` ranges | `r = 0` or `2`: `I` 0..6, `O` −1..7, others 0..7. `r = 1`: `I` −2..7, others −1..7. `r = 3`: `I` −1..8, others 0..8. (Subject to the board being clear, see 2.4. The engine reaches all of these, but the candidate list never contains `r = 2` or `r = 3` for `I`, `S`, `Z`, nor `r ≥ 1` for `O`, because those are twins of listed placements, see 4.2.) |

### 2.2 Pieces and rotation

Cell offsets `[dx, dy]` per piece and rotation (box coordinates, `dy` downwards). These match the SRS pictures.

| Piece | Box | r = 0 | r = 1 | r = 2 | r = 3 |
|---|---|---|---|---|---|
| I | 4×4 | `[0,1] [1,1] [2,1] [3,1]` (row 1) | `[2,0] [2,1] [2,2] [2,3]` (column 2) | `[0,2] [1,2] [2,2] [3,2]` (row 2) | `[1,0] [1,1] [1,2] [1,3]` (column 1) |
| O | 4×4 | `[1,0] [2,0] [1,1] [2,1]` | same | same | same |
| T | 3×3 | `[1,0] [0,1] [1,1] [2,1]` nub up | `[1,0] [1,1] [1,2] [2,1]` nub right | `[0,1] [1,1] [2,1] [1,2]` nub down | `[1,0] [0,1] [1,1] [1,2]` nub left |
| S | 3×3 | `[1,0] [2,0] [0,1] [1,1]` | `[1,0] [1,1] [2,1] [2,2]` | `[1,1] [2,1] [0,2] [1,2]` | `[0,0] [0,1] [1,1] [1,2]` |
| Z | 3×3 | `[0,0] [1,0] [1,1] [2,1]` | `[2,0] [1,1] [2,1] [1,2]` | `[0,1] [1,1] [1,2] [2,2]` | `[1,0] [0,1] [1,1] [0,2]` |
| J | 3×3 | `[0,0] [0,1] [1,1] [2,1]` | `[1,0] [2,0] [1,1] [1,2]` | `[0,1] [1,1] [2,1] [2,2]` | `[1,0] [1,1] [0,2] [1,2]` |
| L | 3×3 | `[2,0] [0,1] [1,1] [2,1]` | `[1,0] [1,1] [1,2] [2,2]` | `[0,1] [1,1] [2,1] [0,2]` | `[0,0] [1,0] [1,1] [1,2]` |

Rotation uses the SRS kick tables (one table for `J L S T Z`, one for `I`, none for `O`). Each rotation tries the five offsets of the table in order and takes the first that fits; if none fits the rotation is impossible. The index of the successful offset is the **kick** (0 = no kick, 4 = the fifth and last offset).

Note for adapters that want to recompute placements: for `I`, `S` and `Z`, rotation 2 is rotation 0 one row lower inside the box and rotation 3 is rotation 1 one column to the left, so every rotation-2 and rotation-3 placement locks the same shape as a rotation-0 or rotation-1 twin. The harness collapses such twins (see 4.2): after collapse only rotations 0 and 1 are listed for `I`, `S` and `Z`, and only rotation 0 for `O`. Only the listed representative is accepted; naming the twin is `invalid`.

### 2.3 Spawn, hold, preview and the seven-bag

- **Preview.** Five upcoming pieces are visible (`next`). The generator is a seven-bag: each bag holds one of each piece, shuffled by an unbiased Fisher-Yates over a xorshift32 stream seeded from the game seed. The bag and generator state are hidden; adapters see only the five previewed pieces.
- **Hold.** One hold per locked piece. Holding swaps the active piece into the hold slot; the previously held piece (or, when the slot is empty, the next previewed piece, with the preview refilled) spawns in its place at the spawn position in rotation 0. `canHold` is false from a hold until the next lock. A hold consumes a tick but not a piece. If the swapped-in piece cannot spawn, the game tops out.
- **Spawn.** After every lock the next piece spawns at `x = 3, y = −1, rotation 0`. If it does not fit, the game is over (top-out).

### 2.4 Reachability

Plain language: the brain does not steer the piece. It names a column and a rotation; the engine finds a way to get there at the piece's current height, then drops it straight down.

- From the active piece's current `(x, y, rotation)` the engine runs a breadth-first search over four moves: **left, right, rotate clockwise, rotate anticlockwise** (with kicks). There is no downward move, so the search happens entirely at (or, after kicks, near) the current height. Cavities below an overhang cannot be entered.
- The first path that reaches each distinct `(x, rotation)` in BFS order is the **canonical path**. Its last move and kick are remembered for T-spin scoring.
- A placement is then applied by moving the piece along the canonical path and hard-dropping it until it rests. The drop distance in rows is `dropDistance`.
- In IQ the piece is always at spawn height when asked. In Blitz the piece may already have fallen several rows; reachability is computed from where it is now, so options shrink as it falls.

### 2.5 Gravity, locking and caps

- Level `L = 1 + floor(lines / 10)`.
- Gravity interval in milliseconds: `max(16, round(1000 × 0.8^(L − 1)))`. Per level: 1000, 800, 640, 512, 410, 328, 262, 210, 168, 134, 107, 86, 69, 55, 44, 35, 28, 23, 18, 16 (levels 1 to 20, then 16 ms).
- A gravity step moves the piece down one row. If it cannot move it locks where it is. There is no lock delay and no soft-drop scoring.
- A game ends at **top-out** (spawn collision, or a locked piece with any cell above row 0), at the **piece cap** (500 locked pieces, outcome `piece-cap`), at the **tick cap** (10,000 ticks, outcome `tick-cap`) or on **adapter failure** (three consecutive unusable decisions, outcome `adapter-failure`).
- **Lock-out.** When a piece locks with a cell above row 0, its visible cells (rows ≥ 0) are written to the board, `lastClear` is `{ lines: 0, spin: 'none', points: 0 }`, no line is cleared, `pieces` is not incremented, nothing spawns, and the game is over. Replays therefore show the fatal piece.

### 2.6 Scoring

All clear values are multiplied by the level **before** the clear is counted (the level used is the one in force when the piece locks).

| Event | Points |
|---|---|
| Hard drop | 2 per row dropped (`dropPoints`) |
| 1 / 2 / 3 / 4 lines | 100 / 300 / 500 / 800 × level |
| T-spin, 0 / 1 / 2 / 3 lines | 400 / 800 / 1,200 / 1,600 × level |
| Mini T-spin, 0 / 1 lines | 100 / 200 × level |
| Mini T-spin, 2 lines | promoted to a full T-spin double: 1,200 × level |
| Back-to-back | × 1.5 on the base clear value when a difficult clear (four lines or any spin that clears at least one line) follows another difficult clear with no ordinary clear between them. A placement that clears nothing preserves back-to-back status. |
| Combo | `50 × combo × level` on every clear; `combo` starts at −1 and becomes 0 on the first clear of a chain, so the first clear adds nothing and the second adds 50 × level. Any non-clearing placement resets it to −1. |
| Perfect clear | 800 / 1,200 / 1,800 / 2,000 × level for 1 / 2 / 3 / 4 lines; a back-to-back four-line perfect clear adds 3,200 × level instead of 2,000. |

**T-spin rules (v3).** A `T` counts as a spin only when both hold: the canonical path's last move was a rotation, **and** the hard-drop distance is zero (the piece is already resting where it was rotated). Then the three-corner test applies at the landing position: of the four corners of the 3×3 box, at least three must be occupied, where walls and the floor count as occupied and cells above the board count as empty. It is a **full** spin if both front corners (the two beside the nub) are occupied or the rotation used the fifth kick; otherwise a **mini**. Because the harness never soft-drops, a spin is only possible when the piece is already resting when it is rotated into place: in IQ that means the stack has reached the spawn rows; in Blitz it can happen on a late answer to a piece that has fallen to rest. In v2 the drop distance was ignored and spins were credited on hard drops from spawn; those points are gone.

`scoreDelta` of a candidate is `dropPoints + clearPoints`, where `clearPoints` is everything except the hard-drop points.

## 3. One tick

Plain language: each tick the harness builds the question, asks the brain once, and acts on whatever comes back first: an answer, an error, a timeout, or (in Blitz) gravity.

1. Build `AgentInput` from the current state: every legal placement is simulated one step ahead, twins are collapsed, the list is shuffled by a generator seeded from the state hash, and ids `p0…pN` are assigned in the shuffled order. The time this takes is `preparationMs` and is excluded from latency.
2. Call `brain.decide(structuredClone(input), { signal, budgetMs })` exactly once. One call is in flight per game at any time.
3. Wait for the first of: the call resolving (`answer`), the call rejecting (`error`), the IQ timeout (`timeout`), or a due gravity step (Blitz only). The outcome is whichever wins the race, never a flag.
4. Validate an answer against **the question's** hash and legal list (see 4.3). Apply it: hold, placement, or nothing.
5. Record a `Decision` (status, latency, budget, gravity steps, piece height at question and at decision, normalised answer, cost, retries, provider metadata, reason) and a `ReplayFrame` with the post-decision state. Set `tick = tick + 1`.
6. Update the strike counter: `invalid`, `stale`, `error` and `timeout` increment `consecutiveUnusable`; any accepted action resets it; `unreachable` and `locked-by-gravity` leave it unchanged. At three the game ends as `adapter-failure`.

| | IQ | Blitz |
|---|---|---|
| Gravity | Paused. The piece is at spawn height for every question. | Running from the start of the game. `gravityAt` is the next due step. |
| Budget passed to the brain | `IQ_TIMEOUT_MS = 20,000` (`budgetMs: 20000`) | `budgetMs: null`. There is no fixed cap. |
| Deadline | The timeout. On expiry the call is aborted via `signal`, the harness waits up to `SETTLE_GRACE_MS = 250` for it to settle (a cost reported by a call that settles in that window is still counted), then records `timeout`. A synchronous brain that blocks past the timeout is counted as completed but its answer is not used. | The piece locking. Each due gravity step is applied while the call is in flight (`gravitySteps++`). If the piece locks or the game ends, the call is aborted and the tick is `locked-by-gravity`. Otherwise the harness keeps waiting for the same call. |
| Late answer | Not possible: nothing changes while waiting. | Due gravity steps are applied before the answer is judged (a synchronous brain cannot pre-empt timers), so an answer that arrives after the piece has locked is `locked-by-gravity` even though it completed. Otherwise it is validated against the question's hash, so it is not stale. A hold is applied as normal. A placement must still be reachable from the piece's **current** position **and** `applyPlacement` must produce exactly the candidate grid the brain was shown; otherwise `unreachable`. Accepted after ≥ 1 gravity step → `placement-late`. Drop points are earned from the current height, so a late placement scores fewer than the `scoreDelta` shown. |
| After an accepted action | n/a | The new piece gets a full gravity interval: `gravityAt = now + interval(level)`. |
| Strikes | invalid / stale / error / timeout | invalid / stale / error (there are no timeouts) |
| Ticks vs pieces | One tick per piece, plus one per hold and per unusable decision. | Same, plus one per `unreachable` answer and one per piece that locks under gravity before an answer arrives; gravity steps never consume ticks. |

Blitz is therefore a real-time game. A brain whose latency is well under the gravity interval plays exactly its IQ game; as the level rises the interval shrinks (2.5) and a slow brain first loses drop points, then options, then whole pieces. Wall-clock results depend on hardware, provider load and concurrency; all three are recorded in provenance (8.3).

## 4. Agent contract

Types are in `lib/tetris-bench/contract.ts`. Everything the brain sees is public; the hidden bag and generator are never disclosed; there is no conversation history and no simulation handle. Local brains may run the engine on the public input themselves (the two-ply search brain does); hosted brains only see it rendered as text.

### 4.1 `AgentInput`

```jsonc
{
  "ruleset": "tetris-bench@3",
  "mode": "IQ",                       // "IQ" | "Blitz"
  "tick": 14,                         // number of questions asked so far this game
  "stateHash": "7e417cf6",            // copy this back verbatim; never compute it
  "grid": [ /* 20 rows × 10 cells, null or "I"|"O"|"T"|"S"|"Z"|"J"|"L" */ ],
  "active": { "type": "T", "x": 3, "y": -1, "rotation": 0 },   // where the piece is now (2.1)
  "hold": null,                       // piece letter or null
  "canHold": true,                    // false from a hold until the next lock
  "next": ["Z", "O", "J", "I", "L"],  // five previewed pieces
  "level": 1, "score": 676, "lines": 2, "pieces": 14,
  "combo": -1, "backToBack": false,   // combo starts at -1
  "features": { /* BoardFeatures of the current grid, see below */ },
  "legal": [ { "x": 3, "rotation": 0 }, { "x": 8, "rotation": 3 } /* … */ ],   // legal[i] === candidates[i].placement
  "candidates": [ /* CandidateOutcome[], same order as legal */ ]
}
```

| Field | Type | Notes |
|---|---|---|
| `ruleset` | string | Always `tetris-bench@3`. |
| `mode` | `'IQ' \| 'Blitz'` | |
| `tick` | integer | Ticks completed before this question. |
| `stateHash` | 8 hex chars | 32-bit FNV-1a over the JSON of `[ruleset, board, [active.type, active.x, active.y, active.rotation], hold, next, level, score, tick, holdUsed, over, lines, pieces, combo, backToBack]`. Mode is not part of it. Adapters never compute it; they copy it. |
| `grid` | `(Piece \| null)[20][10]` | Row 0 top. |
| `active` | `{ type, x, y, rotation }` | In IQ always the spawn position. In Blitz `y` may be lower. |
| `hold`, `canHold` | | See 2.3. |
| `next` | `Piece[5]` | |
| `level`, `score`, `lines`, `pieces`, `combo`, `backToBack` | numbers / boolean | Current values. |
| `features` | `BoardFeatures` | Of the current grid. |
| `legal` | `Placement[]` | The **only** placements an answer may name. |
| `candidates` | `CandidateOutcome[]` | One per legal placement, same order. |

`BoardFeatures` (`lib/tetris-bench/features.ts`, shared by the builtin heuristics and the hosted-model rendering):

| Field | Definition |
|---|---|
| `heights[10]` | Per column, `20 − (row of the first filled cell)`; 0 for an empty column. |
| `maxHeight` | `max(heights)` |
| `aggregateHeight` | `Σ heights` |
| `holes` | Empty cells with at least one filled cell above them in the same column. |
| `bumpiness` | `Σ |heights[x] − heights[x+1]|` over the nine adjacent pairs. |
| `wells` | `Σ over columns of max(0, min(leftHeight, rightHeight) − heights[x])`, with the walls counted as height 20. |
| `rowTransitions` | Per row, the number of changes between filled and empty walking left to right, with both walls counted as filled; summed over rows. |
| `colTransitions` | Per column, the number of changes walking top to bottom, with the space above the board counted as empty and the floor as filled; summed over columns. |

`CandidateOutcome`:

```jsonc
{
  "id": "p14",                                  // opaque, reassigned every tick after the shuffle
  "placement": { "x": 3, "rotation": 0 },       // == legal[i]
  "grid": [ /* board after the drop and after clears; same encoding as input.grid */ ],
  "linesCleared": 0,
  "scoreDelta": 30,                             // dropPoints + clearPoints
  "dropPoints": 30,                             // 2 × rows the piece falls from its current position
  "clearPoints": 0,                             // everything else: line, spin, back-to-back, combo, perfect clear
  "topOut": false,                              // this placement ends the game
  "features": { /* BoardFeatures of grid */ }
}
```

### 4.2 Candidates

- Candidates come from `legalPlacements` (2.4) and are each simulated with `applyPlacement`.
- **Twins are collapsed.** Two placements whose `[grid, linesCleared, topOut]` are identical are one candidate; the one with the higher `scoreDelta` is kept, and on a tie the lower rotation. This removes the `I`/`S`/`Z` rotation 2 and rotation 3 twins of rotations 0 and 1 (2.2) and the four identical `O` rotations, so those pieces only ever list rotations 0 and 1 (`O`: rotation 0). Only the surviving representative is legal.
- The list is shuffled by a xorshift32 generator seeded from the state hash (so it is reproducible from the public input but the spawn column is not always first), then ids `p0…pN` are assigned in that order. Ids carry no information and change every tick.
- `legal[i]` is exactly `candidates[i].placement`. The two arrays are redundant by design so that an adapter can work with either.
- Typical list sizes: 9 (`O`) to about 34; `I`, `S` and `Z` have fewer after twin collapse.
- **Top-out candidates.** If the piece would lock with a cell above row 0, `topOut` is true and `grid` shows the visible cells written (2.5). If the drop itself is fine but the next piece could not spawn, `topOut` is also true and `grid` is the board after the drop and clears.

### 4.3 `AgentAnswer`

```jsonc
{
  "stateHash": "7e417cf6",                                  // required: the question's hash
  "choice": [ { "x": 3, "rotation": 0, "p": 1 } ],          // required: distribution over listed placements
  "noul": { "hold": false },                                // optional: boolean, or a number in [0,1]; hold iff > 0.5
  "score": { "risk": 0.1 },                                 // optional: P(top-out within the next ten pieces)
  "costUsd": 0.00019,                                       // optional: this call's provider cost
  "providerProbabilityMass": 1.0,                           // optional, adapter-internal (Jev): raw mass before renormalisation
  "meta": { "promptTokens": 1290, "completionTokens": 9, "reasoningTokens": 0, "finishReason": "stop", "retries": 0, "raw": "…" }   // optional
}
```

`validateAnswer(value, hash, legal, canHold)` runs in this order and returns `ok`, `invalid` (with a reason) or `stale`:

1. `value` must be an object with a string `stateHash`, else **invalid**.
2. `stateHash !== hash` → **stale**. (In Blitz, `hash` is the hash of the question, not of the current state.)
3. `choice` must be a non-empty array. Each entry must have integer `x`, integer `rotation`, finite `p` in `[0, 1]`, must appear in `legal`, and must not repeat an `(x, rotation)` already listed. Σ`p` must be within 0.001 of 1. Any failure → **invalid**. `choice` must be non-empty even when holding.
4. Optional fields are checked **independently** and, when malformed, **dropped, not fatal**: `noul.hold` must be a boolean or a finite number in `[0, 1]`, `score.risk` a finite number in `[0, 1]`, `costUsd` a finite number ≥ 0, `providerProbabilityMass` a finite number, `meta` an object. A dropped field is named in `ignored`, and the decision's `reason` records it. Inside `meta`, only finite non-negative `promptTokens`, `completionTokens`, `reasoningTokens` and `retries` and string `finishReason` and `raw` are kept; malformed keys inside `meta` are omitted without being reported. The returned `answer` is a normalised copy containing only known fields (extra keys are discarded and never stored).
5. Hold is requested when `noul.hold` is `true` or `> 0.5`. If `canHold` is false the hold is ignored (`'noul'` is listed in `ignored`) and the choice is applied instead.
6. The played placement is the argmax of `p`, ties broken by ascending `x`, then ascending `rotation`.

### 4.4 Worked example

Source: a real IQ position from a v2 recording (Jev, `seed-01`, the question at tick 14), rebuilt with the v3 `inputFor` so the hash, the ids, the points split and the features are what v3 produces for this board. Under v2 the same position hashed to `3eb6c51a` and the ids fell differently, which is exactly why an adapter must copy what it receives. Three of the 34 candidates are shown. `grid` rows 0 to 14 are empty and omitted.

**`AgentInput` (excerpt)**

```jsonc
{
  "ruleset": "tetris-bench@3", "mode": "IQ", "tick": 14, "stateHash": "7e417cf6",
  "active": { "type": "T", "x": 3, "y": -1, "rotation": 0 },       // spawn; the nub is above row 0
  "hold": null, "canHold": true,
  "next": ["Z", "O", "J", "I", "L"],
  "level": 1, "score": 676, "lines": 2, "pieces": 14, "combo": -1, "backToBack": false,
  "grid": [
    /* rows 0-14: all null */
    ["I","J",null,null,null,null,"S","S",null,null],       // row 15   ##....##..
    ["I","J","J","J","Z","S","S",null,"L",null],           // row 16   #######.#.
    ["I","O","O","Z","Z","T","L","L","L",null],            // row 17   #########.
    ["L",null,"S","S","O","O",null,"T","Z","Z"],           // row 18   #.####.###
    [null,"S","S",null,"O","O","T","T","T",null]           // row 19   .##.#####.
  ],
  "features": { "heights": [5,5,4,4,4,4,5,5,4,2], "maxHeight": 5, "aggregateHeight": 42,
                "holes": 6, "bumpiness": 5, "wells": 2, "rowTransitions": 50, "colTransitions": 22 },
  "legal": [ { "x": 3, "rotation": 0 }, { "x": 8, "rotation": 3 }, { "x": 2, "rotation": 0 } /* … */ ],
  "candidates": [
    { "id": "p14", "placement": { "x": 3, "rotation": 0 }, "linesCleared": 0,
      "scoreDelta": 30, "dropPoints": 30, "clearPoints": 0, "topOut": false,
      "grid": [ /* rows 0-13 empty */ "....#.....", "##.#####..", "#######.#.", "#########.", "#.####.###", ".##.#####." ],
      "features": { "heights": [5,5,4,5,6,5,5,5,4,2], "maxHeight": 6, "aggregateHeight": 46,
                    "holes": 6, "bumpiness": 7, "wells": 3, "rowTransitions": 52, "colTransitions": 22 } },
    { "id": "p28", "placement": { "x": 8, "rotation": 3 }, "linesCleared": 0,
      "scoreDelta": 30, "dropPoints": 30, "clearPoints": 0, "topOut": false,
      "grid": [ /* … */ ".........#", "##....####", "#######.##", "#########.", "#.####.###", ".##.#####." ],
      "features": { "heights": [5,5,4,4,4,4,5,5,5,6], "maxHeight": 6, "aggregateHeight": 47,
                    "holes": 7, "bumpiness": 3, "wells": 0, "rowTransitions": 46, "colTransitions": 24 } },
    { "id": "p23", "placement": { "x": 2, "rotation": 0 }, "linesCleared": 0,
      "scoreDelta": 30, "dropPoints": 30, "clearPoints": 0, "topOut": false,
      "grid": [ /* … */ "...#......", "#####.##..", "#######.#.", "#########.", "#.####.###", ".##.#####." ],
      "features": { "heights": [5,5,5,6,5,4,5,5,4,2], "maxHeight": 6, "aggregateHeight": 46,
                    "holes": 6, "bumpiness": 7, "wells": 3, "rowTransitions": 52, "colTransitions": 22 } }
    /* … the rest; ids are opaque and re-shuffled every tick */
  ]
}
```

Candidate grids are shown in the `#`/`.` form the hosted-model rendering uses. In-process adapters receive the same `(Piece | null)[][]` arrays as `grid`. `dropPoints` 30 = 15 rows × 2. No candidate here clears a line, so `clearPoints` is 0 and `scoreDelta` equals `dropPoints` for all of them, which is the number that made v2's hosted models "drop into the deepest column". A brain reading the features would prefer `p14` or `p23` (no new hole) over `p28` (one new hole, `holes` 7).

**`AgentAnswer` as a distribution (Jev via the System One adapter, 34 entries in the original, abbreviated)**

```jsonc
{
  "stateHash": "7e417cf6",
  "providerProbabilityMass": 1.0000000000000002,
  "choice": [
    { "x": 3, "rotation": 0, "p": 0.27 },      // p14, the argmax, so this is played
    { "x": 8, "rotation": 3, "p": 0.24 },      // p28
    { "x": 2, "rotation": 0, "p": 0.09 }       // p23
    /* … every listed placement, summing to 1 within 0.001 */
  ],
  "noul": { "hold": 0.3 },                     // ≤ 0.5 → do not hold
  "costUsd": 0.00019068
}
```

**Minimal equivalent answer** (what a new adapter may return; identical effect):

```json
{ "stateHash": "7e417cf6", "choice": [ { "x": 3, "rotation": 0, "p": 1 } ] }
```

**What the LLM adapter actually sends back** is built from the model's `{"candidate":"<id>","hold":false,"risk":0.1}` reply: `choice: [{ x: 3, rotation: 0, p: 1 }]`, `noul: { hold: false }`, `score: { risk: 0.1 }`, plus `costUsd` and `meta` from the provider's usage block.

**Effect.** `validateAnswer` → `ok`, placement `(3, 0)`. The T hard-drops 15 rows and locks with cells at columns 3 to 5 of row 15 and column 4 of row 14. Nothing clears. Score 676 → 706, `pieces` 14 → 15, the frame's status is `placement`, and the next question is tick 15 with a new hash and a new candidate order.

**Answers that would fail on this same input**

| Answer | Result | Why |
|---|---|---|
| `{ "stateHash": "7e417cf6", "choice": [ { "x": 3, "rotation": 0, "p": 0.6 }, { "x": 8, "rotation": 3, "p": 0.6 } ] }` | invalid | Σp = 1.2 |
| `{ "stateHash": "7e417cf6", "choice": [], "noul": { "hold": true } }` | invalid | `choice` must be non-empty even when holding |
| `{ "stateHash": "00000000", "choice": [ { "x": 3, "rotation": 0, "p": 1 } ] }` | stale | hash mismatch |
| `{ "stateHash": "7e417cf6", "choice": [ { "x": 3, "rotation": 0, "p": 1 } ], "noul": { "hold": "yes" } }` | **ok**, `ignored: ["noul"]` | malformed optional field is dropped; the placement is played (v2 rejected the whole answer) |
| (same board, an `O` active) `{ "x": 3, "rotation": 1 }` | invalid | only the surviving representative rotation is listed; unlisted placements are illegal |
| (Blitz, answered after the piece fell 12 rows) `{ "x": 8, "rotation": 3 }` when that column is no longer reachable | unreachable | not a strike; the piece keeps falling and the next tick asks again |

### 4.5 Outcomes of an answer

| Status | When | Board effect | Counter | Strike? |
|---|---|---|---|---|
| `placement` | Valid choice, applied with no gravity step since the question | piece locks | `accepted` | resets |
| `placement-late` | Blitz: valid choice applied after ≥ 1 gravity step | piece locks from its current height | `accepted`, `lateAccepted` | resets |
| `hold` | Valid hold with `canHold` | swap; new piece at spawn | `accepted`, `holds` | resets |
| `unreachable` | Blitz: placement no longer reachable, or would not produce the disclosed grid | none | `unreachable` | no |
| `invalid` | Fails 4.3 | none | `invalid` | yes |
| `stale` | Wrong hash | none | `stale` | yes |
| `error` | The call rejected / threw (after the adapter's own retry) | none | `errors` | yes |
| `timeout` | IQ: no settlement within 20 s | none | `timedOutCalls` | yes |
| `locked-by-gravity` | Blitz: the piece locked before the answer | the lock already happened | `lockedByGravity` | no |

## 5. Writing an adapter

### 5.1 The `Brain` interface (verbatim from `contract.ts`)

```ts
export interface Brain {
  slug: string;
  name: string;
  description: string;
  kind: 'baseline' | 'heuristic' | 'search' | 'llm' | 'classifier';
  provider?: string;
  model?: string;
  via?: string;
  adapterVersion: string;
  decide(input: AgentInput, ctx: { signal: AbortSignal; budgetMs: number | null }): Promise<unknown> | unknown;
}
```

`decide` receives a `structuredClone` of the input (mutating it changes nothing) and returns anything; the harness validates, it does not trust. `budgetMs` is 20,000 in IQ and `null` in Blitz. `signal` fires when the harness gives up on the call (IQ timeout, or the piece locking in Blitz); pass it to your transport so that aborted calls stop promptly and are not billed longer than necessary. A call that keeps running after abort blocks nothing (the harness has moved on) but still counts as unpriced if it never reported a cost.

### 5.2 Sync vs async, cancellation, budgets

- Local brains may return synchronously. Keep them fast: in Blitz the deadline is the gravity interval, 1,000 ms at level 1 and 16 ms at level 20.
- Hosted brains must be async, must pass `signal` through, and should retry once with a short backoff on HTTP 429 / 5xx / network errors when the remaining budget allows; the second failure should throw (the harness records `error`). Record the retry count in `meta.retries`.
- Never hold state between calls. There is no conversation; every question is complete on its own.

### 5.3 Cost and metadata

Return `costUsd` for every call that has a provider cost (OpenRouter: request `usage: { include: true }` and read `usage.cost`). Calls without a numeric `costUsd` are counted as **unpriced** and shown next to the known cost. Local brains report nothing. Put token counts, `finishReason` and `retries` in `meta`; the harness copies `meta` and `retries` into the decision so that the replay can show them.

### 5.4 Registration

- **Local brain:** add it to `builtInBrains` in `lib/tetris-bench/adapters.ts`, using `boardFeatures` from `features.ts` for any evaluation so that it reads the same numbers the hosted models are shown. Give it a stable `slug`, a `kind`, and an `adapterVersion`.
- **Hosted model:** add a `HostedModel` entry to the registry in `lib/tetris-bench/models.ts` (`slug`, `name`, `provider`, `model`, `kind`, per-model request settings: `temperature`, `reasoning`, `maxTokens`, `jsonSchema`, `pricing`). The shared adapter `openRouterBrain(model)` renders the evidence, sends the request with a strict JSON schema whose `candidate` enum is the tick's ids (or `json_object` where the model rejects schemas), extracts the first `{…}` object from the reply, and maps it to an `AgentAnswer`. Any registry slug can be named with `--brains`.
- The hosted rendering (`renderEvidence`) is the same for every model: the goal rubric in the system prompt, then the header (active piece, next, hold slot, `canHold`, level, score, lines, pieces, combo, back-to-back), the occupied rows of the board in `#`/`.` with one empty row above, the current heights/holes/maxH, and one line per candidate with `x`, `rot`, `lines`, `clear=+N drop=+M`, `maxH`, `holes`, `bump`, `wells`, `topOut`, under a two-letter id derived from the state hash. It ends with `Reply with JSON only: {"candidate":"<ID>","hold":false,"risk":0.1}`. `hold` and `risk` are optional in the contract, but the strict JSON schema sent to chat models lists all three keys as required (OpenAI's strict mode demands it), so every schema-path answer carries a `hold` boolean and a `risk` number; only Jev and models on the `json_object` fallback can omit them.

### 5.5 Tests and the probe

```sh
node --test scripts/tetris-bench/*.test.ts        # unit tests; never touch the network
OPENROUTER_API_KEY=… node scripts/tetris-bench/probe.ts --brain=<slug>
```

Unit tests stub `fetch`; `adapters.test.ts` shows how. The probe is diagnostic only: it plays the two fixture positions (each has a unique two-line clear) and eight no-clear positions regenerated from greedy play on seeds 02 to 05, in both candidate orders, and reports whether the brain's pick adds a hole.

### 5.6 Pull-request checklist

- [ ] Implements `Brain` and returns a valid `AgentAnswer` for the fixture positions (a test proves it).
- [ ] Reads only `AgentInput`; no hidden state, no network for local brains, no side effects.
- [ ] Passes `signal` to every transport call; retries at most once.
- [ ] Reports `costUsd` and `meta` for hosted calls.
- [ ] Registered in `adapters.ts` (local) or `models.ts` (hosted) with `adapterVersion` set.
- [ ] `node --test scripts/tetris-bench/*.test.ts` green without credentials.
- [ ] Probe run pasted into the PR for hosted brains.
- [ ] No keys, request headers or provider error bodies in the diff or in test fixtures.

Adapter submissions are reviewed by hand: in-process adapters are trusted code, not sandboxed.

## 6. Rating

Plain language: every brain plays the same thirty seeds in IQ. Its headline number is its average score. The interval says how much that average would move with different seeds. Brains are ranked by the average; two neighbours are called a tie when the seed-by-seed difference between them could plausibly be zero.

Code: `lib/tetris-bench/rating.ts`, `summariseField(slugs, seeds, games)`.

- **Seeds.** `OFFICIAL_SEEDS = seed-01 … seed-30`; `QUICK_SEEDS` = the first three. IQ requires exactly one game per seed per brain (the runner refuses otherwise). Blitz is optional per brain but, if present, must cover every seed.
- **Score summary** per brain and mode: `mean`, `sd` over seeds, `meanLines`, the per-seed list (`seed`, `score`, `lines`, `pieces`, `outcome`), and `interval`.
- **Interval.** For `S ≥ 10` seeds a t-interval `mean ± t(0.975, S − 1) × sd / √S` (t = 2.045 at S = 30, 2.262 at S = 10; a small table covers 9 to 40 degrees of freedom and 1.96 is used beyond). `null` for `S < 10`: three-seed quick runs show their three scores and no interval, because no interval method reaches useful coverage there.
- **Head-to-head.** For each pair `(a, b)`: the paired difference `score_a − score_b` on every seed, its mean, and a 95% percentile interval from 2,000 seed-block bootstrap replicates (deterministic xorshift generator); `null` for `S < 10`. `wins / draws / losses` are the seeds where `a > b` / `a = b` / `a < b`.
- **Rank.** By IQ mean descending; ties by mean lines descending, then slug.
- **Ties.** Adjacent pairs in the rank order whose head-to-head interval includes 0 (only when intervals exist). The site shows them as a tie.
- **Elo-style rating (footnote only).** A penalised Bradley-Terry fit on IQ seed points (one point per pair per seed to the higher score, half each on equal scores; Gaussian prior precision 0.25 on log-strength; pair weight `1 / (n − 1)`), mapped to an Elo scale (`400 / ln 10` per log-strength unit, centred at 1,500), with a 2,000-replicate seed-block bootstrap interval. The interval is `null` when `S < 10` or when a brain's record is separated (0 or `(n − 1) × S` points), because the bootstrap collapses there. Caveats: it discards score magnitude, its scale depends on field size and seed count, it moves for everyone when a brain joins, and it is shown only in the brain page footnotes.
- **Blitz** is reported as its own score summary (mean score, lines, level reached, answered-in-time rate) and never enters the rank.
- **What the numbers are not.** Intervals cover seed variation only, not provider variation between runs, prompt choices or tuning on the public seeds. Nothing here is a general-intelligence claim; hosted models are largely measuring how well they read a rubric off numbers.

## 7. Measurements

Per game (`Metrics`), then aggregated per brain and mode in the index.

| Metric | Definition | Denominator / notes |
|---|---|---|
| `calls` | Questions asked (one per tick) | |
| `completedCalls` | Calls that resolved with a value or an error before the harness moved on. A synchronous brain that blocked past its deadline still counts (its answer is measured but cannot act); a call that only settled inside the grace window after a deadline does not | latency percentiles use exactly these calls, in the harness and in the index |
| `timedOutCalls` | IQ calls that did not settle within the timeout | |
| `errors` | Calls that rejected | after the adapter's own retry |
| `invalid`, `stale`, `unreachable`, `lockedByGravity` | Decisions with that status | |
| `accepted` | Answers the harness applied (placements, late placements, holds) | |
| `lateAccepted` | `placement-late` decisions | Blitz only |
| `holds` | `hold` decisions | |
| `p50Ms`, `p95Ms` | Nearest-rank percentiles of latency over completed calls, excluding preparation | `null` when there are none |
| `preparationP50Ms`, `preparationP95Ms` | Time to build the question | harness cost, not the brain's |
| `costUsd` | Sum of numeric `costUsd` over answers | never `null`; 0 for local brains |
| `unpricedCalls` | Hosted-brain calls without a numeric cost, aborted calls included | shown beside the cost |
| `calibrationError` | Mean squared error of `risk` forecasts that resolved: outcome 1 if the game topped out within ten locked pieces of the forecast, else 0; forecasts cut off by a cap are excluded | `null` when nothing resolved |
| `calibrationCount` | Number of resolved forecasts | |
| `retries` | Sum of `meta.retries` | |
| `maxLevel` | Highest level reached | |

Index-level: `costPer100Decisions` = known `costUsd` divided by the priced calls (`calls − unpricedCalls`), times 100 (`null` for local brains and when no call was priced), with `unpricedCalls` beside it. Unpriced calls are aborted or unparseable hosted calls that reported no cost; the runner's spend estimate prices them at the mean known cost per priced call. Latency and cost describe the recorded provider run on the recorded hardware; a rerun on another day is a different measurement.

## 8. Artifacts and provenance

### 8.1 Recording format (`tetris-bench-recording@1`)

Plain language: a recording stores what the brain did, not what the board looked like. Anyone can rebuild every board from the seed with the public engine, and the stored hash at every step proves the rebuild matches.

```ts
export const RECORDING_FORMAT = 'tetris-bench-recording@1';
export interface RecordedDecision {
  c: 0 | 1;            // called
  k: 0 | 1;            // completed
  l: number;           // latencyMs, 2 dp
  b: number | null;    // budgetMs
  yq: number; yd: number;   // active.y at question and at decision
  p: number;           // preparationMs, 2 dp
  a?: AgentAnswer;     // normalised answer (hosted answers keep the full choice distribution)
  u?: number;          // costUsd
  rt?: number;         // retries
  m?: AnswerMeta;
  why?: string;        // validation failure, unreachable detail, error message, or "ignored: …" for a dropped optional field
}
export interface RecordedEvent {
  t: number;           // tick after this event
  e: DecisionStatus;   // 'placement' | 'placement-late' | 'hold' | 'unreachable' | 'invalid' | 'stale' | 'error' | 'timeout' | 'locked-by-gravity'
  g: number;           // gravity steps applied before the action
  x?: number; r?: Rotation;   // the placement applied
  ms: number;          // elapsedMs, 2 dp
  sh: string;          // stateHash after this event
  d: RecordedDecision;
}
export interface Recording {
  format: 'tetris-bench-recording@1'; ruleset: string; id: string; startedAt: string;
  brain: string; seed: string; mode: Mode; score: number; lines: number; pieces: number; ticks: number;
  outcome: 'top-out' | 'piece-cap' | 'tick-cap' | 'adapter-failure'; metrics: Metrics;
  initialHash: string; events: RecordedEvent[];
}
```

Re-simulating one event: start from the previous state; apply `g` gravity steps (tick-preserving); apply the action for `e` (`placement` / `placement-late` → `applyPlacement`, which must change the state; `hold` → `applyHold`; every other status → nothing); set `tick = t`; assert `stateHash === sh`. `expandRecording` does this in the browser and throws `integrity: …` on the first mismatch; the replay viewer shows "integrity verified" or "integrity mismatch".

### 8.2 Digests and verification

`index.json` lists each run with `artifactSha256`, the SHA-256 of the recording file's bytes. `verifyRecording(bytes, summary, ruleset)` checks, in order: the digest; `format` and `ruleset`; deep equality of the summary (everything but the events and the digest); a full re-simulation; and that the counters recomputed from the events (`accepted`, `lateAccepted`, `holds`, `invalid`, `stale`, `errors`, `timedOutCalls`, `lockedByGravity`, `unreachable`) equal `metrics`. A recording that fails any step is not published and not merged.

### 8.3 Index and provenance

`public/tetris-bench/index.json` (`format: 'tetris-bench-index@3'`) holds `ruleset`, `generatedAt`, `official`, `seeds`, caps, `iqTimeoutMs`, the per-brain standings (`rank`, IQ and Blitz summaries, Elo footnote, per-mode metrics, cost per 100 decisions, unpriced calls), the head-to-head table, ties, the run summaries, and `provenance`: hardware (`cpu`, `cores`), runtime, platform, `sourceCommit`, `sourceTree` (`git rev-parse HEAD:lib/tetris-bench`, which survives squash merges), `sourceDirty` (scoped to `lib/tetris-bench`, `scripts/tetris-bench` and this document), `protocolHashes` (SHA-256 of `engine`, `contract`, `harness`, `features`, `recording`, `rating`), `adapterHashes`, `iqConcurrency`, `blitzConcurrency`, and a flat list of `batches`. The runner re-hashes the sources before writing the index and refuses to publish if they changed during the run.

### 8.4 Merge rules

`--merge` loads the previous index and requires equal `protocolHashes`, ruleset, caps, seeds and `official`. Adapter hashes are recorded, not enforced, so a new brain can join without re-running the field. Retained recordings are verified by re-simulation before anything runs. A re-run brain replaces its games in the modes listed in `--modes`; its games in the other mode are kept, so `--merge --brains jev --modes Blitz` adds Blitz to an existing Jev field without discarding its IQ games. After every index write (merge or not) any `v3-…` recording under `runs/` whose id is not in the new index is deleted and printed. `batches` stays a flat list.

### 8.5 What is never stored

Keys, request headers, provider error bodies, the hidden bag and generator state, and any answer field outside the contract (answers are stored as `validateAnswer`'s normalised copy).

## 9. Running

Node 24 runs the TypeScript directly; there are no package dependencies for the harness.

```sh
node --test scripts/tetris-bench/*.test.ts
node scripts/tetris-bench/run.ts --out /tmp/tetris-bench-quick   # quick: builtins, 3 seeds, both modes
node scripts/tetris-bench/run.ts --official                      # 30 seeds, frozen caps, into public/tetris-bench
OPENROUTER_API_KEY=… node scripts/tetris-bench/run.ts --official --brains jev,gpt-4o-mini --modes IQ --merge --max-spend-usd 5
```

```
node scripts/tetris-bench/run.ts [--official] [--brains a,b] [--modes IQ,Blitz] [--concurrency N]
  [--blitz-concurrency N] [--out dir] [--merge] [--max-pieces N] [--max-ticks N] [--batch-id id]
  [--max-spend-usd X] [--game slug,seed,mode] [--help]
```

| Flag | Meaning |
|---|---|
| `--official` | All 30 seeds at the frozen caps (500 pieces, 10,000 ticks); caps may not be overridden. Publishable. |
| (default) | Quick run: 3 seeds. Provisional; the site shows per-seed scores and no intervals. |
| `--brains` | Comma-separated slugs: any builtin or any `models.ts` registry slug. Hosted slugs need `OPENROUTER_API_KEY`; the runner makes one real pre-flight call per hosted brain on a fixture position and aborts with a clear message if it fails. |
| `--modes` | `IQ`, `Blitz` or both. Hosted brains are usually run in IQ only. |
| `--concurrency N` | 1..16. Above 1, games run in isolated child processes (the `--game` worker path). Allowed with `--official`; recorded as `iqConcurrency`. `--blitz-concurrency` defaults to it. |
| `--max-pieces`, `--max-ticks` | Shorter exhibitions; may not exceed the engine constants and may not be combined with `--official`. |
| `--merge` | Add to or replace brains in the existing index (8.4). |
| `--max-spend-usd X` | Per hosted brain: when known cost plus the unpriced-call estimate exceeds it, that brain is stopped and dropped from the batch. |
| `--batch-id` | Override the timestamp batch id (used by workers). |
| `--game slug,seed,mode` | Internal: play one game and write its recording. |
| `--out dir` | Output directory; default `public/tetris-bench`. |
| `--help` | Print the usage text and exit. |

Repeated flags are an error. Recordings are written as `runs/<id>.json` with `id = v3-<batch>-<slug>-<seed>-<mode>`. In official mode a game that contains `error` or `timeout` statuses **and** ends as `adapter-failure` is retried once from scratch; if it fails again the brain is dropped from the batch with a warning, its recordings from this batch are moved to `partial/` under the output directory (kept for diagnosis, never listed, never deployed, ignored by git), and the index is still written for the rest. A dropped brain that was already in the index under `--merge` keeps its previous standing and games; only a brain new to the field disappears. The runner never deletes a recording: files that no index lists any more are shelved under `partial/` the same way. A batch that plays Blitz only is refused up front for any brain without a full set of retained IQ games. An `adapter-failure` with no `error` or `timeout` in it (three `invalid` or `stale` answers) is the brain's own doing, so it is not retried: the brain is dropped at once. A brain is dropped the same way when `--max-spend-usd` is exceeded; the cap is checked between games, so one game may overrun it. A game with a recovered error (`errors > 0` but no adapter failure) is publishable. The console prints one line per finished game (score, pieces, level, status counts) and the running spend per hosted brain. Worker failures report the exit code and stderr tail and kill the sibling workers.

Keep credentials in the environment, outside git. Every run writes `index.json` and prunes recordings under `--out`, which defaults to `public/tetris-bench`; the runner refuses to replace an official index there with a quick run unless `--out` is given explicitly. The leaderboard shows whatever index is committed, and only official indices are committed. Browser demonstrations never touch the index.

## 10. Version history

See `docs/tetris-bench-changelog.md` for the full entries.

- **tetris-bench@3** (2026-09-20). Current. T-spin credit requires zero drop distance; candidate twins collapsed; lock-out records the fatal piece; tuple hashing of the active piece; Blitz deadline is the piece locking (no 100 ms cap, no idle ticks); IQ timeout 20 s with settle grace; outcome from the race, not a flag; `error`, `unreachable`, `placement-late` and `locked-by-gravity` statuses; the three-strike rule in both modes; optional answer fields dropped rather than fatal; boolean hold; hosted models see feature lines with `clear`/`drop` points split, two-letter ids and strict JSON schemas; risk asked; event-log recordings verified by re-simulation; mean score with t-intervals and paired head-to-head as the rating; Elo-style number demoted to a footnote.
- **tetris-bench@2** (2026-09-20). Withdrawn. IQ-only Bradley-Terry "CR" designed for 30 official seeds with a 200-replicate bootstrap, though the only published v2 index was a three-seed quick run; one-step outcomes disclosed to all brains; candidate shuffle; 100 ms Blitz cap. Its index is kept at `/tetris-bench/archive-v2.json`; its recording files were removed from the site and remain in git history at commit `9bc56f8`.
- **tetris-bench@1** (withdrawn 2026-09-20). Mixed IQ and Blitz into one match point, gave local adapters richer simulation access, used an order-dependent Elo update over five seeds. Its index is kept at `/tetris-bench/archive-v1.json`; its recording files remain in git history at commit `ffb8afd`.

No archived rating is comparable with a current one.
