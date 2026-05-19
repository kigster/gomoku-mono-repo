//! Pattern evaluation and threat analysis.
//!
//! Ported from gomoku.c — calculates threat scores for individual positions.
use crate::board::{Board, CELL_EMPTY, other_player};
use std::cmp::{max, min};

const SEARCH_RADIUS: i32 = 4;
const NUM_DIRECTIONS: usize = 4;
const OUT_OF_BOUNDS: i32 = 32;
const ROW_SIZE: usize = (SEARCH_RADIUS as usize) * 2 + 1;

// Threat type constants
const THREAT_NOTHING: usize = 0;
const THREAT_FIVE: usize = 1;
const THREAT_STRAIGHT_FOUR: usize = 2;
const THREAT_FOUR: usize = 3;
const THREAT_THREE: usize = 4;
const THREAT_FOUR_BROKEN: usize = 5;
const THREAT_THREE_BROKEN: usize = 6;
const THREAT_TWO: usize = 7;
const THREAT_NEAR_ENEMY: usize = 8;
const THREAT_THREE_AND_FOUR: usize = 9;
const THREAT_THREE_AND_THREE: usize = 10;
const THREAT_THREE_AND_THREE_BROKEN: usize = 11;

pub const WIN_SCORE: i32 = 1_000_000;

// Compile-time threat-cost table. Replaces the previous `static mut` + Once::call_once,
// which fired a synchronization check on every threat evaluation in the hot path.
const THREAT_COST: [i32; 12] = {
    let mut t = [0i32; 12];
    t[THREAT_NOTHING] = 0;
    t[THREAT_FIVE] = 100_000;
    t[THREAT_STRAIGHT_FOUR] = 50_000;
    t[THREAT_FOUR] = 10_000;
    t[THREAT_FOUR_BROKEN] = 8_000;
    t[THREAT_THREE] = 1_000;
    t[THREAT_THREE_BROKEN] = 200;
    t[THREAT_TWO] = 50;
    t[THREAT_NEAR_ENEMY] = 10;
    t[THREAT_THREE_AND_FOUR] = 45_000;
    t[THREAT_THREE_AND_THREE] = 40_000;
    t[THREAT_THREE_AND_THREE_BROKEN] = 5_000;
    t
};

/// Kept for API compatibility; the threat table is now compile-time, so this is a no-op.
#[inline]
#[allow(dead_code)]
pub fn populate_threat_matrix() {}

#[inline]
fn threat_cost(idx: usize) -> i32 {
    THREAT_COST[idx]
}

/// Count squares in one direction from center, tracking holes and contiguous stones.
fn count_squares(
    value: i32,
    player: i32,
    last_square: &mut i32,
    hole_count: &mut i32,
    square_count: &mut i32,
    contiguous_square_count: &mut i32,
    enemy_count: &mut i32,
) -> bool {
    if value == player {
        *square_count += 1;
        if *hole_count == 0 {
            *contiguous_square_count += 1;
        }
    } else if value == CELL_EMPTY {
        if *last_square == CELL_EMPTY {
            return true; // Two consecutive holes - stop
        }
        *hole_count += 1;
    } else {
        // enemy
        *enemy_count += 1;
        return true;
    }
    *last_square = value;
    false
}

