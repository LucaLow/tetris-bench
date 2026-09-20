import type { GameResult, MatchResult } from './contract.ts';
export const OFFICIAL_SEEDS = ['seed-01', 'seed-02', 'seed-03', 'seed-04', 'seed-05'];
export function matchPoint(a: number, b: number): number { return a === b ? 0.5 : a > b ? 1 : 0; }
export function elo(a: number, b: number, point: number): [number, number] {
  const delta = 32 * (point - 1 / (1 + 10 ** ((b - a) / 400)));
  return [a + delta, b - delta];
}
export function rateField(slugs: string[], seeds: string[], games: GameResult[]) {
  const sorted = [...slugs].sort();
  const ratings: Record<string, number> = Object.fromEntries(sorted.map(s => [s, 1500]));
  const matches: MatchResult[] = [];
  const lookup = new Map(games.map(g => [`${g.brain}:${g.seed}:${g.mode}`, g]));
  for (let i = 0; i < sorted.length; i++) for (let j = i + 1; j < sorted.length; j++) for (const seed of seeds) {
    const a = sorted[i], b = sorted[j];
    const points = (['IQ', 'Blitz'] as const).map(mode => {
      const ga = lookup.get(`${a}:${seed}:${mode}`), gb = lookup.get(`${b}:${seed}:${mode}`);
      if (!ga || !gb) throw new Error('Rating requires every seed and both modes for every brain');
      return matchPoint(ga.score, gb.score);
    });
    const point = (points[0] + points[1]) / 2;
    [ratings[a], ratings[b]] = elo(ratings[a], ratings[b], point);
    matches.push({ a, b, seed, iq: points[0], blitz: points[1], point });
  }
  return { ratings, matches };
}
