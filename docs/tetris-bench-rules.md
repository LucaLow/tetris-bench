# Tetris Bench

Tetris Bench compares decision models under one typed contract. The site lives at `/tetris-bench` on Luca's personal website. The public engine, adapters and runner live at [LucaLow/tetris-bench](https://github.com/LucaLow/tetris-bench).

## Frozen rules

The protocol identifier is `tetris-bench@2`. Any change to engine behaviour, question interpretation, clocks, caps, seed selection or rating method requires a new identifier. Visual changes and new adapters do not.

The board has 10 columns and 20 visible rows. The engine uses SRS quarter-turn kicks, a seeded xorshift32 Fisher-Yates seven-bag, one hold per locked piece and five visible next pieces. Spawn origin is x=3, y=-1. Top-out occurs when spawning collides or any locked block lies above the board. There is no garbage or targeting.

Legal choices are `(x, rotation)` positions reachable from the current height through horizontal movement and SRS rotation. Rotation is 0, 1, 2 or 3. The engine chooses the first path in breadth-first order, exploring left, right, clockwise and anticlockwise, then hard-drops it. It does not search downwards into cavities or expose stepwise DAS. Multiple routes to the same choice use this canonical path, including its last rotation and kick for T-spin scoring.

Gravity starts at one row per 1,000 ms. At level L the interval is `max(16, round(1000 * 0.8^(L-1)))` ms. Contact locks on the next gravity step, without an additional lock delay. Level is `1 + floor(lines / 10)`. Games stop at top-out, 500 locked pieces or 10,000 decision ticks. There is no wall-clock survival bonus.

## Scoring

Hard drops earn two points per row. Single, double, triple and four-line clears earn 100, 300, 500 and 800 points times the current level. T-spins use the three-corner test after a final rotation. Full T-spins earn 400, 800, 1,200 or 1,600 for zero through three lines. Minis earn 100, 200 or 400 for zero through two lines. Front-corner occupancy or the fifth kick distinguishes full spins from minis.

Consecutive difficult clears receive a 1.5 multiplier. A no-clear placement preserves back-to-back status. Combos add `50 * combo * level`, with the first clear at combo zero. Perfect clears add 800, 1,200, 1,800 or 2,000 times level. A back-to-back four-line perfect clear adds 3,200 times level. The executable scoring reference is `lib/tetris-bench/engine.ts` and its fixtures in `scripts/tetris-bench/engine.test.ts`.

## Contract

Input contains the grid, active piece and height, hold, `canHold`, five next pieces, level, score, lines, pieces, combo, back-to-back status, mode, tick and state hash. Every adapter receives the same legal candidates with after-clear grids, lines cleared, score delta and top-out flag. Duplicate physical outcomes are deduplicated. Candidate order is deterministically shuffled from the public state hash before opaque IDs are assigned, so the first option is not always the spawn column. The state hash excludes hidden bag and RNG state. No adapter receives a private simulation state or future random bag. There is no conversation history. Each adapter receives a detached snapshot and cancellation signal. Adapter submissions are reviewed because in-process adapters are trusted executable code, not a security sandbox.

```json
{
  "stateHash": "copied request hash",
  "choice": [{ "x": 3, "rotation": 0, "p": 1 }],
  "noul": { "hold": 0.1 },
  "score": { "risk": 0.2 }
}
```

Choice is required and non-empty. Its finite probabilities lie in [0,1] and sum to one within 0.001. Duplicate or illegal placements invalidate the entire answer. Highest probability wins, with ties resolved by ascending x, then rotation. Optional Noul holds when probability is strictly above 0.5 and holding is available. A successful hold consumes that tick and the engine asks again. Attempting another hold before locking is invalid. Optional Score predicts top-out within the next ten locked pieces. Empty, malformed or illegal output is a no-op. A mismatched state hash is discarded.

## Clocks

IQ pauses gravity while waiting. Its operational timeout is 10 seconds per question. Three consecutive unusable decisions (invalid, stale or timed out) end the IQ game as `adapter-failure`. A valid action resets that counter. Blitz uses a soft deadline of the smaller of 100 ms and the time until the next gravity step. Missing it rolls over without input. Elapsed time is checked even for synchronous adapters that block JavaScript timers. A successful placement or hold starts a fresh gravity interval. After each answer or timeout, due gravity steps are applied. When gravity is already due, the call budget is zero and the harness advances gravity without starting a request. Gravity does not consume decision ticks and the next tick gets a fresh question and hash.

A deadline aborts the request. If an adapter ignores cancellation, the harness starts no further request for that game until the old call settles. Late responses cannot act on the board. Remote adapters must pass the supplied AbortSignal to their transport. Isolated child processes keep concurrently scheduled games from sharing an event loop. Hardware, provider load and concurrent processes still affect wall-clock results and are recorded as run context.

## Rating

