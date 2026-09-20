# Tetris Bench changelog

Each entry is one protocol identifier. Anything that changes how a game is played, asked, clocked, capped, seeded or rated gets a new identifier and a fresh field. Ratings from different identifiers are never comparable. The rules for the current identifier are in `docs/tetris-bench-rules.md`.

## tetris-bench@3 (2026-09-20)

Current. Everything below came out of the phase-one audits of v2 (engine, harness, rating, prompt, pipeline, docs). The short version: v2 credited T-spins on hard drops, showed duplicate I/S/Z candidates, ended an IQ game on a single timeout, only asked slow brains every other Blitz tick, and capped Blitz at 100 ms so every hosted model scored exactly zero. Its prompt made every LLM pick the largest score delta, which is the deepest drop. v3 fixes the engine, makes Blitz a real-time game whose deadline is the falling piece, renders the same evidence to every hosted model, stores recordings as replayable event logs, and rates brains by mean score with honest intervals.

### Engine

- **T-spins.** Credit requires the canonical path's last move to be a rotation and the hard-drop distance to be zero. v2 ignored the drop distance, so a T rotated at spawn and dropped 18 rows scored a "full T-spin double" (1,200). Eight such phantom spins worth 3,500 points sat in the 18 published v2 IQ games and flipped the seed-02 order. The mini-to-full promotion for two-line minis is kept and now documented.
- **Candidate twins.** Placements with the same after-grid, lines cleared and top-out flag are collapsed to one candidate, keeping the higher score delta (lower rotation on a tie). v2 showed I, S and Z as 24 or 25 candidates for 17 distinct boards, the twins differing by 2 drop points.
- **Lock-out.** A piece that locks with a cell above row 0 now writes its visible cells to the board, sets `lastClear` to zero, does not count as a piece and does not spawn. v2 dropped the fatal piece from the replay and carried the previous `lastClear`.
- **State hash.** The active piece is hashed as a tuple `[type, x, y, rotation]` instead of an object, so key order cannot change the hash. The ruleset string in the hash is now `tetris-bench@3`.
- **Gravity cap.** `advanceGravity` no longer checks the tick cap, the harness owns caps. Nothing observable changed, it was dead code.
- Unchanged and audit-verified: board size, SRS cell tables and kicks, seven-bag, hold, five-piece preview, spawn at (3, -1), gravity formula, level formula, scoring constants, caps of 500 pieces and 10,000 ticks.

### Harness and contract

- **Blitz clock.** No 100 ms cap. One question per tick, the call lives until the piece locks, gravity keeps running during the call. A late answer is applied if the placement is still reachable from the piece's current position and produces the board the brain was shown (`placement-late`); otherwise `unreachable`. A piece that locks first is `locked-by-gravity` and the call is aborted. After an accepted action the new piece gets a full gravity interval. In v2 a brain slower than 100 ms scored zero in every Blitz game and was only called on every other tick because of a stale busy flag.
- **IQ timeout.** 20 s (was 10 s). On expiry the harness aborts, waits up to 250 ms for the call to settle, and records `timeout`. In v2 one hung call produced two instant follow-up misses and ended the game as `adapter-failure`.
- **Outcome from the race.** Whether a call completed is decided by which promise won (answer, error, timeout, gravity), not by a flag set in a `.then`. v2 could count an aborted call as completed with a 100 ms latency.
- **Statuses.** `placement`, `placement-late`, `hold`, `unreachable`, `invalid`, `stale`, `error`, `timeout`, `locked-by-gravity`. v2's `miss` mixed timeouts, idle ticks and zero-budget ticks; `error` was double counted as `invalid`.
- **Three strikes in both modes.** Three consecutive `invalid` / `stale` / `error` / `timeout` decisions end the game as `adapter-failure` in Blitz too. v2 let a broken Blitz brain burn the 10,000-tick cap in seconds.
- **Optional answer fields.** A malformed `noul`, `score`, `costUsd`, `providerProbabilityMass` or `meta` is dropped and listed in `ignored`; only `stateHash` and `choice` can invalidate an answer. `noul.hold` accepts a boolean. A hold requested while `canHold` is false is ignored and the choice is played. v2 rejected the whole answer, so a model replying `"hold":"false"` lost the tick and took a strike.
- **Candidate outcomes** carry `dropPoints`, `clearPoints` and `features`; the input carries `features` of the current board. `legal[i]` is `candidates[i].placement`, documented.
- **Normalised answers.** Recordings store `validateAnswer`'s copy, never the brain's own object. Decisions carry `gravitySteps`, `yAtQuestion`, `yAtDecision`, `retries`, `meta` and a `reason`.
- **Cost.** `costUsd` is a sum and never null; calls without a numeric cost are counted as `unpricedCalls`. v2 nulled the whole game's cost on any miss, so no hosted brain ever had a Blitz cost and one IQ timeout blanked IQ cost.
- `Brain.kind` is `baseline | heuristic | search | llm | classifier` with `provider`, `model`, `via` and `adapterVersion`. `decide` receives `budgetMs` (20,000 in IQ, null in Blitz).

