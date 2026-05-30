//
//  ai.h
//  gomoku - AI module for minimax search and move finding
//
//  Handles AI move finding, minimax algorithm, and move prioritization
//

#ifndef AI_H
#define AI_H

#include "game.h"
#include "gomoku.h"
#include <stddef.h>

//===============================================================================
// SCORING REPORT STRUCTURES
//===============================================================================

#define MAX_SCORING_ENTRIES 16
#define MAX_VCT_SEQUENCE 20

/**
 * A single evaluator's result during move selection.
 */
typedef struct {
  const char
      *evaluator; // e.g. "have_win", "block_threat", "have_vct", "minimax"
  int is_current_player; // 1 = current player's perspective, 0 = opponent
  int evaluated_moves;   // how many moves this evaluator examined
  int score;             // best score found by this evaluator
  double time_ms;        // wall-clock time for this evaluator
  int decisive;          // 1 if this evaluator determined the final move
  int have_win;          // boolean: did we find a win?
  int have_vct;          // boolean: did we find a VCT?
  int vct_sequence[MAX_VCT_SEQUENCE][2]; // VCT move sequence [(x,y), ...]
  int vct_length;                        // number of moves in VCT sequence
} scoring_entry_t;

/**
 * Full scoring report for a single AI move decision.
 */
typedef struct {
  scoring_entry_t entries[MAX_SCORING_ENTRIES];
  int entry_count;
  int offensive_max_score; // best score our algorithm can achieve
  int defensive_max_score; // best score opponent can achieve (negative)
} scoring_report_t;

/**
 * Initialize a scoring report (zero all fields).
 */
static inline void scoring_report_init(scoring_report_t *report) {
  report->entry_count = 0;
  report->offensive_max_score = 0;
  report->defensive_max_score = 0;
}

/**
 * Add an entry to a scoring report. Returns pointer to the new entry, or NULL
 * if full.
 */
static inline scoring_entry_t *scoring_report_add(scoring_report_t *report,
                                                  const char *evaluator,
                                                  int is_current_player) {
  if (report->entry_count >= MAX_SCORING_ENTRIES)
    return NULL;
  scoring_entry_t *e = &report->entries[report->entry_count++];
  e->evaluator = evaluator;
  e->is_current_player = is_current_player;
  e->evaluated_moves = 0;
  e->score = 0;
  e->time_ms = 0;
  e->decisive = 0;
  e->have_win = 0;
  e->have_vct = 0;
  e->vct_length = 0;
  return e;
}

//===============================================================================
// AI MOVE FINDING FUNCTIONS
//===============================================================================

/**
 * Finds the best AI move using minimax algorithm with alpha-beta pruning.
 * Populates scoring report with evaluator details.
 *
 * @param game The game state
 * @param best_x Pointer to store the best x coordinate
 * @param best_y Pointer to store the best y coordinate
 * @param report Optional scoring report (NULL to skip)
 */
void find_best_ai_move(game_state_t *game, int *best_x, int *best_y,
                       scoring_report_t *report);

/**
 * Finds the AI's first response move from a small opening book
 * (common white replies to black's first stone).
 *
 * @param game The game state
 * @param best_x Pointer to store the best x coordinate
 * @param best_y Pointer to store the best y coordinate
 */
void find_first_ai_move(game_state_t *game, int *best_x, int *best_y);

//===============================================================================
// MINIMAX ALGORITHM
//===============================================================================

/**
 * Minimax algorithm with alpha-beta pruning and timeout support.
 *
 * @param game The game state
 * @param board The game board
 * @param depth Current search depth
 * @param alpha Alpha value for pruning
 * @param beta Beta value for pruning
 * @param maximizing_player 1 if maximizing, 0 if minimizing
 * @param ai_player The AI player
 * @param last_x X coordinate of last move
 * @param last_y Y coordinate of last move
 * @return Best evaluation score
 */
int minimax_with_timeout(game_state_t *game, int **board, int depth, int alpha,
                         int beta, int maximizing_player, int ai_player,
                         int last_x, int last_y);

/**
 * Wrapper for backward compatibility with existing minimax function.
 *
 * @param board The game board
 * @param board_size Size of the board (number of rows/columns)
 * @param depth Current search depth
 * @param alpha Alpha value for pruning
 * @param beta Beta value for pruning
 * @param maximizing_player 1 if maximizing, 0 if minimizing
 * @param ai_player The AI player
 * @return Best evaluation score
 */
