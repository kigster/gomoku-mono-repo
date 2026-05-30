//
//  board.h
//  gomoku - Board management and coordinate utilities
//
//  Handles board creation, destruction, validation, and coordinate conversion
//

#ifndef BOARD_H
#define BOARD_H

#include "gomoku.h"
#include <stddef.h>

//===============================================================================
// BOARD MANAGEMENT FUNCTIONS
//===============================================================================

/**
 * Creates a new game board with the specified size.
 *
 * @param size The size of the square board (e.g., 15 or 19)
 * @return 2D array representing the board, or NULL on failure
 */
int **create_board(int size);

/**
 * Frees the memory allocated for a game board.
 *
 * @param board The board to free
 * @param size The size of the board
 */
void free_board(int **board, int size);

/**
 * Checks if a move is valid at the given position.
 *
 * @param board The game board
 * @param x Row coordinate
 * @param y Column coordinate
 * @param size Board size
 * @return 1 if valid, 0 if invalid
 */
int is_valid_move(int **board, int x, int y, int size);

//===============================================================================
// COORDINATE UTILITIES
//===============================================================================

/**
 * Converts a 0-based index to Unicode circled number (❶–⓳).
 *
 * @param index 0-based coordinate index
 * @return Unicode string representation of the coordinate
 */
const char *get_coordinate_unicode(int index);

/**
 * Converts a 0-based column index to a Unicode circled letter (Ⓐ–Ⓣ,
 * skipping Ⓘ) matching the A–T notation used in JSON game records.
 *
 * @param index 0-based column index (0–18)
 * @return Unicode circled letter string
 */
const char *get_column_letter_unicode(int index);

/**
 * Converts board coordinates to display coordinates (1-based).
 *
 * @param board_coord 0-based board coordinate
 * @return 1-based display coordinate
 */
int board_to_display_coord(int board_coord);

/**
 * Converts display coordinates to board coordinates (0-based).
 *
 * @param display_coord 1-based display coordinate
 * @return 0-based board coordinate
 */
int display_to_board_coord(int display_coord);

/**
 * Converts board coordinates (row x, column y) to short notation (e.g. "A2").
 * Column uses letters A–T excluding I; row is 1-based.
 *
 * @param row_x Row (0-based)
 * @param col_y Column (0-based)
 * @param buf Output buffer
 * @param size Buffer size
 */
void board_coord_to_notation(int row_x, int col_y, char *buf, size_t size);

/**
 * Converts short notation (e.g. "A2", "J10") to board coordinates.
 *
 * @param notation String like "A2" (column A–T excluding I, row 1-based)
 * @param row_x Output: 0-based row (may be NULL)
 * @param col_y Output: 0-based column (may be NULL)
 * @return 1 on success, 0 on parse failure
 */
int notation_to_board_coord(const char *notation, int *row_x, int *col_y);

#endif // BOARD_H
