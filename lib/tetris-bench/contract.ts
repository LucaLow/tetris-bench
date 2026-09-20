import type { GameState, Placement } from './engine.ts';
export type Mode = 'IQ' | 'Blitz';
export interface AgentInput { ruleset: string; grid: GameState['board']; active: GameState['active']; hold: GameState['hold']; next: GameState['next']; level: number; score: number; mode: Mode; tick: number; stateHash: string; legal: Placement[] }
export interface AgentAnswer { stateHash: string; choice: Array<Placement & { p: number }>; noul?: { hold: number }; score?: { risk: number }; costUsd?: number }
export interface Brain { slug: string; name: string; description: string; kind: 'builtin' | 'remote'; model?: string; decide(input: AgentInput, context: { signal: AbortSignal; state: GameState }): Promise<unknown> | unknown }
export interface Metrics { p50Ms: number | null; p95Ms: number | null; costUsd: number | null; calibrationError: number | null; calls: number; misses: number; invalid: number; stale: number }
export interface ReplayFrame { tick: number; elapsedMs: number; state: GameState; event: 'start' | 'placement' | 'hold' | 'gravity' | 'miss' | 'invalid' | 'stale'; decision?: { status: 'accepted' | 'miss' | 'invalid' | 'stale'; called: boolean; stateHash: string; answer?: AgentAnswer; latencyMs: number; budgetMs: number } }
export interface GameResult { id: string; brain: string; seed: string; mode: Mode; score: number; lines: number; pieces: number; ticks: number; outcome: 'top-out' | 'piece-cap' | 'tick-cap'; metrics: Metrics; frames: ReplayFrame[] }
export interface BrainStanding { slug: string; name: string; description: string; kind: Brain['kind']; model?: string; cr: number; games: number; wins: number; draws: number; losses: number; meanScore: number; metrics: Metrics }
export interface MatchResult { a: string; b: string; seed: string; iq: number; blitz: number; point: number }
export interface TournamentIndex { ruleset: string; generatedAt: string; official: boolean; seeds: string[]; maxPieces: number; maxTicks: number; rating: 'Elo 1500 / K32'; provenance: { runtime: string; platform: string; sourceCommit: string | null; sourceDirty: boolean; sourceHashes: Record<string, string>; concurrency: number; previousBatches?: unknown[] }; leaderboard: BrainStanding[]; runs: Array<Omit<GameResult, 'frames'>>; matches: MatchResult[] }
export function validateAnswer(value: unknown, hash: string, legal: Placement[]): { status: 'ok'; answer: AgentAnswer; placement?: Placement; hold: boolean } | { status: 'invalid' } | { status: 'stale' } {
  if (!value || typeof value !== 'object') return { status: 'invalid' };
  const a = value as AgentAnswer;
  if (typeof a.stateHash !== 'string') return { status: 'invalid' };
  if (a.stateHash !== hash) return { status: 'stale' };
  const probability = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
  if (!Array.isArray(a.choice) || (a.noul !== undefined && (!a.noul || !probability(a.noul.hold))) || (a.score !== undefined && (!a.score || !probability(a.score.risk))) || (a.costUsd !== undefined && (typeof a.costUsd !== 'number' || !Number.isFinite(a.costUsd) || a.costUsd < 0))) return { status: 'invalid' };
  const seen = new Set<string>();
  for (const c of a.choice) {
    if (!c || !Number.isInteger(c.x) || !Number.isInteger(c.rotation) || !probability(c.p) || !legal.some(l => l.x === c.x && l.rotation === c.rotation) || seen.has(`${c.x}:${c.rotation}`)) return { status: 'invalid' };
    seen.add(`${c.x}:${c.rotation}`);
  }
  const mass = a.choice.reduce((sum, c) => sum + c.p, 0);
  if (a.choice.length && Math.abs(mass - 1) > 0.001) return { status: 'invalid' };
  const hold = (a.noul?.hold ?? 0) > 0.5;
  if (!a.choice.length) return { status: 'invalid' };
  const best = [...a.choice].sort((a, b) => b.p - a.p || a.x - b.x || a.rotation - b.rotation)[0];
  return { status: 'ok', answer: a, placement: best ? { x: best.x, rotation: best.rotation } : undefined, hold };
}
