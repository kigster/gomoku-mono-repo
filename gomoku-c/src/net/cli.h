//
//  cli.h
//  gomoku-httpd - CLI configuration for network daemon
//

#ifndef NET_CLI_H
#define NET_CLI_H

#include <stddef.h>

//===============================================================================
// CONSTANTS
//===============================================================================

#define DAEMON_VERSION "1.0.0"
#define DEFAULT_LOG_LEVEL LOG_INFO

//===============================================================================
// LOG LEVEL ENUM (matches log.c levels)
//===============================================================================

typedef enum {
  DAEMON_LOG_TRACE = 0,
  DAEMON_LOG_DEBUG = 1,
  DAEMON_LOG_INFO = 2,
  DAEMON_LOG_WARN = 3,
  DAEMON_LOG_ERROR = 4,
  DAEMON_LOG_FATAL = 5
} daemon_log_level_t;

//===============================================================================
// CONFIGURATION STRUCTURE
//===============================================================================

typedef struct {
  char bind_host[256]; // Host to bind (from -b/--bind)
  int bind_port;       // Port to bind (from -b/--bind)
  int agent_port; // HAProxy agent-check port (-a/--agent-port), 0 = disabled
  int daemonize;  // Run as daemon (-d/--daemonize)
  char log_file[512];           // Log file path (-l/--log-file), empty = stdout
  daemon_log_level_t log_level; // Log level (-L/--log-level)
  int report_scoring; // Include scoring report in JSON (-r/--report-scoring)
  int show_help;      // Show help and exit
  int invalid_args;   // Invalid arguments detected
} daemon_config_t;

//===============================================================================
// FUNCTION DECLARATIONS
//===============================================================================

/**
 * Parse command line arguments for the daemon.
 *
 * @param argc Number of arguments
 * @param argv Argument array
 * @return Parsed configuration
 */
daemon_config_t daemon_parse_arguments(int argc, char *argv[]);

/**
 * Print help message for the daemon.
 *
 * @param program_name Name of the program (argv[0])
 */
void daemon_print_help(const char *program_name);

/**
 * Validate the parsed configuration.
 *
 * @param config Configuration to validate
 * @return 1 if valid, 0 if invalid
 */
int daemon_validate_config(const daemon_config_t *config);

/**
 * Parse log level string (case insensitive).
 *
 * @param level_str String like "DEBUG", "INFO", "WARN", "ERROR"
 * @return Corresponding log level, or -1 if invalid
 */
daemon_log_level_t daemon_parse_log_level(const char *level_str);

#endif // NET_CLI_H
