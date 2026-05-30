//! Game state management, move history, and optimization caches.
//!
//! Ported from game.c and game.h.
use crate::board::{Board, CELL_CROSSES, CELL_EMPTY, CELL_NAUGHTS, other_player};
use std::time::Instant;

pub const MAX_MOVE_HISTORY: usize = 400;
pub const MAX_SEARCH_DEPTH: usize = 10;
pub const MAX_KILLER_MOVES: usize = 2;
pub const TRANSPOSITION_TABLE_SIZE: usize = 100_000;

pub const TT_EXACT: i32 = 0;
pub const TT_LOWER_BOUND: i32 = 1;
pub const TT_UPPER_BOUND: i32 = 2;

pub const GAME_RUNNING: i32 = 0;
pub const GAME_X_WIN: i32 = 1;
pub const GAME_O_WIN: i32 = 2;
pub const GAME_DRAW: i32 = 3;

#[derive(Clone, Debug, Default)]
pub struct MoveHistory {
    pub x: i32,
    pub y: i32,
    pub player: i32,
    pub time_taken: f64,
    pub positions_evaluated: i32,
    pub own_score: i32,
    pub opponent_score: i32,
    pub is_winner: bool,
    pub queue_wait_ms: f64,
}

#[derive(Clone)]
pub struct TranspositionEntry {
    pub hash: u64,
    pub ai_player: i32,
    pub value: i32,
    pub depth: i32,
    pub flag: i32,
    pub best_move_x: i32,
    pub best_move_y: i32,
}

