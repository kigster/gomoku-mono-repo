export interface PlayerConfig {
  player: 'human' | 'AI'
  depth?: number
  time_ms: number
}

export type MoveCoord = string | [number, number]

export interface MoveEntry {
  'X (human)'?: MoveCoord
  'X (AI)'?: MoveCoord
  'O (human)'?: MoveCoord
  'O (AI)'?: MoveCoord
  time_ms?: number
  moves_searched?: number
  moves_evaluated?: number
  score?: number
  opponent?: number
  winner?: boolean
}

export interface GameState {
  X: PlayerConfig
  O: PlayerConfig
  board_size: 15 | 19
  radius: number
  timeout: string
  undo?: string
  winner: 'none' | 'X' | 'O' | 'draw'
  board_state: string[]
  moves: MoveEntry[]
  /** Server-issued id for the games row inserted at `/game/start`. The
   *  client carries it through and sends it on `/game/save` so the row
   *  is UPDATEd in place rather than duplicated. Optional because the
   *  C engine doesn't set it and the legacy save path tolerates its
   *  absence. */
  game_id?: string
}

export type DisplayMode = 'stones' | 'xo'
export type PlayerSide = 'X' | 'O'
export type GamePhase = 'idle' | 'playing' | 'thinking' | 'gameover'

export interface GameSettings {
  aiDepth: number
  aiRadius: number
  aiTimeout: string
  displayMode: DisplayMode
  playerSide: PlayerSide
  boardSize: 15 | 19
  undoEnabled: boolean
}

export type CellValue = 'empty' | 'X' | 'O'
