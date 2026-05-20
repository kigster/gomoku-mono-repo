//! AI module: minimax search, move generation, VCT, and move finding.
//!
//! Ported from ai.c.
use crate::board::{Board, CELL_CROSSES, CELL_EMPTY, other_player};
use crate::eval::{
    WIN_SCORE, evaluate_position, evaluate_position_incremental_fast, evaluate_threat_fast,
};
use crate::game::{GameState, TT_EXACT, TT_LOWER_BOUND, TT_UPPER_BOUND};
use rand::Rng;
use rayon::prelude::*;
use std::cmp::{max, min};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::available_parallelism;
use std::time::Instant;

#[derive(Clone, Copy)]
pub struct Move {
    pub x: i32,
    pub y: i32,
    pub priority: i32,
}

#[derive(Clone, Default)]
pub struct ScoringEntry {
    pub evaluator: String,
    pub is_current_player: bool,
    pub evaluated_moves: i32,
    pub score: i32,
    pub time_ms: f64,
    pub decisive: bool,
    pub have_win: bool,
    pub have_vct: bool,
    pub vct_sequence: Vec<(i32, i32)>,
}

#[derive(Clone, Default)]
pub struct ScoringReport {
    pub entries: Vec<ScoringEntry>,
    pub offensive_max_score: i32,
    pub defensive_max_score: i32,
}

impl ScoringReport {
    pub fn add_entry(&mut self, evaluator: &str, is_current_player: bool) -> &mut ScoringEntry {
        self.entries.push(ScoringEntry {
            evaluator: evaluator.to_string(),
            is_current_player,
            ..Default::default()
        });
        self.entries.last_mut().unwrap()
    }
}

// ============================================================================
// Move generation
// ============================================================================

/// Maximum supported board (19x19) — used to size scratch arrays without alloc.
const MAX_BOARD_CELLS: usize = 19 * 19;

pub fn generate_moves(
    game: &GameState,
    board: &Board,
    current_player: i32,
    depth_remaining: i32,
) -> Vec<Move> {
    let size = board.size;

    // Quick empty-board check: scan until first stone is found instead of
    // counting all stones. `Board::stone_count` was iterating the full Vec
    // on every call.
    let mut any_stone = false;
    'outer: for x in 0..size {
        for y in 0..size {
            if board.get(x, y) != CELL_EMPTY {
                any_stone = true;
                break 'outer;
            }
        }
    }
    if !any_stone {
        return vec![Move {
            x: (size / 2) as i32,
            y: (size / 2) as i32,
            priority: 1000,
        }];
    }

    // Stack-allocated candidate mask. Replaces a `vec![vec![false; size]; size]`
    // that allocated `size + 1` heap vectors on every recursive call.
    let mut candidate = [false; MAX_BOARD_CELLS];
    let radius = game.search_radius;
    let isize_size = size as i32;
    let mut moves = Vec::with_capacity(64);

    for x in 0..size {
        for y in 0..size {
            if board.get(x, y) == CELL_EMPTY {
                continue;
            }
            let xi = x as i32;
            let yi = y as i32;
            let x_lo = max(0, xi - radius);
            let x_hi = min(isize_size - 1, xi + radius);
            let y_lo = max(0, yi - radius);
            let y_hi = min(isize_size - 1, yi + radius);
            for nx in x_lo..=x_hi {
                for ny in y_lo..=y_hi {
                    if board.get(nx as usize, ny as usize) != CELL_EMPTY {
                        continue;
                    }
                    candidate[nx as usize * size + ny as usize] = true;
                }
            }
        }
    }

    for x in 0..size {
        for y in 0..size {
            if !candidate[x * size + y] {
                continue;
            }
            let priority = get_move_priority_optimized(
                game,
                board,
                x as i32,
                y as i32,
                current_player,
                depth_remaining,
            );
            moves.push(Move {
                x: x as i32,
                y: y as i32,
                priority,
            });
        }
    }

    moves
}

