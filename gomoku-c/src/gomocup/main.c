//
//  main.c
//  gomoku-c — Gomocup brain (pbrain-kig-standard)
//
//  Stdin/stdout dispatch loop for the Gomocup AI Protocol v2.
//  Spec: https://plastovicka.github.io/protocl2en.htm
//

#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "ai.h"
#include "cli.h"
#include "game.h"
#include "gomoku.h"

#include "coords.h"
#include "metadata.h"
#include "protocol.h"
#include "time_budget.h"

// The engine's gomoku.h already defines DEFAULT_BOARD_SIZE = 19 for the TUI;
// the brain uses a separate constant to avoid the macro collision and to
// document that the Standard tournament category is fixed at 15x15.
#define BRAIN_BOARD_SIZE 15

// Default search depth. We use 5 (not 7) deliberately:
//
// The engine's find_best_ai_move pipeline (see
// reference/c-engine-ai-algorithm-deep-dive.md §1) handles every meaningful
// tactical situation BEFORE minimax via Steps 1-6: own winning move, blocking
// opponent's win, compound threats, VCT search, blocking open threes, playing
// forcing fours. Depth only matters for Step 7 (minimax), which runs in QUIET
// positions where neither side has a forcing line. In quiet positions, the
// static evaluator is the dominant signal, and depth 5 vs 7 changes the move
// chosen rarely.
//
// An adaptive "depth 5 normally, depth 7 when the position is hot" rule
// would need a position-classifier that the existing pipeline doesn't
// already provide cheaply (steps 1-6 already short-circuit on hot
// positions, so by the time we reach the depth choice we're in quiet
// territory by definition). Implementing such a classifier well would
// add real complexity for marginal strength gain. Depth 5 with the
// improved heuristic from PR #86 (broken-three / broken-four / overline
// fixes) is a strong baseline that fits comfortably inside the 30s
// per-turn tournament budget on a 15x15 board.
#define BRAIN_DEFAULT_DEPTH 5
#define BRAIN_SEARCH_RADIUS 3

// Brain-side identification of the two engine players. self_color is whichever
// side the manager assigns to us — determined the first time the manager asks
// us to play (BEGIN means self-first; the first TURN means opponent-first).
typedef struct {
  game_state_t *game;
  time_budget_t budget;
  int board_size;       // Set on START; rejects sizes != 15.
  int self_color;       // AI_CELL_CROSSES or AI_CELL_NAUGHTS, or 0 if unknown.
  int started;          // 1 once START succeeded.
  int board_collecting; // 1 between BOARD and DONE.
} brain_t;

// ---------------------------------------------------------------------------
// IO helpers
// ---------------------------------------------------------------------------

static void out_line(const char *line) {
  fputs(line, stdout);
  fputc('\n', stdout);
  fflush(stdout);
}

static void out_ok(void) { out_line("OK"); }

static void out_error(const char *msg) {
  fprintf(stdout, "ERROR %s\n", msg);
  fflush(stdout);
}

static void out_unknown(const char *msg) {
  fprintf(stdout, "UNKNOWN %s\n", msg);
  fflush(stdout);
}

// ---------------------------------------------------------------------------
// Engine wiring
// ---------------------------------------------------------------------------

// Construct a cli_config_t suitable for the headless brain. We never link
// cli.c (it pulls getopt) so we set every field explicitly here.
static cli_config_t make_brain_config(int board_size) {
  cli_config_t cfg;
  memset(&cfg, 0, sizeof(cfg));
  cfg.board_size = board_size;
  cfg.max_depth = BRAIN_DEFAULT_DEPTH;
  cfg.move_timeout = 0; // Per-move budget is set on each search.
  cfg.show_help = 0;
  cfg.invalid_args = 0;
  cfg.enable_undo = 1;
  cfg.max_undo_allowed = 0; // 0 = unlimited; takeback may arrive any time.
  cfg.skip_welcome = 1;
  cfg.headless = 1;       // Suppress stdout chatter from the engine.
  cfg.stateless_mode = 0; // Reuse the TT across turns (see plan §6).
  cfg.search_radius = BRAIN_SEARCH_RADIUS;
  cfg.json_file[0] = '\0';
  cfg.replay_file[0] = '\0';
  cfg.replay_wait = 0;
  // Both players are "AI" so make_move alternates current_player on every
  // call. The brain decides who is self vs opponent via self_color.
  cfg.player_x_type = PLAYER_TYPE_AI;
  cfg.player_o_type = PLAYER_TYPE_AI;
  cfg.depth_x = -1;
  cfg.depth_o = -1;
  cfg.player_x_explicit = 0;
  cfg.player_o_explicit = 0;
  cfg.hints_enabled = 0;
  return cfg;
}

