import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Brain, GameResult, Mode, TournamentIndex } from '../../lib/tetris-bench/contract.ts';

export function artifactDigest(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function verifyRecording(bytes: string | Uint8Array, summary: Omit<GameResult, 'frames'> & { artifactSha256?: string }, ruleset: string): GameResult {
  if (!summary.artifactSha256 || artifactDigest(bytes) !== summary.artifactSha256) throw new Error(`Recording digest mismatch: ${summary.id}`);
  const game = JSON.parse(typeof bytes === 'string' ? bytes : Buffer.from(bytes).toString('utf8')) as GameResult;
  const { frames, ...actual } = game;
  const { artifactSha256, ...expected } = summary;
  void artifactSha256;
  if (!isDeepStrictEqual(actual, expected)) throw new Error(`Recording summary mismatch: ${summary.id}`);
  if (!Array.isArray(frames) || !frames.length || frames.some(frame => frame.state?.ruleset !== ruleset || frame.state.seed !== game.seed)) throw new Error(`Recording protocol or seed mismatch: ${summary.id}`);
  const final = frames.at(-1)!.state;
  if (final.score !== game.score || final.lines !== game.lines || final.pieces !== game.pieces || final.tick !== game.ticks) throw new Error(`Recording final state mismatch: ${summary.id}`);
  return game;
}

export function assertMergeCompatible(previous: TournamentIndex, current: Pick<TournamentIndex, 'ruleset' | 'official' | 'maxPieces' | 'maxTicks' | 'seeds'> & { provenance: Pick<TournamentIndex['provenance'], 'sourceHashes' | 'concurrency' | 'runtime' | 'platform' | 'hardware'> }): void {
  for (const field of ['ruleset', 'official', 'maxPieces', 'maxTicks', 'seeds'] as const) {
    if (!isDeepStrictEqual(previous[field], current[field])) throw new Error('Cannot merge different protocols');
  }
  if (!previous.provenance.hardware || !current.provenance.hardware) throw new Error('Cannot merge missing hardware timing provenance');
  for (const field of ['sourceHashes', 'concurrency', 'runtime', 'platform', 'hardware'] as const) {
    if (!isDeepStrictEqual(previous.provenance[field], current.provenance[field])) throw new Error('Cannot merge different source or timing configurations');
  }
}

export function assertOfficialPublishable(official: boolean, slugs: string[], games: GameResult[]): void {
  if (!official) return;
  if (new Set(slugs).size < 2) throw new Error('Official publication requires at least two brains');
  if (games.some(game => game.outcome === 'adapter-failure' || (game.metrics.errors ?? 0) > 0 || game.frames.some(frame => frame.decision?.failure === 'provider-error'))) throw new Error('Official publication refused: adapter/provider failure. Recordings retained for diagnosis; index unchanged.');
}

/** Seed-major blocks rotate sorted brains and alternate mode order. */
export function counterbalancedJobs(brains: Brain[], seeds: string[]): Array<{ brain: Brain; seed: string; mode: Mode }> {
  const sorted = [...brains].sort((a, b) => a.slug.localeCompare(b.slug));
  return seeds.flatMap((seed, s) => {
    const offset = s % sorted.length;
    const rotated = [...sorted.slice(offset), ...sorted.slice(0, offset)];
    const modes: Mode[] = s % 2 ? ['Blitz', 'IQ'] : ['IQ', 'Blitz'];
    return modes.flatMap(mode => rotated.map(brain => ({ brain, seed, mode })));
  });
}