fn get_move_priority_optimized(
    game: &GameState,
    board: &Board,
    x: i32,
    y: i32,
    player: i32,
    depth_remaining: i32,
) -> i32 {
    let center = (game.board_size / 2) as i32;
    let mut priority = 0i32;
    let center_dist = (x - center).abs() + (y - center).abs();
    priority += max(0, game.board_size as i32 - center_dist);

    let my_threat = evaluate_threat_fast(board, x, y, player);
    let opp_threat = evaluate_threat_fast(board, x, y, other_player(player));

    if my_threat >= 500_000 {
        return 2_000_000_000;
    }
    if opp_threat >= 500_000 {
        return 1_500_000_000;
    }
    if my_threat >= 40000 {
        return 1_200_000_000 + my_threat;
    }
    if opp_threat >= 40000 {
        return 1_100_000_000 + opp_threat;
    }

    if game.is_killer_move(depth_remaining, x, y) {
        priority += 1_000_000;
    }

    if opp_threat >= 1500 {
        priority += my_threat * 10;
        priority += opp_threat * 12;
    } else {
        priority += my_threat * 15;
        priority += opp_threat * 5;
    }

    priority
}

// ============================================================================
// VCT (Victory by Continuous Threats)
// ============================================================================

fn find_block_cell(board: &Board, x: i32, y: i32, player: i32) -> Option<(i32, i32)> {
    let size = board.size as i32;
    let directions: [(i32, i32); 4] = [(1, 0), (0, 1), (1, 1), (1, -1)];
    let mut found_count = 0;
    let mut block = (-1i32, -1i32);

    for &(dx, dy) in &directions {
        for sign in [-1i32, 1] {
            for dist in 1..=5 {
                let nx = x + sign * dx * dist;
                let ny = y + sign * dy * dist;
                if nx < 0 || nx >= size || ny < 0 || ny >= size {
                    break;
                }
                let cell = board.get(nx as usize, ny as usize);
                if cell == CELL_EMPTY {
                    // Check if placing player's stone here would win
                    let _threat = evaluate_threat_fast(board, nx, ny, player);
                    // Approximate is_winning_move by checking if threat >= 1000000
                    // (we'd need to place and check, but this is close enough)
                    let mut test_board = board.clone();
                    test_board.set(nx as usize, ny as usize, player);
                    if test_board.has_winner(player) {
                        if found_count == 0 {
                            block = (nx, ny);
                        }
                        found_count += 1;
                        if found_count >= 2 {
                            return None; // Open four: unstoppable
                        }
                    }
                    break;
                } else if cell != player {
                    break;
                }
            }
        }
    }

    if found_count == 1 { Some(block) } else { None }
}

fn find_forced_win_recursive(
    game: &GameState,
    board: &mut Board,
    player: i32,
    max_depth: i32,
    sequence: &mut Vec<(i32, i32)>,
) -> Option<(i32, i32)> {
    let opponent = other_player(player);

    let moves = generate_moves(game, board, player, game.max_depth);

    // Check for immediate compound win
    for m in &moves {
        let threat = evaluate_threat_fast(board, m.x, m.y, player);
        if threat >= 40000 {
            sequence.push((m.x, m.y));
            return Some((m.x, m.y));
        }
    }

    if max_depth <= 0 {
        return None;
    }

    for m in &moves {
        let threat = evaluate_threat_fast(board, m.x, m.y, player);
        if threat < 8000 {
            continue;
        }

        let (mx, my) = (m.x, m.y);
        board.set(mx as usize, my as usize, player);

        let post_threat = evaluate_threat_fast(board, mx, my, player);
        if post_threat >= 500_000 {
            board.set(mx as usize, my as usize, CELL_EMPTY);
            sequence.push((mx, my));
            return Some((mx, my));
        }

        // Check if placing creates a compound threat
        let mut creates_compound = false;
        for m2 in &moves {
            if board.get(m2.x as usize, m2.y as usize) != CELL_EMPTY {
                continue;
            }
            if evaluate_threat_fast(board, m2.x, m2.y, player) >= 40000 {
                creates_compound = true;
                break;
            }
        }
        if creates_compound {
            board.set(mx as usize, my as usize, CELL_EMPTY);
            sequence.push((mx, my));
            return Some((mx, my));
        }

        let block_result = find_block_cell(board, mx, my, player);
        match block_result {
            None => {
                board.set(mx as usize, my as usize, CELL_EMPTY);
                continue;
            }
            Some((bx, by)) => {
                let opp_threat_at_block = evaluate_threat_fast(board, bx, by, opponent);
                if opp_threat_at_block >= 8000 {
                    board.set(mx as usize, my as usize, CELL_EMPTY);
                    continue;
                }

                board.set(bx as usize, by as usize, opponent);

                let saved_len = sequence.len();
                sequence.push((mx, my));

                let found = find_forced_win_recursive(game, board, player, max_depth - 1, sequence);

                board.set(bx as usize, by as usize, CELL_EMPTY);
                board.set(mx as usize, my as usize, CELL_EMPTY);

                if found.is_some() {
                    return Some((mx, my));
                }

                sequence.truncate(saved_len);
            }
        }
    }

    None
}

