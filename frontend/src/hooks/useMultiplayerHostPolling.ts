import { useEffect, useRef, useState } from "react";
import {
  getGame,
  type MultiplayerGameView,
  type MultiplayerGamePreview,
} from "../lib/multiplayerClient";
import { pollingIntervalForElapsedMs } from "./pollingSchedule";

interface Args {
  /** Auth token. Polling pauses when null. */
  token: string | null;
  /** Game code to poll. Polling pauses when null. */
  code: string | null;
  /** Stop polling when state ≠ 'waiting'. Default: true. */
  stopWhenNotWaiting?: boolean;
  /** Hard cap (ms) — stop after this elapsed wall time even if state is still 'waiting'. Default: 15 minutes. */
  maxAgeMs?: number;
}

interface State {
  /** Most recent server view (full or preview). */
  view: MultiplayerGameView | MultiplayerGamePreview | null;
  /** Seconds since polling started. */
  secondsWaited: number;
  /** True once we've stopped polling because we hit `maxAgeMs`. */
  expired: boolean;
  /** Polling-network error (transient). */
  error: string | null;
}

/**
 * Polls `/multiplayer/{code}` for the **host** while they wait for a guest.
 * Cadence is wall-clock-tiered (see `pollingSchedule.ts`): 300 ms for the
 * first 10 minutes, then 2 s up to 30 min, 3 s up to 60 min, 5 s after.
 */
export function useMultiplayerHostPolling({
  token,
  code,
  stopWhenNotWaiting = true,
  maxAgeMs = 15 * 60 * 1000,
}: Args): State {
  const [view, setView] = useState<
    MultiplayerGameView | MultiplayerGamePreview | null
  >(null);
  const [secondsWaited, setSecondsWaited] = useState(0);
  const [expired, setExpired] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Tick the seconds counter once a second.
  useEffect(() => {
    if (!token || !code) return;
    setSecondsWaited(0);
    const t = setInterval(() => setSecondsWaited((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [token, code]);

  // Poll loop with backoff.
  const cancelledRef = useRef(false);
  useEffect(() => {
    cancelledRef.current = false;
    if (!token || !code) return;

    let lastVersion: number | undefined = undefined;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const startedAt = Date.now();

    const tick = async () => {
      if (cancelledRef.current) return;
      const elapsed = Date.now() - startedAt;
      if (elapsed >= maxAgeMs) {
        setExpired(true);
        return;
      }
      try {
        const v = await getGame(token, code, lastVersion);
        if (cancelledRef.current) return;
        if (v !== null) {
          lastVersion = v.version;
          setView(v);
          setError(null);
          if (stopWhenNotWaiting && v.state !== "waiting") return;
        }
      } catch (err) {
        if (!cancelledRef.current) {
          setError(err instanceof Error ? err.message : "poll_failed");
        }
      }
      if (!cancelledRef.current) {
        timeout = setTimeout(
          tick,
          pollingIntervalForElapsedMs(Date.now() - startedAt),
        );
      }
    };

    timeout = setTimeout(tick, pollingIntervalForElapsedMs(0));
    return () => {
      cancelledRef.current = true;
      if (timeout) clearTimeout(timeout);
    };
  }, [token, code, stopWhenNotWaiting, maxAgeMs]);

  return { view, secondsWaited, expired, error };
}