Official fields use `seed-01` through `seed-30`, serial execution and the fixed 500-piece cap. Quick runs use the first three and are provisional exhibitions. These public seeds support reproduction, not held-out evaluation. No general-intelligence claim follows from these results. All brains play IQ and Blitz for each seed. One measured brain/seed/mode game is reused against every opponent because there is no multiplayer interaction.

Only IQ contributes to headline CR. For each pair and seed, higher score earns one point and equal score earns half. Blitz is a separate 100 ms systems stress test. Its score reflects hardware, network and provider behaviour as well as policy. It does not rank intelligence.

CR fits penalised Bradley-Terry log-strengths with Gaussian precision 0.25 and pair weight `1 / (field size - 1)`. Log-strengths are converted to an Elo scale centred at 1,500. The fit is independent of pair traversal order. Ratings are recalculated from scratch and rounded only for display. Field membership changes CR, so unrelated tournaments are not comparable.

The 95% intervals use 200 paired seed bootstrap resamples. Each resampled seed retains all brains' games and all resulting comparisons. Pairwise results sharing a game are not independent samples. Three-seed quick results cannot establish a significant difference or a winner. Intervals cover seed variation only, not repeated-provider variation, prompt choice or tuning on the public seeds.

Version 1 ratings are withdrawn. They mixed IQ and Blitz, gave local adapters richer simulation access, used an order-dependent Elo update and overrepresented a five-seed sample. The original index is preserved at `/tetris-bench/archive-v1.json`. Its recordings retain their original IDs and ruleset. Current version 2 run IDs begin with `v2-`. No archived rating is a current comparison.

## Measurements

Latency p50 and p95 exclude input preparation and use completed calls, including synchronous calls rejected for exceeding their deadline. Aborted calls with no observed completion and ticks with an outstanding request are excluded, and completed-call, timed-out-call, invalid-answer and deadline-miss counts remain visible separately for each mode. Deadline-miss ticks include waiting on an outstanding call and are not the same denominator as timed-out calls. An all-miss game has unknown latency, not 100 ms model latency. Replay decisions include measured waiting duration, deadline, whether a call started and accepted/miss/invalid/stale status.

Provider API cost is zero for local adapters. This excludes hardware, electricity and hosting for all entrants. Remote cost is taken from provider usage and is unknown if any request cost is missing, including aborted requests. The leaderboard shows mean cost per game only when every game has complete cost information. Aborted requests may still be billed by a provider.

Calibration is the mean squared error of optional ten-piece top-out probabilities. It is policy-dependent risk forecasting, not classifier accuracy. Predictions that cannot be resolved before a cap are excluded. A brain that supplies no scores has unknown calibration. Resolved forecast counts are reported beside the available score.

Artifacts contain replay frames, run summaries, match points, source SHA-256 digests, runtime, platform, concurrency and source revision context. The runner checks for source changes before publishing the index. Official fields require at least two brains and refuse provider errors in either mode or IQ adapter failures. Jobs interleave brains by seed, rotating the order, and retain per-game start times. Recordings have SHA-256 digests. Merging validates bytes, summaries, identities, ruleset, executable sources and timing environment before collecting new games. Merged batches retain previous provenance. No keys, request headers or provider error bodies are saved.

## Running

Node 24 executes the TypeScript directly.

```sh
node --test scripts/tetris-bench/*.test.ts
node scripts/tetris-bench/run.ts --help
node scripts/tetris-bench/probe.ts # requires provider credentials, diagnostic only
node scripts/tetris-bench/run.ts --official
OPENROUTER_API_KEY=... node scripts/tetris-bench/run.ts --official --brains jev,llm-classifier --merge
```

Keep credentials in the environment, outside Git. The default output is `public/tetris-bench/index.json` and `public/tetris-bench/runs/<id>.json`. `--out` selects another directory. `--max-pieces` and `--max-ticks` make shorter exhibitions and cannot be combined with `--official` unless they equal the frozen caps.

The Jev adapter calls OpenRouter's System One endpoint with `typesafe/jev-1.13`, typed Choice criteria and a Noul hold question. The LLM adapter defaults to `openai/gpt-4o-mini` and can be selected with `OPENROUTER_MODEL`. It requests JSON and validates the result against the same contract. Jev returns rounded probabilities. Its transport adapter renormalises finite [0,1] values only when their sum differs from one by at most min(0.05, 0.005 times the number of choices), retaining the original mass in the replay. The argmax is unchanged. Larger deviations, zero mass and malformed values remain invalid. Model availability and latency are properties of the recorded provider run.

## Entering

Submit a pull request adding a thin adapter and tests to the public repository. It must accept the existing typed input, return the typed probability distribution, respect cancellation and avoid side effects. Include the model identifier and any provider cost information. The maintained runner produces official artifacts. Browser demonstrations and shortened local runs do not update official CR.
