import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Board from './Board'
import ChatPanel from './ChatPanel'
import SettingsPanel from './SettingsPanel'
import SidePanelTabs, { type SidePanelTab } from './SidePanelTabs'
import WaitingForOpponent from './WaitingForOpponent'
import { DEFAULT_SETTINGS } from '../constants'
import {
  joinGame,
  isParticipantView,
  MultiplayerApiError,
  type Color,
  type MultiplayerGameView,
} from '../lib/multiplayerClient'
import { useMultiplayerPolling } from '../hooks/useMultiplayerPolling'
import type { CellValue } from '../types'

const API_BASE = (import.meta.env.VITE_API_BASE as string) || ''

interface MultiplayerGamePageProps {
  token: string
  code: string
  username: string
}

/**
 * Map API `detail` strings to user-friendly messages. Per
 * `doc/multiplayer-bugs.md` item #6 — every join failure must surface as
 * something the user can read and act on.
 */
function joinDetailToMessage(status: number, detail: string): string {
  const map: Record<string, string> = {
    multiplayer_game_not_found: 'This invitation link is not valid.',
    game_already_full: 'Someone has already joined this game.',
    cannot_join_own_game: 'You cannot join your own invitation.',
    game_cancelled: 'This invitation was cancelled or expired.',
    game_not_in_waiting_state: 'This game has already started.',
    chosen_color_required: 'Please choose your color before joining.',
    chosen_color_not_allowed: 'The host already picked the color.',
  }
  return map[detail] ?? `Could not join (${status}). Please try again.`
}

function buildBoard(
  size: number,
  moves: [number, number][],
): CellValue[][] {
  const board: CellValue[][] = Array.from({ length: size }, () =>
    Array<CellValue>(size).fill('empty'),
  )
  moves.forEach(([x, y], idx) => {
    if (x < 0 || x >= size || y < 0 || y >= size) return
    board[x][y] = idx % 2 === 0 ? 'X' : 'O'
  })
  return board
}