static int reset_game(brain_t *b, int board_size) {
  if (b->game) {
    cleanup_game(b->game);
    b->game = NULL;
  }
  cli_config_t cfg = make_brain_config(board_size);
  b->game = init_game(cfg);
  if (!b->game)
    return 0;
  b->board_size = board_size;
  b->self_color = 0;
  return 1;
}

static int other_color(int color) {
  return (color == AI_CELL_CROSSES) ? AI_CELL_NAUGHTS : AI_CELL_CROSSES;
}

// Apply an opponent stone to the engine. Returns 1 on success.
static int apply_stone(brain_t *b, int row, int col, int player) {
  if (!b->game)
    return 0;
  if (!gomocup_coord_in_bounds(col, row, b->board_size))
    return 0;
  // make_move uses the engine's internal current_player only for game-state
  // bookkeeping; we pass `player` directly so a BOARD replay can interleave
  // the two sides regardless of whose turn the engine "thinks" it is.
  return make_move(b->game, row, col, player, 0.0, 0, 0, 0);
}

// ---------------------------------------------------------------------------
// AI move generation
// ---------------------------------------------------------------------------

// Run find_best_ai_move with the per-turn time budget applied.
static int compute_and_emit_move(brain_t *b) {
  if (!b->game || !b->started) {
    out_error("brain not started");
    return 0;
  }

  // Decide our colour if the manager has not yet implied one. BEGIN sets
  // CROSSES; a TURN before any of our moves sets NAUGHTS.
  if (!b->self_color) {
    b->self_color = AI_CELL_CROSSES;
  }

  // The engine reads game->current_player to decide whose perspective the
  // search runs from. Force it to self_color so we always search for our move.
  b->game->current_player = b->self_color;

  double budget_s = time_budget_compute_seconds(&b->budget);
  b->game->move_timeout = budget_s;
  b->game->search_start_time = get_current_time();
  b->game->search_timed_out = 0;

  // timeout_turn = 0 means "play instantly" per spec; cap depth so iterative
  // deepening does not waste time exploring deep branches.
  int saved_depth = b->game->max_depth;
  if (b->budget.timeout_turn_ms == 0) {
    b->game->max_depth = 2;
  }

  int row = -1, col = -1;
  scoring_report_t report;
  scoring_report_init(&report);
  find_best_ai_move(b->game, &row, &col, &report);

  b->game->max_depth = saved_depth;

  if (row < 0 || col < 0 || !gomocup_coord_in_bounds(col, row, b->board_size)) {
    // Defensive: pick centre as a last-ditch fallback so we do not forfeit.
    row = b->board_size / 2;
    col = b->board_size / 2;
  }

  // Commit the move on the engine side and emit it on the wire.
  make_move(b->game, row, col, b->self_color, 0.0, 0, 0, 0);

  int gx = -1, gy = -1;
  engine_to_gomocup(row, col, &gx, &gy);
  char buf[16];
  snprintf(buf, sizeof(buf), "%d,%d", gx, gy);
  out_line(buf);

  double elapsed = get_current_time() - b->game->search_start_time;
  time_budget_record_elapsed(&b->budget, elapsed);
  return 1;
}

// ---------------------------------------------------------------------------
// Command dispatch
// ---------------------------------------------------------------------------