pub fn find_forced_win(
    game: &GameState,
    board: &mut Board,
    player: i32,
    max_depth: i32,
) -> (Option<(i32, i32)>, Vec<(i32, i32)>) {
    let mut sequence = Vec::new();
    let result = find_forced_win_recursive(game, board, player, max_depth, &mut sequence);
    (result, sequence)
}

fn find_forced_win_block(
    game: &GameState,
    board: &mut Board,
    ai_player: i32,
    max_depth: i32,
) -> Option<(i32, i32)> {
    let opponent = other_player(ai_player);

    let (opp_result, _) = find_forced_win(game, board, opponent, max_depth);
    let (opp_x, opp_y) = opp_result?;

    let moves = generate_moves(game, board, ai_player, game.max_depth);
    let mut best: Option<(i32, i32)> = None;
    let mut best_own_threat = -1i32;

    for m in &moves {
        board.set(m.x as usize, m.y as usize, ai_player);
        let (opp_still, _) = find_forced_win(game, board, opponent, max_depth);
        board.set(m.x as usize, m.y as usize, CELL_EMPTY);

        if opp_still.is_none() {
            let own_threat = evaluate_threat_fast(board, m.x, m.y, ai_player);
            if own_threat > best_own_threat {
                best_own_threat = own_threat;
                best = Some((m.x, m.y));
            }
        }
    }

    best.or(Some((opp_x, opp_y)))
}

// ============================================================================
// Minimax with alpha-beta pruning
// ============================================================================

