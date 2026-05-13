// Typed wrappers around the /multiplayer/* API. All endpoints require the
// user's JWT, which we pass via the Authorization header (token is read
// from sessionStorage by the caller).

const API_BASE = import.meta.env.VITE_API_BASE || ''

export type GameStateName =
  | 'waiting'
  | 'in_progress'
  | 'finished'
  | 'abandoned'
  | 'cancelled'
export type Color = 'X' | 'O'
export type ColorChosenBy = 'host' | 'guest'

export interface PlayerInfo {
  username: string
  color: Color | null
}

export interface MultiplayerGameView {
  code: string
  state: GameStateName
  board_size: number
  rule_set: string
  host: PlayerInfo
  guest: PlayerInfo | null
  moves: [number, number][]
  next_to_move: Color
  winner: Color | 'draw' | null
  your_color: Color | null
  your_turn: boolean
  version: number
  color_chosen_by: ColorChosenBy
  expires_at: string
  created_at: string
  finished_at: string | null
  invite_url: string
}

export interface MultiplayerGamePreview {
  code: string
  state: GameStateName
  board_size: number
  rule_set: string
  host: PlayerInfo
  guest: PlayerInfo | null
  next_to_move: Color
  winner: Color | 'draw' | null
  your_color: null
  your_turn: false
  version: number
  color_chosen_by: ColorChosenBy
  expires_at: string
  created_at: string
  finished_at: string | null
}

export class MultiplayerApiError extends Error {
  status: number
  detail: string

  constructor(status: number, detail: string) {
    super(`HTTP ${status}: ${detail}`)
    this.status = status
    this.detail = detail
  }
}

function authHeaders(token: string): HeadersInit {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  }
}

async function parseError(response: Response): Promise<MultiplayerApiError> {
  let detail = ''
  try {
    const body = await response.json()
    detail = typeof body.detail === 'string' ? body.detail : JSON.stringify(body)
  } catch {
    detail = await response.text().catch(() => '')
  }
  return new MultiplayerApiError(response.status, detail)
}

export async function newGame(
  token: string,
  opts: { board_size?: 15 | 19; host_color?: Color | null } = {},
): Promise<MultiplayerGameView> {
  // `host_color: null` is meaningful — it tells the server "guest will pick
  // their color at join time". We pass it through as null rather than
  // omitting the key.
  const body: Record<string, unknown> = {}
  if (opts.board_size !== undefined) body.board_size = opts.board_size
  if (opts.host_color !== undefined) body.host_color = opts.host_color
  const response = await fetch(`${API_BASE}/multiplayer/new`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(body),
  })
  if (!response.ok) throw await parseError(response)
  return response.json() as Promise<MultiplayerGameView>
}

export async function joinGame(
  token: string,
  code: string,
  opts: { chosen_color?: Color } = {},
): Promise<MultiplayerGameView> {
  const body: Record<string, unknown> = {}
  if (opts.chosen_color) body.chosen_color = opts.chosen_color
  const response = await fetch(`${API_BASE}/multiplayer/${code}/join`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(body),
  })
  if (!response.ok) throw await parseError(response)
  return response.json() as Promise<MultiplayerGameView>
}

export async function cancelGame(
  token: string,
  code: string,
): Promise<MultiplayerGameView> {
  const response = await fetch(`${API_BASE}/multiplayer/${code}/cancel`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({}),
  })
  if (!response.ok) throw await parseError(response)
  return response.json() as Promise<MultiplayerGameView>
}

/** Returns the view, or `null` when the server signals "no update since
 *  `sinceVersion`". We send `X-Accept-No-Change: 1` so a current server
 *  replies with a 200 + `{no_change: true}` sentinel (clean console). A
 *  legacy server that doesn't recognise the header replies with HTTP 304
 *  instead — still handled here for forward/backward-compat across
 *  deploy windows. */
export async function getGame(
  token: string,
  code: string,
  sinceVersion?: number,
): Promise<MultiplayerGameView | MultiplayerGamePreview | null> {
  const url = new URL(`${API_BASE}/multiplayer/${code}`, window.location.origin)
  if (sinceVersion !== undefined) {
    url.searchParams.set('since_version', String(sinceVersion))
  }
  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Accept-No-Change': '1',
    },
  })
  if (response.status === 304) return null
  if (!response.ok) throw await parseError(response)
  const body = (await response.json()) as
    | MultiplayerGameView
    | MultiplayerGamePreview
    | { no_change: true; version: number }
  if (body && typeof body === 'object' && 'no_change' in body && body.no_change === true) {
    return null
  }
  return body as MultiplayerGameView | MultiplayerGamePreview
}

export async function postMove(
  token: string,
  code: string,
  x: number,
  y: number,
  expectedVersion: number,
): Promise<MultiplayerGameView> {
  const response = await fetch(`${API_BASE}/multiplayer/${code}/move`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ x, y, expected_version: expectedVersion }),
  })
  if (!response.ok) throw await parseError(response)
  return response.json() as Promise<MultiplayerGameView>
}

export async function resignGame(
  token: string,
  code: string,
): Promise<MultiplayerGameView> {
  const response = await fetch(`${API_BASE}/multiplayer/${code}/resign`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({}),
  })
  if (!response.ok) throw await parseError(response)
  return response.json() as Promise<MultiplayerGameView>
}

export async function listMyGames(token: string): Promise<MultiplayerGameView[]> {
  const response = await fetch(`${API_BASE}/multiplayer/mine`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!response.ok) throw await parseError(response)
  return response.json() as Promise<MultiplayerGameView[]>
}

export function isParticipantView(
  v: MultiplayerGameView | MultiplayerGamePreview,
): v is MultiplayerGameView {
  return v.your_color !== null
}