/// Analyze a single line/direction for threat patterns.
fn calc_threat_in_one_dimension(row: &[i32], player: i32) -> usize {
    let center = SEARCH_RADIUS as usize;
    let mut player_square_count = 1i32;
    let mut player_contiguous_square_count = 1i32;
    let mut enemy_count = 0i32;
    let mut right_hole_count = 0i32;
    let mut left_hole_count = 0i32;
    let mut last_square;

    // Walk right
    last_square = player;
    for i in (center + 1)..row.len() {
        if row[i] == OUT_OF_BOUNDS {
            break;
        }
        if count_squares(
            row[i],
            player,
            &mut last_square,
            &mut right_hole_count,
            &mut player_square_count,
            &mut player_contiguous_square_count,
            &mut enemy_count,
        ) {
            break;
        }
    }

    // Walk left
    last_square = player;
    for i in (0..center).rev() {
        if row[i] == OUT_OF_BOUNDS {
            break;
        }
        if count_squares(
            row[i],
            player,
            &mut last_square,
            &mut left_hole_count,
            &mut player_square_count,
            &mut player_contiguous_square_count,
            &mut enemy_count,
        ) {
            break;
        }
    }

    let holes = left_hole_count + right_hole_count;
    let total = holes + player_square_count;

    if player_contiguous_square_count >= 5 {
        THREAT_FIVE
    } else if player_contiguous_square_count == 4 && right_hole_count > 0 && left_hole_count > 0 {
        THREAT_STRAIGHT_FOUR
    } else if player_contiguous_square_count == 4 && (right_hole_count > 0 || left_hole_count > 0) {
        THREAT_FOUR
    } else if player_contiguous_square_count == 3 && right_hole_count > 0 && left_hole_count > 0 {
        THREAT_THREE
    } else if player_square_count >= 4
        && (right_hole_count > 0 || left_hole_count > 0)
        && total >= 5
    {
        THREAT_FOUR_BROKEN
    } else if player_square_count >= 3
        && (right_hole_count > 0 || left_hole_count > 0)
        && total >= 5
    {
        THREAT_THREE_BROKEN
    } else if player_contiguous_square_count >= 2
        && (right_hole_count > 0 || left_hole_count > 0)
        && total >= 4
    {
        THREAT_TWO
    } else if player_contiguous_square_count >= 1
        && (right_hole_count == 0 || left_hole_count == 0)
        && enemy_count > 0
    {
        THREAT_NEAR_ENEMY
    } else {
        THREAT_NOTHING
    }
}

fn calc_combination_threat(one: usize, two: usize) -> i32 {
    let (one, two) = if one > two { (two, one) } else { (one, two) };

    if one == THREAT_THREE
        && (two == THREAT_FOUR || two == THREAT_STRAIGHT_FOUR || two == THREAT_FOUR_BROKEN)
    {
        return threat_cost(THREAT_THREE_AND_FOUR);
    }
    if one == THREAT_THREE && two == THREAT_THREE {
        return threat_cost(THREAT_THREE_AND_THREE);
    }
    if one == THREAT_THREE_BROKEN
        && (two == THREAT_FOUR || two == THREAT_STRAIGHT_FOUR || two == THREAT_FOUR_BROKEN)
    {
        return threat_cost(THREAT_THREE_AND_THREE);
    }
    if one == THREAT_THREE && two == THREAT_THREE_BROKEN {
        return threat_cost(THREAT_THREE_AND_THREE_BROKEN);
    }
    if one == THREAT_THREE_BROKEN && two == THREAT_THREE_BROKEN {
        return threat_cost(THREAT_THREE_AND_THREE_BROKEN) / 2;
    }
    if (one == THREAT_FOUR || one == THREAT_FOUR_BROKEN)
        && (two == THREAT_FOUR || two == THREAT_FOUR_BROKEN)
    {
        return threat_cost(THREAT_THREE_AND_FOUR);
    }
    if one == THREAT_TWO && (two == THREAT_FOUR || two == THREAT_FOUR_BROKEN) {
        return 500;
    }
    if one == THREAT_TWO && two == THREAT_THREE {
        return 300;
    }
    0
}

