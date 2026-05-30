import { useEffect, useRef } from 'react'

interface UserActivityTrackerProps {
  authToken: string
  apiBase: string
  // Test seam: override the debounce / sync cadence so vitest doesn't
  // have to wait real wall-clock seconds. Production callers leave both
  // unset and get the spec defaults.
  activityDebounceMs?: number
  syncIntervalMs?: number
}

// Debounce window between consecutive "user is active" timestamps. Once
// an activity event fires, the listener is detached and re-armed only
// after this interval — keeps the work per interaction trivial.
const DEFAULT_ACTIVITY_DEBOUNCE_MS = 15_000
// How often the sync loop wakes and decides whether to POST.
const DEFAULT_SYNC_INTERVAL_MS = 60_000

// The set of DOM events that count as "user is here." Kept narrow on
// purpose: mouse/keyboard/touch + visibility regaining focus. We do NOT
// watch `mousemove` (fires hundreds of times per second on a normal
// browse session — the debounce would still re-arm forever, defeating
// any battery-saving intent).
const ACTIVITY_EVENTS: readonly (keyof DocumentEventMap)[] = [
  'click',
  'keydown',
  'scroll',
  'touchstart',
  'visibilitychange',
]

/**
 * Client-side presence tracker. Renders nothing.
 *
 * Watches the document for a small set of user-interaction events,
 * debounces them by `activityDebounceMs`, and POSTs the most recent
 * activity timestamp to `/users/me/seen` on a `syncIntervalMs`
 * cadence — but only when there's an unsynced timestamp to share.
 *
 * Spec: AGENT.md §2 ("Computing User's IDLE Time"). The principle is
 * to decouple in-tab activity tracking from server writes: the listener
 * runs free, the network call is rate-limited.
 */
export default function UserActivityTracker ({
  authToken,
  apiBase,
  activityDebounceMs = DEFAULT_ACTIVITY_DEBOUNCE_MS,
  syncIntervalMs = DEFAULT_SYNC_INTERVAL_MS,
}: UserActivityTrackerProps) {
  // Refs (not state) so the listener and the scheduler don't trigger
  // re-renders. There's nothing to render — the work is all side-effect.
  const lastSeenAtRef = useRef<Date | null>(null)
  const syncedAtRef = useRef<Date | null>(null)
  // True while the activity listener is attached. The "immediately
  // detach, re-arm after debounceMs" pattern from the spec turns a
  // potentially noisy event stream into one timestamp per window.
  const listenerArmedRef = useRef(false)
  const inFlightRef = useRef(false)

  useEffect(() => {
    // Bail entirely if we don't have credentials yet — the parent will
    // re-mount the tracker once auth is in.
    if (!authToken) return

    let rearmTimer: ReturnType<typeof setTimeout> | null = null
    let unmounted = false

    const onActivity = () => {
      if (unmounted) return
      lastSeenAtRef.current = new Date()
      detachListeners()
      listenerArmedRef.current = false
      // Re-arm after the debounce window. We don't bother coalescing
      // bursts past the debounce — the first event of a new window is
      // the one that counts.
      rearmTimer = setTimeout(() => {
        if (unmounted) return
        attachListeners()
        listenerArmedRef.current = true
      }, activityDebounceMs)
    }

    const attachListeners = () => {
      for (const ev of ACTIVITY_EVENTS) {
        // `passive: true` because we never preventDefault — it lets
        // the scroll handler avoid blocking the main thread.
        document.addEventListener(ev, onActivity, { passive: true })
      }
    }

    const detachListeners = () => {
      for (const ev of ACTIVITY_EVENTS) {
        document.removeEventListener(ev, onActivity)
      }
    }

    attachListeners()
    listenerArmedRef.current = true

    return () => {
      unmounted = true
      detachListeners()
      if (rearmTimer !== null) clearTimeout(rearmTimer)
    }
  }, [authToken, activityDebounceMs])

  useEffect(() => {
    if (!authToken) return
    let unmounted = false

    const sync = async () => {
      if (unmounted || inFlightRef.current) return
      const lastSeen = lastSeenAtRef.current
      if (!lastSeen) return
      const synced = syncedAtRef.current
      if (synced && synced.getTime() >= lastSeen.getTime()) return

      inFlightRef.current = true
      try {
        const resp = await fetch(`${apiBase}/users/me/seen`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${authToken}`,
          },
          body: JSON.stringify({ last_seen_at: lastSeen.toISOString() }),
        })
        if (resp.ok) {
          // Mark as synced — anything fresher arriving after this
          // moment will look "unsynced" and trigger the next POST.
          syncedAtRef.current = new Date()
        }
        // On non-200 we deliberately don't touch syncedAt — the next
        // tick will retry without piling up requests (the inFlight
        // guard above keeps overlapping attempts from happening).
      } catch {
        // Network errors fall through to the same retry-next-tick
        // path. We don't surface them — they're transient and a
        // user-visible alert for "presence sync failed" is noise.
      } finally {
        inFlightRef.current = false
      }
    }

    const id = setInterval(sync, syncIntervalMs)
    return () => {
      unmounted = true
      clearInterval(id)
    }
  }, [apiBase, authToken, syncIntervalMs])

  return null
}
