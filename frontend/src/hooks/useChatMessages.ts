import { useCallback, useEffect, useRef, useState } from 'react'
import { pollingIntervalForElapsedMs } from './pollingSchedule'

/**
 * One persisted chat message — mirrors the API's `ChatMessage` Pydantic
 * model. `speaker_is_me` is the server's view of whose message it is
 * (compared against the auth token's user), so the bubble side never
 * disagrees with persistence.
 */
export interface PersistedChatMessage {
  id: string
  speaker_username: string
  speaker_is_me: boolean
  message: string
  created_at: string
}

interface UseChatMessagesArgs {
  /** Auth token. Polling pauses when null. */
  token: string | null
  /** Multiplayer game code. Polling pauses when null (e.g. the home-page
   *  right-rail variant of ChatPanel, which is local-only). */
  code: string | null
  /** Backend base URL. */
  apiBase: string
}

interface UseChatMessagesResult {
  messages: PersistedChatMessage[]
  /** True until the first poll completes. The UI uses this to avoid
   *  flashing "no messages yet" before the initial load. */
  loading: boolean
  /** Most recent transport error from a poll or POST, or null. */
  error: string | null
  /** Persist a message and append it to the local list. The promise
   *  resolves with the stored row (so callers like ChatPanel can grab
   *  the server-generated id/created_at for ordering). */
  send: (message: string) => Promise<PersistedChatMessage>
}

/**
 * Persistence + polling for in-game chat messages. Polls
 * `GET /chat/{code}/messages?since=<count seen>` on the same wall-clock
 * cadence the board uses (see `pollingSchedule.ts`) so the conversation
 * stays in sync without doubling the polling budget.
 *
 * Returns local messages in append order. The `since` query param uses
 * the offset of messages already seen, so the response only carries the
 * delta — cheap on every tick once the chat is warm.
 */
export function useChatMessages ({
  token,
  code,
  apiBase,
}: UseChatMessagesArgs): UseChatMessagesResult {
  const [messages, setMessages] = useState<PersistedChatMessage[]>([])
  const [loading, setLoading] = useState<boolean>(!!token && !!code)
  const [error, setError] = useState<string | null>(null)
  // `seenCount` lives in a ref so we can pass the latest value to fetches
  // inside the async polling loop without re-running the whole effect on
  // every message arrival. Mirrors `messages.length` after each merge.
  const seenCountRef = useRef<number>(0)
  const stoppedRef = useRef<boolean>(false)

  useEffect(() => {
    if (!token || !code) {
      setMessages([])
      setLoading(false)
      seenCountRef.current = 0
      return
    }
    stoppedRef.current = false
    setLoading(true)
    setMessages([])
    seenCountRef.current = 0
    const startedAt = Date.now()

    const tick = async () => {
      if (stoppedRef.current) return
      try {
        const since = seenCountRef.current
        const resp = await fetch(
          `${apiBase}/chat/${code}/messages?since=${since}`,
          { headers: { Authorization: `Bearer ${token}` } },
        )
        if (stoppedRef.current) return
        if (resp.status === 401 || resp.status === 403 || resp.status === 404) {
          // Stop polling on terminal HTTP errors — these aren't retryable
          // on the same code/token combo and would just spam the network log.
          stoppedRef.current = true
          setError(`HTTP ${resp.status}`)
          setLoading(false)
          return
        }
        if (resp.ok) {
          const body = (await resp.json()) as { messages: PersistedChatMessage[] }
          if (body.messages.length > 0) {
            setMessages(prev => {
              // Append-only path: dedup by id so an in-flight `send` that
              // pre-populated the list doesn't double up when the poll
              // returns the same row.
              const seenIds = new Set(prev.map(m => m.id))
              const fresh = body.messages.filter(m => !seenIds.has(m.id))
              const next = fresh.length === 0 ? prev : [...prev, ...fresh]
              seenCountRef.current = next.length
              return next
            })
          }
          setError(null)
        } else {
          setError(`HTTP ${resp.status}`)
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'poll_failed')
      } finally {
        setLoading(false)
      }
      if (!stoppedRef.current) {
        setTimeout(tick, pollingIntervalForElapsedMs(Date.now() - startedAt))
      }
    }
    void tick()

    return () => {
      stoppedRef.current = true
    }
  }, [token, code, apiBase])

  const send = useCallback(
    async (message: string): Promise<PersistedChatMessage> => {
      if (!token || !code) {
        throw new Error('chat is not persisted in this context')
      }
      const resp = await fetch(`${apiBase}/chat/${code}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ message }),
      })
      if (!resp.ok) {
        const text = await resp.text().catch(() => '')
        throw new Error(text || `HTTP ${resp.status}`)
      }
      const persisted = (await resp.json()) as PersistedChatMessage
      // Append immediately so the speaker sees their own bubble without
      // waiting on the next poll tick. The dedup in the poll handler
      // collapses any duplicate the GET would surface next.
      setMessages(prev => {
        if (prev.some(m => m.id === persisted.id)) return prev
        const next = [...prev, persisted]
        seenCountRef.current = next.length
        return next
      })
      return persisted
    },
    [token, code, apiBase],
  )

  return { messages, loading, error, send }
}
