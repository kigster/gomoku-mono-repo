import type { GameSettings } from "./types";

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
  }
}

function gtag(
  command: string,
  action: string,
  params?: Record<string, unknown>,
) {
  if (window.gtag) {
    window.gtag(command, action, params);
  }
}

// Generate a UUID v4 for game_id
function uuid(): string {
  return crypto.randomUUID();
}

let currentGameId: string | null = null;
let currentUser: string | null = null;

export function setAnalyticsUser(username: string | null) {
  currentUser = username;
}

export function getGameId(): string | null {
  return currentGameId;
}

// ── Auth Events ──────────────────────────────────────────────────────

export function trackSignup(username: string) {
  gtag("event", "gomoku.auth.signup", { user: username });
}

export function trackLogin(username: string) {
  gtag("event", "gomoku.auth.login", { user: username });
}

export function trackLogout(username: string) {
  gtag("event", "gomoku.auth.logout", { user: username });
}

// ── Game Lifecycle ───────────────────────────────────────────────────

export function trackGameStart(settings: GameSettings) {
  currentGameId = uuid();
  gtag("event", "gomoku.game.start", {
    game_id: currentGameId,
    user: currentUser,
    depth: settings.aiDepth,
    radius: settings.aiRadius,
    timeout: settings.aiTimeout,
    board_size: settings.boardSize,
    human_plays: settings.playerSide,
    undo: settings.undoEnabled,
  });
}

export function trackGameFinish(
  winnerSide: "X" | "O" | "draw",
  playerSide: "X" | "O",
  playerName: string,
  humanTimeSec: number,
  aiTimeSec: number,
  moveCount?: number,
  depth?: number,
) {
  const humanWon = winnerSide === playerSide;
  gtag("event", "gomoku.game.end", {
    game_id: currentGameId,
    user: playerName,
    winner: humanWon ? "human" : winnerSide === "draw" ? "draw" : "ai",
    winner_side: winnerSide,
    moves: moveCount,
    depth,
    human_time_sec: humanTimeSec,
    ai_time_sec: aiTimeSec,
  });
}

export function trackGameAbort() {
  gtag("event", "gomoku.game.abort", {
    game_id: currentGameId,
    user: currentUser,
  });
  currentGameId = null;
}

export function trackUndo() {
  gtag("event", "gomoku.game.undo", {
    game_id: currentGameId,
    user: currentUser,
  });
}

// ── UI Events ────────────────────────────────────────────────────────

export function trackModalOpen(modal: string) {
  gtag("event", `gomoku.opened.${modal}`, { user: currentUser });
}

export function trackModalClose(modal: string) {
  gtag("event", `gomoku.closed.${modal}`, { user: currentUser });
}

export function trackJsonDownload() {
  gtag("event", "gomoku.downloaded.json", {
    game_id: currentGameId,
    user: currentUser,
  });
}

// ── Performance Events ───────────────────────────────────────────────

export function trackTimeout(configuredTimeoutSec: number) {
  gtag("event", "gomoku.game.timeout", {
    game_id: currentGameId,
    user: currentUser,
    configured_timeout_sec: configuredTimeoutSec,
  });
}

export function trackCriticalTimeout(attempts: number) {
  gtag("event", "gomoku.game.critical_timeout", {
    game_id: currentGameId,
    user: currentUser,
    number_of_attempts: attempts,
  });
}

// Legacy — kept for backward compat
export function trackEntered(name: string) {
  gtag("event", "gomoku.auth.entered", { name });
}

export function trackAbandoned() {
  gtag("event", "gomoku.auth.abandoned", {});
}
