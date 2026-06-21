#ifndef NET_TEST_CLIENT_UTILS_H
#define NET_TEST_CLIENT_UTILS_H

#define MAX_TEST_CLIENT_DEPTH 10
#define MAX_TEST_CLIENT_RADIUS 4

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Create an initial game state JSON payload (same depth for both players).
 * Caller owns the returned buffer.
 */
char *test_client_create_initial_game_state(int board_size, int depth,
                                            int radius);

/**
 * Create an initial game state JSON with depth_x, depth_o and optional timeout.
 * If timeout_sec is 0, "timeout" is sent as "none".
 * Caller owns the returned buffer.
 */
char *test_client_create_initial_game_state_ex(int board_size, int depth_x,
                                               int depth_o, int radius,
                                               int timeout_sec);

/**
 * Extract the last move (player label and position) from JSON response.
 * Returns 1 on success, 0 on failure.
 */
int test_client_get_last_move(const char *json, const char **out_label,
                              int *out_x, int *out_y);

/**
 * Read HTTP response from an open socket. Reads headers (up to 8K), parses
 * Content-Length, then reads exactly that many body bytes (capped at
 * max_body_size). If Content-Length is missing or invalid, reads into a
 * 512KB buffer until recv returns 0.
 * Returns malloc'd body (null-terminated), or NULL on error. Optional
 * tick_cb(tick_ctx) is called about once per second while waiting for data.
 */
char *test_client_read_http_response(int sock, int *out_status,
                                     size_t *out_body_len, size_t max_body_size,
                                     void (*tick_cb)(void *), void *tick_ctx);

/**
 * Return 1 if the string looks like complete JSON (ends with '}').
 * Used to detect truncated responses.
 */
int test_client_response_looks_complete(const char *body, size_t body_len);

#ifdef __cplusplus
}
#endif

#endif // NET_TEST_CLIENT_UTILS_H
