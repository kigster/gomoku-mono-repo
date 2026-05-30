//
//  json_api.h
//  gomoku-httpd - JSON parsing and serialization for HTTP API
//

#ifndef NET_JSON_API_H
#define NET_JSON_API_H

#include "ai.h"
#include "game.h"
#include <stddef.h>
#include <time.h>

//===============================================================================
// API CONSTRAINTS
//===============================================================================

#define API_VERSION "1.0.0"
#define API_MAX_DEPTH 7
#define API_MAX_RADIUS 4

//===============================================================================
// GAME STATE PARSING
//===============================================================================

/**
 * Parse incoming JSON and restore game state.
 * Caps depth to API_MAX_DEPTH and radius to API_MAX_RADIUS.
 *
 * @param json_str The JSON string to parse
 * @param error_msg Buffer to store error message on failure
 * @param error_msg_len Size of error message buffer
 * @return game_state_t* on success, NULL on error (check error_msg)
 */
game_state_t *json_api_parse_game(const char *json_str, char *error_msg,
                                  size_t error_msg_len);

//===============================================================================
// GAME STATE SERIALIZATION
//===============================================================================

/**
 * Serialize game state to JSON string.
 * Uses the same format as write_game_json() but returns a string.
 *
 * @param game The game state to serialize
 * @return Allocated JSON string (caller must free), or NULL on error
 */
char *json_api_serialize_game(game_state_t *game);

/**
 * Extended serialization with scoring report for the latest AI move.
 * When report is non-NULL, adds scoring, offensive_max_score,
 * defensive_max_score to the last move in the moves array.
 *
 * @param game The game state to serialize
 * @param report Scoring report for the latest move (NULL to omit)
 * @param total_time_ms Total thinking time in seconds for the latest move
 * @return Allocated JSON string (caller must free), or NULL on error
 */
char *json_api_serialize_game_ex(game_state_t *game,
                                 const scoring_report_t *report,
                                 double total_time_sec);

//===============================================================================
// RESPONSE HELPERS
//===============================================================================

/**
 * Create error response JSON.
 *
 * @param error_message The error message
 * @return Allocated JSON string (caller must free)
 *         Format: {"error": "message"}
 */
char *json_api_error_response(const char *error_message);

/**
 * Create health check response JSON.
 *
 * @param start_time The daemon start time for uptime calculation
 * @return Allocated JSON string (caller must free)
 *         Format: {"status": "ok", "version": "1.0.0", "uptime": "..."}
 */
char *json_api_health_response(time_t start_time);

//===============================================================================
// UTILITY FUNCTIONS
//===============================================================================

/**
 * Determine which player the AI should play as.
 * Returns the opposite of the last move's player.
 * If no moves, returns AI_CELL_NAUGHTS (O plays second).
 *
 * @param game The game state
 * @return AI_CELL_CROSSES or AI_CELL_NAUGHTS
 */
int json_api_determine_ai_player(game_state_t *game);

/**
 * Check if the game already has a winner.
 *
 * @param game The game state
 * @return 1 if game has winner (or draw), 0 if game is ongoing
 */
int json_api_has_winner(game_state_t *game);

/**
 * Format uptime as human-readable string.
 *
 * @param seconds Number of seconds
 * @param buffer Buffer to store formatted string
 * @param buffer_len Size of buffer
 */
void json_api_format_uptime(long seconds, char *buffer, size_t buffer_len);

#endif // NET_JSON_API_H
