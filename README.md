# Tetris Bench

Decision models and LLMs play Tetris through one contract; ranked by score on fixed seeds.

The harness works out every legal landing spot for the current piece, simulates each one a step ahead, and shows the same list to every brain. The brain picks one. IQ pauses the clock while it thinks, so only judgement counts. Blitz keeps the clock running: the piece falls while the brain thinks, and a slow answer arrives to a lower piece and fewer options. The headline number is the mean IQ score over thirty seeds, with a 95% interval from those seeds.

The leaderboard, replays and brain pages are at [lowndes.dev/tetris-bench](https://www.lowndes.dev/tetris-bench). This repository holds the engine, harness, adapters, rating code, runner and tests, so every published game can be re-simulated and checked.

The protocol identifier is `tetris-bench@3`. The rules, the contract, the rating method and the recording format are in [docs/tetris-bench-rules.md](docs/tetris-bench-rules.md). What changed between versions is in [docs/tetris-bench-changelog.md](docs/tetris-bench-changelog.md).

## Run

Node.js 24 or newer. No package dependencies.

```sh
npm test                                                   # unit tests, no network, no credentials
node scripts/tetris-bench/run.ts --out /tmp/tetris-bench-quick   # quick run: builtin brains, 3 seeds, IQ and Blitz
node scripts/tetris-bench/run.ts --official                      # 30 seeds at the frozen caps, into public/tetris-bench
OPENROUTER_API_KEY=… node scripts/tetris-bench/run.ts --official --brains jev,gpt-4o-mini --modes IQ --merge --max-spend-usd 5
node scripts/tetris-bench/run.ts --help
```

Local brains (`random-legal`, `greedy`, `dellacherie`, `search`) need no credentials. Hosted brains are listed in `lib/tetris-bench/models.ts` and go through OpenRouter. Put the key in the environment, never in git. The runner makes one pre-flight call per hosted brain before a batch and refuses to publish an index whose sources changed while it ran.

Output is `public/tetris-bench/index.json` plus one recording per game under `public/tetris-bench/runs/`. A recording is the seed and an event log. The boards are rebuilt from it with the public engine and every step's hash is checked. Quick runs are provisional and show per-seed scores. Every run writes an index and prunes recordings under `--out`, so quick runs in a checkout that holds the official field must pass `--out`; the runner refuses to replace an official index with a quick one otherwise. The leaderboard shows whatever index is committed, and only official indices from the maintained runner are committed, never anything from a browser.

## Enter

Open a pull request with an adapter and a test.

- A local brain implements `Brain` from `lib/tetris-bench/contract.ts` and is added to `builtInBrains` in `lib/tetris-bench/adapters.ts`.
- A hosted model is one registry entry in `lib/tetris-bench/models.ts`. The shared OpenRouter adapter renders the evidence, sends a strict JSON schema, and maps the reply.
- Read only the input, pass the `AbortSignal` to your transport, report `costUsd` per call, keep no state between calls.
- `npm test` must pass without credentials. Paste a probe run (`node scripts/tetris-bench/probe.ts --brain=<slug>`) into the PR for hosted brains.

The checklist and the exact validation rules are in section 5 of the rules document. Adapters are reviewed by hand: in-process code is trusted, not sandboxed.

## Versions

`tetris-bench@3` is current. `tetris-bench@2` and `tetris-bench@1` are withdrawn. Their indices are kept on the site as archives and their recordings are in the website repository's git history. Ratings from different identifiers are never compared.
