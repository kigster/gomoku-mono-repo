/**
 * Coordinate conversion between internal [row, col] (0-indexed)
 * and alphanumeric notation (e.g. "H8", "K10").
 *
 * Notation format (matching Go/Gomoku convention and backend json_api.c):
 *   <column_letter><row_number>
 *   - Column letters: A B C D E F G H J K L M N O P Q R S T  (I is skipped)
 *   - Row numbers: 1-based (1..boardSize)
 */

const COLUMNS = "ABCDEFGHJKLMNOPQRST";

/** Convert internal (row, col) to notation string like "H8". */
export function toNotation(row: number, col: number): string {
  return `${COLUMNS[col]}${row + 1}`;
}

/** Convert notation string like "H8" to internal [row, col]. Returns null on invalid input. */
export function fromNotation(notation: string): [number, number] | null {
  if (!notation || notation.length < 2) return null;
  const letter = notation[0].toUpperCase();
  const col = COLUMNS.indexOf(letter);
  if (col < 0) return null;
  const rowStr = notation.slice(1);
  if (!/^\d+$/.test(rowStr)) return null;
  const row = parseInt(rowStr, 10);
  if (row < 1) return null;
  return [row - 1, col];
}

/** Type guard: is the coordinate in alphanumeric notation (string) or legacy [row, col]? */
export function isNotation(coord: unknown): coord is string {
  return typeof coord === "string";
}

/** Extract [row, col] from a coordinate that may be either notation string or legacy [number, number]. */
export function coordToRowCol(
  coord: string | [number, number],
): [number, number] | null {
  if (Array.isArray(coord)) return coord;
  return fromNotation(coord);
}