/// Calculate the threat score for a stone at position (x, y).
pub fn calc_score_at(board: &Board, player: i32, x: i32, y: i32) -> i32 {
    let size = board.size as i32;
    let min_x = max(x - SEARCH_RADIUS, 0);
    let max_x = min(x + SEARCH_RADIUS, size - 1);
    let min_y = max(y - SEARCH_RADIUS, 0);
    let max_y = min(y + SEARCH_RADIUS, size - 1);

    let center = SEARCH_RADIUS as usize;
    let mut threats = [0usize; NUM_DIRECTIONS];
    // Stack-allocated scratch row reused for all 4 directions. Avoids 4 heap
    // allocations per call — and `calc_score_at` is called once per occupied
    // stone in the eval radius for every leaf node, so the savings are large.
    let mut row = [OUT_OF_BOUNDS; ROW_SIZE];

    // Horizontal
    row[center] = player;
    for (i, idx) in ((x + 1)..=max_x).zip((center + 1)..) {
        row[idx] = board.get(i as usize, y as usize);
    }
    for (i, idx) in (min_x..x).rev().zip((0..center).rev()) {
        row[idx] = board.get(i as usize, y as usize);
    }
    threats[0] = calc_threat_in_one_dimension(&row, player);

    // Vertical
    row = [OUT_OF_BOUNDS; ROW_SIZE];
    row[center] = player;
    for (j, idx) in ((y + 1)..=max_y).zip((center + 1)..) {
        row[idx] = board.get(x as usize, j as usize);
    }
    for (j, idx) in (min_y..y).rev().zip((0..center).rev()) {
        row[idx] = board.get(x as usize, j as usize);
    }
    threats[1] = calc_threat_in_one_dimension(&row, player);

    // Diagonal (top-left to bottom-right)
    row = [OUT_OF_BOUNDS; ROW_SIZE];
    row[center] = player;
    {
        let mut i = x + 1;
        let mut j = y + 1;
        let mut idx = center + 1;
        while i <= max_x && j <= max_y {
            row[idx] = board.get(i as usize, j as usize);
            i += 1;
            j += 1;
            idx += 1;
        }
    }
    {
        let mut i = x - 1;
        let mut j = y - 1;
        let mut idx = center as i32 - 1;
        while i >= min_x && j >= min_y && idx >= 0 {
            row[idx as usize] = board.get(i as usize, j as usize);
            i -= 1;
            j -= 1;
            idx -= 1;
        }
    }
    threats[2] = calc_threat_in_one_dimension(&row, player);

    // Diagonal (bottom-left to top-right)
    row = [OUT_OF_BOUNDS; ROW_SIZE];
    row[center] = player;
    {
        let mut i = x + 1;
        let mut j = y - 1;
        let mut idx = center + 1;
        while i <= max_x && j >= min_y {
            row[idx] = board.get(i as usize, j as usize);
            i += 1;
            j -= 1;
            idx += 1;
        }
    }
    {
        let mut i = x - 1;
        let mut j = y + 1;
        let mut idx = center as i32 - 1;
        while i >= min_x && j <= max_y && idx >= 0 {
            row[idx as usize] = board.get(i as usize, j as usize);
            i -= 1;
            j += 1;
            idx -= 1;
        }
    }
    threats[3] = calc_threat_in_one_dimension(&row, player);

    let mut score = 0;
    for i in 0..NUM_DIRECTIONS {
        score += threat_cost(threats[i]);
        for j in (i + 1)..NUM_DIRECTIONS {
            score += calc_combination_threat(threats[i], threats[j]);
        }
    }
    score
}

/// Full board evaluation from the perspective of `player`.
pub fn evaluate_position(board: &Board, player: i32) -> i32 {
    if board.has_winner(player) {
        return WIN_SCORE;
    }
    let opp = other_player(player);
    if board.has_winner(opp) {
        return -WIN_SCORE;
    }
    let mut total = 0i32;
    let size = board.size as i32;
    for i in 0..size {
        for j in 0..size {
            let cell = board.get(i as usize, j as usize);
            if cell == player {
                total += calc_score_at(board, player, i, j);
            } else if cell == opp {
                total -= calc_score_at(board, opp, i, j);
            }
        }
    }
    total
}

/// Incremental evaluation focusing on the region near the last move (no terminal checks).
pub fn evaluate_position_incremental_fast(
    board: &Board,
    player: i32,
    last_x: i32,
    last_y: i32,
) -> i32 {
    let size = board.size as i32;
    let opp = other_player(player);
    let eval_radius = 3;
    let min_x = max(0, last_x - eval_radius);
    let max_x = min(size - 1, last_x + eval_radius);
    let min_y = max(0, last_y - eval_radius);
    let max_y = min(size - 1, last_y + eval_radius);

    let mut total = 0i32;
    for i in min_x..=max_x {
        for j in min_y..=max_y {
            let cell = board.get(i as usize, j as usize);
            if cell == player {
                total += calc_score_at(board, player, i, j);
            } else if cell == opp {
                total -= calc_score_at(board, opp, i, j);
            }
        }
    }
    total
}

