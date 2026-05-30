import { useEffect, useRef, useState } from 'react'

interface InviteAcceptModalProps {
  authToken: string
  apiBase: string
  meUsername: string
  // Test seam — production callers leave this unset and get the
  // default 5s cadence. The modal polls regardless of whether one is
  // currently open, so an invite that arrives between polls surfaces
  // within the cadence.
  pollIntervalMs?: number
  // Test seam — called instead of window.location.href = ... on
  // Accept, so vitest can observe the navigation.
  onAccept?: (code: string) => void
}

interface IncomingInvite {
  code: string
  invite_url: string
  host_username: string
  board_size: number
  created_at: string
  expires_at: string
  message: string | null
}

const DEFAULT_POLL_MS = 5_000

/**
 * Top-of-the-stack modal that surfaces incoming `/chat/invite` invites
 * for the authenticated user. Polls `GET /chat/incoming` and renders
 * the newest pending invite — Accept navigates to the join URL,
 * Decline POSTs `/chat/incoming/{code}/decline` (which cancels the
 * multiplayer game and writes a polite apology into the chat).
 *
 * z-50 is the highest layer in the app (every other modal is z-40 or
 * lower), so this modal renders above whatever the user happened to
 * be in the middle of — matching the spec's "above all other modals."
 */
export default function InviteAcceptModal ({
  authToken,
  apiBase,
  meUsername,
  pollIntervalMs = DEFAULT_POLL_MS,
  onAccept,
}: InviteAcceptModalProps) {
  const [invite, setInvite] = useState<IncomingInvite | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Dismissed codes — codes the user has already declined or accepted
  // in this session. Stops the modal from re-appearing for a code
  // whose row is briefly still 'waiting' in the next poll.
  const dismissedRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    if (!authToken) return
    let cancelled = false

    const poll = async () => {
      try {
        const resp = await fetch(`${apiBase}/chat/incoming`, {
          headers: { Authorization: `Bearer ${authToken}` },
        })
        if (!resp.ok) return
        const body = (await resp.json()) as { invites: IncomingInvite[] }
        if (cancelled) return
        const next = body.invites.find(i => !dismissedRef.current.has(i.code))
        setInvite(prev => {
          // Avoid flashing the modal off and back on between identical
          // polls. Only update if the code changed.
          if (!prev && !next) return prev
          if (prev && next && prev.code === next.code) return prev
          return next ?? null
        })
      } catch {
        // Polling failures are silent — the next tick retries. A
        // banner here would be noisier than valuable for a background
        // task the user didn't initiate.
      }
    }

    void poll()
    const id = setInterval(poll, pollIntervalMs)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [authToken, apiBase, pollIntervalMs])

  if (!invite) return null

  const dismiss = () => {
    dismissedRef.current.add(invite.code)
    setInvite(null)
    setError(null)
  }

  const handleAccept = () => {
    dismissedRef.current.add(invite.code)
    if (onAccept) {
      onAccept(invite.code)
    } else {
      window.location.href = `/play/${invite.code}`
    }
  }

  const handleDecline = async () => {
    setPending(true)
    setError(null)
    try {
      const resp = await fetch(
        `${apiBase}/chat/incoming/${invite.code}/decline`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${authToken}` },
        },
      )
      if (!resp.ok) {
        const raw = await resp.text().catch(() => '')
        throw new Error(raw || `HTTP ${resp.status}`)
      }
      dismiss()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not decline invite')
    } finally {
      setPending(false)
    }
  }

  return (
    <div
      className='fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4'
      role='dialog'
      aria-modal='true'
      aria-labelledby='invite-modal-title'
    >
      <div className='w-full max-w-md rounded-2xl bg-neutral-900 border border-amber-500/40 shadow-2xl p-6 space-y-4'>
        <h2
          id='invite-modal-title'
          className='font-heading text-xl font-bold text-amber-400 text-center tracking-wide'
        >
          [ CHAT & GAME INVITATION! ]
        </h2>
        <p className='text-neutral-200 leading-relaxed'>
          Hey{' '}
          <span className='text-amber-300 font-semibold'>@{meUsername}</span>!
          Another user{' '}
          <span className='text-amber-300 font-semibold'>
            @{invite.host_username}
          </span>{' '}
          would like to chat and play a game with you.
        </p>
        {invite.message && (
          <p className='text-neutral-300 leading-relaxed bg-neutral-800/70 border border-neutral-700 rounded-lg px-3 py-2'>
            Oh, and there is an attached message from{' '}
            <span className='text-amber-300 font-semibold'>
              @{invite.host_username}
            </span>
            ! <span className='font-mono text-amber-100'>{invite.message}</span>{' '}
            <span aria-hidden>😃</span>
          </p>
        )}
        {error && (
          <p className='text-red-400 text-sm'>{error}</p>
        )}
        <div className='flex items-center justify-end gap-3 pt-2'>
          <button
            type='button'
            onClick={handleDecline}
            disabled={pending}
            className='rounded-lg border border-neutral-600 text-neutral-200 px-4 py-2 text-sm hover:bg-neutral-800 disabled:opacity-50 disabled:cursor-not-allowed'
          >
            Decline
          </button>
          <button
            type='button'
            onClick={handleAccept}
            disabled={pending}
            className='rounded-lg bg-amber-500 text-neutral-900 font-semibold px-4 py-2 text-sm hover:bg-amber-400 disabled:opacity-50 disabled:cursor-not-allowed'
          >
            Accept
          </button>
        </div>
      </div>
    </div>
  )
}
