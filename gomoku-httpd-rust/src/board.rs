//! Board management and coordinate utilities.
//!
//! Cell values: 0 = empty, 1 = crosses (X), -1 = naughts (O).

pub const CELL_EMPTY: i32 = 0;
pub const CELL_CROSSES: i32 = 1;
pub const CELL_NAUGHTS: i32 = -1;

/// A game board represented as a flat Vec for cache efficiency.
#[derive(Clone)]
pub struct Board {
    pub size: usize,
    cells: Vec<i32>,
}

impl Board {
    pub fn new(size: usize) -> Self {
        Board {
            size,
            cells: vec![CELL_EMPTY; size * size],
        }
    }

    #[inline]
    pub fn get(&self, x: usize, y: usize) -> i32 {
        self.cells[x * self.size + y]
    }

    #[inline]
    pub fn set(&mut self, x: usize, y: usize, val: i32) {
        self.cells[x * self.size + y] = val;
    }

    #[inline]
    pub fn is_valid_move(&self, x: i32, y: i32) -> bool {
        x >= 0
            && (x as usize) < self.size
            && y >= 0
            && (y as usize) < self.size
            && self.get(x as usize, y as usize) == CELL_EMPTY
    }

    /// Check if `player` has exactly 5 in a row anywhere on the board.
    pub fn has_winner(&self, player: i32) -> bool {
        let size = self.size as i32;
        let directions: [(i32, i32); 4] = [(1, 0), (0, 1), (1, 1), (1, -1)];

        for i in 0..self.size {
            for j in 0..self.size {
                if self.get(i, j) != player {
                    continue;
                }
                for &(dx, dy) in &directions {
                    let mut count = 1i32;
                    let (mut x, mut y) = (i as i32 + dx, j as i32 + dy);
                    while x >= 0
                        && x < size
                        && y >= 0
                        && y < size
                        && self.get(x as usize, y as usize) == player
                    {
                        count += 1;
                        x += dx;
                        y += dy;
                    }
                    let (mut x, mut y) = (i as i32 - dx, j as i32 - dy);
                    while x >= 0
                        && x < size
                        && y >= 0
                        && y < size
                        && self.get(x as usize, y as usize) == player
                    {
                        count += 1;
                        x -= dx;
                        y -= dy;
                    }
                    if count == 5 {
                        return true;
                    }
                }
            }
        }
        false
    }

    /// Fast check: does the stone at (x,y) complete exactly 5 in a row?
    pub fn is_five_from_last_move(&self, x: i32, y: i32, player: i32) -> bool {
        let size = self.size as i32;
        if x < 0 || y < 0 || x >= size || y >= size {
            return false;
        }
        if self.get(x as usize, y as usize) != player {
            return false;
        }
        let directions: [(i32, i32); 4] = [(1, 0), (0, 1), (1, 1), (1, -1)];
        for &(dx, dy) in &directions {
            let mut count = 1;
            let (mut nx, mut ny) = (x + dx, y + dy);
            while nx >= 0
                && nx < size
                && ny >= 0
                && ny < size
                && self.get(nx as usize, ny as usize) == player
            {
                count += 1;
                nx += dx;
                ny += dy;
            }
            let (mut nx, mut ny) = (x - dx, y - dy);
            while nx >= 0
                && nx < size
                && ny >= 0
                && ny < size
                && self.get(nx as usize, ny as usize) == player
            {
                count += 1;
                nx -= dx;
                ny -= dy;
            }
            if count == 5 {
                return true;
            }
        }
        false
    }

    /// Count empty cells on the board.
    pub fn empty_count(&self) -> usize {
        self.cells.iter().filter(|&&c| c == CELL_EMPTY).count()
    }

    /// Count stones on the board.
    #[allow(dead_code)]
    pub fn stone_count(&self) -> usize {
        self.cells.iter().filter(|&&c| c != CELL_EMPTY).count()
    }

    /// Render the board state as an array of row strings for JSON serialization.
    pub fn to_row_strings(&self) -> Vec<String> {
        let mut rows = Vec::with_capacity(self.size);
        for i in 0..self.size {
            let mut parts = Vec::with_capacity(self.size);
            for j in 0..self.size {
                let cell = self.get(i, j);
                let ch = if cell == CELL_CROSSES {
                    "X"
                } else if cell == CELL_NAUGHTS {
                    "O"
                } else {
                    "."
                };
                parts.push(ch);
            }
            rows.push(parts.join(" "));
        }
        rows
    }
}

/// Return the opponent of the given player.
#[inline]
pub fn other_player(player: i32) -> i32 {
    -player
}

/// Column letters used for notation (A-T, skipping I).
const COLUMNS: &[u8] = b"ABCDEFGHJKLMNOPQRST";

/// Convert board coordinates (0-indexed internal) to notation like "K9".
///
/// Matches the C implementation: column letter from `y`, row digit is `x + 1`
/// so display rows start at 1. The letter `I` is intentionally skipped.
pub fn coord_to_notation(x: usize, y: usize, board_size: usize) -> Option<String> {
    if x >= board_size || y >= board_size || y >= COLUMNS.len() {
        return None;
    }
    Some(format!("{}{}", COLUMNS[y] as char, x + 1))
}

