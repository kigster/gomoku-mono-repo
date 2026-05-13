import { useState, useCallback, useEffect, useRef } from 'react'
import type { GameSettings } from './types'
import { DEFAULT_SETTINGS } from './constants'
import { useGameState } from './hooks/useGameState'
import {
  trackGameStart,
  trackGameFinish,
  trackGameAbort,
  trackUndo,
  trackModalOpen,
  trackModalClose,
  trackLogin,
  trackLogout,
  setAnalyticsUser
} from './analytics'
import AlertPanel, { showInfo, showError } from './components/AlertPanel'
import AuthModal from './components/AuthModal'
import SettingsPanel from './components/SettingsPanel'
import SidePanelTabs, { type SidePanelTab } from './components/SidePanelTabs'
import ChatPanel from './components/ChatPanel'
import Board from './components/Board'
import GameStatus from './components/GameStatus'
import ThinkingTimer from './components/ThinkingTimer'
import PreviousGames from './components/PreviousGames'
import JsonDebugModal from './components/JsonDebugModal'
import RulesModal from './components/RulesModal'
import AboutModal from './components/AboutModal'
import LeaderboardModal from './components/LeaderboardModal'
import DifficultySettingsModal from './components/DifficultySettingsModal'
import AmbientBackground from './components/AmbientBackground'
import MultiplayerGamePage from './components/MultiplayerGamePage'
import ChooseGameTypeModal from './components/ChooseGameTypeModal'
import logo from '../assets/images/logo.png'

const MULTIPLAYER_PATH_RE = /^\/play\/([A-Z2-9]{6})$/

function readMultiplayerCode(): string | null {
  const m = MULTIPLAYER_PATH_RE.exec(window.location.pathname)
  return m ? m[1] : null
}

const STORAGE_KEY = 'gomoku_username'
const TOKEN_KEY = 'gomoku_auth_token'
const API_BASE = import.meta.env.VITE_API_BASE || ''

async function extractErrorDetail (response: Response): Promise<string> {
  const text = await response.text().catch(() => '')
  if (!text) return ''

  try {
    const parsed = JSON.parse(text)
    if (typeof parsed.detail === 'string') return parsed.detail
    if (typeof parsed.error === 'string') return parsed.error
    return text
  } catch {
    return text
  }
}