pub fn minimax_with_timeout(
    game: &mut GameState,
    depth: i32,
    mut alpha: i32,
    mut beta: i32,
    maximizing_player: bool,
    ai_player: i32,
    last_x: i32,
    last_y: i32,
) -> i32 {
    if game.is_search_timed_out() {
        game.search_timed_out = true;
        if last_x >= 0 && last_y >= 0 {
            return evaluate_position_incremental_fast(&game.board, ai_player, last_x, last_y);
        }
        return evaluate_position(&game.board, ai_player);
    }

    let hash = game.current_hash;

    if let Some(value) = game.probe_transposition(hash, ai_player, depth, alpha, beta) {
        return value;
    }

    // Terminal check
    if last_x >= 0 && last_y >= 0 && game.board.get(last_x as usize, last_y as usize) != CELL_EMPTY
    {
        let last_player = game.board.get(last_x as usize, last_y as usize);
        if game
            .board
            .is_five_from_last_move(last_x, last_y, last_player)
        {
            let value = if last_player == ai_player {
                WIN_SCORE + depth
            } else {
                -WIN_SCORE - depth
            };
            game.store_transposition(hash, ai_player, value, depth, TT_EXACT, -1, -1);
            return value;
        }
    }

    if depth == 0 {
        let value = if last_x >= 0 && last_y >= 0 {
            evaluate_position_incremental_fast(&game.board, ai_player, last_x, last_y)
        } else {
            evaluate_position(&game.board, ai_player)
        };
        game.store_transposition(hash, ai_player, value, depth, TT_EXACT, -1, -1);
        return value;
    }

    let current_player_turn = if maximizing_player {
        ai_player
    } else {
        other_player(ai_player)
    };
    let mut moves = generate_moves(game, &game.board, current_player_turn, depth);

    if moves.is_empty() {
        return 0;
    }

    moves.sort_by_key(|m| std::cmp::Reverse(m.priority));

    let mut best_x = -1i32;
    let mut best_y = -1i32;
    let original_alpha = alpha;
    let original_beta = beta;
    let pi = if current_player_turn == CELL_CROSSES {
        0
    } else {
        1
    };

    if maximizing_player {
        let mut max_eval = -WIN_SCORE - 1;
        for m in &moves {
            if game.is_search_timed_out() {
                game.search_timed_out = true;
                return max_eval;
            }

            let (i, j) = (m.x, m.y);
            game.board.set(i as usize, j as usize, current_player_turn);
            let pos = i as usize * game.board_size + j as usize;
            game.current_hash ^= game.zobrist_keys[pi][pos];

            let eval = minimax_with_timeout(game, depth - 1, alpha, beta, false, ai_player, i, j);

            game.current_hash ^= game.zobrist_keys[pi][pos];
            game.board.set(i as usize, j as usize, CELL_EMPTY);

            if eval > max_eval {
                max_eval = eval;
                best_x = i;
                best_y = j;
            }
            alpha = max(alpha, eval);
            if eval >= WIN_SCORE - 1000 {
                break;
            }
            if beta <= alpha {
                break;
            }
        }

        let flag = if max_eval <= original_alpha {
            TT_UPPER_BOUND
        } else if max_eval >= original_beta {
            TT_LOWER_BOUND
        } else {
            TT_EXACT
        };
        game.store_transposition(hash, ai_player, max_eval, depth, flag, best_x, best_y);
        if max_eval >= original_beta && best_x != -1 {
            game.store_killer_move(depth, best_x, best_y);
        }
        max_eval
    } else {
        let mut min_eval = WIN_SCORE + 1;
        for m in &moves {
            if game.is_search_timed_out() {
                game.search_timed_out = true;
                return min_eval;
            }

            let (i, j) = (m.x, m.y);
            game.board.set(i as usize, j as usize, current_player_turn);
            let pos = i as usize * game.board_size + j as usize;
            game.current_hash ^= game.zobrist_keys[pi][pos];

            let eval = minimax_with_timeout(game, depth - 1, alpha, beta, true, ai_player, i, j);

            game.current_hash ^= game.zobrist_keys[pi][pos];
            game.board.set(i as usize, j as usize, CELL_EMPTY);

            if eval < min_eval {
                min_eval = eval;
                best_x = i;
                best_y = j;
            }
            beta = min(beta, eval);
            if eval <= -WIN_SCORE + 1000 {
                break;
            }
            if beta <= alpha {
                break;
            }
        }

        let flag = if min_eval <= original_alpha {
            TT_UPPER_BOUND
        } else if min_eval >= original_beta {
            TT_LOWER_BOUND
        } else {
            TT_EXACT
        };
        game.store_transposition(hash, ai_player, min_eval, depth, flag, best_x, best_y);
        if min_eval <= original_alpha && best_x != -1 {
            game.store_killer_move(depth, best_x, best_y);
        }
        min_eval
    }
}

// ============================================================================
// Root iterative-deepening search (with optional rayon parallelism)
// ============================================================================

/// Search a single root move on a (cloned) GameState. Returns the score.
/// Mutates the passed-in GameState's TT and killer-move tables — caller must
/// clone first if it doesn't want those side effects.
fn search_one_root(game: &mut GameState, mv: Move, ai_player: i32, depth: i32) -> i32 {
    let pi = if ai_player == CELL_CROSSES { 0 } else { 1 };
    let (i, j) = (mv.x, mv.y);
    game.board.set(i as usize, j as usize, ai_player);
    let pos = i as usize * game.board_size + j as usize;
    game.current_hash ^= game.zobrist_keys[pi][pos];

    let score = minimax_with_timeout(
        game,
        depth - 1,
        -WIN_SCORE - 1,
        WIN_SCORE + 1,
        false,
        ai_player,
        i,
        j,
    );

    game.current_hash ^= game.zobrist_keys[pi][pos];
    game.board.set(i as usize, j as usize, CELL_EMPTY);
    score
}

