import { createGame, legalPlacements, applyPlacement, applyHold, advanceGravity, stateHash, gravityIntervalMs, RULESET, MAX_PIECES, MAX_TICKS } from './engine.ts';
import type { GameState } from './engine.ts';
import { validateAnswer } from './contract.ts';
import type { AgentInput, Brain, GameResult, Metrics, Mode, ReplayFrame } from './contract.ts';
export const IQ_TIMEOUT_MS = 10_000;
export const BLITZ_CAP_MS = 100;
export function percentile(values: number[], p: number): number | null { if (!values.length) return null; const sorted = [...values].sort((a,b) => a-b); return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]; }
export function inputFor(state: GameState, mode: Mode): AgentInput { return { ruleset: RULESET, grid: state.board, active: state.active, hold: state.hold, next: state.next, level: state.level, score: state.score, mode, tick: state.tick, stateHash: stateHash(state), legal: legalPlacements(state) }; }
export interface GameOptions { maxPieces?: number; maxTicks?: number; iqTimeoutMs?: number; blitzCapMs?: number }
/** Each brain has at most one in-flight call per game, even if it ignores abort. */
export async function runGame(brain: Brain, seed: string, mode: Mode, options: GameOptions = {}): Promise<GameResult> {
  let state = createGame(seed);
  const maxPieces = options.maxPieces ?? MAX_PIECES, maxTicks = options.maxTicks ?? MAX_TICKS;
  const started = performance.now(); let gravityAt = started + gravityIntervalMs(state);
  const frames: ReplayFrame[] = [{ tick: 0, elapsedMs: 0, state, event: 'start' }];
  const latencies: number[] = [], forecasts: Array<{ pieces: number; risk: number }> = [];
  let calls = 0, misses = 0, invalid = 0, stale = 0, cost = 0, costKnown = true;
  let busy = false;
  while (!state.over && state.pieces < maxPieces && state.tick < maxTicks) {
    const tick = state.tick + 1, input = inputFor(state, mode);
    const remaining = Math.max(0, gravityAt - performance.now());
    const budget = mode === 'IQ' ? options.iqTimeoutMs ?? IQ_TIMEOUT_MS : Math.min(options.blitzCapMs ?? BLITZ_CAP_MS, remaining);
    const controller = new AbortController();
    const began = performance.now();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false, called = false, raw: unknown;
    if (!busy && budget > 0) {
      busy = true; called = true; calls++;
      const work = Promise.resolve().then(() => brain.decide(structuredClone(input), { signal: controller.signal, state: { ...structuredClone(state), seed: '', rng: 1, bag: [] } })).catch(() => null).finally(() => { busy = false; });
      const expired = new Promise<null>(resolve => { timeout = setTimeout(() => { timedOut = true; controller.abort(); resolve(null); }, budget); });
      raw = await Promise.race([work, expired]);
      if (timeout) clearTimeout(timeout);
    } else if (mode === 'Blitz' && budget > 0) {
      await new Promise(resolve => setTimeout(resolve, budget)); timedOut = true;
    } else timedOut = true;
    const latency = performance.now() - began;
    const reportedCost = raw && typeof raw === 'object' ? (raw as { costUsd?: unknown }).costUsd : undefined;
    if (typeof reportedCost === 'number' && Number.isFinite(reportedCost) && reportedCost >= 0) cost += reportedCost;
    else if (brain.kind === 'remote') costKnown = false;
    // Synchronous adapters cannot pre-empt JS timers, so elapsed time is checked too.
    if (latency > budget) timedOut = true;
    if (called && !timedOut) latencies.push(latency);
    let event: ReplayFrame['event'];
    const checked = timedOut ? null : validateAnswer(raw, input.stateHash, input.legal);
    if (timedOut) { misses++; event = 'miss'; controller.abort(); }
    else if (!checked || checked.status === 'invalid') { invalid++; event = 'invalid'; }
    else if (checked.status === 'stale') { stale++; event = 'stale'; }
    else {
      if (checked.answer.score) forecasts.push({ pieces: state.pieces, risk: checked.answer.score.risk });
      if (checked.hold) { state = applyHold(state); event = 'hold'; }
      else if (checked.placement) { state = applyPlacement(state, checked.placement); event = 'placement'; }
      else { invalid++; event = 'invalid'; }
    }
    if (mode === 'Blitz' && performance.now() >= gravityAt) {
      do { state = advanceGravity(state); gravityAt += gravityIntervalMs(state); } while (!state.over && performance.now() >= gravityAt);
      if (event === 'miss') event = 'gravity';
    }
    state = { ...state, tick };
    frames.push({ tick, elapsedMs: performance.now() - started, state, event, decision: { status: timedOut ? 'miss' : checked?.status === 'ok' ? 'accepted' : checked?.status ?? 'invalid', called, stateHash: input.stateHash, ...(checked?.status === 'ok' ? { answer: checked.answer } : {}), latencyMs: latency, budgetMs: budget } });
  }
  // A forecast means top-out in the next ten locked pieces. Censored forecasts are omitted.
  const topOut = state.over && state.pieces < MAX_PIECES && state.tick < MAX_TICKS;
  const resolved = forecasts.filter(f => topOut || state.pieces >= f.pieces + 10);
  const calibrationError = resolved.length ? resolved.reduce((sum, f) => sum + (f.risk - Number(topOut && state.pieces <= f.pieces + 10)) ** 2, 0) / resolved.length : null;
  const metrics: Metrics = { p50Ms: percentile(latencies, .5), p95Ms: percentile(latencies, .95), costUsd: costKnown && (brain.kind === 'builtin' || !misses) ? cost : null, calibrationError, calls, misses, invalid, stale };
  return { id: `${brain.slug}-${seed}-${mode.toLowerCase()}`, brain: brain.slug, seed, mode, score: state.score, lines: state.lines, pieces: state.pieces, ticks: state.tick, outcome: topOut ? 'top-out' : state.pieces >= maxPieces ? 'piece-cap' : 'tick-cap', metrics, frames };
}
