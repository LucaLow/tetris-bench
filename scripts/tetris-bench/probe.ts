/**
 * Diagnostic only. Fixed questions for the hosted brains; not tournament seeds
 * or ratings.
 *
 *   node scripts/tetris-bench/probe.ts [--brain=<slug>[,<slug>]] [--strict]
 *
 * Positions: the two fixtures (a unique two-line clear that any working
 * transport must find) and eight discriminating no-clear positions generated
 * deterministically from greedy play on seeds 02-05, where the largest score
 * delta (the deepest drop) creates a hole and at least one candidate does not.
 * Every position is asked in both candidate orders. The report says, per
 * brain, whether every answer was valid, whether the fixture pick survives a
 * reversal, and whether the discriminating pick adds no hole under both
 * orders. `--strict` also fails the process on that last assertion.
 *
 * `--brain` accepts any registry slug (needs OPENROUTER_API_KEY) or a built-in
 * slug. Default: every hosted model in the registry.
 */
import { builtInBrains, hostedBrain } from '../../lib/tetris-bench/adapters.ts';
import { HOSTED_MODELS, findHostedModel } from '../../lib/tetris-bench/models.ts';
import { applyPlacement, createGame } from '../../lib/tetris-bench/engine.ts';
import type { Placement } from '../../lib/tetris-bench/engine.ts';
import { inputFor } from '../../lib/tetris-bench/harness.ts';
import { validateAnswer } from '../../lib/tetris-bench/contract.ts';
import type { AgentAnswer, AgentInput, Brain, CandidateOutcome } from '../../lib/tetris-bench/contract.ts';

const PROBE_TIMEOUT_MS = 20_000;
const DISCRIMINATING_SEEDS = ['seed-02', 'seed-03', 'seed-04', 'seed-05'];
const POSITIONS_PER_SEED = 2;
// After outcome dedup an O piece offers 9 candidates, I/S/Z 17 and T/J/L 34; skip the O positions.
const MIN_CANDIDATES = 17;
const MAX_PIECES_SEARCHED = 120;

interface ProbePosition {
  name: string;
  kind: 'fixture' | 'discriminating';
  input: AgentInput;
}

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

/** Two full rows with a two-wide gap and an O piece: exactly one candidate clears two lines. */
function fixture(side: 'left' | 'right'): ProbePosition {
  const state = createGame(`diagnostic-${side}`);
  state.active = { type: 'O', rotation: 0, x: 3, y: -1 };
  state.holdUsed = true;
  const gap = side === 'left' ? 0 : 8;
  for (const y of [18, 19]) {
    for (let x = 0; x < 10; x++) state.board[y][x] = x === gap || x === gap + 1 ? null : 'J';
  }
  const input = inputFor(state, 'IQ');
  if (input.candidates.filter(c => c.linesCleared === 2).length !== 1) throw new Error('Probe fixture must have one unique two-line clear');
  return { name: `fixture-${side}`, kind: 'fixture', input };
}

/** The one-ply greedy value, used only to rank picks in the report. */
function greedyValue(candidate: CandidateOutcome): number {
  if (candidate.topOut) return -1e9;
  const f = candidate.features;
  return candidate.linesCleared * 10 - f.aggregateHeight * 0.51 - f.holes * 7.5 - f.bumpiness * 0.18;
}

/**
 * A position discriminates when no line clear is available, every candidate
 * with the largest score delta adds a hole, and some candidate adds none.
 */
function isDiscriminating(input: AgentInput): boolean {
  if (input.candidates.length < MIN_CANDIDATES) return false;
  if (input.candidates.some(c => c.linesCleared > 0)) return false;
  const maxDelta = Math.max(...input.candidates.map(c => c.scoreDelta));
  const argmax = input.candidates.filter(c => c.scoreDelta === maxDelta);
  const holesNow = input.features.holes;
  const argmaxAddsHole = argmax.every(c => c.features.holes > holesNow);
  const someCandidateAddsNone = input.candidates.some(c => !c.topOut && c.features.holes <= holesNow);
  return argmaxAddsHole && someCandidateAddsNone;
}

async function greedyPick(input: AgentInput): Promise<Placement> {
  const greedy = builtInBrains.find(b => b.slug === 'greedy');
  if (!greedy) throw new Error('greedy brain missing');
  const raw = await greedy.decide(structuredClone(input), { signal: new AbortController().signal, budgetMs: null });
  const checked = validateAnswer(raw, input.stateHash, input.legal, input.canHold);
  if (checked.status !== 'ok') throw new Error('greedy brain returned an unusable answer');
  return checked.placement;
}