/// Returns (best_x, best_y, moves_considered, final_best_score, won_early).
/// `won_early` is true if a winning score was found and we should short-circuit.
fn run_root_search(
    game: &mut GameState,
    sorted_moves: &[Move],
    ai_player: i32,
) -> (i32, i32, i32, i32, bool) {
    let cores = available_parallelism().map(|n| n.get()).unwrap_or(1);
    // Parallelism is only worthwhile when the per-move search is expensive
    // (depth >= 3) and we have at least a couple of root moves to spread.
    // For shallow depths the clone overhead dominates.
    let want_parallel = cores >= 2 && sorted_moves.len() >= 2 && game.max_depth >= 3;

    let mut best_x = sorted_moves[0].x;
    let mut best_y = sorted_moves[0].y;
    let mut moves_considered = 0i32;
    let mut final_best_score: i32 = -WIN_SCORE - 1;

    for current_depth in 1..=game.max_depth {
        if game.is_search_timed_out() {
            break;
        }

        let (results, considered) = if want_parallel && current_depth >= 2 {
            search_root_moves_parallel(game, sorted_moves, ai_player, current_depth, cores)
        } else {
            search_root_moves_serial(game, sorted_moves, ai_player, current_depth)
        };

        moves_considered += considered;

        if !results.is_empty() {
            let mut depth_best = i32::MIN;
            for &(_, _, s) in &results {
                if s > depth_best {
                    depth_best = s;
                }
            }
            let bests: Vec<&(i32, i32, i32)> = results
                .iter()
                .filter(|(_, _, s)| *s == depth_best)
                .collect();
            if !bests.is_empty() {
                let idx = rand::rng().random_range(0..bests.len());
                best_x = bests[idx].0;
                best_y = bests[idx].1;
                final_best_score = depth_best;
            }

            // Early exit if we found a near-immediate win.
            if depth_best >= WIN_SCORE - 1000 {
                return (best_x, best_y, moves_considered, depth_best, true);
            }
        }

        if game.search_timed_out {
            break;
        }
    }

    (best_x, best_y, moves_considered, final_best_score, false)
}

fn search_root_moves_serial(
    game: &mut GameState,
    sorted_moves: &[Move],
    ai_player: i32,
    depth: i32,
) -> (Vec<(i32, i32, i32)>, i32) {
    let mut results = Vec::with_capacity(sorted_moves.len());
    let mut considered = 0i32;
    for m in sorted_moves {
        if game.is_search_timed_out() {
            game.search_timed_out = true;
            break;
        }
        let score = search_one_root(game, *m, ai_player, depth);
        results.push((m.x, m.y, score));
        considered += 1;
        if game.search_timed_out {
            break;
        }
        if score >= WIN_SCORE - 1000 {
            break;
        }
    }
    (results, considered)
}

/// Parallel root-move search. Each worker takes a chunk of the sorted root
/// moves and searches them on its own GameState clone. The clones each carry
/// their own TT and killer-move tables — no shared mutable state, no locks
/// — and are dropped when the search completes, so nothing leaks across
/// requests. A shared `AtomicBool` lets workers cooperate on timeout.
fn search_root_moves_parallel(
    game: &mut GameState,
    sorted_moves: &[Move],
    ai_player: i32,
    depth: i32,
    cores: usize,
) -> (Vec<(i32, i32, i32)>, i32) {
    let n = sorted_moves.len();
    let workers = cores.min(n).max(1);
    let chunk_size = n.div_ceil(workers);
    let timeout_flag = Arc::new(AtomicBool::new(false));

    let chunks: Vec<&[Move]> = sorted_moves.chunks(chunk_size).collect();
    let parent_search_start = game.search_start;
    let parent_move_timeout = game.move_timeout;

    let outputs: Vec<(Vec<(i32, i32, i32)>, i32, bool)> = chunks
        .into_par_iter()
        .map(|chunk| {
            // Each worker gets its own GameState clone so the TT, killer moves,
            // hash, and board mutations don't collide with other workers or
            // with the parent search.
            let mut local = game.clone();
            local.search_start = parent_search_start;
            local.move_timeout = parent_move_timeout;
            local.search_timed_out = false;

            let mut local_results = Vec::with_capacity(chunk.len());
            let mut local_considered = 0i32;
            let mut local_timed_out = false;

            for m in chunk {
                if timeout_flag.load(Ordering::Relaxed) || local.is_search_timed_out() {
                    local.search_timed_out = true;
                    local_timed_out = true;
                    break;
                }
                let score = search_one_root(&mut local, *m, ai_player, depth);
                local_results.push((m.x, m.y, score));
                local_considered += 1;
                if local.search_timed_out {
                    local_timed_out = true;
                    timeout_flag.store(true, Ordering::Relaxed);
                    break;
                }
                if score >= WIN_SCORE - 1000 {
                    // Other workers can stop early too.
                    timeout_flag.store(true, Ordering::Relaxed);
                    break;
                }
            }
            (local_results, local_considered, local_timed_out)
        })
        .collect();

    let mut all_results = Vec::with_capacity(n);
    let mut total_considered = 0i32;
    let mut any_timeout = false;
    for (rs, c, t) in outputs {
        all_results.extend(rs);
        total_considered += c;
        any_timeout |= t;
    }
    if any_timeout {
        game.search_timed_out = true;
    }
    (all_results, total_considered)
}