// ============================================================================
// Fast threat evaluation (used by move ordering and VCT)
// ============================================================================

struct DirectionInfo {
    contiguous: i32,
    total: i32,
    open_end: i32,
    holes: i32,
}

fn analyze_direction(
    board: &Board,
    x: i32,
    y: i32,
    dx: i32,
    dy: i32,
    player: i32,
) -> DirectionInfo {
    let size = board.size as i32;
    let mut info = DirectionInfo {
        contiguous: 0,
        total: 0,
        open_end: 0,
        holes: 0,
    };
    let (mut nx, mut ny) = (x + dx, y + dy);
    let mut found_hole = false;

    while nx >= 0 && nx < size && ny >= 0 && ny < size {
        let cell = board.get(nx as usize, ny as usize);
        if cell == player {
            if !found_hole {
                info.contiguous += 1;
            }
            info.total += 1;
        } else if cell == CELL_EMPTY {
            if found_hole {
                info.open_end = 1;
                break;
            }
            found_hole = true;
            info.holes += 1;
            let (nnx, nny) = (nx + dx, ny + dy);
            if nnx >= 0
                && nnx < size
                && nny >= 0
                && nny < size
                && board.get(nnx as usize, nny as usize) == player
            {
                // Continue scanning
            } else {
                info.open_end = 1;
                break;
            }
        } else {
            info.open_end = 0;
            break;
        }
        nx += dx;
        ny += dy;
    }

    if nx < 0 || nx >= size || ny < 0 || ny >= size {
        info.open_end = 0;
    }

    info
}

