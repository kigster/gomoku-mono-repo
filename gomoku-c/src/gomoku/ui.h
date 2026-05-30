//
//  ui.h
//  gomoku - User Interface module for display and input handling
//
//  Handles screen rendering, keyboard input, and user interactions
//

#ifndef UI_H
#define UI_H

#include "ansi.h"
#include "game.h"
#include "gomoku.h"
#include <termios.h>

//===============================================================================
// INPUT HANDLING
//===============================================================================

/**
 * Structure to hold terminal settings
 */
extern struct termios original_termios;

/**
 * Enables raw mode for keyboard input.
 */
void enable_raw_mode(void);

/**
 * Disables raw mode and restores original terminal settings.
 */
void disable_raw_mode(void);

/**
 * Gets a single keypress from the user.
 *
 * @return Key code or -1 on error
 */
int get_key(void);

/**
 * Handles user input and updates game state accordingly.
 *
 * @param game The game state
 */
void handle_input(game_state_t *game);

//===============================================================================
// DISPLAY FUNCTIONS
//===============================================================================

/**
 * Clears the screen.
 */
void clear_screen(void);

/**
 * Draws the game header with title and instructions.
 */
void draw_game_header(void);

/**
 * Draws the game board with current stone positions and cursor.
 *
 * @param game The game state
 */
void draw_board(game_state_t *game);

/**
 * Draws the game history sidebar.
 *
 * @param game The game state
 * @param start_row Starting row position for the sidebar
 */
void draw_game_history_sidebar(game_state_t *game, int start_row);

/**
 * Draws the status panel with game information and controls.
 *
 * @param game The game state
 */
void draw_status(game_state_t *game);

/**
 * Displays the game rules in a formatted screen.
 */
void display_rules(void);

/**
 * Refreshes the entire game display.
 *
 * @param game The game state
 */
void refresh_display(game_state_t *game);

/**
 * Positions the cursor on an empty cell near the last move.
 * Called after AI moves when the next player is human.
 *
 * @param game The game state
 */
void position_cursor_near_last_move(game_state_t *game);

#endif // UI_H
