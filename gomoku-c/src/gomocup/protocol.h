//
//  protocol.h
//  gomoku-c — Gomocup brain
//
//  Pure parser for the Gomocup AI Protocol v2 commands.
//  No engine state lives here — every parsing routine operates on a
//  zero-initialised parsed_command_t. The dispatch / engine plumbing
//  is in main.c; the split keeps parsing testable in isolation.
//
//  Reference: https://plastovicka.github.io/protocl2en.htm
//

#ifndef GOMOCUP_PROTOCOL_H
#define GOMOCUP_PROTOCOL_H

#include <stddef.h>

typedef enum {
  CMD_UNKNOWN = 0, // Unrecognised verb; the brain replies UNKNOWN <text>
  CMD_INVALID,     // Recognised verb, malformed arguments
  CMD_EMPTY,       // Blank line — no-op
  CMD_START,       // START [size]
  CMD_RECTSTART,   // RECTSTART [w],[h] (we decline)
  CMD_RESTART,     // RESTART
  CMD_BEGIN,       // BEGIN
  CMD_TURN,        // TURN [X],[Y]
  CMD_TAKEBACK,    // TAKEBACK [X],[Y]
  CMD_BOARD,       // BOARD ... DONE — multi-line; parser only flags start
  CMD_INFO,        // INFO [key] [value]
  CMD_END,         // END
  CMD_ABOUT,       // ABOUT
  CMD_SWAP2BOARD   // SWAP2BOARD (we decline with ERROR)
} command_kind_t;

typedef struct {
  command_kind_t kind;

  // For START / RECTSTART
  int width;
  int height;

  // For TURN / TAKEBACK / individual BOARD rows (callers reuse parse_board_row)
  int x;
  int y;
  int field; // For BOARD rows: 1 = self, 2 = opponent, 3 = winning line

  // For INFO
  char info_key[64];
  char info_value[64];

  // For UNKNOWN — preserved so dispatch can echo back the line
  char raw[256];
} parsed_command_t;

/**
 * Parse a single command line (without trailing newline) into `out`.
 *
 * The line may have CR LF, LF, or CR endings — the parser strips them.
 * Whitespace around tokens is tolerated. Returns no useful value beyond
 * mutating `out`; the caller dispatches on `out->kind`.
 */
void protocol_parse_line(const char *line, parsed_command_t *out);

/**
 * Parse a single BOARD row of the form "[X],[Y],[field]". Returns 1 on
 * success and writes x, y, field; returns 0 on malformed input. Used
 * inside the BOARD ... DONE block which is collected line-by-line by
 * the dispatch loop.
 */
int protocol_parse_board_row(const char *line, int *x, int *y, int *field);

/**
 * Format an engine-side move (col, row) into the wire format "X,Y\n"
 * where X = col, Y = row. `out_len` must be at least 16 bytes. Returns
 * the number of bytes written, or 0 on overflow.
 */
size_t protocol_format_move(int gx, int gy, char *out, size_t out_len);

#endif // GOMOCUP_PROTOCOL_H