### Hosted models

- **Evidence rendering.** One shared rendering for every hosted model: goal rubric, board once as ASCII (occupied rows plus one empty row), current heights and holes, and one line per candidate with `x`, `rot`, `lines`, `clear=+N drop=+M`, `maxH`, `holes`, `bump`, `wells`, `topOut`, under a two-letter id derived from the state hash. v2 sent a full 20 by 10 grid per candidate plus a single `scoreDelta` that included drop points. Measured over eight no-clear positions, every model and Jev picked the score-delta argmax 7 or 8 times out of 8, none picked the best move, and the tie-break followed the lowest ordinal id. The feature rendering halves prompt tokens and cost and is the only arm where models beat "deepest drop".
- **Structured output.** Strict `json_schema` with the tick's ids as the `candidate` enum (`json_object` only where a model rejects schemas), first-object extraction before parsing, `usage: { include: true }`, per-model `temperature` / `reasoning` / `max_tokens` from a registry. v2's single adapter returned 100% invalid for three reasoning-by-default models (empty content after 120 reasoning tokens) and for Claude Haiku (fenced JSON plus prose).
- **Retry.** One retry with 500 ms backoff on HTTP 429 / 5xx / network error when the budget allows, and the second failure throws.
- **Risk and hold** are asked of every hosted model (`risk` is defined in the system prompt as the probability of top-out within ten pieces, both optional). v2 mentioned risk in prose but not in the JSON template, so 0 of 506 measured replies carried it and calibration was never measured.
- **Jev.** The hold question is grounded (names the active piece, the slot and what would be placed instead). `risk` is asked as a score question. Same evidence text as the LLMs.
- **Registry.** `lib/tetris-bench/models.ts` lists Jev 1.13, GPT-4o mini, GPT-5.6 Luna, Gemini 3.5 Flash Lite, DeepSeek V4 Flash, Qwen 3.7 Flash and Claude Haiku 4.5 with their measured settings. Any registry slug works with `--brains`. GLM 5.3 Flash was tried and left out: its reasoning cannot be switched off and it spent a 2,000-token output budget without answering.
- **Probe.** Two fixture positions plus eight no-clear positions regenerated from greedy play on seeds 02 to 05, in both candidate orders, and asserts the pick adds no hole. v2's probe passed on a rendering that lost the game.

### Rating

- **Headline: mean IQ score** over the 30 official seeds, with a t-interval for 10 or more seeds and none below. v2's headline was "CR", a penalised Bradley-Terry rating on seed win points scaled to Elo. It discarded score magnitude (an 82-point seed win counted like a 4,600-point one), depended on field size and seed count, moved for every brain whenever one joined, and its bootstrap interval collapsed to zero width for any brain that won or lost every pairing (random-legal showed the tightest interval in the field).
- **Head-to-head.** Paired seed differences with a 2,000-replicate seed-block bootstrap interval and won/drawn/lost seed counts, per pair. Adjacent brains whose interval includes zero are shown as a tie.
- **Elo-style number** kept as a brain-page footnote only, with 2,000 replicates and no interval when the record is separated or there are fewer than 10 seeds.
- **Blitz** is a separate score summary and never ranks. `blitzCr` is gone. It said random play beat both hosted models, which was true of a 100 ms network round trip and nothing else.
- Quick runs show per-seed scores and no interval, because with 3 seeds the bootstrap has 10 possible resamples and covered 46 to 76% instead of 95%.

### Recordings and runner

