/**
 * Board features shared by the builtin heuristics and the hosted-model
 * evidence rendering. One implementation so every brain reads the same
 * numbers. Browser-safe: no Node imports.
 */
import { HEIGHT, WIDTH } from './engine.ts';
import type { Board } from './engine.ts';

export interface BoardFeatures {
  /** Per column: 20 minus the first filled row, 0 for an empty column. */
  heights: number[];
  maxHeight: number;
  aggregateHeight: number;
  /** Empty cells with any filled cell above them in the same column. */
  holes: number;
  /** Sum of |h[x] - h[x + 1]| over adjacent columns. */
  bumpiness: number;
  /** Sum over columns of max(0, min(left, right) - h); the walls count as height 20. */
  wells: number;
  /** Filled/empty changes along each row, with both walls treated as filled. */
  rowTransitions: number;
  /** Filled/empty changes down each column, with the sky empty and the floor filled. */
  colTransitions: number;
}

function columnHeight(board: Board, x: number): number {
  for (let y = 0; y < HEIGHT; y++) {
    if (board[y][x] !== null) return HEIGHT - y;
  }
  return 0;
}

export function boardFeatures(board: Board): BoardFeatures {
  const heights = Array.from({ length: WIDTH }, (_, x) => columnHeight(board, x));

  let holes = 0;
  let wells = 0;
  let colTransitions = 0;
  for (let x = 0; x < WIDTH; x++) {
    for (let y = HEIGHT - heights[x]; y < HEIGHT; y++) {
      if (board[y][x] === null) holes++;
    }
    const left = x === 0 ? HEIGHT : heights[x - 1];
    const right = x === WIDTH - 1 ? HEIGHT : heights[x + 1];
    wells += Math.max(0, Math.min(left, right) - heights[x]);

    let previousFilled = false;
    for (let y = 0; y < HEIGHT; y++) {
      const filled = board[y][x] !== null;
      if (filled !== previousFilled) colTransitions++;
      previousFilled = filled;
    }
    if (!previousFilled) colTransitions++;
  }

  let rowTransitions = 0;
  for (const row of board) {
    let previousFilled = true;
    for (const cell of row) {
      const filled = cell !== null;
      if (filled !== previousFilled) rowTransitions++;
      previousFilled = filled;
    }
    if (!previousFilled) rowTransitions++;
  }

  let bumpiness = 0;
  for (let x = 0; x + 1 < WIDTH; x++) {
    bumpiness += Math.abs(heights[x] - heights[x + 1]);
  }

  return {
    heights,
    maxHeight: Math.max(...heights),
    aggregateHeight: heights.reduce((sum, h) => sum + h, 0),
    holes,
    bumpiness,
    wells,
    rowTransitions,
    colTransitions,
  };
}
