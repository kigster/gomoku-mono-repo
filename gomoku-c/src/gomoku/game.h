//
//  game.h
//  gomoku - Game logic, state management, and move history
//
//  Handles game state, move validation, history management, and timing
//

#ifndef GAME_H
#define GAME_H

#include "board.h"
#include "cli.h"
#include "gomoku.h"
#include <stdint.h>

// move_t is defined in ai.h

//===============================================================================
// GAME CONSTANTS
//===============================================================================

#define MAX_MOVE_HISTORY 400
#define MAX_AI_HISTORY 20

//===============================================================================
// GAME STATE STRUCTURES
//===============================================================================

/**
 * Structure to represent a move in the game history
 */
typedef struct {
  int x, y;                // Position of the move
  int player;              // Player who made the move
  double time_taken;       // Time taken to make this move in seconds
  int positions_evaluated; // For AI moves, number of positions evaluated
  int own_score;        // For AI moves, score of this position for the player
  int opponent_score;   // For AI moves, score of this position for opponent
  int is_winner;        // Whether this move won the game
  double queue_wait_ms; // Client-reported queue wait time in milliseconds
} move_history_t;

/**
 * Transposition table entry for caching evaluated positions
 */
typedef struct {
  uint64_t hash;   // Position hash
  int ai_player;   // Perspective this score was computed for (X or O)
  int value;       // Evaluated value
  int depth;       // Search depth
  int flag;        // Exact, lower bound, or upper bound
  int best_move_x; // Best move coordinates
  int best_move_y;
} transposition_entry_t;

#define TRANSPOSITION_TABLE_SIZE 100000
#define TT_EXACT 0
#define TT_LOWER_BOUND 1
#define TT_UPPER_BOUND 2
#define MAX_KILLER_MOVES 2
#define MAX_THREATS 100
#define ASPIRATION_WINDOW 50
#define NULL_MOVE_REDUCTION 2

/**
 * Threat structure for threat-space search (from Allis 1994 paper)
 */
typedef struct {
  int x, y;        // Position
  int threat_type; // Type of threat
  int player;      // Player who benefits from this threat
  int priority;    // Priority score
  int is_active;   // Whether this threat is still valid
} threat_t;

/**
 * Aspiration window structure for enhanced pruning
 */
typedef struct {
  int alpha; // Lower bound
  int beta;  // Upper bound
  int depth; // Depth at which window was set
} aspiration_window_t;

// move_t is defined in ai.h

/**
 * Structure to represent the current game state
 */
typedef struct {
  cli_config_t config;    // Configuration
  int **board;            // The game board
  int board_size;         // Size of the board
  int cursor_x, cursor_y; // Current cursor position
  int current_player;     // Current player (AI_CELL_CROSSES or AI_CELL_NAUGHTS)
  int game_state;         // Current game state (GAME_RUNNING, etc.)
  int max_depth;          // AI search depth
  double move_timeout; // Move timeout in seconds, fractional (0 = no timeout)
  int search_radius;   // Search radius for move generation (1-5)
  int replay_mode;     // Whether we're in replay mode (disables cursor)

  // Player configuration
  player_type_t player_type[2]; // [0]=CROSSES/X, [1]=NAUGHTS/O
  int depth_for_player[2];      // [0]=CROSSES depth, [1]=NAUGHTS depth

  // Move history
  move_history_t move_history[MAX_MOVE_HISTORY];
  int move_history_count;
  int undos_used; // Number of times undo was invoked this game (for limit)

  // AI history
  char ai_history[MAX_AI_HISTORY][50];
  int ai_history_count;
  char ai_status_message[256];
  int last_ai_moves_evaluated; // Number of moves evaluated in last AI search

  // Last AI move for highlighting
  int last_ai_move_x, last_ai_move_y;

  // Timing
  double total_human_time;
  double total_ai_time;
  double move_start_time;

  // Timeout tracking
  double search_start_time;
  int search_timed_out;

  // Optimization caches
  int stones_on_board;      // Cached stone count
  int has_winner_cache[2];  // Cache for winner detection [player1, player2]
  int winner_cache_valid;   // Whether winner cache is valid
  int disable_winner_cache; // If true, bypass winner cache entirely

  // Transposition table
  transposition_entry_t transposition_table[2][TRANSPOSITION_TABLE_SIZE];
  uint64_t zobrist_keys[2][361]; // Zobrist keys for hashing
  uint64_t current_hash;         // Current position hash

  // Killer moves heuristic
  int killer_moves[MAX_SEARCH_DEPTH][MAX_KILLER_MOVES]
                  [2]; // [depth][move_num][x,y]

  // Threat-space search (from research papers)
  threat_t active_threats[MAX_THREATS]; // Currently active threats
  int threat_count;                     // Number of active threats

  // Aspiration windows for enhanced pruning
  aspiration_window_t aspiration_windows[MAX_SEARCH_DEPTH];
  int use_aspiration_windows; // Whether to use aspiration windows

  // Null-move pruning
  int null_move_allowed; // Whether null moves are allowed
  int null_move_count;   // Count of consecutive null moves
} game_state_t;