/** Eight no-clear positions from greedy play: one early (<60 pieces) and one late per seed. */
async function discriminatingPositions(): Promise<ProbePosition[]> {
  const positions: ProbePosition[] = [];
  for (const seed of DISCRIMINATING_SEEDS) {
    let state = createGame(seed);
    let picked = 0;
    while (state.pieces < MAX_PIECES_SEARCHED && !state.over && picked < POSITIONS_PER_SEED) {
      const input = inputFor(state, 'IQ');
      const window = picked === 0 ? state.pieces >= 10 && state.pieces < 60 : state.pieces >= 60;
      if (window && isDiscriminating(input)) {
        positions.push({ name: `${seed}-p${state.pieces}`, kind: 'discriminating', input });
        picked++;
      }
      state = applyPlacement(state, await greedyPick(input));
    }
    if (picked < POSITIONS_PER_SEED) throw new Error(`Only ${picked} discriminating positions found on ${seed}`);
  }
  return positions;
}

/** The same question with the candidate list reversed and ordinal ids reassigned. */
function reversedInput(input: AgentInput): AgentInput {
  const copy = structuredClone(input);
  copy.candidates = [...copy.candidates].reverse().map((candidate, index) => ({ ...candidate, id: `p${index}` }));
  copy.legal = copy.candidates.map(candidate => candidate.placement);
  return copy;
}

// ---------------------------------------------------------------------------
// Asking
// ---------------------------------------------------------------------------

interface ProbeResult {
  position: string;
  kind: ProbePosition['kind'];
  reversed: boolean;
  status: string;
  id?: string;
  placement?: Placement;
  probability?: number;
  latencyMs: number;
  costUsd?: number;
  retries?: number;
  finishReason?: string;
  /** Fixture: the pick is the unique two-line clear. */
  clearsTwo?: boolean;
  /** Discriminating: holes after the pick minus holes now. */
  holesAdded?: number;
  addsNoHole?: boolean;
  /** Discriminating: rank of the pick under the one-ply greedy value (1 = best). */
  greedyRank?: number;
  error?: string;
}

function samePlacement(a: Placement | undefined, b: Placement | undefined): boolean {
  return !!a && !!b && a.x === b.x && a.rotation === b.rotation;
}

