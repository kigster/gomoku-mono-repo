#ifndef ANSI_H
#define ANSI_H

// ANSI Color codes
#define COLOR_RESET "\033[0m"
#define COLOR_RED "\033[31m"
#define COLOR_BLUE "\033[34m"
#define COLOR_CYAN "\033[36m"
#define COLOR_YELLOW "\033[33m"
#define COLOR_GREEN "\033[32m"
#define COLOR_MAGENTA "\033[35m"

#define COLOR_BRIGHT_RED "\033[91m"
#define COLOR_BRIGHT_BLUE "\033[94m"
#define COLOR_BRIGHT_YELLOW "\033[93m"
#define COLOR_BRIGHT_MAGENTA "\033[95m"
#define COLOR_BRIGHT_CYAN "\033[96m"
#define COLOR_BRIGHT_WHITE "\033[97m"
#define COLOR_BRIGHT_GREEN "\033[92m" // Bright green for human highlight

#define COLOR_BOLD_BLACK "\033[1;30m"

#define ESCAPE_CODE_BLINK "\033[1;33;5m"
#define ESCAPE_CODE_BOLD "\033[1m"
#define ESCAPE_CODE_ITALIC "\033[3m"
#define ESCAPE_CODE_UNDERLINE "\033[4m"
#define ESCAPE_CODE_REVERSE "\033[7m"
#define ESCAPE_CODE_STRIKE "\033[9m"
#define ESCAPE_CODE_RESET "\033[0m"

// Cursor colors
#define COLOR_BG_CURSOR_OCCUPIED                                               \
  "\033[46m" // Cyan background for cursor on occupied cells
#define COLOR_CURSOR "\033[1;33m" // Yellow color for cursor symbol

#define COLOR_BOLD_RED "\033[1;31m"
#define COLOR_BOLD_GREEN "\033[1;32m"

#define COLOR_X_NORMAL "\033[0;31m"    // Red for X
#define COLOR_X_LAST_MOVE "\033[1;31m" // Bold red for X last move

#define COLOR_O_NORMAL "\033[0;32m"    // Green for O
#define COLOR_O_LAST_MOVE "\033[1;32m" // Bold green for O last move

#define COLOR_O_INVALID                                                        \
  "\033[0m\033[5;37;41m" // Red background for invalid moves
#define COLOR_X_INVALID "\033[0m\033[5;37;41m"

// Hint mode: bold + blink for threatening patterns
#define COLOR_X_HINT "\033[1;5;31m" // Bold blinking red for X threats
#define COLOR_O_HINT "\033[1;5;32m" // Bold blinking green for O threats

// Victory highlight: bold + blink for the winning five
#define COLOR_X_WIN "\033[1;5;31m" // Bold blinking red
#define COLOR_O_WIN "\033[1;5;32m" // Bold blinking green

// Cursor movement
#define ESCAPE_RESTORE_CURSOR_POSITION "\033[u"
#define ESCAPE_SAVE_CURSOR_POSITION "\033[s"
#define ESCAPE_CLEAR_SCREEN "\033[2J"
#define ESCAPE_MOVE_CURSOR_UP "\033[A"
#define ESCAPE_MOVE_CURSOR_DOWN "\033[B"
#define ESCAPE_MOVE_CURSOR_RIGHT "\033[C"
#define ESCAPE_MOVE_CURSOR_LEFT "\033[D"
#define ESCAPE_MOVE_CURSOR_TO "\033[%d;%dH"
#define ESCAPE_MOVE_CURSOR_TO_HOME "\033[H"

#endif // ANSI_H
