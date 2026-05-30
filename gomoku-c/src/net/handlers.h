//
//  handlers.h
//  gomoku-httpd - HTTP endpoint handlers
//

#ifndef NET_HANDLERS_H
#define NET_HANDLERS_H

// Forward declaration - httpserver.h is included in handlers.c with
// HTTPSERVER_IMPL
struct http_request_s;

//===============================================================================
// INITIALIZATION
//===============================================================================

/**
 * Initialize handlers. Must be called once at startup.
 * Calls populate_threat_matrix() and any other required initialization.
 */
void handlers_init(void);

/**
 * Set whether scoring reports are included in JSON responses.
 * Should be called once at startup based on -r/--report-scoring flag.
 */
void handlers_set_report_scoring(int enabled);

//===============================================================================
// BUSY STATUS (for HAProxy agent-check)
//===============================================================================

/**
 * Check if the server is currently processing a request.
 * Used by the agent-check thread to report availability to HAProxy.
 *
 * @return 1 if busy (processing a move), 0 if ready for new requests
 */
int handlers_is_busy(void);

/**
 * Mark the server as busy (starting to process a request).
 * Called internally by handle_play before AI computation.
 */
void handlers_set_busy(void);

/**
 * Mark the server as ready (finished processing a request).
 * Called internally by handle_play after AI computation.
 */
void handlers_set_ready(void);

//===============================================================================
// REQUEST DISPATCHER
//===============================================================================

/**
 * Main request dispatcher. Routes requests to appropriate handlers.
 *
 * @param request The HTTP request
 */
void handle_request(struct http_request_s *request);

//===============================================================================
// ENDPOINT HANDLERS
//===============================================================================

/**
 * Handle GET /health endpoint.
 * Returns JSON: {"status": "ok", "version": "1.0.0", "uptime": "..."}
 * Always returns 200 if server is alive (liveness check).
 *
 * @param request The HTTP request
 */
void handle_health(struct http_request_s *request);

/**
 * Handle GET /ready endpoint.
 * Returns 200 with {"status": "ready"} when server is idle.
 * Returns 503 with {"status": "busy"} when server is processing a request.
 * Used by Envoy/load balancers for readiness checks and intelligent routing.
 *
 * @param request The HTTP request
 */
void handle_ready(struct http_request_s *request);

/**
 * Handle POST /gomoku/play endpoint.
 * Receives game state JSON, makes AI move, returns updated JSON.
 *
 * @param request The HTTP request
 */
void handle_play(struct http_request_s *request);

/**
 * Handle 404 Not Found responses.
 *
 * @param request The HTTP request
 */
void handle_not_found(struct http_request_s *request);

/**
 * Handle 405 Method Not Allowed responses.
 *
 * @param request The HTTP request
 */
void handle_method_not_allowed(struct http_request_s *request);

/**
 * Handle 400 Bad Request responses.
 *
 * @param request The HTTP request
 * @param error_message Error message to include in response
 */
void handle_bad_request(struct http_request_s *request,
                        const char *error_message);

/**
 * Handle 500 Internal Server Error responses.
 *
 * @param request The HTTP request
 * @param error_message Error message to include in response
 */
void handle_internal_error(struct http_request_s *request,
                           const char *error_message);

#endif // NET_HANDLERS_H
