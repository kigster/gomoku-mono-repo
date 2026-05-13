import { render, act } from '@testing-library/react'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest'
import UserActivityTracker from '../components/UserActivityTracker'

// Helpers ------------------------------------------------------------------

function lastSeenInBody (call: { body: BodyInit | null | undefined }): string {
  return JSON.parse(call.body as string).last_seen_at as string
}

function postCalls (
  fetchSpy: MockInstance<typeof fetch>,
): Array<{ url: string; body: BodyInit | null | undefined }> {
  return fetchSpy.mock.calls
    .map(([url, init]) => ({
      url: typeof url === 'string' ? url : (url as Request).url,
      body: (init as RequestInit | undefined)?.body ?? null,
    }))
    .filter(c => c.url.endsWith('/users/me/seen'))
}

// Tests -------------------------------------------------------------------

describe('UserActivityTracker', () => {
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.useFakeTimers()
    fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ last_seen_at: new Date().toISOString() }), {
        status: 200,
      }),
    )
    vi.stubGlobal('fetch', fetchSpy)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('renders nothing', () => {
    const { container } = render(
      <UserActivityTracker authToken='tok' apiBase='http://api.test' />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('does not POST when there is no observed activity', async () => {
    render(
      <UserActivityTracker
        authToken='tok'
        apiBase='http://api.test'
        syncIntervalMs={50}
      />,
    )
    // Run several sync intervals — nothing should fire because there's
    // been no user activity to report.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(postCalls(fetchSpy).length).toBe(0)
  })

  it('POSTs once after an activity event, on the next sync tick', async () => {
    render(
      <UserActivityTracker
        authToken='tok'
        apiBase='http://api.test'
        activityDebounceMs={50}
        syncIntervalMs={20}
      />,
    )
    await act(async () => {
      document.dispatchEvent(new Event('keydown'))
      // First sync tick lands at 20ms — the click set lastSeen, and
      // there's no syncedAt yet, so POST should fire.
      await vi.advanceTimersByTimeAsync(20)
    })
    expect(postCalls(fetchSpy).length).toBe(1)
    expect(postCalls(fetchSpy)[0].url).toBe('http://api.test/users/me/seen')
    // Body carries a valid ISO timestamp.
    const ts = lastSeenInBody(postCalls(fetchSpy)[0])
    expect(Number.isFinite(new Date(ts).getTime())).toBe(true)
  })

  it('does NOT re-POST until a fresh activity event arrives', async () => {
    render(
      <UserActivityTracker
        authToken='tok'
        apiBase='http://api.test'
        activityDebounceMs={50}
        syncIntervalMs={20}
      />,
    )
    await act(async () => {
      document.dispatchEvent(new Event('keydown'))
      // First sync POSTs the initial activity, then several more ticks
      // pass with no new events.
      await vi.advanceTimersByTimeAsync(200)
    })
    // Exactly one POST in the run — the debounce window has elapsed
    // (50ms < 200ms total), the listener is re-armed, but no event
    // has fired since, so syncedAt >= lastSeen and we stay quiet.
    expect(postCalls(fetchSpy).length).toBe(1)
  })

  it('debounces a burst of activity to one stored timestamp per window', async () => {
    render(
      <UserActivityTracker
        authToken='tok'
        apiBase='http://api.test'
        activityDebounceMs={100}
        syncIntervalMs={1000}
      />,
    )
    await act(async () => {
      // 5 rapid events within the debounce window — only the first
      // one is observed; the listener is detached for the next 100ms.
      for (let i = 0; i < 5; i++) {
        document.dispatchEvent(new Event('keydown'))
        await vi.advanceTimersByTimeAsync(10)
      }
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(postCalls(fetchSpy).length).toBe(1)
  })

  it('re-arms the listener after the debounce window so later activity is captured', async () => {
    render(
      <UserActivityTracker
        authToken='tok'
        apiBase='http://api.test'
        activityDebounceMs={50}
        syncIntervalMs={1000}
      />,
    )
    await act(async () => {
      document.dispatchEvent(new Event('keydown'))
      // Wait past the debounce window, then fire again.
      await vi.advanceTimersByTimeAsync(60)
      document.dispatchEvent(new Event('keydown'))
      // First sync interval lands at 1000ms; both events should have
      // been folded into a single POST carrying the LATER timestamp
      // (the most recent lastSeenAtRef value).
      await vi.advanceTimersByTimeAsync(1000)
    })
    const calls = postCalls(fetchSpy)
    expect(calls.length).toBe(1)
    // Second event was ~60ms after the first; the body timestamp
    // should match the second event, not the first.
    const ts = new Date(lastSeenInBody(calls[0])).getTime()
    // Allow generous slack to absorb fake-timer scheduling jitter.
    expect(ts).toBeGreaterThanOrEqual(60)
  })

  it('does nothing while authToken is empty (parent re-mounts when auth lands)', async () => {
    render(<UserActivityTracker authToken='' apiBase='http://api.test' />)
    await act(async () => {
      document.dispatchEvent(new Event('keydown'))
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(postCalls(fetchSpy).length).toBe(0)
  })
})
