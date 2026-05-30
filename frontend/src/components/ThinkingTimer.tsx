import { useState, useEffect, useRef } from "react";
import type { GamePhase } from "../types";

interface ThinkingTimerProps {
  phase: GamePhase;
  playerName: string;
}

export default function ThinkingTimer({
  phase,
  playerName,
}: ThinkingTimerProps) {
  const [seconds, setSeconds] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevPhaseRef = useRef(phase);

  useEffect(() => {
    if (prevPhaseRef.current !== phase) setSeconds(0);
    prevPhaseRef.current = phase;
    if (phase === "playing" || phase === "thinking") {
      intervalRef.current = setInterval(() => setSeconds((s) => s + 1), 1000);
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [phase]);

  if (phase !== "playing" && phase !== "thinking") return null;

  const isThinking = phase === "thinking";
  const label = isThinking ? "AI thinking" : `${playerName}'s turn`;

  return (
    <div
      className={`mt-3 flex items-center justify-between rounded-xl px-4 py-3 border
                     transition-all duration-300
                     ${
                       isThinking
                         ? "bg-amber-500/10 border-amber-500/30"
                         : "glass-card border-neutral-700/30"
                     }`}
    >
      <div className="flex items-center gap-2.5">
        <span className="relative flex h-2 w-2 shrink-0">
          <span
            className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75
            ${isThinking ? "bg-amber-400" : "bg-sky-400"}`}
          />
          <span
            className={`relative inline-flex rounded-full h-2 w-2
            ${isThinking ? "bg-amber-500" : "bg-sky-500"}`}
          />
        </span>
        <span
          className={`text-sm font-medium ${isThinking ? "text-amber-200" : "text-neutral-300"}`}
        >
          {label}
        </span>
      </div>
      <span
        className={`font-mono font-bold text-sm tabular-nums
        ${isThinking ? "text-amber-400" : "text-neutral-400"}`}
      >
        {seconds}s
      </span>
    </div>
  );
}