// ============================================================================
// Top-level move finding
// ============================================================================

fn find_first_ai_move(game: &GameState) -> (i32, i32) {
    let size = game.board_size as i32;
    let mut black_x = -1i32;
    let mut black_y = -1i32;

    for i in 0..game.board_size {
        for j in 0..game.board_size {
            if game.board.get(i, j) == CELL_CROSSES {
                black_x = i as i32;
                black_y = j as i32;
                break;
            }
        }
        if black_x >= 0 {
            break;
        }
    }

    if black_x == -1 {
        return (size / 2, size / 2);
    }

    let offsets: [(i32, i32); 16] = [
        (1, 1),
        (1, -1),
        (-1, 1),
        (-1, -1),
        (0, 1),
        (1, 0),
        (0, -1),
        (-1, 0),
        (2, 2),
        (2, -2),
        (-2, 2),
        (-2, -2),
        (0, 2),
        (2, 0),
        (0, -2),
        (-2, 0),
    ];

    for &(ox, oy) in &offsets {
        let x = black_x + ox;
        let y = black_y + oy;
        if x < 0 || x >= size || y < 0 || y >= size {
            continue;
        }
        if game.board.get(x as usize, y as usize) == CELL_EMPTY {
            return (x, y);
        }
    }

    (
        min(size - 1, max(0, black_x + 1)),
        min(size - 1, max(0, black_y)),
    )
}

