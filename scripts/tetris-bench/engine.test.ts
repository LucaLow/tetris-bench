import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  HEIGHT,
  MAX_TICKS,
  RULESET,
  WIDTH,
  advanceGravity,
  applyHold,
  applyPlacement,
  cells,
  createGame,
  dropDistance,
  fits,
  gravityIntervalMs,
  legalPlacements,
  rotate,
  simulatePlacement,
  stateHash,
  stepGravity,
} from '../../lib/tetris-bench/engine.ts';
import type { GameState, Piece, Rotation } from '../../lib/tetris-bench/engine.ts';
import { inputFor } from '../../lib/tetris-bench/harness.ts';

const ALL_PIECES: Piece[] = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'];

function emptyBoard(): GameState['board'] {
  return Array.from({ length: HEIGHT }, () => Array<Piece | null>(WIDTH).fill(null));
}

function cellKey(list: [number, number][]): string {
  return list.map(([x, y]) => `${x},${y}`).sort().join(' ');
}

/** SRS pictures in screen coordinates (y down), transcribed independently of the engine's shape tables. */
const SRS_CELLS: Record<Piece, [number, number][][]> = {
  I: [[[0, 1], [1, 1], [2, 1], [3, 1]], [[2, 0], [2, 1], [2, 2], [2, 3]], [[0, 2], [1, 2], [2, 2], [3, 2]], [[1, 0], [1, 1], [1, 2], [1, 3]]],
  O: [[[1, 0], [2, 0], [1, 1], [2, 1]], [[1, 0], [2, 0], [1, 1], [2, 1]], [[1, 0], [2, 0], [1, 1], [2, 1]], [[1, 0], [2, 0], [1, 1], [2, 1]]],
  T: [[[1, 0], [0, 1], [1, 1], [2, 1]], [[1, 0], [1, 1], [2, 1], [1, 2]], [[0, 1], [1, 1], [2, 1], [1, 2]], [[1, 0], [0, 1], [1, 1], [1, 2]]],
  S: [[[1, 0], [2, 0], [0, 1], [1, 1]], [[1, 0], [1, 1], [2, 1], [2, 2]], [[1, 1], [2, 1], [0, 2], [1, 2]], [[0, 0], [0, 1], [1, 1], [1, 2]]],
  Z: [[[0, 0], [1, 0], [1, 1], [2, 1]], [[2, 0], [1, 1], [2, 1], [1, 2]], [[0, 1], [1, 1], [1, 2], [2, 2]], [[1, 0], [0, 1], [1, 1], [0, 2]]],
  J: [[[0, 0], [0, 1], [1, 1], [2, 1]], [[1, 0], [2, 0], [1, 1], [1, 2]], [[0, 1], [1, 1], [2, 1], [2, 2]], [[1, 0], [1, 1], [0, 2], [1, 2]]],
  L: [[[2, 0], [0, 1], [1, 1], [2, 1]], [[1, 0], [1, 1], [1, 2], [2, 2]], [[0, 1], [1, 1], [2, 1], [0, 2]], [[0, 0], [1, 0], [1, 1], [1, 2]]],
};

/** SRS kick tables from the wiki, Cartesian y (positive up). */
const WIKI_JLSTZ: Record<string, number[][]> = {
  '0>1': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]], '1>0': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
  '1>2': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]], '2>1': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  '2>3': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]], '3>2': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  '3>0': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]], '0>3': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
};
const WIKI_I: Record<string, number[][]> = {
  '0>1': [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]], '1>0': [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
  '1>2': [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]], '2>1': [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
  '2>3': [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]], '3>2': [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
  '3>0': [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]], '0>3': [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
};

test('golden SRS cell table: every piece and rotation matches the wiki picture', () => {
  for (const piece of ALL_PIECES) {
    for (const rotation of [0, 1, 2, 3]) {
      assert.equal(cellKey(cells(piece, rotation)), cellKey(SRS_CELLS[piece][rotation]), `${piece} rotation ${rotation}`);
    }
  }
  assert.equal(cellKey(cells('T', 5)), cellKey(SRS_CELLS.T[1]), 'rotation wraps modulo 4');
});

