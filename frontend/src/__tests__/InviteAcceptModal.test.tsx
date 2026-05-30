import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest'
import InviteAcceptModal from '../components/InviteAcceptModal'

type FetchSpy = MockInstance<typeof fetch>

interface InviteShape {
  code: string
  invite_url: string
  host_username: string
  board_size: number
  created_at: string
  expires_at: string
  message: string | null
}

function makeInvite (overrides: Partial<InviteShape> = {}): InviteShape {
  return {
    code: 'ABCDEF',
    invite_url: 'http://api.test/play/ABCDEF',
    host_username: 'bob',
    board_size: 15,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
    message: null,
    ...overrides,
  }
}

function installFetchMock (invites: InviteShape[]) {
  const spy = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : (url as Request).url
    if (u.endsWith('/chat/incoming') && (!init || init.method == null)) {
      return new Response(JSON.stringify({ invites }), { status: 200 })
    }
    if (u.includes('/chat/incoming/') && u.endsWith('/decline')) {
      return new Response(JSON.stringify({ declined: true }), { status: 200 })
    }
    return new Response(JSON.stringify({}), { status: 200 })
  })
  vi.stubGlobal('fetch', spy)
  return spy as unknown as FetchSpy
}

describe('InviteAcceptModal', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('renders nothing when there are no incoming invites', async () => {
    installFetchMock([])
    const { container } = render(
      <InviteAcceptModal
        authToken='tok'
        apiBase='http://api.test'
        meUsername='kate'
        pollIntervalMs={50}
      />,
    )
    // Give the first poll a chance to land.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60)
    })
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })

  it('surfaces the modal when an invite arrives and shows the host/message', async () => {
    installFetchMock([
      makeInvite({ host_username: 'bob', message: 'hey wanna play?' }),
    ])
    render(
      <InviteAcceptModal
        authToken='tok'
        apiBase='http://api.test'
        meUsername='kate'
        pollIntervalMs={50}
      />,
    )
    await waitFor(() =>
      expect(
        screen.getByText(/CHAT & GAME INVITATION/i),
      ).toBeInTheDocument(),
    )
    expect(screen.getByText(/Hey/)).toBeInTheDocument()
    expect(screen.getByText(/@kate/)).toBeInTheDocument()
    expect(screen.getAllByText(/@bob/).length).toBeGreaterThan(0)
    expect(screen.getByText(/hey wanna play\?/)).toBeInTheDocument()
  })

  it('omits the attached-message line when the invite has no message', async () => {
    installFetchMock([makeInvite({ message: null })])
    render(
      <InviteAcceptModal
        authToken='tok'
        apiBase='http://api.test'
        meUsername='kate'
        pollIntervalMs={50}
      />,
    )
    await waitFor(() =>
      expect(
        screen.getByText(/CHAT & GAME INVITATION/i),
      ).toBeInTheDocument(),
    )
    expect(
      screen.queryByText(/there is an attached message/i),
    ).toBeNull()
  })

  it('Accept fires the onAccept callback with the code', async () => {
    installFetchMock([makeInvite({ code: 'ABCDEF' })])
    const accepted: string[] = []
    render(
      <InviteAcceptModal
        authToken='tok'
        apiBase='http://api.test'
        meUsername='kate'
        pollIntervalMs={50}
        onAccept={code => accepted.push(code)}
      />,
    )
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /accept/i })).toBeInTheDocument(),
    )
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    await user.click(screen.getByRole('button', { name: /accept/i }))
    expect(accepted).toEqual(['ABCDEF'])
  })

  it('Decline POSTs /chat/incoming/{code}/decline and dismisses', async () => {
    const fetchSpy = installFetchMock([makeInvite({ code: 'ABCDEF' })])
    render(
      <InviteAcceptModal
        authToken='tok'
        apiBase='http://api.test'
        meUsername='kate'
        pollIntervalMs={50}
      />,
    )
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /decline/i })).toBeInTheDocument(),
    )
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    await user.click(screen.getByRole('button', { name: /decline/i }))
    const declineCalls = fetchSpy.mock.calls.filter(([url]) => {
      const u = typeof url === 'string' ? url : (url as Request).url
      return u.endsWith('/chat/incoming/ABCDEF/decline')
    })
    expect(declineCalls.length).toBe(1)
    expect(
      (declineCalls[0][1] as RequestInit | undefined)?.method,
    ).toBe('POST')
    // After dismissal the dialog should be gone.
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).toBeNull(),
    )
  })

  it('does not re-open the modal for a code already dismissed (idempotent polling)', async () => {
    const invite = makeInvite({ code: 'XYZXYZ' })
    installFetchMock([invite])
    render(
      <InviteAcceptModal
        authToken='tok'
        apiBase='http://api.test'
        meUsername='kate'
        pollIntervalMs={20}
      />,
    )
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    await user.click(screen.getByRole('button', { name: /decline/i }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    // Server still says this code is pending — modal must NOT reappear.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