export default function App () {
  const [playerName, setPlayerName] = useState<string | null>(() =>
    sessionStorage.getItem(STORAGE_KEY)
  )
  const [authToken, setAuthToken] = useState<string | null>(() =>
    sessionStorage.getItem(TOKEN_KEY)
  )

  // Set analytics user from persisted session
  if (playerName) setAnalyticsUser(playerName)

  // Compute once: does the URL contain a password reset token?
  const [hasResetToken, setHasResetToken] = useState(() =>
    new URLSearchParams(window.location.search).has('token')
  )

  const handleAuth = useCallback((username: string, token: string) => {
    window.history.replaceState({}, '', window.location.pathname)
    sessionStorage.setItem(STORAGE_KEY, username)
    sessionStorage.setItem(TOKEN_KEY, token)
    setPlayerName(username)
    setAuthToken(token)
    setHasResetToken(false)
    setAnalyticsUser(username)
    trackLogin(username)
    showInfo(`Welcome, ${username}!`)

    fetch(`${API_BASE}/user/me`, {
      headers: { Authorization: `Bearer ${token}` }
    })
      .then(r => (r.ok ? r.json() : null))
      .then(data => {
        if (data)
          setStats({ won: data.games_won ?? 0, lost: data.games_lost ?? 0, bestScore: data.personal_best?.score ?? null })
      })
      .catch(() => {})
  }, [])

  const handleSessionExpired = useCallback(() => {
    sessionStorage.removeItem(TOKEN_KEY)
    setAuthToken(null)
    showError('Session expired. Please log in again.')
  }, [])

  const [settings, setSettings] = useState<GameSettings>(DEFAULT_SETTINGS)
  const [showSettings, setShowSettings] = useState(false)
  const [stats, setStats] = useState<{ won: number; lost: number; bestScore: number | null } | null>(null)
  const prevPhaseRef = useRef<string>('idle')
  const lastAlertedErrorRef = useRef<string | null>(null)

  // Fetch win/loss stats from API on mount
  useEffect(() => {
    const token = sessionStorage.getItem(TOKEN_KEY)
    if (!token) return
    fetch(`${API_BASE}/user/me`, {
      headers: { Authorization: `Bearer ${token}` }
    })
      .then(r => {
        if (r.status === 401) {
          handleSessionExpired()
          return null
        }
        return r.ok ? r.json() : null
      })
      .then(data => {
        if (data)
          setStats({ won: data.games_won ?? 0, lost: data.games_lost ?? 0, bestScore: data.personal_best?.score ?? null })
      })
      .catch(() => {})
  }, [handleSessionExpired])

  const {
    board,
    phase,
    error,
    lastMove,
    moveCount,
    winner,
    humanTimeMs,
    aiTimeMs,
    humanTotalMs,
    aiTotalMs,
    lastHumanMoveMs,
    lastAiMoveMs,
    turnStartMs,
    isHumanTurn,
    gameState,
    startGame,
    makeMove,
    undoMove,
    resetGame
  } = useGameState(settings)

  useEffect(() => {
    if (!error) {
      lastAlertedErrorRef.current = null
      return
    }
    if (lastAlertedErrorRef.current === error) return
    lastAlertedErrorRef.current = error
    showError('API request failed.', error)
  }, [error])

  // Record win/loss when game ends
  useEffect(() => {
    if (
      prevPhaseRef.current !== 'gameover' &&
      phase === 'gameover' &&
      playerName
    ) {
      const isFinishedGame = winner !== 'none'
      const isDraw = winner === 'draw'

      if (isDraw) {
        showInfo('The game ended in a draw!')
      } else if (isFinishedGame) {
        const youWon = winner === settings.playerSide

        setStats(prev => {
          if (!prev) return { won: youWon ? 1 : 0, lost: youWon ? 0 : 1, bestScore: null }
          return {
            won: prev.won + (youWon ? 1 : 0),
            lost: prev.lost + (youWon ? 0 : 1),
            bestScore: prev.bestScore,
          }
        })

        if (youWon) {
          showInfo(`Congratulations ${playerName}! You won!`)
        } else {
          showError(
            `The AI won this round. Better luck next time, ${playerName}!`
          )
        }
      }

      // Save every finished game, including draws.
      if (isFinishedGame && authToken && gameState) {
        fetch(`${API_BASE}/game/save`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${authToken}`
          },
          body: JSON.stringify({ game_json: gameState, game_id: gameState.game_id })
        })
          .then(async r => {
            if (r.status === 401) {
              handleSessionExpired()
              throw new Error('Session expired')
            }
            if (!r.ok) {
              const detail = await extractErrorDetail(r)
              throw new Error(detail || `Game save failed (${r.status})`)
            }
            return r.json()
          })
          .then(data => {
            if (data.score > 0) {
              showInfo(`Score: ${data.score} (Rating: ${data.rating}/100)`)
            }
          })
          .catch(err => {
            const detail = err instanceof Error ? err.message : 'Unable to save game'
            if (detail !== 'Session expired') {
              showError('Failed to save finished game.', detail)
            }
          })
      }

      if (isFinishedGame) {
        trackGameFinish(
          winner,
          settings.playerSide,
          playerName,
          Math.round(humanTimeMs / 1000),
          Math.round(aiTimeMs / 1000),
          moveCount,
          settings.aiDepth
        )
      }
    }
    prevPhaseRef.current = phase
  }, [
    phase,
    winner,
    playerName,
    authToken,
    settings.playerSide,
    settings.aiDepth,
    settings.aiRadius,
    humanTimeMs,
    aiTimeMs,
    gameState,
    handleSessionExpired
  ])

  const boardRef = useRef<HTMLDivElement>(null)
  const footerRef = useRef<HTMLElement>(null)

  const scrollToBottom = useCallback(() => {
    if (window.innerWidth < 950) {
      setTimeout(() => {
        if (boardRef.current) {
          const rect = boardRef.current.getBoundingClientRect()
          const bottomOfBoard = rect.bottom + window.scrollY
          const target = bottomOfBoard - window.innerHeight
          window.scrollTo({ top: Math.max(0, target), behavior: 'smooth' })
        }
      }, 200)
    }
  }, [])

  const scrollToTop = useCallback(() => {
    if (window.innerWidth < 950) {
      setTimeout(() => {
        window.scrollTo({ top: 0, behavior: 'smooth' })
      }, 200)
    }
  }, [])

  const handleAbort = useCallback(() => {
    trackGameAbort()
    resetGame()
    scrollToTop()
  }, [resetGame, scrollToTop])
  const handleUndo = useCallback(() => {
    trackUndo()
    undoMove()
  }, [undoMove])

  const [showHistoryModal, setShowHistoryModal] = useState(false)
  const [showRulesModal, setShowRulesModal] = useState(false)
  const [showDifficultySettingsModal, setShowDifficultySettingsModal] = useState(false)
  const [showAboutModal, setShowAboutModal] = useState(false)
  const [showLeaderboardModal, setShowLeaderboardModal] = useState(false)
  const [showNavMenu, setShowNavMenu] = useState(false)
  // Show "Choose Game Type" once per login session; reset whenever the auth
  // token transitions from absent → present, dismissed permanently after
  // the user makes (or cancels) a selection.
  const [showChooseGameType, setShowChooseGameType] = useState<boolean>(false)
  const sawAuthRef = useRef<string | null>(authToken)
  useEffect(() => {
    if (authToken && sawAuthRef.current !== authToken) {
      sawAuthRef.current = authToken
      setShowChooseGameType(true)
    }
    if (!authToken) sawAuthRef.current = null
  }, [authToken])

  // Right-rail tab — Solo holds the AI settings, Multi holds the chat panel.
  // Default to Solo on load; auto-flip to Multi the moment the user clicks
  // "New Multiplayer Game" so they immediately see the chat-driven flow
  // they're opting into. They can manually flip back via the tab header.
  const [sideTab, setSideTab] = useState<SidePanelTab>('solo')

  // Click handler for "New Multiplayer Game" — opens the modal AND
  // auto-switches the tab to Multi so the chat is in front of the user
  // while they're hosting / pasting an opponent's code.
  const openMultiplayerFlow = useCallback(() => {
    setShowChooseGameType(true)
    setSideTab('multi')
  }, [])

  const isActive = phase === 'playing' || phase === 'thinking'

  const needsAuth = !playerName || !authToken || hasResetToken
  const multiplayerCode = readMultiplayerCode()

  // Multiplayer page route: requires auth, but otherwise short-circuits the
  // single-player UI entirely. When a not-logged-in user arrives via an
  // invite link, render the auth modal on top of an explanatory backdrop so
  // they understand WHY they're being asked to log in (and after auth the
  // URL still says /play/CODE, so the auto-join fires on the next render).
  if (multiplayerCode) {
    if (needsAuth) {
      return (
        <>
          <AlertPanel />
          <div className='fixed inset-0 z-40 flex items-center justify-center px-4 text-center text-neutral-200'>
            <div className='max-w-md space-y-3'>
              <h1 className='font-heading text-3xl font-bold text-amber-400'>
                You're invited to a Gomoku game
              </h1>
              <p className='text-neutral-300'>
                Game code: <span className='font-mono text-amber-300'>{multiplayerCode}</span>
              </p>
              <p className='text-sm text-neutral-400'>
                Sign in or create an account to join — we'll drop you straight
                into the game once you're in.
              </p>
            </div>
          </div>
          <AuthModal
            onAuth={handleAuth}
            apiBase={API_BASE}
            initialView={hasResetToken ? 'reset' : 'signup'}
          />
        </>
      )
    }
    return (
      <>
        <AlertPanel />
        <div className='min-h-screen relative z-10'>
          <AmbientBackground />
          <nav className='bg-neutral-800/95 backdrop-blur-sm border-b border-neutral-700 shadow-lg sticky top-0 z-40'>
            <div className='max-w-6xl mx-auto px-4 py-3 flex items-center justify-between'>
              <a href='/' className='flex items-center gap-3'>
                <img src={logo} alt='Gomoku' className='h-9 w-auto' />
                <h1 className='font-heading text-2xl font-bold text-amber-400'>
                  Gomoku
                </h1>
              </a>
              <span className='text-neutral-400 text-sm'>
                Hey,{' '}
                <span className='text-amber-400 font-semibold'>@{playerName}</span>
                {'! '}
              </span>
            </div>
          </nav>
          <MultiplayerGamePage
            token={authToken!}
            code={multiplayerCode}
            username={playerName!}
            onSessionExpired={handleSessionExpired}
          />
        </div>
      </>
    )
  }

  return (
    <>
      <AlertPanel />
      {needsAuth ? (
        <AuthModal
          onAuth={handleAuth}
          apiBase={API_BASE}
          initialView={hasResetToken ? 'reset' : undefined}
        />
      ) : (
        <div className='min-h-screen relative z-10'>
          {showChooseGameType && authToken && (
            <ChooseGameTypeModal
              authToken={authToken}
              onAIChosen={() => setShowChooseGameType(false)}
              onGuestJoined={code => {
                window.location.href = `/play/${code}`
              }}
              onClose={() => setShowChooseGameType(false)}
            />
          )}
          <AmbientBackground />
          {/* Navigation Bar */}
          <nav className='bg-neutral-800/95 backdrop-blur-sm border-b border-neutral-700 shadow-lg sticky top-0 z-40'>
            <div className='max-w-6xl mx-auto px-4 py-3 flex items-center justify-between'>
              <div className='flex items-center gap-3'>
                <img src={logo} alt='Gomoku' className='h-9 w-auto' />
                <h1 className='font-heading text-2xl font-bold text-amber-400'>
                  Gomoku
                </h1>
              </div>

              {/* Unified nav menu — visible dropdown on all screen sizes */}
              <div className='flex items-center gap-3 mr-5'>
                <span className='hidden sm:block text-neutral-400 text-sm'>
                  Hey,{' '}
                  <span className='text-amber-400 font-semibold'>@{playerName}</span>
                  {'! '}
                  {stats?.bestScore != null && (
                    <span className='text-neutral-500'>
                      (Highest Score:{' '}
                      <span className='text-neutral-300 font-medium'>{stats.bestScore}</span>
                      )
                    </span>
                  )}
                </span>
                <div className='relative'>
                  <button
                    onClick={() => setShowNavMenu(s => !s)}
                    className={`flex items-center gap-2 px-4 py-2 rounded-lg font-semibold
                               text-sm transition-all cursor-pointer border
                               ${showNavMenu
                                 ? 'bg-amber-500 text-neutral-900 border-amber-400'
                                 : 'bg-neutral-700 hover:bg-neutral-600 text-neutral-200 border-neutral-600 hover:border-neutral-500'
                               }`}
                    aria-label='Menu'
                    aria-expanded={showNavMenu}
                  >
                    <svg viewBox='0 0 24 24' width='16' height='16' fill='none'
                      stroke='currentColor' strokeWidth='2.5' strokeLinecap='round'>
                      <path d='M3 12h18' /><path d='M3 6h18' /><path d='M3 18h18' />
                    </svg>
                    <span>Menu</span>
                    <svg viewBox='0 0 24 24' width='14' height='14' fill='none'
                      stroke='currentColor' strokeWidth='2.5' strokeLinecap='round'
                      className={`transition-transform duration-200 ${showNavMenu ? 'rotate-180' : ''}`}>
                      <path d='M6 9l6 6 6-6' />
                    </svg>
                  </button>

                  {showNavMenu && (
                    <div className='absolute top-full right-0 z-[1001] mt-1
                                    min-w-[220px] overflow-hidden rounded-xl border border-neutral-700
                                    bg-neutral-800 shadow-2xl shadow-black/50'>
                      <div className='py-1'>
                        <button
                          onClick={() => {
                            setShowNavMenu(false)
                            trackModalOpen('rules')
                            setShowRulesModal(true)
                            window.scrollTo(0, 0)
                          }}
                          className='w-full px-4 py-3 text-left
                                     text-neutral-300 hover:text-white hover:bg-neutral-700
                                     transition-colors cursor-pointer text-[1.05rem] font-semibold'
                        >
                          Gomoku Rules
                        </button>
                        <button
                          onClick={() => {
                            setShowNavMenu(false)
                            trackModalOpen('difficulty')
                            setShowDifficultySettingsModal(true)
                            window.scrollTo(0, 0)
                          }}
                          className='w-full px-4 py-3 text-left
                                     text-neutral-300 hover:text-white hover:bg-neutral-700
                                     transition-colors cursor-pointer text-[1.05rem] font-semibold'
                        >
                          Difficulty Settings
                        </button>
                        <button
                          onClick={() => {
                            setShowNavMenu(false)
                            trackModalOpen('about')
                            setShowAboutModal(true)
                            window.scrollTo(0, 0)
                          }}
                          className='w-full px-4 py-3 text-left
                                     text-neutral-300 hover:text-white hover:bg-neutral-700
                                     transition-colors cursor-pointer text-[1.05rem] font-semibold'
                        >
                          About the Author
                        </button>
                        <hr className='my-1 border-neutral-700' />
                        <button
                          onClick={() => {
                            setShowNavMenu(false)
                            trackModalOpen('history')
                            setShowHistoryModal(true)
                            window.scrollTo(0, 0)
                          }}
                          className='w-full px-4 py-3 text-left
                                     text-neutral-300 hover:text-white hover:bg-neutral-700
                                     transition-colors cursor-pointer text-[1.05rem] font-semibold'
                        >
                          Your Game History
                        </button>
                        <button
                          onClick={() => {
                            setShowNavMenu(false)
                            trackModalOpen('leaderboard')
                            setShowLeaderboardModal(true)
                            window.scrollTo(0, 0)
                          }}
                          className='w-full px-4 py-3 text-left
                                     text-neutral-300 hover:text-white hover:bg-neutral-700
                                     transition-colors cursor-pointer text-[1.05rem] font-semibold'
                        >
                          Worldwide Leaderboard
                        </button>
                        <hr className='my-1 border-neutral-700' />
                        <JsonDebugModal
                          className='w-full px-4 py-3 text-left
                                     text-neutral-300 hover:text-white hover:bg-neutral-700
                                     transition-colors cursor-pointer text-[1.05rem] font-semibold'
                        />
                        <button
                          onClick={() => {
                            setShowNavMenu(false)
                            if (playerName) trackLogout(playerName)
                            sessionStorage.removeItem(TOKEN_KEY)
                            sessionStorage.removeItem(STORAGE_KEY)
                            setAnalyticsUser(null)
                            setAuthToken(null)
                            setPlayerName(null)
                          }}
                          className='w-full px-4 py-3 text-left
                                     text-red-400 hover:text-red-300 hover:bg-red-950/40
                                     transition-colors cursor-pointer text-[1.05rem] font-semibold'
                        >
                          Log Out
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Dropdown menu */}
            {showNavMenu && (
              <>
                <div
                  className='fixed inset-0 z-[1000]'
                  onClick={() => setShowNavMenu(false)}
                />
              </>
            )}
          </nav>

          {/* Main Content */}
          <div
            className={`flex justify-center px-2 sm:px-4 pb-4 sm:py-8 ${
              isActive ? 'pt-0 -mt-[30px]' : 'pt-4'
            } sm:mt-0`}
          >
            <div className='game-panel rounded-2xl p-4 sm:p-8 max-w-5xl w-full text-neutral-100'>
              <div className='flex flex-col lg:flex-row gap-4 sm:gap-8 items-center lg:items-start justify-center'>
                {/* Left panel: Settings */}
                <div className='w-full lg:w-72 shrink-0 flex flex-col'>
                  <button
                    onClick={() => setShowSettings(s => !s)}
                    className='lg:hidden w-full mb-3 py-2 rounded-lg bg-neutral-700 hover:bg-neutral-600
                           font-medium transition-all duration-200 hover:scale-[1.01]'
                  >
                    {showSettings ? 'Hide Settings' : 'Settings'}
                  </button>
                  {/* Wrapper uses grid-rows collapse + opacity so CSS transition works */}
                  <div
                    className={[
                      'grid overflow-hidden',
                      'transition-[grid-template-rows,opacity] duration-500 ease-in-out',
                      showSettings || !isActive
                        ? 'grid-rows-[1fr] opacity-100'
                        : 'grid-rows-[0fr] opacity-0 pointer-events-none',
                      'lg:!block lg:!opacity-100 lg:pointer-events-auto',
                    ].join(' ')}
                  >
                    <div className='overflow-hidden'>
                      <SidePanelTabs
                        active={sideTab}
                        onChange={setSideTab}
                        solo={
                          <SettingsPanel
                            settings={settings}
                            onChange={setSettings}
                            disabled={isActive}
                          />
                        }
                        multi={
                          authToken && playerName ? (
                            <ChatPanel
                              meUsername={playerName}
                              peerUsername={null}
                              authToken={authToken}
                              apiBase={API_BASE}
                              onActiveGameTerminated={handleAbort}
                            />
                          ) : (
                            <p className='text-center text-sm text-neutral-500 py-6'>
                              Sign in to use chat.
                            </p>
                          )
                        }
                      />
                    </div>
                  </div>

                  {/* Start / New Game Button — both primary actions share
                      identical typography and dimensions (text-lg /
                      font-semibold = 600 / py-3) so neither visually
                      dominates the other. */}
                  <div className='mt-5'>
                    {phase === 'idle' && (
                      <button
                        onClick={async () => {
                          setShowSettings(false)
                          trackGameStart(settings)
                          // Await /game/start so we can stamp the
                          // server-issued games.id onto the initial
                          // GameState. The save path later sends it
                          // back so `/game/save` UPDATEs the row in
                          // place rather than inserting a duplicate.
                          let gameId: string | undefined
                          if (authToken) {
                            try {
                              const resp = await fetch(`${API_BASE}/game/start`, {
                                method: 'POST',
                                headers: {
                                  Authorization: `Bearer ${authToken}`,
                                  'Content-Type': 'application/json',
                                },
                                body: JSON.stringify({
                                  board_size: settings.boardSize,
                                  depth: settings.aiDepth,
                                  radius: settings.aiRadius,
                                  human_player: settings.playerSide,
                                }),
                              })
                              if (resp.ok) {
                                const data = await resp.json()
                                if (typeof data.game_id === 'string') gameId = data.game_id
                              }
                            } catch {
                              // Non-fatal: lose UPDATE-in-place; the
                              // save path falls back to INSERT.
                            }
                          }
                          startGame(gameId)
                          scrollToBottom()
                        }}
                        className='w-full py-3 rounded-xl text-lg font-semibold font-heading
                               bg-amber-600 hover:bg-amber-500 active:bg-amber-700
                               ring-1 ring-amber-500/30 shadow-lg shadow-amber-900/40
                               transition-all duration-200 hover:shadow-amber-600/25
                               hover:shadow-xl hover:scale-[1.01]'
                      >
                        Start Game with AI
                      </button>
                    )}
                    {phase === 'idle' && (
                      <button
                        onClick={openMultiplayerFlow}
                        className='w-full mt-3 py-3 rounded-xl text-lg font-semibold font-heading
                               bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700
                               text-white shadow-md shadow-emerald-900/40
                               transition-all duration-200 hover:scale-[1.01]'
                      >
                        New Multiplayer Game
                      </button>
                    )}
                    {phase === 'gameover' && (
                      <button
                        onClick={handleAbort}
                        className='w-full py-3 rounded-xl text-lg font-semibold font-heading
                               glass-card border-neutral-600 hover:border-neutral-500
                               hover:bg-neutral-800/90 text-neutral-300 transition-all duration-200 hover:scale-[1.01]'
                      >
                        New Game
                      </button>
                    )}
                  </div>

                  {/* Undo Button + Timer + Abort — desktop/large only */}
                  {isActive && (
                    <div className='hidden lg:block mt-auto pt-5'>
                      {settings.undoEnabled && (
                        <button
                          onClick={handleUndo}
                          disabled={phase !== 'playing' || moveCount < 2}
                          className='w-full py-3 rounded-xl text-lg font-semibold font-heading
                                 bg-sky-700 hover:bg-sky-600 active:bg-sky-800
                                 text-white shadow-md shadow-sky-900/40 transition-all duration-200
                                 hover:scale-[1.01] disabled:opacity-30 disabled:cursor-not-allowed'
                        >
                          Undo
                        </button>
                      )}
                      <ThinkingTimer phase={phase} playerName={playerName} />
                      <button
                        onClick={handleAbort}
                        className='w-full mt-3 py-3 rounded-xl text-lg font-semibold font-heading
                               bg-red-700 hover:bg-red-600 active:bg-red-800
                               text-white shadow-md shadow-red-900/40 transition-all duration-200 hover:scale-[1.01]'
                      >
                        Abort Game
                      </button>
                    </div>
                  )}
                </div>

                {/* Center: Board + Status */}
                <div className='flex flex-col items-center w-full lg:w-auto'>
                  <GameStatus
                    phase={phase}
                    playerName={playerName}
                    playerSide={settings.playerSide}
                    displayMode={settings.displayMode}
                    winner={winner}
                    moveCount={moveCount}
                    error={null}
                    stats={stats}
                    humanTotalMs={humanTotalMs}
                    aiTotalMs={aiTotalMs}
                    lastHumanMoveMs={lastHumanMoveMs}
                    lastAiMoveMs={lastAiMoveMs}
                    turnStartMs={turnStartMs}
                    isHumanTurn={isHumanTurn}
                  />

                  {/* Mobile: Thinking timer + Abort/Undo row above board */}
                  {isActive && (
                    <div className='lg:hidden w-full'>
                      <ThinkingTimer phase={phase} playerName={playerName} />
                      <div className='flex justify-between mt-1'>
                        <button
                          onClick={handleAbort}
                          className='w-[30%] py-2 rounded-xl text-sm font-bold font-heading
                                 bg-red-700 hover:bg-red-600 active:bg-red-800
                                 text-white shadow-md shadow-red-900/40 transition-all duration-200 hover:scale-[1.02]'
                        >
                          Abort
                        </button>
                        {settings.undoEnabled && (
                          <button
                            onClick={handleUndo}
                            disabled={phase !== 'playing' || moveCount < 2}
                            className='w-[30%] py-2 rounded-xl text-sm font-bold font-heading
                                   bg-sky-700 hover:bg-sky-600 active:bg-sky-800
                                   text-white shadow-md shadow-sky-900/40 transition-all duration-200
                                   hover:scale-[1.02] disabled:opacity-30 disabled:cursor-not-allowed'
                          >
                            Undo
                          </button>
                        )}
                      </div>
                    </div>
                  )}

                  <div
                    ref={boardRef}
                    className={isActive ? 'mt-[20px] lg:mt-0' : ''}
                  >
                    <Board
                      board={board}
                      boardSize={settings.boardSize}
                      displayMode={settings.displayMode}
                      interactive={phase === 'playing'}
                      lastMove={lastMove}
                      onCellClick={makeMove}
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Footer */}
          <footer
            ref={footerRef}
            className='text-center py-6'
            style={{ fontSize: '12pt', fontWeight: 400 }}
          >
            <p className='text-neutral-500'>
              &copy; 2026{' '}
              <a
                href='https://kig.re/'
                target='_blank'
                rel='noopener noreferrer'
                className='text-neutral-500 hover:text-amber-400 transition-colors'
              >
                Konstantin Gredeskoul
              </a>
              , All Rights Reserved.
            </p>
            <p className='mt-1'>
              <a
                href='https://github.com/kigster/gomoku-ansi-c'
                target='_blank'
                rel='noopener noreferrer'
                className='text-neutral-500 hover:text-amber-400 transition-colors inline-block'
              >
                <svg
                  viewBox='0 0 16 16'
                  width='30'
                  height='30'
                  fill='currentColor'
                  aria-label='GitHub'
                >
                  <path d='M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z' />
                </svg>
              </a>
            </p>
          </footer>

          {/* Overlay Modals */}
          {showHistoryModal && (
            <PreviousGames
              authToken={authToken!}
              apiBase={API_BASE}
              onClose={() => {
                trackModalClose('history')
                setShowHistoryModal(false)
              }}
            />
          )}
          {showRulesModal && (
            <RulesModal
              onClose={() => {
                trackModalClose('rules')
                setShowRulesModal(false)
              }}
            />
          )}
          {showDifficultySettingsModal && (
            <DifficultySettingsModal
              onClose={() => {
                trackModalClose('difficulty')
                setShowDifficultySettingsModal(false)
              }}
            />
          )}
          {showAboutModal && (
            <AboutModal
              onClose={() => {
                trackModalClose('about')
                setShowAboutModal(false)
              }}
            />
          )}
          {showLeaderboardModal && (
            <LeaderboardModal
              apiBase={API_BASE}
              onClose={() => {
                trackModalClose('leaderboard')
                setShowLeaderboardModal(false)
              }}
            />
          )}
        </div>
      )}
    </>
  )
}