int minimax(int **board, int board_size, int depth, int alpha, int beta,
            int maximizing_player, int ai_player);

//===============================================================================
// MOVE EVALUATION AND ORDERING
//===============================================================================

/**
 * Structure to hold move coordinates and priority for sorting.
 */
typedef struct {
  int x, y;
  int priority;
} move_t;

/**
 * Optimized move generation using cached interesting moves.
 *
 * @param game The game state
 * @param moves Array to store generated moves
 * @param current_player The current player
 * @return Number of moves generated
 */
int generate_moves_optimized(game_state_t *game, int **board, move_t *moves,
                             int current_player, int depth_remaining);

/**
 * Optimized move prioritization that avoids expensive temporary placements.
 *
 * @param game The game state
 * @param x Row coordinate
 * @param y Column coordinate
 * @param player The player making the move
 * @return Priority score for the move
 */
int get_move_priority_optimized(game_state_t *game, int **board, int x, int y,
                                int player, int depth_remaining);

/**
 * Fast threat evaluation without temporary board modifications.
 *
 * @param board The game board
 * @param x Row coordinate
 * @param y Column coordinate
 * @param player The player making the move
 * @param board_size Size of the board
 * @return Threat score for the move
 */
int evaluate_threat_fast(int **board, int x, int y, int player, int board_size);

/**
 * Checks if a move position is "interesting" (within range of existing stones).
 *
 * @param board The game board
 * @param x Row coordinate
 * @param y Column coordinate
 * @param stones_on_board Number of stones currently on board
 * @param board_size Size of the board
 * @param radius Search radius to check around the position
 * @return 1 if interesting, 0 otherwise
 */
int is_move_interesting(int **board, int x, int y, int stones_on_board,
                        int board_size, int radius);

/**
 * Checks if a move results in an immediate win.
 *
 * @param board The game board
 * @param x Row coordinate
 * @param y Column coordinate
 * @param player The player making the move
 * @param board_size Size of the board
 * @return 1 if winning move, 0 otherwise
 */
int is_winning_move(int **board, int x, int y, int player, int board_size);

/**
 * Calculates move priority for ordering (higher = better).
 *
 * @param board The game board
 * @param x Row coordinate
 * @param y Column coordinate
 * @param player The player making the move
 * @param board_size Size of the board
 * @return Priority score for the move
 */
int get_move_priority(int **board, int x, int y, int player, int board_size);

/**
 * Comparison function for sorting moves by priority (descending).
 *
 * @param a First move
 * @param b Second move
 * @return Comparison result
 */
int compare_moves(const void *a, const void *b);

//===============================================================================
// VCT (VICTORY BY CONTINUOUS THREATS) SEARCH
//===============================================================================

/**
 * Find the cell that the opponent must block after a four is created.
 *
 * @param board The game board
 * @param x Row of the placed stone that created the four
 * @param y Column of the placed stone
 * @param player The player who created the four
 * @param board_size Size of the board
 * @param block_x Pointer to store block cell row
 * @param block_y Pointer to store block cell column
 * @return 1 if a single block cell found, 0 if open four (2 cells) or none
 */
int find_block_cell(int **board, int x, int y, int player, int board_size,
                    int *block_x, int *block_y);

/**
 * Offensive VCT: search for a forced-win sequence through continuous fours.
 *
 * @param game The game state
 * @param board The game board
 * @param player The player trying to force a win
 * @param max_depth Maximum depth (number of our forcing moves)
 * @param result_x Pointer to store the first move's row
 * @param result_y Pointer to store the first move's column
 * @param sequence Optional array to store the full VCT sequence [(x,y), ...]
 * @param seq_len Pointer to store sequence length (if sequence is non-NULL)
 * @return 1 if forced win found, 0 otherwise
 */
int find_forced_win(game_state_t *game, int **board, int player, int max_depth,
                    int *result_x, int *result_y, int sequence[][2],
                    int *seq_len);

/**
 * Defensive VCT: find the move that disrupts the opponent's forced-win
 * sequence.
 *
 * @param game The game state
 * @param board The game board
 * @param ai_player The AI player
 * @param max_depth Maximum VCT search depth
 * @param result_x Pointer to store the disrupting move's row
 * @param result_y Pointer to store the disrupting move's column
 * @return 1 if opponent has a VCT and we found a disrupting move, 0 if no
 * threat
 */
int find_forced_win_block(game_state_t *game, int **board, int ai_player,
                          int max_depth, int *result_x, int *result_y);

#endif // AI_H
