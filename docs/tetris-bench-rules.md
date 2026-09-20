# Tetris Bench

Tetris Bench compares decision models under one typed contract. The site lives at `/tetris-bench` on Luca's personal website. The public engine, adapters and runner live at [LucaLow/tetris-bench](https://github.com/LucaLow/tetris-bench).

## Frozen rules

The protocol identifier is `tetris-bench@1`. Any change to engine behaviour, question interpretation, clocks, caps, seed selection or rating order requires a new identifier. Visual changes and new adapters do not.

The board has 10 columns and 20 visible rows. The engine uses SRS quarter-turn kicks, a seeded xorshift32 Fisher-Yates seven-bag, one hold per locked piece and five visible next pieces. Spawn origin is x=3, y=-1. Top-out occurs when spawning collides or any locked block lies above the board. There is no garbage or targeting.

Legal choices are `(x, rotation)` positions reachable from the current height through horizontal movement and SRS rotation. Rotation is 0, 1, 2 or 3. The engine chooses the first path in breadth-first order, exploring left, right, clockwise and anticlockwise, then hard-drops it. It does not search downwards into cavities or expose stepwise DAS. Multiple routes to the same choice use this canonical path, including its last rotation and kick for T-spin scoring.

Gravity starts at one row per 1,000 ms. At level L the interval is `max(16, round(1000 * 0.8^(L-1)))` ms. Contact locks on the next gravity step, without an additional lock delay. Level is `1 + floor(lines / 10)`. Games stop at top-out, 500 locked pieces or 10,000 decision ticks. There is no wall-clock survival bonus.

## Scoring

Hard drops earn two points per row. Single, double, triple and four-line clears earn 100, 300, 500 and 800 points times the current level. T-spins use the three-corner test after a final rotation. Full T-spins earn 400, 800, 1,200 or 1,600 for zero through three lines. Minis earn 100, 200 or 400 for zero through two lines. Front-corner occupancy or the fifth kick distinguishes full spins from minis.

Consecutive difficult clears receive a 1.5 multiplier. A no-clear placement preserves back-to-back status. Combos add `50 * combo * level`, with the first clear at combo zero. Perfect clears add 800, 1,200, 1,800 or 2,000 times level. A back-to-back four-line perfect clear adds 3,200 times level. The executable scoring reference is `lib/tetris-bench/engine.ts` and its fixtures in `scripts/tetris-bench/engine.test.ts`.

## Contract

Input contains the grid, active piece and height, hold, five next pieces, level, score, mode, tick, state hash and the engine's legal placements. It contains no natural-language conversation history. Each adapter receives a detached snapshot. A local simulation context contains a copied state with the seed removed and unseen bag and random generator replaced. It exists for visible-next lookahead, not future-bag prediction. Adapter submissions are reviewed because in-process adapters are trusted executable code, not a security sandbox.

```json
{
  "stateHash": "copied request hash",
  "choice": [{ "x": 3, "rotation": 0, "p": 1 }],
  "noul": { "hold": 0.1 },
  "score": { "risk": 0.2 }
}
```

Choice is required and non-empty. Its finite probabilities lie in [0,1] and sum to one within 0.001. Duplicate or illegal placements invalidate the entire answer. Highest probability wins, with ties resolved by ascending x, then rotation. Optional Noul holds when probability is strictly above 0.5 and holding is available. A successful hold consumes that tick and the engine asks again. Attempting another hold before locking is a no-op. Optional Score predicts top-out within the next ten locked pieces. Empty, malformed or illegal output is a no-op. A mismatched state hash is discarded.

## Clocks

IQ pauses gravity while waiting. Its operational timeout is 10 seconds per question. A timeout is a no-op. Blitz uses a soft deadline of the smaller of 100 ms and the time until the next gravity step. Missing it rolls over without input. Elapsed time is checked even for synchronous adapters that block JavaScript timers. After each answer or timeout, due gravity steps are applied and the next tick gets a fresh question and hash.

A deadline aborts the request. If an adapter ignores cancellation, the harness starts no further request for that game until the old call settles. Late responses cannot act on the board. Remote adapters must pass the supplied AbortSignal to their transport. Isolated child processes keep concurrently scheduled games from sharing an event loop. Hardware, provider load and concurrent processes still affect wall-clock results and are recorded as run context.

## Rating

Official fields use `seed-01` through `seed-05`. Quick runs use the first three and are labelled exhibition. All brains play IQ and Blitz for each seed. Because there is no multiplayer interaction, one measured brain/seed/mode game is reused against every opponent in that field.

For each pair and seed, higher score earns one point and equal score earns half. IQ and Blitz each contribute 50% of the match point. Elo starts at 1,500 and uses K=32. Pairs are traversed by ascending slug, then frozen seed order. Each field is calculated from scratch. CR is rounded only for display. Changing field membership changes CR. These numbers compare the recorded field and protocol, not performance across unrelated tournaments.

## Measurements

Latency p50 and p95 use completed calls that arrive inside their deadline. Missed calls and ticks with an outstanding request are excluded, and misses remain visible separately. An all-miss game has unknown latency, not 100 ms model latency. Replay decisions include measured waiting duration, deadline, whether a call started and accepted/miss/invalid/stale status.

Cost is zero for local adapters. Remote cost is taken from provider usage and is unknown if any request cost is missing, including aborted requests. The leaderboard shows mean cost per game only when every game has complete cost information. Aborted requests may still be billed by a provider.

Calibration is the mean squared error of optional ten-piece top-out probabilities. Predictions that cannot be resolved before a cap are excluded. A brain that supplies no scores has unknown calibration. The leaderboard averages available per-game calibration errors.

Artifacts contain replay frames, run summaries, match points, source SHA-256 digests, runtime, platform, concurrency and source revision context. The runner checks for source changes before publishing the index. Merged batches retain previous provenance. No keys, request headers or provider error bodies are saved.

## Running

Node 24 executes the TypeScript directly.

```sh
node --test scripts/tetris-bench/*.test.ts
node scripts/tetris-bench/run.ts --help
node scripts/tetris-bench/run.ts --official
OPENROUTER_API_KEY=... node scripts/tetris-bench/run.ts --official --brains jev,llm-classifier --concurrency 4 --merge
```

Keep credentials in the environment, outside Git. The default output is `public/tetris-bench/index.json` and `public/tetris-bench/runs/<id>.json`. `--out` selects another directory. `--max-pieces` and `--max-ticks` make shorter exhibitions and cannot be combined with `--official` unless they equal the frozen caps.

The Jev adapter calls OpenRouter's System One endpoint with `typesafe/jev-1.13`, typed Choice criteria and a Noul hold question. The LLM adapter defaults to `openai/gpt-4o-mini` and can be selected with `OPENROUTER_MODEL`. It requests JSON and validates the result against the same contract. Model availability and latency are properties of the recorded provider run.

## Entering

Submit a pull request adding a thin adapter and tests to the public repository. It must accept the existing typed input, return the typed probability distribution, respect cancellation and avoid side effects. Include the model identifier and any provider cost information. The maintained runner produces official artifacts. Browser demonstrations and shortened local runs do not update official CR.
