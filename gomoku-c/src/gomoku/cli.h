//
//  cli.h
//  gomoku - Command Line Interface module
//
//  Handles command-line argument parsing and help display
//

#ifndef CLI_H
#define CLI_H

#include "gomoku.h"

//===============================================================================
// CLI CONFIGURATION STRUCTURE
//===============================================================================

/**
 * Structure to hold parsed command line arguments
 */
typedef struct {
  int board_size;       // Board size (15 or 19)
  int max_depth;        // AI search depth
  int move_timeout;     // Move timeout in seconds (0 = no timeout)
  int show_help;        // Whether to show help and exit
  int invalid_args;     // Whether invalid arguments were provided
  int enable_undo;      // Whether to undo is allowed at all
  int max_undo_allowed; // Total undo moves allowed per game (0 = unlimited)
  int skip_welcome;     // Whether to skip the welcome screen
  int headless;       // Whether to suppress all stdout output (for daemon mode)
  int stateless_mode; // Disable persistent/derived caches for stateless API use
  int search_radius;  // Search radius for move generation (1-5, default 2)
  char json_file[256]; // Path to JSON output file (empty = no output)

  // Replay mode
  char replay_file[256]; // Path to JSON file to replay (empty = no replay)
  double replay_wait; // Seconds to wait between moves (0 = wait for keypress)

  // Player configuration
  player_type_t player_x_type; // Type of player X (first player)
  player_type_t player_o_type; // Type of player O (second player)
  int depth_x;           // AI search depth for player X (-1 = use max_depth)
  int depth_o;           // AI search depth for player O (-1 = use max_depth)
  int player_x_explicit; // Was -x explicitly specified?
  int player_o_explicit; // Was -o explicitly specified?
  int hints_enabled;     // Highlight threatening patterns on the board
} cli_config_t;

//===============================================================================
// CLI FUNCTIONS
//===============================================================================

/**
 * Parses command line arguments and returns configuration.
 *
 * @param argc Number of command line arguments
 * @param argv Array of command line argument strings
 * @return Configuration structure with parsed values
 */
cli_config_t parse_arguments(int argc, char *argv[]);

/**
 * Prints help message with usage information.
 *
 * @param program_name The name of the program (argv[0])
 */
void print_help(const char *program_name);

/**
 * Validates the parsed configuration for consistency.
 *
 * @param config The configuration to validate
 * @return 1 if valid, 0 if invalid
 */
int validate_config(const cli_config_t *config);

#endif // CLI_H