export default function MultiplayerGamePage({
  token,
  code,
  username,
}: MultiplayerGamePageProps) {
  const { game, loading, error, expired, sendMove, sendResign, refresh } =
    useMultiplayerPolling(token, code)
  const [joining, setJoining] = useState(false)
  const [joinError, setJoinError] = useState<string | null>(null)
  // Right-rail tab — defaults to 'multi' so the chat panel is in front
  // of the user the moment they land on the multiplayer page. They can
  // flip to 'solo' to inspect the (read-only) AI settings if they want
  // to compare, but the chat is the relevant surface here.
  const [sideTab, setSideTab] = useState<SidePanelTab>('multi')
  // Guest's chosen color for `color_chosen_by='guest'` games. Set via the
  // pick-color screen before the auto-join fires.
  const [guestPickedColor, setGuestPickedColor] = useState<Color | null>(null)
  // At-most-once guard against the useEffect firing repeatedly while the
  // polled `game` is in flight. Without it, the cleanup-driven cancel of
  // the .then(refresh) chain leaves `game.state` stale at 'waiting', the
  // effect re-runs on the next render, and we hammer POST /join → 409.
  const joinAttemptedRef = useRef(false)
  useEffect(() => {
    joinAttemptedRef.current = false
  }, [code])

  // URL hygiene — once the game *transitions* into a terminal state
  // (finished / cancelled / abandoned) drop the /play/<code> path so a
  // refresh lands on the home page rather than re-fetching a finished game.
  // We only run on the transition (tracked via a ref); landing directly on
  // a finished game keeps the URL so the game-over panel stays visible
  // through subsequent re-renders / direct revisits.
  const prevStateRef = useRef<string | null>(null)
  // True once we've shown the "opponent has left" banner so the polling
  // loop doesn't re-trigger it on every refresh.
  const [opponentLeft, setOpponentLeft] = useState(false)
  useEffect(() => {
    if (!game) return
    const prev = prevStateRef.current
    prevStateRef.current = game.state
    const isTerminal = ['finished', 'cancelled', 'abandoned'].includes(game.state)
    const wasInProgress = prev !== null && !['finished', 'cancelled', 'abandoned'].includes(prev)
    if (isTerminal && wasInProgress && window.location.pathname !== '/') {
      window.history.replaceState({}, '', '/')
    }
    // "Opponent has left" banner — fired only on the in_progress →
    // abandoned transition. A win or draw goes to `finished`; a host
    // cancel of a never-joined game goes to `cancelled`. The only way
    // a live game lands in `abandoned` is the other side blocking us
    // (or a future timeout / admin action). We deliberately do NOT
    // surface "you were blocked" — that's a privacy norm. Just a
    // neutral message about the opponent leaving.
    if (
      game.state === 'abandoned' &&
      prev === 'in_progress' &&
      !opponentLeft
    ) {
      setOpponentLeft(true)
    }
  }, [game, opponentLeft])

  // If the loaded game is in `waiting` state and the caller isn't the host,
  // automatically POST /join — exactly once per `code`.
  useEffect(() => {
    if (!game || joining || joinAttemptedRef.current) return
    if (game.state !== 'waiting') return
    if (game.your_color !== null) return
    if (game.host.username === username) return
    // If the host wants the guest to pick the color, wait for the user.
    if (game.color_chosen_by === 'guest' && guestPickedColor === null) return

    joinAttemptedRef.current = true
    setJoining(true)
    setJoinError(null)
    joinGame(token, code, {
      chosen_color:
        game.color_chosen_by === 'guest' ? (guestPickedColor as Color) : undefined,
    })
      .then(() => refresh())
      .catch((err) => {
        if (err instanceof MultiplayerApiError) {
          setJoinError(joinDetailToMessage(err.status, err.detail))
        } else {
          setJoinError(err instanceof Error ? err.message : String(err))
        }
      })
      .finally(() => {
        setJoining(false)
      })
  }, [game, joining, token, code, username, refresh, guestPickedColor])

  const handleCellClick = useCallback(
    (row: number, col: number) => {
      if (!game || !isParticipantView(game)) return
      if (!game.your_turn) return
      void sendMove(row, col)
    },
    [game, sendMove],
  )

  const board = useMemo(() => {
    if (!game) return null
    const moves = isParticipantView(game) ? game.moves : []
    return buildBoard(game.board_size, moves)
  }, [game])

  if (loading && !game) {
    return (
      <div className="min-h-screen flex items-center justify-center text-neutral-300">
        Loading game…
      </div>
    )
  }

  if (!game) {
    return <ErrorPage message={error ?? 'Could not load game.'} />
  }

  // Cancelled/abandoned games — read-only result panel. We split the
  // copy by which transition got us here:
  //
  // - opponentLeft == true → we were in the middle of an in_progress
  //   game when the other side left (block, timeout, etc.). Neutral
  //   "Your opponent has left the game" message — we deliberately do
  //   not reveal a block as the proximate cause.
  // - otherwise the game was cancelled (host cancel) or expired
  //   without ever getting joined.
  if (game.state === 'cancelled' || game.state === 'abandoned') {
    return (
      <ErrorPage
        message={
          opponentLeft
            ? 'Your opponent has left the game.'
            : 'This invitation was cancelled or expired.'
        }
      />
    )
  }

  // Guest-picks-color step — show a small inline picker.
  const needsGuestColorPick =
    game.state === 'waiting' &&
    game.color_chosen_by === 'guest' &&
    game.host.username !== username &&
    guestPickedColor === null

  if (needsGuestColorPick) {
    return (
      <GuestColorPicker
        hostUsername={game.host.username}
        onPick={setGuestPickedColor}
      />
    )
  }

  if (joining) {
    return (
      <div className="min-h-screen flex items-center justify-center text-neutral-300">
        Joining game…
      </div>
    )
  }

  if (joinError) {
    return <ErrorPage message={joinError} />
  }

  if (expired) {
    return (
      <ErrorPage message="This game session has expired. Please start a new one." />
    )
  }

  const interactive =
    isParticipantView(game) &&
    game.state === 'in_progress' &&
    game.your_turn

  const lastMove: [number, number] | null = (() => {
    if (!isParticipantView(game) || game.moves.length === 0) return null
    const m = game.moves[game.moves.length - 1]
    return [m[0], m[1]]
  })()

  // Title format: "Gomoku — alice vs bob" once both players are present;
  // fall back to the bare host name (or the code) before the guest joins.
  const titleLabel = game.guest
    ? `${game.host.username} vs ${game.guest.username}`
    : `Game ${game.code}`

  // Opponent username drives the in-game chat panel header. Pick whichever
  // side of the pairing isn't us. Falls back to null while the guest hasn't
  // joined yet (chat panel will show its "no conversation" placeholder).
  const opponentUsername =
    game.guest && game.host.username === username
      ? game.guest.username
      : game.guest && game.guest.username === username
        ? game.host.username
        : null

  // Game-in-progress view reuses the SAME outer frame as the home page
  // (`game-panel` background + SidePanelTabs sidebar on the left + board
  // in the centre). The only differences from the home layout are:
  //   - left sidebar defaults to the Multi tab so the chat is in front;
  //   - the Solo tab shows a read-only SettingsPanel (multiplayer ignores
  //     local AI settings);
  //   - the centre column renders the multiplayer Board + PlayerHeader +
  //     resign control instead of the AI Board + GameStatus + Start/Abort.
  const showInGameLayout = game.state === 'in_progress' || game.state === 'finished'

  if (showInGameLayout) {
    return (
      <div className='flex justify-center px-2 sm:px-4 pb-4 sm:py-8 pt-4'>
        <div className='game-panel rounded-2xl p-4 sm:p-8 max-w-5xl w-full text-neutral-100'>
          <h1 className='font-heading text-2xl sm:text-3xl font-bold text-amber-400 text-center mb-4 sm:mb-6'>
            Gomoku — {titleLabel}
          </h1>
          <div className='flex flex-col lg:flex-row gap-4 sm:gap-8 items-center lg:items-start justify-center'>
            {/* Left panel: Settings/Chat tabs (same as home page) */}
            <div className='w-full lg:w-72 shrink-0 flex flex-col'>
              <SidePanelTabs
                active={sideTab}
                onChange={setSideTab}
                solo={
                  <SettingsPanel
                    settings={DEFAULT_SETTINGS}
                    onChange={() => {}}
                    disabled={true}
                  />
                }
                multi={
                  <ChatPanel
                    meUsername={username}
                    peerUsername={opponentUsername}
                    authToken={token}
                    apiBase={API_BASE}
                  />
                }
              />

              {isParticipantView(game) && game.state === 'in_progress' && (
                <div className='hidden lg:block mt-5'>
                  <button
                    onClick={() => {
                      if (window.confirm('Resign this game?')) void sendResign()
                    }}
                    className='w-full py-3 rounded-xl text-lg font-semibold font-heading
                               bg-red-700 hover:bg-red-600 active:bg-red-800
                               text-white shadow-md shadow-red-900/40
                               transition-all duration-200 hover:scale-[1.01]'
                  >
                    Resign
                  </button>
                </div>
              )}
            </div>

            {/* Centre: board + status */}
            <div className='flex flex-col items-center w-full lg:w-auto gap-4'>
              <PlayerHeader game={game as MultiplayerGameView} />
              {board && (
                <Board
                  board={board}
                  boardSize={game.board_size === 19 ? 19 : 15}
                  displayMode='stones'
                  interactive={interactive}
                  lastMove={lastMove}
                  onCellClick={handleCellClick}
                />
              )}
              {isParticipantView(game) && game.state === 'in_progress' && (
                <p className='text-neutral-300'>
                  {game.your_turn ? 'Your move.' : 'Waiting for opponent…'}
                </p>
              )}
              {/* Mobile-only resign button — desktop has it in the left rail. */}
              {isParticipantView(game) && game.state === 'in_progress' && (
                <button
                  onClick={() => {
                    if (window.confirm('Resign this game?')) void sendResign()
                  }}
                  className='lg:hidden px-4 py-2 rounded-lg bg-red-700 hover:bg-red-600 text-white font-semibold'
                >
                  Resign
                </button>
              )}
              {game.state === 'finished' && isParticipantView(game) && (
                <GameOverPanel game={game} username={username} />
              )}
              {error && (
                <p className='text-red-400 text-sm mt-2 max-w-md text-center'>
                  {error}
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className='min-h-screen px-4 py-6 text-neutral-100'>
      <div className='max-w-3xl mx-auto flex flex-col items-center gap-4'>
        <h1 className='font-heading text-3xl font-bold text-amber-400'>
          Gomoku — {titleLabel}
        </h1>

        {game.state === 'waiting' && <WaitingForOpponent code={game.code} />}

        {error && (
          <p className='text-red-400 text-sm mt-2 max-w-md text-center'>{error}</p>
        )}
      </div>
    </div>
  )
}

function GameOverPanel({
  game,
  username,
}: {
  game: MultiplayerGameView
  username: string
}) {
  const opponentUsername =
    game.host.username === username
      ? game.guest?.username ?? 'opponent'
      : game.host.username
  const youWon =
    game.your_color !== null && game.winner === game.your_color
  const isDraw = game.winner === 'draw'
  const elapsedSec =
    game.finished_at && game.created_at
      ? Math.max(
          1,
          Math.round(
            (new Date(game.finished_at).getTime() -
              new Date(game.created_at).getTime()) /
              1000,
          ),
        )
      : null

  let headline: string
  let detail: string | null = null
  if (isDraw) {
    headline = `Draw against @${opponentUsername}`
  } else if (youWon) {
    headline = `@${username} wins against @${opponentUsername}`
  } else {
    headline = 'Game Over'
    detail =
      elapsedSec !== null
        ? `Lost to @${opponentUsername} in ${elapsedSec} seconds.`
        : `Lost to @${opponentUsername}.`
  }

  return (
    <div className='mt-4 px-6 py-4 rounded-xl bg-neutral-800 border border-amber-500 text-center'>
      <h2 className='font-heading text-2xl text-amber-400 font-bold mb-1'>
        {headline}
      </h2>
      {detail && <p className='text-neutral-200'>{detail}</p>}
      <a
        href='/'
        className='inline-block mt-3 px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-neutral-900 font-semibold'
      >
        Back home
      </a>
    </div>
  )
}

function ErrorPage({ message }: { message: string }) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center text-neutral-200 gap-4 px-4 text-center">
      <p className="max-w-md">{message}</p>
      <a
        href="/"
        className="px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-neutral-900 font-semibold"
      >
        Back home
      </a>
    </div>
  )
}

function GuestColorPicker({
  hostUsername,
  onPick,
}: {
  hostUsername: string
  onPick: (c: Color) => void
}) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center text-neutral-100 gap-6 px-4">
      <h1 className="font-heading text-2xl font-bold text-amber-400 text-center">
        @{hostUsername} invited you — pick your color
      </h1>
      <div className="flex gap-3">
        <button
          onClick={() => onPick('X')}
          className="px-6 py-3 rounded-lg bg-neutral-100 text-neutral-900 font-bold border-2 border-amber-400 hover:bg-amber-100"
        >
          Black (X) — moves first
        </button>
        <button
          onClick={() => onPick('O')}
          className="px-6 py-3 rounded-lg bg-neutral-700 text-neutral-100 font-bold border-2 border-amber-400 hover:bg-neutral-600"
        >
          White (O)
        </button>
      </div>
    </div>
  )
}

function PlayerHeader({ game }: { game: MultiplayerGameView }) {
  const yourSide = game.your_color
  const hostLabel = `${game.host.username} (${game.host.color ?? '?'})`
  const guestLabel = game.guest
    ? `${game.guest.username} (${game.guest.color ?? '?'})`
    : '— waiting —'
  return (
    <div className="flex flex-wrap gap-4 justify-center text-neutral-300 text-sm">
      <div>
        Host: <span className="text-amber-300 font-semibold">{hostLabel}</span>
      </div>
      <div>
        Guest: <span className="text-amber-300 font-semibold">{guestLabel}</span>
      </div>
      {yourSide && (
        <div>
          You play: <span className="text-amber-300 font-semibold">{yourSide}</span>
        </div>
      )}
    </div>
  )
}