//===============================================================================
// GAME INITIALIZATION AND CLEANUP
//===============================================================================

/**
 * Initializes a new game state with the specified parameters.
 *
 * @param board_size Size of the board (15 or 19)
 * @param max_depth AI search depth
 * @param move_timeout Timeout for moves in seconds (0 = no timeout)
 * @return Initialized game state, or NULL on failure
 */
game_state_t *init_game(cli_config_t config);

/**
 * Cleans up and frees game state resources.
 *
 * @param game The game state to clean up
 */
void cleanup_game(game_state_t *game);

//===============================================================================
// GAME LOGIC FUNCTIONS
//===============================================================================

/**
 * Checks the current game state for win/draw conditions.
 *
 * @param game The game state to check
 */
void check_game_state(game_state_t *game);

/**
 * Makes a move on the board and updates game state.
 *
 * @param game The game state
 * @param x Row coordinate
 * @param y Column coordinate
 * @param player The player making the move
 * @param time_taken Time taken to make the move
 * @param positions_evaluated Number of positions evaluated (for AI moves)
 * @return 1 if move was successful, 0 if invalid
 */
int make_move(game_state_t *game, int x, int y, int player, double time_taken,
              int positions_evaluated, int own_score, int opponent_score);

/**
 * Checks if undo is possible (need at least 2 moves).
 *
 * @param game The game state
 * @return 1 if undo is possible, 0 otherwise
 */
int can_undo(game_state_t *game);

/**
 * Undoes the last move pair (human + AI).
 *
 * @param game The game state
 */
void undo_last_moves(game_state_t *game);

//===============================================================================
// OPTIMIZATION FUNCTIONS
//===============================================================================

/**
 * Initializes the optimization caches for a game state.
 *
 * @param game The game state
 */
void init_optimization_caches(game_state_t *game);

/**
 * Refreshes per-move bookkeeping after a stone is placed: increments the
 * stone count, applies the incremental zobrist update for the placed stone,
 * and invalidates the winner cache. Call after writing the stone to the
 * board, before calling check_game_state.
 *
 * @param game The game state
 * @param x X coordinate of the placed stone
 * @param y Y coordinate of the placed stone
 */
void update_post_move_state(game_state_t *game, int x, int y);

/**
 * Invalidates the winner cache when a move is made.
 *
 * @param game The game state
 */
void invalidate_winner_cache(game_state_t *game);

/**
 * Gets the cached winner status or computes it if invalid.
 *
 * @param game The game state
 * @param player The player to check for
 * @return 1 if player has won, 0 otherwise
 */
int get_cached_winner(game_state_t *game, int player);

/**
 * Initializes the transposition table and Zobrist keys.
 *
 * @param game The game state
 */
void init_transposition_table(game_state_t *game);

/**
 * Computes the Zobrist hash for the current position.
 *
 * @param game The game state
 * @return The hash value
 */
uint64_t compute_zobrist_hash(game_state_t *game);

/**
 * Stores a position evaluation in the transposition table.
 *
 * @param game The game state
 * @param hash Position hash
 * @param ai_player The AI player (AI_CELL_CROSSES or AI_CELL_NOUGHTS)
 * @param value Evaluated value
 * @param depth Search depth
 * @param flag Type of bound (exact, lower, upper)
 * @param best_x Best move x coordinate
 * @param best_y Best move y coordinate
 */
void store_transposition(game_state_t *game, uint64_t hash, int ai_player,
                         int value, int depth, int flag, int best_x,
                         int best_y);

/**
 * Probes the transposition table for a cached evaluation.
 *
 * @param game The game state
 * @param hash Position hash
 * @param ai_player The AI player (AI_CELL_CROSSES or AI_CELL_NOUGHTS)
 * @param depth Search depth
 * @param alpha Alpha value
 * @param beta Beta value
 * @param value Pointer to store the cached value
 * @return 1 if found and usable, 0 otherwise
 */
int probe_transposition(game_state_t *game, uint64_t hash, int ai_player,
                        int depth, int alpha, int beta, int *value);

/**
 * Initializes the killer moves table.
 *
 * @param game The game state
 */
void init_killer_moves(game_state_t *game);