test('blocked-kick sweep: every kick of all 16 transitions lands where the SRS table says', () => {
  const probed = new Map<string, number>();
  let mismatches = 0;
  for (const type of ['T', 'J', 'L', 'S', 'Z', 'I'] as Piece[]) {
    const wiki = type === 'I' ? WIKI_I : WIKI_JLSTZ;
    for (const from of [0, 1, 2, 3] as Rotation[]) {
      for (const direction of [1, -1] as const) {
        const to = ((from + direction + 4) % 4) as Rotation;
        const offsets = wiki[`${from}>${to}`];
        for (let k = 0; k < offsets.length; k++) {
          const s = createGame('kick');
          s.board = emptyBoard();
          const piece = { type, x: 4, y: 8, rotation: from };
          const target = new Set(cells(type, to).map(([dx, dy]) => `${piece.x + offsets[k][0] + dx},${piece.y - offsets[k][1] + dy}`));
          // Fill every cell of the earlier kick targets that is not part of the k-th target.
          for (let j = 0; j < k; j++) {
            for (const [dx, dy] of cells(type, to)) {
              const x = piece.x + offsets[j][0] + dx;
              const y = piece.y - offsets[j][1] + dy;
              if (!target.has(`${x},${y}`)) s.board[y][x] = 'J';
            }
          }
          if (!fits(s, piece)) continue;
          const earlierStillOpen = Array.from({ length: k }, (_, j) => j)
            .some(j => fits(s, { ...piece, rotation: to, x: piece.x + offsets[j][0], y: piece.y - offsets[j][1] }));
          if (earlierStillOpen) continue;
          const result = rotate(s, piece, direction);
          const table = type === 'I' ? 'I' : 'JLSTZ';
          probed.set(`${table} ${from}>${to}`, (probed.get(`${table} ${from}>${to}`) ?? 0) + 1);
          const expected = { piece: { ...piece, rotation: to, x: piece.x + offsets[k][0], y: piece.y - offsets[k][1] }, kick: k };
          if (JSON.stringify(result) !== JSON.stringify(expected)) mismatches++;
        }
      }
    }
  }
  assert.equal(mismatches, 0);
  assert.equal(probed.size, 16, 'eight JLSTZ transitions and eight I transitions were probed');
  for (const [transition, count] of probed) assert.ok(count >= 1, `${transition} probed ${count} times`);
  assert.deepEqual(rotate(createGame('o'), { type: 'O', x: 3, y: 5, rotation: 0 }, 1), { piece: { type: 'O', x: 3, y: 5, rotation: 1 }, kick: 0 });
});

test('dimensions, five-piece preview, seven-bag, deterministic seed and purity', () => {
  let s = createGame('seed-01');
  const original = JSON.stringify(s);
  assert.equal(s.board.length, HEIGHT);
  assert.ok(s.board.every(row => row.length === WIDTH));
  assert.equal(s.next.length, 5);
  assert.deepEqual(s, createGame('seed-01'));
  assert.notEqual(stateHash(s), stateHash(createGame('seed-02')));
  applyPlacement(s, legalPlacements(s)[0]);
  assert.equal(JSON.stringify(s), original, 'applyPlacement must not mutate its input');
  const sequence: Piece[] = [];
  for (let i = 0; i < 140; i++) {
    sequence.push(s.active.type);
    s = applyPlacement(s, legalPlacements(s)[0]);
    // Clear the board only in this bag test so survival does not censor the stream.
    s.board = emptyBoard();
    s.over = false;
  }
  for (let i = 0; i < sequence.length; i += 7) assert.equal(new Set(sequence.slice(i, i + 7)).size, 7);
});