static void handle_start(brain_t *b, const parsed_command_t *cmd) {
  if (cmd->width != BRAIN_BOARD_SIZE) {
    out_error("unsupported board size");
    return;
  }
  if (!reset_game(b, cmd->width)) {
    out_error("failed to allocate game");
    return;
  }
  time_budget_init(&b->budget);
  b->started = 1;
  out_ok();
}

static void handle_restart(brain_t *b) {
  if (!b->started) {
    out_error("brain not started");
    return;
  }
  if (!reset_game(b, b->board_size)) {
    out_error("failed to reset game");
    return;
  }
  // Match-wide budgets persist; turn-local fields are recomputed each move.
  out_ok();
}

static void handle_begin(brain_t *b) {
  if (!b->started) {
    out_error("brain not started");
    return;
  }
  // BEGIN means we play first — the canonical opening is the centre square.
  b->self_color = AI_CELL_CROSSES;
  b->game->current_player = AI_CELL_CROSSES;

  int row = b->board_size / 2;
  int col = b->board_size / 2;
  make_move(b->game, row, col, AI_CELL_CROSSES, 0.0, 0, 0, 0);

  int gx = -1, gy = -1;
  engine_to_gomocup(row, col, &gx, &gy);
  char buf[16];
  snprintf(buf, sizeof(buf), "%d,%d", gx, gy);
  out_line(buf);
}

static void handle_turn(brain_t *b, const parsed_command_t *cmd) {
  if (!b->started) {
    out_error("brain not started");
    return;
  }
  // First TURN with no prior moves implies opponent moved first → we are
  // NAUGHTS.
  if (!b->self_color) {
    b->self_color = AI_CELL_NAUGHTS;
  }

  int row = -1, col = -1;
  gomocup_to_engine(cmd->x, cmd->y, &row, &col);
  if (!apply_stone(b, row, col, other_color(b->self_color))) {
    out_error("illegal move");
    return;
  }
  compute_and_emit_move(b);
}

static void handle_takeback(brain_t *b, const parsed_command_t *cmd) {
  if (!b->started) {
    out_error("brain not started");
    return;
  }
  int row = -1, col = -1;
  gomocup_to_engine(cmd->x, cmd->y, &row, &col);
  if (!gomocup_coord_in_bounds(cmd->x, cmd->y, b->board_size)) {
    out_error("takeback out of bounds");
    return;
  }
  if (b->game->board[row][col] == AI_CELL_EMPTY) {
    out_error("takeback target is empty");
    return;
  }
  // The engine's undo_last_moves is hard-wired to the move pair pattern;
  // for the protocol we just clear the cell and rebuild caches.
  b->game->board[row][col] = AI_CELL_EMPTY;
  if (b->game->move_history_count > 0) {
    b->game->move_history_count--;
  }
  // Recompute hash and stones-on-board so the TT stays consistent.
  b->game->stones_on_board = 0;
  for (int r = 0; r < b->board_size; r++) {
    for (int c = 0; c < b->board_size; c++) {
      if (b->game->board[r][c] != AI_CELL_EMPTY)
        b->game->stones_on_board++;
    }
  }
  invalidate_winner_cache(b->game);
  b->game->current_hash = compute_zobrist_hash(b->game);
  out_ok();
}

static void apply_info(brain_t *b, const parsed_command_t *cmd) {
  // Unknown keys silently ignored per spec.
  if (strcmp(cmd->info_key, "timeout_turn") == 0) {
    time_budget_set_turn(&b->budget, atoi(cmd->info_value));
  } else if (strcmp(cmd->info_key, "timeout_match") == 0) {
    time_budget_set_match(&b->budget, atoi(cmd->info_value));
  } else if (strcmp(cmd->info_key, "time_left") == 0) {
    time_budget_set_time_left(&b->budget, atoi(cmd->info_value));
  }
  // No response for INFO.
}

static void handle_about(void) { out_line(GOMOCUP_ABOUT_LINE); }

