import { useState, useCallback, useRef } from 'react'
import type { GameState, GameSettings, GamePhase, CellValue } from '../types'
import { postGameState } from '../api'
import { trackTimeout, trackCriticalTimeout } from '../analytics'
import { toNotation, coordToRowCol } from '../coordinates'

function buildEmptyBoard(size: number): string[] {
  const row = Array(size).fill('.').join(' ')
  return Array(size).fill(row)
}

function updateBoardState(
  board: string[],
  row: number,
  col: number,
  piece: 'X' | 'O',
  boardSize: number,
): string[] {
  if (board.length === 0) {
    board = buildEmptyBoard(boardSize)
  }
  const cells = board[row].split(' ')
  cells[col] = piece
  const newBoard = [...board]
  newBoard[row] = cells.join(' ')
  return newBoard
}

function parseBoardState(boardState: string[], boardSize: number): CellValue[][] {
  if (boardState.length === 0) {
    return Array.from({ length: boardSize }, () =>
      Array(boardSize).fill('empty') as CellValue[]
    )
  }
  return boardState.map(row => {
    const cells = row.split(' ')
    return cells.map(c => {
      if (c === 'X') return 'X' as CellValue
      if (c === 'O') return 'O' as CellValue
      return 'empty' as CellValue
    })
  })
}

function getLastMoveCoords(state: GameState): [number, number] | null {
  if (state.moves.length === 0) return null
  const lastMove = state.moves[state.moves.length - 1]
  for (const key of ['X (human)', 'X (AI)', 'O (human)', 'O (AI)'] as const) {
    const coord = lastMove[key]
    if (coord != null) return coordToRowCol(coord)
  }
  return null
}

function currentTurn(state: GameState): 'X' | 'O' {
  return state.moves.length % 2 === 0 ? 'X' : 'O'
}

