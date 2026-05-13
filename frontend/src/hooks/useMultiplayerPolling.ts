import { useCallback, useEffect, useRef, useState } from 'react'
import {
  getGame,
  MultiplayerApiError,
  postMove,
  resignGame,
  type MultiplayerGameView,
  type MultiplayerGamePreview,
} from '../lib/multiplayerClient'
import { pollingIntervalForElapsedMs } from './pollingSchedule'

// Wall-clock caps before we stop polling and surface "this game has
// expired" to the user. See doc/multiplayer-bugs.md item #5. The poll
// cadence itself is tiered by elapsed time (see pollingSchedule.ts) —
// 300 ms for the first 10 min, then 2/3/5 s thereafter.
const MAX_AGE_WAITING_MS = 15 * 60 * 1000      // 15 min for `waiting` games
const MAX_AGE_IN_PROGRESS_MS = 8 * 60 * 60 * 1000 // 8 h for `in_progress`

export interface UseMultiplayerPollingResult {
  game: MultiplayerGameView | MultiplayerGamePreview | null
  isParticipant: boolean
  loading: boolean
  error: string | null
  /** True once the polling loop has timed out per `MAX_AGE_*_MS`. The UI
   *  should stop awaiting state changes and surface an "expired" message. */
  expired: boolean
  sendMove: (x: number, y: number) => Promise<void>
  sendResign: () => Promise<void>
  refresh: () => Promise<void>
}

/** Polls GET /multiplayer/{code}. When the server replies with the
 *  `{no_change: true}` sentinel (no update since the prior `version`),
 *  keeps the existing state. Stops polling once the game reaches
 *  `finished` or `abandoned`, or once the server returns 401 (in which
 *  case `onSessionExpired` fires and the loop terminates so we don't
 *  hammer the auth-failing endpoint every 300 ms). */
export function useMultiplayerPolling(
  token: string,
  code: string,
  onSessionExpired?: () => void,
): UseMultiplayerPollingResult {
  const [game, setGame] = useState<
    MultiplayerGameView | MultiplayerGamePreview | null
  >(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [expired, setExpired] = useState(false)
  const versionRef = useRef<number | null>(null)
  const stoppedRef = useRef(false)
  // Track when polling started so we can enforce the wall-clock cap and
  // pick the right tier from `pollingIntervalForElapsedMs`. The ref is
  // reset every time `code` changes.
  const startedAtRef = useRef<number>(Date.now())

  const refresh = useCallback(async () => {
    try {
      const result = await getGame(
        token,
        code,
        versionRef.current ?? undefined,
      )
      if (result === null) {
        // `{no_change: true}` — keep the prior state. Cadence is driven
        // by elapsed wall time (see pollingSchedule.ts).
        return
      }
      setGame(result)
      versionRef.current = result.version
      setError(null)
      if (
        result.state === 'finished' ||
        result.state === 'abandoned' ||
        result.state === 'cancelled'
      ) {
        stoppedRef.current = true
      }
    } catch (err) {
      // Terminal HTTP errors — no point retrying these every 300 ms:
      //   401: JWT decoded fine but the user record was missing
      //        (DB reset, deleted user, cross-env token). Hand off to
      //        the App so it can clear the session and surface the
      //        sign-in modal.
      //   403: caller has a valid session but is not allowed to see
      //        this game (not a participant on a non-public game, etc.).
      //   404: the game code doesn't exist (or was hard-deleted). The
      //        row isn't coming back; further polls just waste battery
      //        and spam the network log.
      if (err instanceof MultiplayerApiError) {
        if (err.status === 401) {
          stoppedRef.current = true
          setError(err.detail || 'Session expired')
          onSessionExpired?.()
          return
        }
        if (err.status === 404 || err.status === 403) {
          stoppedRef.current = true
          setError(err.detail || `HTTP ${err.status}`)
          return
        }
      }
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
    } finally {
      setLoading(false)
    }
  }, [token, code, onSessionExpired])

  // Initial fetch + polling loop with a max-age cutoff. Cadence comes
  // from `pollingIntervalForElapsedMs` — wall-clock-tiered, not no-change-stream.
  useEffect(() => {
    stoppedRef.current = false
    versionRef.current = null
    startedAtRef.current = Date.now()
    setExpired(false)
    let cancelled = false

    const tick = async () => {
      if (cancelled || stoppedRef.current) return
      const elapsed = Date.now() - startedAtRef.current
      const cap =
        game?.state === 'in_progress'
          ? MAX_AGE_IN_PROGRESS_MS
          : MAX_AGE_WAITING_MS
      if (elapsed >= cap) {
        stoppedRef.current = true
        setExpired(true)
        return
      }
      await refresh()
      if (!cancelled && !stoppedRef.current) {
        setTimeout(tick, pollingIntervalForElapsedMs(Date.now() - startedAtRef.current))
      }
    }
    tick()

    return () => {
      cancelled = true
    }
    // game?.state is intentionally a read-only escape hatch for the cap; we
    // don't want to restart polling on every state change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh])

  const sendMove = useCallback(
    async (x: number, y: number) => {
      if (!game || game.your_color === null) return
      const expectedVersion = game.version
      try {
        const updated = await postMove(token, code, x, y, expectedVersion)
        setGame(updated)
        versionRef.current = updated.version
        setError(null)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        setError(msg)
        // On version conflict, force a fresh poll to catch up.
        await refresh()
      }
    },
    [game, token, code, refresh],
  )

  const sendResign = useCallback(async () => {
    try {
      const updated = await resignGame(token, code)
      setGame(updated)
      versionRef.current = updated.version
      setError(null)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
    }
  }, [token, code])

  const isParticipant = game !== null && game.your_color !== null

  return { game, isParticipant, loading, error, expired, sendMove, sendResign, refresh }
}