static void handle_board(brain_t *b) {
  if (!b->started) {
    out_error("brain not started");
    return;
  }
  // Replay every cell. Until DONE arrives, each subsequent line is a
  // "X,Y,field" triple. Reset the board first so the BOARD state is
  // authoritative; the engine TT is preserved (plan §6).
  for (int r = 0; r < b->board_size; r++) {
    for (int c = 0; c < b->board_size; c++) {
      b->game->board[r][c] = AI_CELL_EMPTY;
    }
  }
  b->game->move_history_count = 0;
  b->game->stones_on_board = 0;
  invalidate_winner_cache(b->game);
  b->game->current_hash = compute_zobrist_hash(b->game);
  b->game->current_player = AI_CELL_CROSSES;

  if (!b->self_color) {
    b->self_color = AI_CELL_CROSSES; // fallback; refined below if BOARD has
                                     // only opponent stones
  }

  b->board_collecting = 1;

  char line[256];
  while (fgets(line, sizeof(line), stdin)) {
    // Detect DONE (case-insensitive) anywhere on the line.
    char *p = line;
    while (*p && isspace((unsigned char)*p))
      p++;
    if (strncasecmp(p, "DONE", 4) == 0) {
      b->board_collecting = 0;
      break;
    }
    int gx = -1, gy = -1, field = -1;
    if (!protocol_parse_board_row(line, &gx, &gy, &field)) {
      continue; // tolerate noise
    }
    if (!gomocup_coord_in_bounds(gx, gy, b->board_size))
      continue;
    int row = -1, col = -1;
    gomocup_to_engine(gx, gy, &row, &col);
    int stone = (field == 1) ? b->self_color : other_color(b->self_color);
    if (b->game->board[row][col] != AI_CELL_EMPTY)
      continue;
    make_move(b->game, row, col, stone, 0.0, 0, 0, 0);
  }
  // After DONE, it is always our turn (the manager sends BOARD when it wants
  // a move from us).
  compute_and_emit_move(b);
}

static int dispatch(brain_t *b, const char *line) {
  parsed_command_t cmd;
  protocol_parse_line(line, &cmd);

  switch (cmd.kind) {
  case CMD_EMPTY:
    return 1;
  case CMD_START:
    handle_start(b, &cmd);
    return 1;
  case CMD_RESTART:
    handle_restart(b);
    return 1;
  case CMD_BEGIN:
    handle_begin(b);
    return 1;
  case CMD_TURN:
    handle_turn(b, &cmd);
    return 1;
  case CMD_TAKEBACK:
    handle_takeback(b, &cmd);
    return 1;
  case CMD_BOARD:
    handle_board(b);
    return 1;
  case CMD_INFO:
    apply_info(b, &cmd);
    return 1;
  case CMD_ABOUT:
    handle_about();
    return 1;
  case CMD_END:
    return 0;
  case CMD_RECTSTART:
    out_error("rectangular boards not supported");
    return 1;
  case CMD_SWAP2BOARD:
    out_error("swap2 not supported");
    return 1;
  case CMD_INVALID:
    out_error("malformed command");
    return 1;
  case CMD_UNKNOWN:
  default:
    out_unknown(cmd.raw[0] ? cmd.raw : "unrecognised command");
    return 1;
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

int main(int argc, char **argv) {
  (void)argc;
  (void)argv;

  // The Piskvork manager expects every line of brain output to flush
  // immediately. Force unbuffered stdout so even a single short reply
  // ("OK") arrives before the manager's read deadline.
  setvbuf(stdout, NULL, _IONBF, 0);
  setvbuf(stdin, NULL, _IOLBF, 0);

  brain_t brain;
  memset(&brain, 0, sizeof(brain));
  time_budget_init(&brain.budget);

  char line[1024];
  while (fgets(line, sizeof(line), stdin)) {
    if (!dispatch(&brain, line))
      break;
  }

  if (brain.game) {
    cleanup_game(brain.game);
    brain.game = NULL;
  }
  return 0;
}
