import type { GameSettings } from "./types";

export const DEFAULT_SETTINGS: GameSettings = {
  aiDepth: 5,
  aiRadius: 2,
  aiTimeout: "none",
  displayMode: "stones",
  playerSide: "X",
  boardSize: 19,
  undoEnabled: true,
};

export const TIMEOUT_OPTIONS = [
  { label: "None", value: "none" },
  { label: "30s", value: "30" },
  { label: "60s", value: "60" },
  { label: "120s", value: "120" },
  { label: "300s", value: "300" },
];

// Star points (hoshi) for 19x19 board
export const STAR_POINTS_19: [number, number][] = [
  [3, 3],
  [3, 9],
  [3, 15],
  [9, 3],
  [9, 9],
  [9, 15],
  [15, 3],
  [15, 9],
  [15, 15],
];

// Star points for 15x15 board
export const STAR_POINTS_15: [number, number][] = [
  [3, 3],
  [3, 7],
  [3, 11],
  [7, 3],
  [7, 7],
  [7, 11],
  [11, 3],
  [11, 7],
  [11, 11],
];

// Fixed board pixel size to prevent layout jumps
export const BOARD_PX = 600;

// Inner margin (px) between the board edge and the outer grid lines. Single
// source of truth: Board.tsx draws/hit-tests with it, and the Playwright e2e
// (e2e-pw/support.ts) imports it to compute click coordinates.
export const PADDING = 24;