async function ask(brain: Brain, position: ProbePosition, reversed: boolean): Promise<ProbeResult> {
  const input = reversed ? reversedInput(position.input) : structuredClone(position.input);
  const started = performance.now();
  const base: ProbeResult = { position: position.name, kind: position.kind, reversed, status: 'pending', latencyMs: 0 };
  try {
    const raw = await brain.decide(input, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), budgetMs: PROBE_TIMEOUT_MS });
    base.latencyMs = Math.round(performance.now() - started);
    const answer = raw && typeof raw === 'object' ? raw as AgentAnswer : undefined;
    base.costUsd = answer?.costUsd;
    base.retries = answer?.meta?.retries;
    base.finishReason = answer?.meta?.finishReason;
    const checked = validateAnswer(raw, input.stateHash, input.legal, input.canHold);
    base.status = checked.status;
    if (checked.status !== 'ok') {
      if (checked.status === 'invalid') base.error = checked.reason;
      return base;
    }
    const selected = input.candidates.find(c => samePlacement(c.placement, checked.placement));
    base.id = selected?.id;
    base.placement = checked.placement;
    base.probability = checked.answer.choice.find(c => samePlacement(c, checked.placement))?.p;
    if (!selected) return base;
    if (position.kind === 'fixture') {
      base.clearsTwo = selected.linesCleared === 2;
    } else {
      base.holesAdded = selected.features.holes - input.features.holes;
      base.addsNoHole = base.holesAdded <= 0;
      const ranked = [...input.candidates].sort((a, b) => greedyValue(b) - greedyValue(a));
      base.greedyRank = ranked.findIndex(c => c.id === selected.id) + 1;
    }
    return base;
  } catch (error) {
    // Provider error messages carry the HTTP status only. Never write request headers or keys.
    base.latencyMs = Math.round(performance.now() - started);
    base.status = 'provider-error';
    base.error = error instanceof Error ? error.message : 'Unknown provider failure';
    return base;
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

function pairs(results: ProbeResult[], positions: ProbePosition[], kind: ProbePosition['kind']): Array<[ProbeResult, ProbeResult]> {
  return positions
    .filter(position => position.kind === kind)
    .map(position => {
      const forward = results.find(r => r.position === position.name && !r.reversed);
      const backward = results.find(r => r.position === position.name && r.reversed);
      if (!forward || !backward) throw new Error(`missing results for ${position.name}`);
      return [forward, backward];
    });
}

function report(brain: Brain, positions: ProbePosition[], results: ProbeResult[]) {
  const fixturePairs = pairs(results, positions, 'fixture');
  const discriminatingPairs = pairs(results, positions, 'discriminating');
  const discriminating = results.filter(r => r.kind === 'discriminating');
  const okDiscriminating = discriminating.filter(r => r.status === 'ok');
  const failingNoHole = discriminatingPairs
    .filter(([forward, backward]) => !(forward.addsNoHole && backward.addsNoHole))
    .map(([forward]) => forward.position);
  const known = results.map(r => r.costUsd).filter((cost): cost is number => typeof cost === 'number');
  return {
    brain: brain.slug,
    name: brain.name,
    model: brain.model,
    adapterVersion: brain.adapterVersion,
    diagnosticOnly: true,
    valid: `${results.filter(r => r.status === 'ok').length}/${results.length}`,
    allValid: results.every(r => r.status === 'ok'),
    fixtures: {
      allUniqueClears: fixturePairs.every(([forward, backward]) => forward.clearsTwo && backward.clearsTwo),
      stableSemanticChoice: fixturePairs.every(([forward, backward]) => forward.status === 'ok' && backward.status === 'ok' && samePlacement(forward.placement, backward.placement)),
    },
    discriminating: {
      noHoleAdded: `${discriminating.filter(r => r.addsNoHole).length}/${discriminating.length}`,
      noHoleBothOrders: `${discriminatingPairs.length - failingNoHole.length}/${discriminatingPairs.length}`,
      assertionPassed: failingNoHole.length === 0,
      failing: failingNoHole,
      sameChoiceAfterReversal: `${discriminatingPairs.filter(([forward, backward]) => samePlacement(forward.placement, backward.placement)).length}/${discriminatingPairs.length}`,
      holesAddedTotal: okDiscriminating.reduce((sum, r) => sum + (r.holesAdded ?? 0), 0),
      meanGreedyRank: okDiscriminating.length ? Number((okDiscriminating.reduce((sum, r) => sum + (r.greedyRank ?? 0), 0) / okDiscriminating.length).toFixed(2)) : null,
    },
    p50LatencyMs: median(results.filter(r => r.status !== 'provider-error').map(r => r.latencyMs)),
    costUsd: known.length ? Number(known.reduce((sum, cost) => sum + cost, 0).toFixed(6)) : null,
    unpricedCalls: results.length - known.length,
    retries: results.reduce((sum, r) => sum + (r.retries ?? 0), 0),
    results,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function selectBrains(argv: string[]): Brain[] {
  const requested = argv.find(arg => arg.startsWith('--brain='))?.slice('--brain='.length);
  const slugs = requested ? requested.split(',').map(s => s.trim()).filter(Boolean) : HOSTED_MODELS.map(m => m.slug);
  return slugs.map(slug => {
    const builtin = builtInBrains.find(b => b.slug === slug);
    if (builtin) return builtin;
    const hosted = findHostedModel(slug);
    if (!hosted) throw new Error(`Unknown brain '${slug}'. Registry: ${HOSTED_MODELS.map(m => m.slug).join(', ')}; built-ins: ${builtInBrains.map(b => b.slug).join(', ')}`);
    if (!process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is required for hosted brains');
    return hostedBrain(hosted);
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const strict = argv.includes('--strict');
  const brains = selectBrains(argv);
  const positions = [fixture('left'), fixture('right'), ...await discriminatingPositions()];
  let failed = false;
  for (const brain of brains) {
    const results: ProbeResult[] = [];
    for (const position of positions) {
      for (const reversed of [false, true]) results.push(await ask(brain, position, reversed));
    }
    const summary = report(brain, positions, results);
    console.log(JSON.stringify(summary, null, 2));
    if (!summary.allValid || !summary.fixtures.allUniqueClears) failed = true;
    if (strict && !summary.discriminating.assertionPassed) failed = true;
  }
  process.exitCode = failed ? 1 : 0;
}

await main();