pub fn find_best_ai_move(game: &mut GameState) -> ((i32, i32), ScoringReport, String) {
    game.search_start = Some(Instant::now());
    game.search_timed_out = false;
    game.current_hash = game.compute_zobrist_hash();

    let mut report = ScoringReport::default();
    let ai_player = game.current_player;
    let opponent = other_player(ai_player);

    let stone_count = game.stones_on_board as usize;

    if stone_count == 1 {
        let (bx, by) = find_first_ai_move(game);
        game.last_ai_moves_evaluated = 1;
        return ((bx, by), report, "adjacent".to_string());
    }

    let moves = generate_moves(game, &game.board, ai_player, game.max_depth);
    let move_count = moves.len() as i32;

    // Pre-compute the threat values for every candidate move ONCE; the prologue
    // steps below previously called `evaluate_threat_fast` 5–7 times for each
    // (move, player) pair, all on the unchanged root board.
    let n = moves.len();
    let mut my_threats = Vec::with_capacity(n);
    let mut opp_threats = Vec::with_capacity(n);
    for m in &moves {
        my_threats.push(evaluate_threat_fast(&game.board, m.x, m.y, ai_player));
        opp_threats.push(evaluate_threat_fast(&game.board, m.x, m.y, opponent));
    }

    // Step 1: collect immediate fives (>= 1_000_000) and open fours (500_000)
    // separately. Open four wins in TWO turns, so the opponent moves first;
    // we must check opponent immediate threats before committing to one.
    let step_start = Instant::now();
    let mut winning_moves: Vec<(i32, i32)> = Vec::new();
    let mut open_four_moves: Vec<(i32, i32)> = Vec::new();
    let mut our_max_score = 0i32;

    for (idx, m) in moves.iter().enumerate() {
        let threat = my_threats[idx];
        if threat > our_max_score {
            our_max_score = threat;
        }
        if threat >= 1_000_000 {
            winning_moves.push((m.x, m.y));
        } else if threat >= 500_000 {
            open_four_moves.push((m.x, m.y));
        }
    }

    {
        let e = report.add_entry("have_win", true);
        e.evaluated_moves = move_count;
        e.score = our_max_score;
        e.have_win = !winning_moves.is_empty();
        e.time_ms = step_start.elapsed().as_secs_f64() * 1000.0;
        if !winning_moves.is_empty() {
            e.decisive = true;
        }
        report.offensive_max_score = our_max_score;
    }

    if !winning_moves.is_empty() {
        let idx = rand::rng().random_range(0..winning_moves.len());
        game.last_ai_moves_evaluated = winning_moves.len() as i32;
        return (winning_moves[idx], report, "have_win".to_string());
    }

    // Step 2: Block opponent immediate wins (>= 500_000 — five or open four).
    // Closed fours (100_000) are intentionally NOT blocked here; they're handled
    // by minimax which can weigh defense against an offensive reply.
    let step_start = Instant::now();
    let mut blocking_moves: Vec<(i32, i32, i32)> = Vec::new();
    let mut max_opp_threat = 0i32;

    for (idx, m) in moves.iter().enumerate() {
        let opp_threat = opp_threats[idx];
        if opp_threat > max_opp_threat {
            max_opp_threat = opp_threat;
        }
        if opp_threat >= 500_000 {
            blocking_moves.push((m.x, m.y, opp_threat));
        }
    }

    {
        let e = report.add_entry("block_threat", false);
        e.evaluated_moves = move_count;
        e.score = -max_opp_threat;
        e.time_ms = step_start.elapsed().as_secs_f64() * 1000.0;
        if !blocking_moves.is_empty() {
            e.decisive = true;
        }
        report.defensive_max_score = -max_opp_threat;
    }

    if !blocking_moves.is_empty() {
        // Among equally urgent blocks, prefer the one that also builds offense.
        let best: Vec<&(i32, i32, i32)> = blocking_moves
            .iter()
            .filter(|b| b.2 == max_opp_threat)
            .collect();
        let mut best_idx = 0usize;
        let mut best_own = -1i32;
        for (i, b) in best.iter().enumerate() {
            // Look up the cached threat for (b.0, b.1) by index in `moves`.
            let own = moves
                .iter()
                .position(|mv| mv.x == b.0 && mv.y == b.1)
                .map(|p| my_threats[p])
                .unwrap_or(0);
            if own > best_own {
                best_own = own;
                best_idx = i;
            }
        }
        let chosen = best[best_idx];
        game.last_ai_moves_evaluated = blocking_moves.len() as i32;
        return ((chosen.0, chosen.1), report, "block_threat".to_string());
    }

    // Step 2.5: Play our open four (500_000) — safe now that opponent's
    // immediate threats are checked. Wins in two turns barring a counter-five.
    if !open_four_moves.is_empty() {
        let e = report.add_entry("open_four", true);
        e.evaluated_moves = open_four_moves.len() as i32;
        e.score = 500_000;
        e.time_ms = 0.0;
        e.decisive = true;
        report.offensive_max_score = report.offensive_max_score.max(500_000);
        let idx = rand::rng().random_range(0..open_four_moves.len());
        game.last_ai_moves_evaluated = open_four_moves.len() as i32;
        return (open_four_moves[idx], report, "open_four".to_string());
    }

    // Step 3: Offensive VCT
    let step_start = Instant::now();
    let mut board_clone = game.board.clone();
    let (vct_result, vct_sequence) = find_forced_win(game, &mut board_clone, ai_player, 10);

    {
        let e = report.add_entry("have_vct", true);
        e.have_vct = vct_result.is_some();
        e.score = if vct_result.is_some() { WIN_SCORE } else { 0 };
        e.time_ms = step_start.elapsed().as_secs_f64() * 1000.0;
        if vct_result.is_some() {
            e.decisive = true;
            e.vct_sequence = vct_sequence.clone();
            report.offensive_max_score = WIN_SCORE;
        }
    }

    if let Some((vx, vy)) = vct_result {
        game.last_ai_moves_evaluated = vct_sequence.len() as i32;
        return ((vx, vy), report, "have_vct".to_string());
    }

    // Step 4: Defensive VCT
    let step_start = Instant::now();
    let mut board_clone = game.board.clone();
    let dvct_result = find_forced_win_block(game, &mut board_clone, ai_player, 10);

    {
        let e = report.add_entry("block_vct", false);
        e.have_vct = dvct_result.is_some();
        e.score = if dvct_result.is_some() { -WIN_SCORE } else { 0 };
        e.time_ms = step_start.elapsed().as_secs_f64() * 1000.0;
        if dvct_result.is_some() {
            e.decisive = true;
            report.defensive_max_score = -WIN_SCORE;
        }
    }

    if let Some((dx, dy)) = dvct_result {
        game.last_ai_moves_evaluated = move_count;
        return ((dx, dy), report, "block_vct".to_string());
    }

    // Step 5: Minimax iterative deepening (root-level parallel when there's
    // more than one CPU available — each worker takes a slice of the sorted
    // root moves and searches it on its own GameState clone).
    let step_start = Instant::now();
    let mut sorted_moves = moves.clone();
    sorted_moves.sort_by_key(|m| std::cmp::Reverse(m.priority));

    let (best_x_out, best_y_out, moves_considered, final_best_score, won_early) =
        run_root_search(game, &sorted_moves, ai_player);

    if won_early {
        game.last_ai_moves_evaluated = moves_considered;
        let e = report.add_entry("minimax", true);
        e.evaluated_moves = moves_considered;
        e.score = final_best_score;
        e.have_win = true;
        e.time_ms = step_start.elapsed().as_secs_f64() * 1000.0;
        report.offensive_max_score = report.offensive_max_score.max(final_best_score);
        return ((best_x_out, best_y_out), report, "minimax".to_string());
    }

    {
        let e = report.add_entry("minimax", true);
        e.evaluated_moves = moves_considered;
        e.score = final_best_score;
        e.time_ms = step_start.elapsed().as_secs_f64() * 1000.0;
        report.offensive_max_score = report.offensive_max_score.max(final_best_score);
    }

    game.last_ai_moves_evaluated = moves_considered;
    ((best_x_out, best_y_out), report, "minimax".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::board::{CELL_CROSSES, CELL_NAUGHTS};
    use crate::game::{GameState, PlayerType};

    fn fresh_game(depth: i32) -> GameState {
        GameState::new(
            15,
            depth,
            0,
            2,
            PlayerType::AI,
            PlayerType::AI,
            depth,
            depth,
            true,
            5,
        )
    }

    #[test]
    fn opening_centre_is_first_move() {
        let mut g = fresh_game(2);
        g.current_player = CELL_CROSSES;
        // generate_moves on an empty board returns the centre.
        let moves = generate_moves(&g, &g.board, CELL_CROSSES, g.max_depth);
        assert_eq!(moves.len(), 1);
        assert_eq!((moves[0].x, moves[0].y), (7, 7));
    }

    #[test]
    fn move_generator_only_produces_empty_cells_within_radius() {
        let mut g = fresh_game(2);
        g.make_move(7, 7, CELL_CROSSES, 0.0, 0, 0, 0);
        let moves = generate_moves(&g, &g.board, CELL_NAUGHTS, g.max_depth);
        // Every generated candidate must be empty.
        for m in &moves {
            assert_eq!(g.board.get(m.x as usize, m.y as usize), 0);
        }
        // Far corner (0,0) must not appear with default radius 2.
        assert!(!moves.iter().any(|m| (m.x, m.y) == (0, 0)));
    }

    #[test]
    fn ai_takes_the_immediate_win() {
        // Set up four-in-a-row for X, both ends open. AI (X) must close it.
        let mut g = fresh_game(2);
        for j in 4..=7 {
            g.board.set(7, j, CELL_CROSSES);
        }
        g.stones_on_board = 4;
        // Inject a fake history entry so find_best_ai_move skips the empty-board branch.
        g.move_history.push(crate::game::MoveHistory {
            x: 7,
            y: 7,
            player: CELL_CROSSES,
            ..Default::default()
        });
        g.current_player = CELL_CROSSES;
        g.current_hash = g.compute_zobrist_hash();
        let ((bx, by), _r, mtype) = find_best_ai_move(&mut g);
        assert_eq!(mtype, "have_win");
        // Either end of the four is a winning move (3 or 8).
        assert_eq!(bx, 7);
        assert!(by == 3 || by == 8, "got y={}", by);
    }

    #[test]
    fn ai_blocks_opponent_open_four() {
        // Opponent X has open four on row 7 (cols 4..=7); AI is O and must block.
        let mut g = fresh_game(2);
        for j in 4..=7 {
            g.board.set(7, j, CELL_CROSSES);
        }
        g.stones_on_board = 4;
        g.move_history.push(crate::game::MoveHistory {
            x: 7,
            y: 7,
            player: CELL_CROSSES,
            ..Default::default()
        });
        g.current_player = CELL_NAUGHTS;
        g.current_hash = g.compute_zobrist_hash();
        let ((bx, by), _r, _) = find_best_ai_move(&mut g);
        // O must close one of the open ends.
        assert_eq!(bx, 7);
        assert!(by == 3 || by == 8, "got y={}", by);
    }
}