test('every legal placement locks four cells in bounds; dropDistance matches the drop points', () => {
  for (const type of ALL_PIECES) {
    const s = createGame('shapes');
    s.active = { type, x: 3, y: 0, rotation: 0 };
    for (const p of legalPlacements(s)) {
      const next = applyPlacement(s, p);
      assert.equal(next.pieces, 1);
      assert.equal(next.board.flat().filter(Boolean).length, 4);
      const distance = dropDistance(s, p);
      assert.ok(distance >= 0);
      assert.equal(next.score - s.score, 2 * distance, 'no clears on an empty board, so the delta is the drop bonus');
    }
  }
  assert.equal(dropDistance(createGame('x'), { x: 99, rotation: 0 }), -1);
  assert.equal(simulatePlacement(createGame('x'), { x: 99, rotation: 0 }), null);
});

test('hold can be used once per piece, swaps without consuming preview, changes hash', () => {
  const s = createGame('hold');
  const held = applyHold(s);
  assert.equal(held.hold, s.active.type);
  assert.equal(held.active.type, s.next[0]);
  assert.equal(held.next.length, 5);
  assert.equal(applyHold(held), held);
  assert.notEqual(stateHash(s), stateHash(held));
  const locked = applyPlacement(held, legalPlacements(held)[0]);
  const swapped = applyHold(locked);
  assert.equal(swapped.active.type, s.active.type);
  assert.deepEqual(swapped.next, locked.next);
});

test('SRS T floor kick and I wall kick use ordered offsets', () => {
  const s = createGame('kicks');
  const t = { type: 'T' as const, x: 3, y: 18, rotation: 0 as const };
  assert.ok(fits(s, t));
  assert.deepEqual(rotate(s, t, 1), { piece: { type: 'T', x: 2, y: 17, rotation: 1 }, kick: 2 });
  const i = { type: 'I' as const, x: -2, y: 5, rotation: 1 as const };
  assert.ok(fits(s, i));
  assert.deepEqual(rotate(s, i, -1), { piece: { type: 'I', x: 0, y: 5, rotation: 0 }, kick: 1 });
});

function tetris(s: GameState): GameState {
  s.board = Array.from({ length: HEIGHT }, (_, y) => Array.from({ length: WIDTH }, (_, x) => (y >= 16 && x !== 4 ? 'J' : null)));
  s.board[0][0] = 'J'; // No perfect-clear bonus.
  s.active = { type: 'I', x: 2, y: 0, rotation: 1 };
  return applyPlacement(s, { x: 2, rotation: 1 });
}

test('Tetris scoring, back-to-back, combos and level boundaries', () => {
  let s = tetris(createGame('score'));
  assert.deepEqual(s.lastClear, { lines: 4, spin: 'none', points: 800 });
  s = tetris(s);
  assert.equal(s.lastClear.points, 1250, '800 x 1.5 back-to-back + 50 combo');
  assert.equal(s.lines, 8);
  s = tetris(s);
  assert.equal(s.lastClear.points, 1300);
  assert.equal(s.level, 2);
  s = tetris(s);
  assert.equal(s.lastClear.points, 2700);
});

test('a normal clear breaks back-to-back, a no-clear placement preserves it, combo resets', () => {
  const s = createGame('b2b');
  s.backToBack = true;
  s.combo = 0;
  s.active = { type: 'I', x: 3, y: 18, rotation: 0 };
  for (let x = 0; x < WIDTH; x++) if (x < 3 || x > 6) s.board[19][x] = 'J';
  s.board[0][0] = 'J';
  const single = applyPlacement(s, { x: 3, rotation: 0 });
  assert.deepEqual(single.lastClear, { lines: 1, spin: 'none', points: 150 }, '100 single + 50 x combo 1');
  assert.equal(single.backToBack, false);
  assert.equal(single.combo, 1);

  const quiet = createGame('quiet');
  quiet.backToBack = true;
  quiet.combo = 2;
  const placed = applyPlacement(quiet, legalPlacements(quiet)[0]);
  assert.equal(placed.backToBack, true, 'a no-clear placement leaves back-to-back untouched');
  assert.equal(placed.combo, -1, 'a no-clear placement resets the combo');
  assert.equal(placed.lastClear.points, 0);
});