/// Fast threat evaluation without board modifications.
pub fn evaluate_threat_fast(board: &Board, x: i32, y: i32, player: i32) -> i32 {
    let directions: [(i32, i32); 4] = [(1, 0), (0, 1), (1, 1), (1, -1)];
    let mut dir_threats = [0i32; 4];
    let mut dir_is_four = [false; 4];
    let mut dir_is_open_three = [false; 4];
    let mut dir_is_three = [false; 4];
    let mut dir_is_open_two = [false; 4];

    for (d, &(dx, dy)) in directions.iter().enumerate() {
        let pos = analyze_direction(board, x, y, dx, dy, player);
        let neg = analyze_direction(board, x, y, -dx, -dy, player);

        let contiguous = 1 + pos.contiguous + neg.contiguous;
        let total = 1 + pos.total + neg.total;
        let _holes = pos.holes + neg.holes;
        let open_ends = pos.open_end + neg.open_end;

        let mut threat = 0;
        // Standard gomoku: exactly five wins; six or more (overline) does not.
        // Without this distinction the AI would score gap-fill moves like
        // XXXX_X → XXXXXX as wins (1_000_000) and pick them over actual fives.
        if contiguous == 5 {
            threat = 1_000_000;
        } else if contiguous >= 6 {
            threat = 0;
        } else if contiguous == 4 {
            if open_ends >= 2 {
                threat = 500_000;
            } else if open_ends == 1 {
                threat = 100_000;
            }
            dir_is_four[d] = true;
        } else if total >= 4 && _holes <= 1 {
            // Broken four (XX_XX, X_XXX, XXX_X) — filling the gap creates five.
            // C version scores this 100_000 (must-block); Rust used 8000 here,
            // which under-rated the threat compared to the C reference.
            threat = 100_000;
            dir_is_four[d] = true;
        } else if contiguous == 3 {
            if open_ends >= 2 {
                threat = 1500;
                dir_is_open_three[d] = true;
            } else if open_ends == 1 {
                threat = 500;
            }
            dir_is_three[d] = true;
        } else if total >= 3 && _holes <= 1 {
            if open_ends >= 2 {
                threat = 1500;
                dir_is_open_three[d] = true;
                dir_is_three[d] = true;
            } else if open_ends == 1 {
                threat = 400;
                dir_is_three[d] = true;
            }
        } else if contiguous == 2 && open_ends >= 2 {
            threat = 100;
            dir_is_open_two[d] = true;
        }
        dir_threats[d] = threat;
    }

    let mut max_threat = *dir_threats.iter().max().unwrap_or(&0);

    let num_fours = dir_is_four.iter().filter(|&&v| v).count();
    let num_open_threes = dir_is_open_three.iter().filter(|&&v| v).count();
    let num_threes = dir_is_three.iter().filter(|&&v| v).count();
    let num_open_twos = dir_is_open_two.iter().filter(|&&v| v).count();

    if num_fours >= 1 && num_threes >= 1 {
        max_threat = max_threat.max(45000);
    }
    if num_open_threes >= 2 {
        max_threat = max_threat.max(40000);
    }
    if num_fours >= 2 {
        max_threat = max_threat.max(48000);
    }
    if num_open_threes >= 1 && num_threes >= 2 {
        max_threat = max_threat.max(30000);
    }
    // Two intersecting open-twos are a fork setup (diamond pattern): each
    // open-two alone is harmless, but the pivot cell creates two open-threes
    // simultaneously — a forced win in 5 moves. C version scores this 25_000.
    if num_open_twos >= 2 {
        max_threat = max_threat.max(25_000);
    }
    if num_open_twos >= 1 && num_open_threes >= 1 {
        max_threat = max_threat.max(15_000);
    }

    max_threat
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::board::{Board, CELL_CROSSES, CELL_NAUGHTS};

    fn empty_score() -> i32 {
        evaluate_position(&Board::new(15), CELL_CROSSES)
    }

    #[test]
    fn evaluate_empty_board_is_zero() {
        assert_eq!(empty_score(), 0);
    }

    #[test]
    fn winning_position_returns_win_score() {
        let mut b = Board::new(15);
        for j in 4..=8 {
            b.set(7, j, CELL_CROSSES);
        }
        assert_eq!(evaluate_position(&b, CELL_CROSSES), WIN_SCORE);
        assert_eq!(evaluate_position(&b, CELL_NAUGHTS), -WIN_SCORE);
    }

    #[test]
    fn threat_fast_detects_open_four() {
        let mut b = Board::new(15);
        // Open four: empty | X X X X | empty (place a stone at the open ends to win).
        for j in 5..=8 {
            b.set(7, j, CELL_CROSSES);
        }
        // Putting another X at (7,9) completes a 5 → "is winning move", reported as 1_000_000.
        let win_threat = evaluate_threat_fast(&b, 7, 9, CELL_CROSSES);
        assert!(win_threat >= 100_000, "got {}", win_threat);
        // Empty far-away cell has no threat.
        assert_eq!(evaluate_threat_fast(&b, 0, 0, CELL_CROSSES), 0);
    }

    #[test]
    fn threat_fast_rates_open_three_above_open_two() {
        let mut b = Board::new(15);
        b.set(7, 6, CELL_CROSSES);
        b.set(7, 7, CELL_CROSSES);
        // Adding a third stone here would make an open three centered around y=8.
        let three = evaluate_threat_fast(&b, 7, 8, CELL_CROSSES);
        // Compare with a totally fresh open-two scenario.
        let mut c = Board::new(15);
        c.set(7, 7, CELL_CROSSES);
        let two = evaluate_threat_fast(&c, 7, 8, CELL_CROSSES);
        assert!(three > two, "three={} should outscore two={}", three, two);
    }

    #[test]
    fn populate_threat_matrix_is_idempotent() {
        populate_threat_matrix();
        populate_threat_matrix();
    }

    #[test]
    fn evaluate_position_is_symmetric_for_mirrored_states() {
        let mut a = Board::new(15);
        let mut b = Board::new(15);
        a.set(7, 7, CELL_CROSSES);
        b.set(7, 7, CELL_NAUGHTS);
        assert_eq!(
            evaluate_position(&a, CELL_CROSSES),
            evaluate_position(&b, CELL_NAUGHTS),
        );
    }
}