export function useGameState(settings: GameSettings) {
  const [gameState, setGameState] = useState<GameState | null>(null)
  const [phase, setPhase] = useState<GamePhase>('idle')
  const [error, setError] = useState<string | null>(null)
  const turnStartMs = useRef<number>(0)
  const humanTimeAccum = useRef<number>(0)
  const aiTimeAccum = useRef<number>(0)
  const lastHumanMoveMs = useRef<number>(0)
  const lastAiMoveMs = useRef<number>(0)

  const buildInitialState = useCallback((): GameState => {
    const humanSide = settings.playerSide
    return {
      X: {
        player: humanSide === 'X' ? 'human' : 'AI',
        depth: humanSide === 'X' ? 0 : settings.aiDepth,
        time_ms: 0,
      },
      O: {
        player: humanSide === 'O' ? 'human' : 'AI',
        depth: humanSide === 'O' ? 0 : settings.aiDepth,
        time_ms: 0,
      },
      board_size: settings.boardSize,
      radius: settings.aiRadius,
      timeout: settings.aiTimeout,
      undo: settings.undoEnabled ? 'on' : undefined,
      winner: 'none',
      board_state: [],
      moves: [],
    }
  }, [settings])

  const sendToServer = useCallback(async (
    state: GameState,
    timeoutMs?: number,
    timeoutSec = 0,
  ): Promise<boolean> => {
    setPhase('thinking')
    setError(null)
    turnStartMs.current = Date.now()

    let attempts = 0
    let backoffMs = 1000
    let totalWaitMs = 0
    let criticalFired = false

    while (true) {
      try {
        const raw = await postGameState(state, 20, timeoutMs)

        // Merge: request fields as defaults, response fields on top.
        // The C backend may omit player configs, winner, etc.
        const response: GameState = { ...state, ...raw }

        // Track AI timing (wall-clock from request to response)
        const aiElapsed = Date.now() - turnStartMs.current
        const aiPlayed = (response.moves?.length ?? 0) > state.moves.length
        if (aiPlayed) {
          lastAiMoveMs.current = aiElapsed
          aiTimeAccum.current += aiElapsed
        }

        setGameState(response)
        if (response.winner !== 'none') {
          turnStartMs.current = 0
          setPhase('gameover')
        } else {
          turnStartMs.current = Date.now()
          setPhase('playing')
        }
        return true
      } catch (err) {
        if (err instanceof DOMException && err.name === 'TimeoutError' && timeoutMs) {
          attempts++
          if (attempts === 1) {
            trackTimeout(timeoutSec)
          }
          totalWaitMs += timeoutMs + backoffMs
          if (totalWaitMs >= 60_000 && !criticalFired) {
            criticalFired = true
            trackCriticalTimeout(attempts)
          }
          await new Promise(r => setTimeout(r, backoffMs))
          backoffMs = Math.min(backoffMs * 2, 30_000)
          continue
        }
        setError(err instanceof Error ? err.message : 'Unknown error')
        setPhase('playing')
        return false
      }
    }
  }, [])

  const startGame = useCallback(async (gameId?: string) => {
    // Stamp the server-issued games.id onto the initial state directly
    // so it survives any subsequent setGameState that spreads from
    // `prev` (the AI response merge in `sendToServer`, etc.). A
    // separate setter would race with the AI's first move.
    const initial: GameState = { ...buildInitialState(), game_id: gameId }
    setGameState(initial)
    setError(null)
    humanTimeAccum.current = 0
    aiTimeAccum.current = 0
    lastHumanMoveMs.current = 0
    lastAiMoveMs.current = 0

    const timeoutSec = settings.aiTimeout !== 'none' ? parseInt(settings.aiTimeout) : 0
    const timeoutMs = timeoutSec > 0 ? (timeoutSec + 5) * 1000 : undefined

    if (settings.playerSide === 'O') {
      // AI plays first (X), send empty state to server
      await sendToServer(initial, timeoutMs, timeoutSec)
    } else {
      // Human plays first, wait for click
      turnStartMs.current = Date.now()
      setPhase('playing')
    }
  }, [buildInitialState, settings.playerSide, settings.aiTimeout, sendToServer])

  const makeMove = useCallback(async (row: number, col: number) => {
    if (!gameState || phase !== 'playing') return
    if (gameState.winner !== 'none') return

    const board = parseBoardState(gameState.board_state, gameState.board_size)
    if (board[row][col] !== 'empty') return

    const turn = currentTurn(gameState)
    if (turn !== settings.playerSide) return

    const elapsed = Date.now() - turnStartMs.current
    const previousGameState = gameState
    const previousHumanTimeAccum = humanTimeAccum.current
    const previousLastHumanMoveMs = lastHumanMoveMs.current
    humanTimeAccum.current += elapsed
    lastHumanMoveMs.current = elapsed
    const moveKey = `${turn} (human)` as 'X (human)' | 'O (human)'

    const newBoardState = updateBoardState(
      gameState.board_state,
      row,
      col,
      turn,
      gameState.board_size,
    )

    const newState: GameState = {
      ...gameState,
      board_state: newBoardState,
      moves: [
        ...gameState.moves,
        { [moveKey]: toNotation(row, col), time_ms: elapsed },
      ],
    }

    // Optimistically update UI with human's move
    setGameState(newState)

    // Send to server for AI's response
    const timeoutSec = settings.aiTimeout !== 'none' ? parseInt(settings.aiTimeout) : 0
    const timeoutMs = timeoutSec > 0 ? (timeoutSec + 5) * 1000 : undefined
    const aiMoveSucceeded = await sendToServer(newState, timeoutMs, timeoutSec)
    if (!aiMoveSucceeded) {
      // Roll back the optimistic human move so the game does not get stuck
      // on the AI's turn after a failed backend request.
      humanTimeAccum.current = previousHumanTimeAccum
      lastHumanMoveMs.current = previousLastHumanMoveMs
      setGameState(previousGameState)
      turnStartMs.current = Date.now()
    }
  }, [gameState, phase, settings.playerSide, settings.aiTimeout, sendToServer])

  const board = gameState
    ? parseBoardState(gameState.board_state, gameState.board_size)
    : parseBoardState([], settings.boardSize)

  const lastMove = gameState ? getLastMoveCoords(gameState) : null
  const moveCount = gameState ? gameState.moves.length : 0
  const winner = gameState?.winner ?? 'none'

  const undoMove = useCallback(() => {
    if (!gameState || phase !== 'playing') return
    // Remove last 2 moves (AI + human) to get back to human's turn
    const movesToRemove = gameState.moves.length >= 2 ? 2 : gameState.moves.length
    if (movesToRemove === 0) return
    const newMoves = gameState.moves.slice(0, -movesToRemove)
    // Rebuild board from remaining moves
    let newBoard: string[] = []
    for (const move of newMoves) {
      for (const key of ['X (human)', 'X (AI)', 'O (human)', 'O (AI)'] as const) {
        const coord = move[key]
        if (coord != null) {
          const rc = coordToRowCol(coord)
          if (rc) {
            const piece = key.startsWith('X') ? 'X' as const : 'O' as const
            newBoard = updateBoardState(newBoard, rc[0], rc[1], piece, gameState.board_size)
          }
        }
      }
    }
    // Recompute timing from remaining moves
    let hTotal = 0, aTotal = 0, lastH = 0, lastA = 0
    for (const move of newMoves) {
      const ms = move.time_ms ?? 0
      if (move['X (human)'] || move['O (human)']) {
        hTotal += ms
        lastH = ms
      } else {
        aTotal += ms
        lastA = ms
      }
    }
    humanTimeAccum.current = hTotal
    aiTimeAccum.current = aTotal
    lastHumanMoveMs.current = lastH
    lastAiMoveMs.current = lastA

    setGameState({
      ...gameState,
      board_state: newBoard,
      moves: newMoves,
      winner: 'none',
    })
    turnStartMs.current = Date.now()
  }, [gameState, phase])

  const humanTimeMs = humanTimeAccum.current
  const aiSide = settings.playerSide === 'X' ? 'O' : 'X'
  const aiTimeMs = gameState ? gameState[aiSide].time_ms : 0

  const resetGame = useCallback(() => {
    setGameState(null)
    setPhase('idle')
    setError(null)
    humanTimeAccum.current = 0
    aiTimeAccum.current = 0
    lastHumanMoveMs.current = 0
    lastAiMoveMs.current = 0
    turnStartMs.current = 0
  }, [])


  return {
    board,
    phase,
    error,
    lastMove,
    moveCount,
    winner,
    humanTimeMs,
    aiTimeMs,
    humanTotalMs: humanTimeAccum.current,
    aiTotalMs: aiTimeAccum.current,
    lastHumanMoveMs: lastHumanMoveMs.current,
    lastAiMoveMs: lastAiMoveMs.current,
    turnStartMs: turnStartMs.current,
    isHumanTurn: phase === 'playing',
    gameState,
    startGame,
    makeMove,
    undoMove,
    resetGame,
  }
}