test('perfect clears: single 800 bonus, Tetris 2000, back-to-back Tetris 3200', () => {
  const single = createGame('pc');
  single.active = { type: 'I', x: 3, y: 18, rotation: 0 };
  for (let x = 0; x < WIDTH; x++) if (x < 3 || x > 6) single.board[19][x] = 'J';
  assert.equal(applyPlacement(single, { x: 3, rotation: 0 }).lastClear.points, 900);

  const pc = createGame('pc-tetris');
  const tetrisPc = (s: GameState): GameState => {
    s.board = Array.from({ length: HEIGHT }, (_, y) => Array.from({ length: WIDTH }, (_, x) => (y >= 16 && x !== 4 ? 'J' : null)));
    s.active = { type: 'I', x: 2, y: 0, rotation: 1 };
    return applyPlacement(s, { x: 2, rotation: 1 });
  };
  const first = tetrisPc(pc);
  assert.equal(first.lastClear.points, 2800, '800 Tetris + 2000 perfect clear');
  const second = tetrisPc(first);
  assert.equal(second.lastClear.points, 4450, '1200 back-to-back Tetris + 3200 perfect clear + 50 combo');
});

test('T-spin credit needs a final rotation with no drop: spawn-height spins are phantoms', () => {
  // A vertical T dropped 15 rows beside a wall onto a step used to be credited as a mini (v2 BUG-1).
  const s = createGame('phantom');
  s.active = { type: 'T', x: 3, y: -1, rotation: 0 };
  for (let y = 12; y < HEIGHT; y++) s.board[y][0] = 'J';
  for (let y = 16; y < HEIGHT; y++) s.board[y][2] = 'J';
  assert.ok(legalPlacements(s).some(p => p.x === 0 && p.rotation === 1));
  const result = simulatePlacement(s, { x: 0, rotation: 1 })!;
  assert.equal(result.dropDistance, 15);
  assert.deepEqual(result.state.lastClear, { lines: 0, spin: 'none', points: 0 });
  assert.equal(result.state.score, 30, 'only the drop bonus');
  assert.equal(result.state.backToBack, false);

  // The same shape completing a row (three corners occupied) is a plain single, not a mini single, and does not arm back-to-back.
  const line = createGame('phantom-line');
  line.active = { type: 'T', x: 3, y: -1, rotation: 0 };
  for (let y = 12; y < HEIGHT; y++) line.board[y][0] = 'J';
  for (let y = 18; y < HEIGHT; y++) line.board[y][2] = 'J';
  for (let x = 3; x < WIDTH; x++) {
    line.board[18][x] = 'J';
    line.board[19][x] = 'J';
  }
  const cleared = simulatePlacement(line, { x: 0, rotation: 1 })!;
  assert.equal(cleared.dropDistance, 17);
  assert.deepEqual(cleared.state.lastClear, { lines: 1, spin: 'none', points: 100 });
  assert.equal(cleared.state.backToBack, false);
});

test('T-spin credit is given when the rotation is the last move (dropDistance 0)', () => {
  const s = createGame('spin');
  s.active = { type: 'T', x: 3, y: 17, rotation: 3 };
  for (let x = 0; x < WIDTH; x++) if (x < 3 || x > 5) s.board[18][x] = 'J';
  s.board[17][3] = 'J';
  s.board[17][5] = 'J';
  s.board[19][3] = 'J';
  assert.ok(fits(s, s.active));
  const result = simulatePlacement(s, { x: 3, rotation: 0 })!;
  assert.equal(result.dropDistance, 0);
  assert.deepEqual(result.state.lastClear, { lines: 1, spin: 'full', points: 800 });
  assert.equal(result.state.backToBack, true);
});

test('every credited spin in random spawn-height play has a zero drop distance', () => {
  let placements = 0;
  for (let seed = 0; seed < 40; seed++) {
    let g = createGame(`spin-${seed}`);
    let rng = seed + 3;
    for (let step = 0; step < 300 && !g.over; step++) {
      if (g.active.type === 'T') {
        for (const p of legalPlacements(g)) {
          const result = simulatePlacement(g, p)!;
          placements++;
          if (result.state.lastClear.spin !== 'none') assert.equal(result.dropDistance, 0);
        }
      }
      const legal = legalPlacements(g);
      rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0;
      g = applyPlacement(g, legal[rng % legal.length]);
    }
  }
  assert.ok(placements > 1000);
});