- **Recording format `tetris-bench-recording@1`.** Seed plus an event log (`t`, status, gravity steps, placement, elapsed ms, post-event hash, decision). Boards are rebuilt by re-simulation; the viewer and the runner verify every event's hash. v2 stored every frame's full state (about 1.6 KB per frame) and `verifyRecording` accepted a forged trajectory as long as the digest matched.
- **Verification** now checks digest, format, ruleset, summary, full re-simulation and recomputed counters.
- **Index format `tetris-bench-index@3`** with `protocolHashes` (engine, contract, harness, features, recording, rating) enforced on merge and `adapterHashes` recorded, so a new brain can join without re-running the field. Provenance records `sourceTree` (a tree hash that survives squash merges), a scoped `sourceDirty`, IQ and Blitz concurrency, and a flat list of batches.
- **CLI.** `--concurrency` up to 16 is allowed with `--official` (games run in child processes); `--max-spend-usd` per hosted brain; caps may not exceed the engine constants; repeated flags are an error; a hosted pre-flight call before the batch; official games that fail with `error` or `timeout` and end as `adapter-failure` are retried once, then the brain is dropped; orphan recordings are deleted after a merge; worker failures report exit code and stderr and kill their siblings.
- Run ids are `v3-<batch>-<slug>-<seed>-<mode>`.

### Site

- The v1 and v2 recording files were removed from the site. The v1 and v2 indices stay at `/tetris-bench/archive-v1.json` and `/tetris-bench/archive-v2.json` (marked withdrawn), listed on `/tetris-bench/archive` without replay links. The recordings remain in git history at commits `ffb8afd` (v1) and `9bc56f8` (v2).

### Known limitations of the v3 harness bookkeeping

Found in review after the official field was played. They do not change any game, score, placement or ranking, so they wait for the next protocol identifier rather than invalidating the published recordings.

- `meta` and `retries` are only kept for accepted and unreachable answers. An invalid or stale hosted answer, or one that settled after its deadline, loses its token counts, finish reason and raw text, and `metrics.retries` undercounts by those retries.
- A call that settled after its deadline is priced into `metrics.costUsd` but its decision carries no `costUsd` of its own, so the sum of per-decision costs in a recording can be below the game total.
- In Blitz, a late placement that still lands on the disclosed board can earn slightly more than the disclosed score when the shorter drop changes the drop points or arms a spin, and a hung or blocking call keeps gravity running for the next piece. Both follow the written rules and are noted here so nobody reads them as measurement error.

## tetris-bench@2 (2026-09-20)

Withdrawn the same day, superseded by v3. It fixed v1's rating and disclosure problems and introduced most of the harness that v3 keeps.

- Rating from IQ games only. Penalised Bradley-Terry over pairwise seed points (precision 0.25, pair weight 1/(n-1)), Elo scale centred at 1,500, 95% intervals from 200 paired seed bootstrap resamples. Official field of 30 seeds (`seed-01` to `seed-30`), quick runs of 3.
- Every brain received the same one-step candidate outcomes (after-clear grid, lines cleared, score delta, top-out flag). Duplicate physical outcomes collapsed by `[board, score, lines, combo, backToBack, topOut]`; candidate order shuffled from the state hash with opaque ids `p0…pN`, so the spawn column was not always first.
- IQ: gravity paused, 10 s per question, three consecutive unusable decisions ended the game as `adapter-failure`. Blitz: soft deadline of `min(100 ms, time to next gravity step)`, a miss rolled over without input.
- Recordings stored every frame in full with SHA-256 digests, and `--merge` compared source hashes and timing environment.
- Known defects, all measured in the phase-one audits and fixed in v3: phantom T-spins on hard drops, I/S/Z twin candidates, one hung IQ call ending the game, Blitz calling on every other tick, hosted models unable to finish under 100 ms (every hosted Blitz game scored 0), whole-answer invalidation on a malformed optional field, the score-delta prompt bias, no `risk` ever asked, dead `blitzCr` and calibration columns, zero-width bootstrap intervals, forgeable recordings, and 545 MB per official field in the old recording format.

## tetris-bench@1 (withdrawn 2026-09-20)

The first published field: six brains (random legal, greedy, Dellacherie-style, two-ply search, Jev, an LLM classifier on GPT-4o mini) over five seeds.

- Withdrawn because the ratings mixed IQ and Blitz into one match point, gave local adapters richer simulation access than hosted ones, used an order-dependent Elo update (K = 32), and overrepresented a five-seed sample. Jev chose the first listed option in all 57 of its accepted IQ decisions, which was always the spawn placement.
- Its index is kept at `/tetris-bench/archive-v1.json`; its 60 recording files were removed from the site and remain in git history at commit `ffb8afd`.