impl Default for TranspositionEntry {
    fn default() -> Self {
        TranspositionEntry {
            hash: 0,
            ai_player: 0,
            value: 0,
            depth: 0,
            flag: 0,
            best_move_x: -1,
            best_move_y: -1,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub enum PlayerType {
    #[default]
    Human,
    AI,
}

/// Full game state.
#[derive(Clone)]
pub struct GameState {
    pub board: Board,
    pub board_size: usize,
    pub current_player: i32,
    pub game_state: i32,
    pub max_depth: i32,
    pub move_timeout: i32,
    pub search_radius: i32,

    pub player_type: [PlayerType; 2], // [0]=X, [1]=O
    pub depth_for_player: [i32; 2],   // per-player depth

    pub move_history: Vec<MoveHistory>,
    pub total_x_time: f64,
    pub total_o_time: f64,

    pub last_ai_moves_evaluated: i32,

    // Timing
    pub search_start: Option<Instant>,
    pub search_timed_out: bool,

    // Optimization
    pub stones_on_board: i32,
    pub current_hash: u64,
    pub zobrist_keys: [[u64; 361]; 2],
    pub transposition_table: [Vec<TranspositionEntry>; 2],
    pub killer_moves: [[[i32; 2]; MAX_KILLER_MOVES]; MAX_SEARCH_DEPTH],

    // Config
    pub enable_undo: bool,
    pub max_undo_allowed: i32,
}

impl GameState {
    pub fn new(
        board_size: usize,
        max_depth: i32,
        move_timeout: i32,
        search_radius: i32,
        player_x_type: PlayerType,
        player_o_type: PlayerType,
        depth_x: i32,
        depth_o: i32,
        enable_undo: bool,
        max_undo_allowed: i32,
    ) -> Self {
        let mut gs = GameState {
            board: Board::new(board_size),
            board_size,
            current_player: CELL_CROSSES,
            game_state: GAME_RUNNING,
            max_depth,
            move_timeout,
            search_radius,
            player_type: [player_x_type, player_o_type],
            depth_for_player: [
                if depth_x > 0 { depth_x } else { max_depth },
                if depth_o > 0 { depth_o } else { max_depth },
            ],
            move_history: Vec::with_capacity(MAX_MOVE_HISTORY),
            total_x_time: 0.0,
            total_o_time: 0.0,
            last_ai_moves_evaluated: 0,
            search_start: None,
            search_timed_out: false,
            stones_on_board: 0,
            current_hash: 0,
            zobrist_keys: [[0u64; 361]; 2],
            transposition_table: [
                vec![TranspositionEntry::default(); TRANSPOSITION_TABLE_SIZE],
                vec![TranspositionEntry::default(); TRANSPOSITION_TABLE_SIZE],
            ],
            killer_moves: [[[-1i32; 2]; MAX_KILLER_MOVES]; MAX_SEARCH_DEPTH],
            enable_undo,
            max_undo_allowed,
        };
        gs.init_zobrist();
        gs
    }

    fn init_zobrist(&mut self) {
        let mut lcg: u64 = 12345;
        for player in 0..2 {
            for pos in 0..361 {
                lcg = lcg
                    .wrapping_mul(6364136223846793005)
                    .wrapping_add(1442695040888963407);
                let high = lcg;
                lcg = lcg
                    .wrapping_mul(6364136223846793005)
                    .wrapping_add(1442695040888963407);
                let low = lcg;
                self.zobrist_keys[player][pos] = (high & 0xFFFFFFFF00000000) | (low >> 32);
            }
        }
        self.current_hash = self.compute_zobrist_hash();
    }

    pub fn compute_zobrist_hash(&self) -> u64 {
        let mut hash = 0u64;
        for i in 0..self.board_size {
            for j in 0..self.board_size {
                let cell = self.board.get(i, j);
                if cell != CELL_EMPTY {
                    let pi = if cell == CELL_CROSSES { 0 } else { 1 };
                    let pos = i * self.board_size + j;
                    hash ^= self.zobrist_keys[pi][pos];
                }
            }
        }
        hash
    }

    pub fn make_move(
        &mut self,
        x: i32,
        y: i32,
        player: i32,
        time_taken: f64,
        positions_evaluated: i32,
        own_score: i32,
        opponent_score: i32,
    ) -> bool {
        if !self.board.is_valid_move(x, y) {
            return false;
        }
        let mh = MoveHistory {
            x,
            y,
            player,
            time_taken,
            positions_evaluated,
            own_score,
            opponent_score,
            is_winner: false,
            queue_wait_ms: 0.0,
        };
        self.move_history.push(mh);

        if player == CELL_CROSSES {
            self.total_x_time += time_taken;
        } else {
            self.total_o_time += time_taken;
        }

        self.board.set(x as usize, y as usize, player);
        self.stones_on_board += 1;

        // Update zobrist hash
        let pi = if player == CELL_CROSSES { 0 } else { 1 };
        let pos = x as usize * self.board_size + y as usize;
        self.current_hash ^= self.zobrist_keys[pi][pos];

        self.check_game_state();

        if (self.game_state == GAME_X_WIN || self.game_state == GAME_O_WIN)
            && let Some(last) = self.move_history.last_mut()
        {
            last.is_winner = true;
        }

        if self.game_state == GAME_RUNNING {
            self.current_player = other_player(self.current_player);
        }

        true
    }

    pub fn check_game_state(&mut self) {
        if self.board.has_winner(CELL_CROSSES) {
            self.game_state = GAME_X_WIN;
        } else if self.board.has_winner(CELL_NAUGHTS) {
            self.game_state = GAME_O_WIN;
        } else if self.board.empty_count() == 0 {
            self.game_state = GAME_DRAW;
        }
    }

    pub fn is_search_timed_out(&self) -> bool {
        if self.move_timeout <= 0 {
            return false;
        }
        if let Some(start) = self.search_start {
            start.elapsed().as_secs() >= self.move_timeout as u64
        } else {
            false
        }
    }

    // Transposition table
    pub fn store_transposition(
        &mut self,
        hash: u64,
        ai_player: i32,
        value: i32,
        depth: i32,
        flag: i32,
        best_x: i32,
        best_y: i32,
    ) {
        let ai_index = if ai_player == CELL_CROSSES { 0 } else { 1 };
        let index = (hash as usize) % TRANSPOSITION_TABLE_SIZE;
        let entry = &mut self.transposition_table[ai_index][index];
        if entry.hash == 0 || entry.depth <= depth {
            entry.hash = hash;
            entry.ai_player = ai_player;
            entry.value = value;
            entry.depth = depth;
            entry.flag = flag;
            entry.best_move_x = best_x;
            entry.best_move_y = best_y;
        }
    }

    pub fn probe_transposition(
        &self,
        hash: u64,
        ai_player: i32,
        depth: i32,
        alpha: i32,
        beta: i32,
    ) -> Option<i32> {
        let ai_index = if ai_player == CELL_CROSSES { 0 } else { 1 };
        let index = (hash as usize) % TRANSPOSITION_TABLE_SIZE;
        let entry = &self.transposition_table[ai_index][index];
        if entry.hash == hash && entry.ai_player == ai_player && entry.depth >= depth {
            if entry.flag == TT_EXACT {
                return Some(entry.value);
            } else if entry.flag == TT_LOWER_BOUND && entry.value >= beta {
                return Some(entry.value);
            } else if entry.flag == TT_UPPER_BOUND && entry.value <= alpha {
                return Some(entry.value);
            }
        }
        None
    }

    // Killer moves
    pub fn store_killer_move(&mut self, depth: i32, x: i32, y: i32) {
        if depth as usize >= MAX_SEARCH_DEPTH {
            return;
        }
        let d = depth as usize;
        if self.is_killer_move(depth, x, y) {
            return;
        }
        for i in (1..MAX_KILLER_MOVES).rev() {
            self.killer_moves[d][i] = self.killer_moves[d][i - 1];
        }
        self.killer_moves[d][0] = [x, y];
    }

    pub fn is_killer_move(&self, depth: i32, x: i32, y: i32) -> bool {
        if depth as usize >= MAX_SEARCH_DEPTH {
            return false;
        }
        let d = depth as usize;
        for i in 0..MAX_KILLER_MOVES {
            if self.killer_moves[d][i][0] == x && self.killer_moves[d][i][1] == y {
                return true;
            }
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::board::{CELL_CROSSES, CELL_NAUGHTS};

    fn fresh_game() -> GameState {
        GameState::new(15, 4, 0, 2, PlayerType::AI, PlayerType::AI, 4, 4, true, 5)
    }

    #[test]
    fn initial_state_is_x_to_move() {
        let g = fresh_game();
        assert_eq!(g.current_player, CELL_CROSSES);
        assert_eq!(g.game_state, GAME_RUNNING);
        assert_eq!(g.move_history.len(), 0);
    }

    #[test]
    fn make_move_advances_history_and_swaps_player() {
        let mut g = fresh_game();
        assert!(g.make_move(7, 7, CELL_CROSSES, 0.0, 0, 0, 0));
        assert_eq!(g.current_player, CELL_NAUGHTS);
        assert_eq!(g.move_history.len(), 1);
        assert_eq!(g.stones_on_board, 1);
        assert_eq!(g.board.get(7, 7), CELL_CROSSES);
    }

    #[test]
    fn duplicate_move_is_rejected() {
        let mut g = fresh_game();
        assert!(g.make_move(7, 7, CELL_CROSSES, 0.0, 0, 0, 0));
        assert!(!g.make_move(7, 7, CELL_NAUGHTS, 0.0, 0, 0, 0));
    }

    #[test]
    fn winning_move_marks_history_and_freezes_player() {
        let mut g = fresh_game();
        // Play X X X X interleaved with O O O O on a different row, then close X.
        for j in 4..=7 {
            assert!(g.make_move(7, j, CELL_CROSSES, 0.0, 0, 0, 0));
            assert!(g.make_move(8, j, CELL_NAUGHTS, 0.0, 0, 0, 0));
        }
        // X completes 5 in a row at (7,8).
        assert!(g.make_move(7, 8, CELL_CROSSES, 0.0, 0, 0, 0));
        assert_eq!(g.game_state, GAME_X_WIN);
        assert!(g.move_history.last().unwrap().is_winner);
        // current_player must NOT advance after a winning move.
        assert_eq!(g.current_player, CELL_CROSSES);
    }

    #[test]
    fn zobrist_hash_is_invariant_under_replay() {
        let mut g = fresh_game();
        g.make_move(7, 7, CELL_CROSSES, 0.0, 0, 0, 0);
        g.make_move(8, 8, CELL_NAUGHTS, 0.0, 0, 0, 0);
        let live = g.current_hash;
        let recomputed = g.compute_zobrist_hash();
        assert_eq!(live, recomputed);
    }

    #[test]
    fn killer_moves_round_trip() {
        let mut g = fresh_game();
        g.store_killer_move(2, 5, 6);
        assert!(g.is_killer_move(2, 5, 6));
        assert!(!g.is_killer_move(2, 0, 0));
    }

    #[test]
    fn transposition_table_round_trip() {
        let mut g = fresh_game();
        g.store_transposition(123, CELL_CROSSES, 42, 3, TT_EXACT, 7, 7);
        let v = g.probe_transposition(123, CELL_CROSSES, 3, -1000, 1000);
        assert_eq!(v, Some(42));
        // Wrong player → miss.
        assert!(
            g.probe_transposition(123, CELL_NAUGHTS, 3, -1000, 1000)
                .is_none()
        );
    }
}