/// Parse notation like "K9" to (x, y) 0-indexed board coordinates.
///
/// Display row "1" maps to internal x=0, so input row must be in `[1, board_size]`.
pub fn notation_to_coord(s: &str, board_size: usize) -> Option<(usize, usize)> {
    if s.len() < 2 {
        return None;
    }
    let col_char = s.as_bytes()[0].to_ascii_uppercase();
    let col = COLUMNS.iter().position(|&c| c == col_char)?;
    if col >= board_size {
        return None;
    }
    let row_str = &s[1..];
    if !row_str.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let row: usize = row_str.parse().ok()?;
    if row < 1 || row > board_size {
        return None;
    }
    Some((row - 1, col))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_board_starts_empty() {
        let b = Board::new(15);
        assert_eq!(b.size, 15);
        assert_eq!(b.empty_count(), 15 * 15);
        assert_eq!(b.stone_count(), 0);
        assert!(b.is_valid_move(7, 7));
    }

    #[test]
    fn set_get_roundtrip() {
        let mut b = Board::new(15);
        b.set(3, 5, CELL_CROSSES);
        assert_eq!(b.get(3, 5), CELL_CROSSES);
        assert!(!b.is_valid_move(3, 5));
        assert_eq!(b.empty_count(), 15 * 15 - 1);
        assert_eq!(b.stone_count(), 1);
    }

    #[test]
    fn out_of_bounds_moves_are_invalid() {
        let b = Board::new(15);
        assert!(!b.is_valid_move(-1, 0));
        assert!(!b.is_valid_move(0, -1));
        assert!(!b.is_valid_move(15, 0));
        assert!(!b.is_valid_move(0, 15));
    }

    #[test]
    fn detects_horizontal_five() {
        let mut b = Board::new(15);
        for j in 4..=8 {
            b.set(7, j, CELL_CROSSES);
        }
        assert!(b.has_winner(CELL_CROSSES));
        assert!(!b.has_winner(CELL_NAUGHTS));
        assert!(b.is_five_from_last_move(7, 6, CELL_CROSSES));
    }

    #[test]
    fn detects_diagonal_five() {
        let mut b = Board::new(15);
        for k in 0..5 {
            b.set(k, k, CELL_NAUGHTS);
        }
        assert!(b.has_winner(CELL_NAUGHTS));
        assert!(b.is_five_from_last_move(2, 2, CELL_NAUGHTS));
    }

    #[test]
    fn four_in_a_row_is_not_a_win() {
        let mut b = Board::new(15);
        for j in 4..=7 {
            b.set(7, j, CELL_CROSSES);
        }
        assert!(!b.has_winner(CELL_CROSSES));
    }

    #[test]
    fn other_player_flips_sign() {
        assert_eq!(other_player(CELL_CROSSES), CELL_NAUGHTS);
        assert_eq!(other_player(CELL_NAUGHTS), CELL_CROSSES);
    }

    #[test]
    fn coord_notation_round_trip() {
        // "K9" — column K=9 (skipping I), row 9 → internal (8, 9).
        assert_eq!(coord_to_notation(8, 9, 15).as_deref(), Some("K9"));
        assert_eq!(notation_to_coord("K9", 15), Some((8, 9)));
        // "A1" → (0, 0) on both sides.
        assert_eq!(coord_to_notation(0, 0, 15).as_deref(), Some("A1"));
        assert_eq!(notation_to_coord("A1", 15), Some((0, 0)));
        // Last cell on a 15x15: "O15" (column O is index 13 because I is skipped).
        assert_eq!(coord_to_notation(14, 13, 15).as_deref(), Some("O15"));
    }

    #[test]
    fn coord_notation_skips_letter_i() {
        // Column index 8 must be 'J', not 'I'.
        assert_eq!(coord_to_notation(0, 8, 15).as_deref(), Some("J1"));
        assert_eq!(notation_to_coord("I3", 15), None);
    }

    #[test]
    fn coord_notation_rejects_out_of_range() {
        assert_eq!(notation_to_coord("A0", 15), None); // row 0 is invalid
        assert_eq!(notation_to_coord("A16", 15), None); // row 16 > board size
        assert_eq!(notation_to_coord("Z1", 15), None); // unknown column
        assert_eq!(notation_to_coord("A", 15), None); // too short
        assert_eq!(notation_to_coord("Ab", 15), None); // non-digit row
    }

    #[test]
    fn to_row_strings_dot_grid() {
        let mut b = Board::new(3);
        b.set(0, 0, CELL_CROSSES);
        b.set(1, 1, CELL_NAUGHTS);
        let rows = b.to_row_strings();
        assert_eq!(rows[0], "X . .");
        assert_eq!(rows[1], ". O .");
        assert_eq!(rows[2], ". . .");
    }
}