/**
 * Stores a killer move at the given depth.
 *
 * @param game The game state
 * @param depth Search depth
 * @param x Move x coordinate
 * @param y Move y coordinate
 */
void store_killer_move(game_state_t *game, int depth, int x, int y);

/**
 * Checks if a move is a killer move at the given depth.
 *
 * @param game The game state
 * @param depth Search depth
 * @param x Move x coordinate
 * @param y Move y coordinate
 * @return 1 if killer move, 0 otherwise
 */
int is_killer_move(game_state_t *game, int depth, int x, int y);

/**
 * Initializes the threat-space search system.
 *
 * @param game The game state
 */
void init_threat_space_search(game_state_t *game);

/**
 * Updates the threat analysis after a move is made.
 *
 * @param game The game state
 * @param x Move x coordinate
 * @param y Move y coordinate
 * @param player Player who made the move
 */
void update_threat_analysis(game_state_t *game, int x, int y, int player);

// Threat-space search function available in ai.c

/**
 * Initializes aspiration windows for enhanced pruning.
 *
 * @param game The game state
 */
void init_aspiration_windows(game_state_t *game);

/**
 * Gets the aspiration window for a given depth.
 *
 * @param game The game state
 * @param depth Search depth
 * @param alpha Pointer to store alpha value
 * @param beta Pointer to store beta value
 * @return 1 if window found, 0 otherwise
 */
int get_aspiration_window(game_state_t *game, int depth, int *alpha, int *beta);

/**
 * Updates aspiration window based on search results.
 *
 * @param game The game state
 * @param depth Search depth
 * @param value Search result value
 * @param alpha Alpha value used
 * @param beta Beta value used
 */
void update_aspiration_window(game_state_t *game, int depth, int value,
                              int alpha, int beta);

/**
 * Checks if null-move pruning should be applied.
 *
 * @param game The game state
 * @param depth Current search depth
 * @return 1 if null-move should be tried, 0 otherwise
 */
int should_try_null_move(game_state_t *game, int depth);

/**
 * Performs null-move pruning search.
 *
 * @param game The game state
 * @param depth Current search depth
 * @param beta Beta value
 * @param ai_player AI player
 * @return Search result or 0 if no pruning
 */
int try_null_move_pruning(game_state_t *game, int depth, int beta,
                          int ai_player);

//===============================================================================
// TIMING FUNCTIONS
//===============================================================================

/**
 * Gets the current time in seconds.
 *
 * @return Current time as double
 */
double get_current_time(void);

/**
 * Starts the move timer.
 *
 * @param game The game state
 */
void start_move_timer(game_state_t *game);

/**
 * Ends the move timer and returns elapsed time.
 *
 * @param game The game state
 * @return Elapsed time in seconds
 */
double end_move_timer(game_state_t *game);

/**
 * Checks if the search has timed out.
 *
 * @param game The game state
 * @return 1 if timed out, 0 otherwise
 */
int is_search_timed_out(game_state_t *game);

//===============================================================================
// HISTORY MANAGEMENT
//===============================================================================

/**
 * Adds a move to the game history.
 *
 * @param game The game state
 * @param x Row coordinate
 * @param y Column coordinate
 * @param player The player who made the move
 * @param time_taken Time taken to make the move
 * @param positions_evaluated Number of positions evaluated
 */
void add_move_to_history(game_state_t *game, int x, int y, int player,
                         double time_taken, int positions_evaluated);

/**
 * Adds an AI thinking entry to the history.
 *
 * @param game The game state
 * @param moves_evaluated Number of moves evaluated
 */
void add_ai_history_entry(game_state_t *game, int moves_evaluated);

//===============================================================================
// JSON EXPORT/IMPORT
//===============================================================================

#ifndef NO_JSON
/**
 * Writes game results to a JSON file.
 *
 * @param game The game state
 * @param filename Path to the output JSON file
 * @return 1 on success, 0 on failure
 */
int write_game_json(game_state_t *game, const char *filename);

/**
 * Structure to hold replay data loaded from JSON
 */
typedef struct {
  int board_size;
  int move_count;
  move_history_t moves[MAX_MOVE_HISTORY];
  char winner[8]; // "X", "O", "draw", or "none"
  int depth_x;    // AI depth for X (-1 = use default)
  int depth_o;    // AI depth for O (-1 = use default)
  int radius;     // Search radius (-1 = use default)
} replay_data_t;

/**
 * Loads game data from a JSON file for replay.
 *
 * @param filename Path to the JSON file
 * @param data Pointer to replay_data_t to fill
 * @return 1 on success, 0 on failure
 */
int load_game_json(const char *filename, replay_data_t *data);
#endif // NO_JSON

#endif // GAME_H
