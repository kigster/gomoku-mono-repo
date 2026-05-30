import { useState, useEffect } from "react";
import type { GamePhase, PlayerSide, DisplayMode } from "../types";

interface GameStatusProps {
  phase: GamePhase;
  playerName: string;
  playerSide: PlayerSide;
  displayMode: DisplayMode;
  winner: string;
  moveCount: number;
  error: string | null;
  stats: { won: number; lost: number } | null;
  humanTotalMs: number;
  aiTotalMs: number;
  lastHumanMoveMs: number;
  lastAiMoveMs: number;
  turnStartMs: number;
  isHumanTurn: boolean;
}

function formatTime(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min === 0) return `${sec}s`;
  return `${min}:${sec.toString().padStart(2, "0")}`;
}

export default function GameStatus({
  phase,
  playerName,
  playerSide,
  displayMode,
  winner,
  moveCount,
  error,
  stats,
  humanTotalMs,
  aiTotalMs,
  lastHumanMoveMs,
  lastAiMoveMs,
  turnStartMs,
  isHumanTurn,
}: GameStatusProps) {
  const isStones = displayMode === "stones";
  const blackLabel = isStones ? "Black" : "X";
  const whiteLabel = isStones ? "White" : "O";

  const blackPlayer = playerSide === "X" ? playerName : "AI";
  const whitePlayer = playerSide === "O" ? playerName : "AI";

  // X moves first; even moveCount = X's turn
  const nextIsX = moveCount % 2 === 0;

  const nextPlayerName = nextIsX
    ? playerSide === "X"
      ? playerName
      : "AI"
    : playerSide === "O"
      ? playerName
      : "AI";

  const isActive =
    phase === "playing" || phase === "thinking" || phase === "gameover";

  // 1-second ticker for live display
  const [, setTick] = useState(0);
  useEffect(() => {
    if (phase !== "playing" && phase !== "thinking") return;
    const interval = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(interval);
  }, [phase]);

  const now = Date.now();
  const currentMoveElapsed = turnStartMs > 0 ? now - turnStartMs : 0;

  const humanCurrentMove = isHumanTurn ? currentMoveElapsed : lastHumanMoveMs;
  const humanTotal = isHumanTurn
    ? humanTotalMs + currentMoveElapsed
    : humanTotalMs;
  const isAiThinking = phase === "thinking";
  const aiCurrentMove = isAiThinking ? currentMoveElapsed : lastAiMoveMs;
  const aiTotal = isAiThinking ? aiTotalMs + currentMoveElapsed : aiTotalMs;

  // Map timing to each card
  const blackIsHuman = playerSide === "X";
  const blackCurrentMs = blackIsHuman ? humanCurrentMove : aiCurrentMove;
  const blackTotalMs = blackIsHuman ? humanTotal : aiTotal;
  const whiteCurrentMs = !blackIsHuman ? humanCurrentMove : aiCurrentMove;
  const whiteTotalMs = !blackIsHuman ? humanTotal : aiTotal;

  const isBlackTurn = (phase === "playing" || phase === "thinking") && nextIsX;
  const isWhiteTurn = (phase === "playing" || phase === "thinking") && !nextIsX;

  // Winner message
  let winnerText = "";
  if (phase === "gameover") {
    const youWon = winner === playerSide;
    const draw = winner === "draw";
    if (draw) {
      winnerText = "It's a draw!";
    } else if (youWon) {
      winnerText = `${playerName} wins! Gomoku Master!`;
    } else {
      const aiSideLabel = isStones
        ? playerSide === "X"
          ? "White"
          : "Black"
        : playerSide === "X"
          ? "O"
          : "X";
      winnerText = `AI (${aiSideLabel}) wins this round. Try again?`;
    }
  }

  return (
    <div className="w-full mb-3">
      {/* ── Player cards ─────────────────────────── */}
      <div className="flex gap-2 sm:gap-3 mb-2">
        {/* Black / X */}
        <div
          className={`flex-1 rounded-xl px-3 py-2.5 border transition-all duration-300
          ${
            isBlackTurn
              ? "bg-neutral-800/90 border-amber-500/50 shadow-[0_0_18px_rgba(245,158,11,0.13)]"
              : "glass-card border-neutral-700/30"
          }`}
        >
          <div className="flex items-center gap-1.5 mb-1">
            <span
              className={`text-[10px] uppercase tracking-widest font-bold
              ${isBlackTurn ? "text-amber-400" : "text-neutral-600"}`}
            >
              {blackLabel}
            </span>
            {isBlackTurn && phase === "thinking" && (
              <span className="flex gap-0.5 items-center">
                {[0, 1, 2].map((i) => (
                  <span
                    key={i}
                    className="w-1 h-1 rounded-full bg-amber-400 animate-bounce"
                    style={{ animationDelay: `${i * 0.15}s` }}
                  />
                ))}
              </span>
            )}
          </div>
          <p
            className={`font-semibold text-sm leading-snug mb-1.5 truncate
            ${isBlackTurn ? "text-neutral-100" : "text-neutral-400"}`}
          >
            {blackPlayer}
          </p>
          <p className="font-mono text-xs tabular-nums">
            <span
              className={isBlackTurn ? "text-amber-400" : "text-neutral-600"}
            >
              {isActive ? formatTime(blackCurrentMs) : "—"}
            </span>
            {isActive && (
              <span className="text-neutral-700">
                {" "}
                · {formatTime(blackTotalMs)}
              </span>
            )}
          </p>
        </div>

        {/* Move counter */}
        <div className="flex flex-col items-center justify-center gap-0.5 px-1 sm:px-2 min-w-[2.5rem]">
          <span className="text-neutral-700 text-[9px] uppercase tracking-wider font-medium">
            Move
          </span>
          <span
            className={`font-mono font-bold text-lg leading-none
            ${isActive ? "text-neutral-200" : "text-neutral-700"}`}
          >
            {isActive ? moveCount + (phase === "gameover" ? 0 : 1) : "—"}
          </span>
          <span className="text-neutral-700 text-[9px] uppercase tracking-wider font-medium">
            vs
          </span>
        </div>

        {/* White / O */}
        <div
          className={`flex-1 rounded-xl px-3 py-2.5 border transition-all duration-300
          ${
            isWhiteTurn
              ? "bg-neutral-800/90 border-amber-500/50 shadow-[0_0_18px_rgba(245,158,11,0.13)]"
              : "glass-card border-neutral-700/30"
          }`}
        >
          <div className="flex items-center gap-1.5 mb-1">
            <span
              className={`text-[10px] uppercase tracking-widest font-bold
              ${isWhiteTurn ? "text-amber-400" : "text-neutral-600"}`}
            >
              {whiteLabel}
            </span>
            {isWhiteTurn && phase === "thinking" && (
              <span className="flex gap-0.5 items-center">
                {[0, 1, 2].map((i) => (
                  <span
                    key={i}
                    className="w-1 h-1 rounded-full bg-amber-400 animate-bounce"
                    style={{ animationDelay: `${i * 0.15}s` }}
                  />
                ))}
              </span>
            )}
          </div>
          <p
            className={`font-semibold text-sm leading-snug mb-1.5 truncate
            ${isWhiteTurn ? "text-neutral-100" : "text-neutral-400"}`}
          >
            {whitePlayer}
          </p>
          <p className="font-mono text-xs tabular-nums">
            <span
              className={isWhiteTurn ? "text-amber-400" : "text-neutral-600"}
            >
              {isActive ? formatTime(whiteCurrentMs) : "—"}
            </span>
            {isActive && (
              <span className="text-neutral-700">
                {" "}
                · {formatTime(whiteTotalMs)}
              </span>
            )}
          </p>
        </div>
      </div>

      {/* ── Status bar ───────────────────────────── */}
      <div
        className="glass-card rounded-lg px-4 py-2 text-center"
        style={{ minHeight: "2.5rem" }}
      >
        {error ? (
          <span className="text-red-400 text-sm font-medium">{error}</span>
        ) : phase === "idle" ? (
          <span className="text-neutral-500 text-sm">
            Configure settings and press Start Game
          </span>
        ) : phase === "playing" ? (
          <span className="text-neutral-300 text-sm font-medium">
            {nextPlayerName}'s turn
          </span>
        ) : phase === "thinking" ? (
          <span className="text-amber-400 text-sm font-medium animate-pulse-slow">
            AI is calculating the best move…
          </span>
        ) : phase === "gameover" ? (
          <>
            <span className="text-amber-400 font-bold text-sm block">
              {winnerText}
            </span>
            {stats && stats.won + stats.lost > 0 && (
              <span className="text-neutral-500 text-xs">
                {stats.won}W · {stats.lost}L ·{" "}
                {Math.round((stats.won / (stats.won + stats.lost)) * 100)}% win
                rate
              </span>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}