test('twin placements of I, S and Z collapse to one candidate per outcome', () => {
  for (const type of ['I', 'S', 'Z'] as const) {
    const s = createGame('twins');
    s.active = { type, x: 3, y: -1, rotation: 0 };
    const input = inputFor(s, 'IQ');
    const grids = new Set(input.candidates.map(c => JSON.stringify(c.grid)));
    assert.equal(legalPlacements(s).length, 34, `${type} has 34 reachable (x, rotation) pairs`);
    assert.equal(input.candidates.length, 17, `${type} has 17 distinct outcomes`);
    assert.equal(grids.size, input.candidates.length);
    for (const candidate of input.candidates) {
      assert.ok(candidate.placement.rotation === 0 || candidate.placement.rotation === 1, 'the twin with more drop points (lower box) wins, then the lower rotation');
      assert.equal(candidate.dropPoints + candidate.clearPoints, candidate.scoreDelta);
    }
  }
});

test('lock-out records the visible cells, scores nothing and does not spawn', () => {
  const s = createGame('lock-out');
  assert.equal(s.active.type, 'I');
  // Rows 1..19 are full except column 0, so nothing clears and a vertical I cannot fall below row 0.
  for (let y = 1; y < HEIGHT; y++) {
    for (let x = 1; x < WIDTH; x++) s.board[y][x] = 'J';
  }
  const before = s.board.flat().filter(Boolean).length;
  assert.ok(legalPlacements(s).some(p => p.x === 4 && p.rotation === 1));
  const result = simulatePlacement(s, { x: 4, rotation: 1 })!;
  const after = result.state;
  assert.equal(result.dropDistance, 0);
  assert.equal(after.over, true);
  assert.equal(after.pieces, 0);
  assert.equal(after.score, 0);
  assert.equal(after.lines, 0);
  assert.deepEqual(after.lastClear, { lines: 0, spin: 'none', points: 0 });
  assert.equal(after.board.flat().filter(Boolean).length, before + 1, 'only the visible cell of the fatal piece is written');
  assert.equal(after.board[0][6], 'I');
  assert.equal(after.active.type, 'I', 'no new piece is spawned');
  assert.deepEqual(after.next, s.next);
  assert.deepEqual(legalPlacements(after), [], 'a finished game has no legal placements');
  const blocked = createGame('blocked');
  blocked.board[0].fill('J');
  assert.equal(applyHold(blocked).over, true, 'a blocked spawn tops out');
});

test('gravity: a resting piece locks on the next step, stepGravity keeps the tick, no tick cap in the engine', () => {
  let g = createGame('grav');
  let steps = 0;
  while (!g.over && g.pieces === 0) {
    g = advanceGravity(g);
    steps++;
  }
  assert.equal(steps, 20, 'an I at spawn falls 19 rows then locks');
  assert.equal(g.tick, 20);
  assert.equal(g.pieces, 1);
  assert.equal(g.score, 0, 'gravity earns no drop points');
  assert.equal(g.holdUsed, false);
  const stepped = stepGravity(createGame('grav'));
  assert.equal(stepped.tick, 0);
  assert.equal(stepped.active.y, 0);
  assert.equal(advanceGravity(createGame('fall')).active.y, 0);
  const capped = { ...createGame('cap'), tick: MAX_TICKS - 1 };
  const beyond = advanceGravity(capped);
  assert.equal(beyond.tick, MAX_TICKS);
  assert.equal(beyond.over, false, 'the harness owns the tick cap');
  assert.equal(gravityIntervalMs({ level: 1 }), 1000);
  assert.equal(gravityIntervalMs({ level: 99 }), 16);
  const illegal = createGame('illegal');
  assert.equal(applyPlacement(illegal, { x: 99, rotation: 0 }), illegal, 'an unreachable placement returns the same state');
});

test('late placement cannot teleport through an occupied wall', () => {
  const s = createGame('wall');
  s.active = { type: 'O', x: 0, y: 15, rotation: 0 };
  for (let y = 0; y < HEIGHT; y++) s.board[y][4] = 'J';
  assert.ok(legalPlacements(s).every(p => p.x <= 1));
  assert.equal(applyPlacement(s, { x: 6, rotation: 0 }), s);
});

test('state hash survives a JSON round trip and does not depend on key order', () => {
  const s = applyPlacement(createGame('hash'), legalPlacements(createGame('hash'))[0]);
  const roundTripped = JSON.parse(JSON.stringify(s)) as GameState;
  assert.equal(stateHash(roundTripped), stateHash(s));
  const reordered = { ...s, active: { rotation: s.active.rotation, y: s.active.y, x: s.active.x, type: s.active.type } };
  assert.equal(stateHash(reordered), stateHash(s));
  const hidden = { ...s, rng: 42, bag: ['I', 'T'] as Piece[], seed: 'other' };
  assert.equal(stateHash(hidden), stateHash(s), 'hidden bag, RNG and seed are not part of the hash');
  assert.notEqual(stateHash({ ...s, score: s.score + 1 }), stateHash(s));
  assert.notEqual(stateHash({ ...s, active: { ...s.active, y: s.active.y + 1 } }), stateHash(s));
});

test('frozen seed-01 canonical replay hashes (tetris-bench@3)', () => {
  let s = createGame('seed-01');
  const hashes: string[] = [];
  for (let i = 0; i < 12; i++) {
    const choices = legalPlacements(s);
    s = applyPlacement(s, choices[(i * 7) % choices.length]);
    hashes.push(stateHash(s));
  }
  assert.deepEqual(hashes, ['f1bae4d6', '9e5ac53f', '17c67b7e', '329767de', 'a98e1276', '82d6c61f', '27afbbb0', 'bf39455b', '895489b5', 'deaa21d4', 'f9954f20', '066c12a8']);
  assert.equal(s.score, 340);
  assert.equal(s.pieces, 12);
});

test('40 deterministic mixed-action games preserve board and stream invariants', () => {
  for (let seed = 0; seed < 40; seed++) {
    let s = createGame(`stress-${seed}`);
    let twin = createGame(`stress-${seed}`);
    let rng = seed + 1;
    for (let step = 0; step < 400 && !s.over; step++) {
      rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0;
      const before = JSON.stringify(s);
      const options = legalPlacements(s);
      const pick = options[rng % options.length];
      const action = (state: GameState): GameState => {
        if (rng % 5 === 0) return applyHold(state);
        if (rng % 5 === 1) return advanceGravity(state);
        return applyPlacement(state, pick);
      };
      const next = action(s);
      twin = action(twin);
      assert.equal(JSON.stringify(s), before, 'actions must not mutate their input');
      s = next;
      assert.deepEqual(s, twin);
      assert.equal(stateHash(s), stateHash(twin));
      assert.equal(s.board.length, HEIGHT);
      assert.ok(s.board.every(row => row.length === WIDTH));
      assert.ok(s.board.flat().every(cell => cell === null || 'IOTSZJL'.includes(cell)));
      if (!s.over) assert.equal(s.board.flat().filter(Boolean).length, 4 * s.pieces - WIDTH * s.lines);
      assert.equal(s.next.length, 5);
      assert.equal(s.level, 1 + Math.floor(s.lines / 10));
      assert.ok(Number.isSafeInteger(s.score) && s.score >= 0);
      assert.ok(s.bag.length <= 7);
      if (!s.over) assert.ok(fits(s, s.active), 'live active piece cannot overlap settled cells');
    }
  }
});

test('frozen rules source fingerprint: deliberate version review required to update', () => {
  assert.equal(RULESET, 'tetris-bench@3');
  const source = readFileSync(new URL('../../lib/tetris-bench/engine.ts', import.meta.url));
  assert.equal(createHash('sha256').update(source).digest('hex'), '38426052e336ed4e6798a84627d68958c3f0e12cdf3e19ebd06c6ab76c29dad4');
});
