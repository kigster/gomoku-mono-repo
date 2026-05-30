//
//  protocol.c
//  gomoku-c — Gomocup brain
//
//  Tolerant tokeniser for one Gomocup command line at a time.
//  We accept whitespace around commas, mixed-case verbs, and CR/LF endings
//  because the spec leaves these underspecified and tournament managers
//  vary slightly.
//

#include "protocol.h"

#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void zero_command(parsed_command_t *out) {
  if (!out)
    return;
  memset(out, 0, sizeof(*out));
  out->kind = CMD_UNKNOWN;
  out->x = -1;
  out->y = -1;
  out->field = -1;
  out->width = -1;
  out->height = -1;
}

// Skip leading whitespace; returns pointer to first non-space char.
static const char *skip_ws(const char *p) {
  while (*p && isspace((unsigned char)*p))
    p++;
  return p;
}

// Lowercase an ASCII verb in-place.
static void to_upper_inplace(char *s) {
  for (; *s; s++) {
    *s = (char)toupper((unsigned char)*s);
  }
}

// Read the verb from the start of the line into `verb` (capacity `cap`).
// Returns a pointer to the rest of the line (whitespace-trimmed).
static const char *read_verb(const char *line, char *verb, size_t cap) {
  const char *p = skip_ws(line);
  size_t i = 0;
  while (*p && !isspace((unsigned char)*p) && i + 1 < cap) {
    verb[i++] = *p++;
  }
  verb[i] = '\0';
  // Skip past any remaining verb chars if we overflowed; then trim ws.
  while (*p && !isspace((unsigned char)*p))
    p++;
  return skip_ws(p);
}

// Parse "X , Y" (with optional whitespace) at *pp. Advances *pp past the
// pair and returns 1 on success; returns 0 on malformed input.
static int parse_xy(const char **pp, int *x, int *y) {
  const char *p = skip_ws(*pp);
  if (!*p)
    return 0;
  char *endp = NULL;
  long lx = strtol(p, &endp, 10);
  if (endp == p)
    return 0;
  p = skip_ws(endp);
  if (*p != ',')
    return 0;
  p++;
  p = skip_ws(p);
  long ly = strtol(p, &endp, 10);
  if (endp == p)
    return 0;
  *x = (int)lx;
  *y = (int)ly;
  *pp = endp;
  return 1;
}

// Strip trailing CR/LF/whitespace from a copy of the line into `dst`,
// up to capacity `cap`.
static void copy_trim(const char *src, char *dst, size_t cap) {
  if (cap == 0)
    return;
  size_t len = strlen(src);
  while (len > 0 && (src[len - 1] == '\r' || src[len - 1] == '\n' ||
                     src[len - 1] == ' ' || src[len - 1] == '\t')) {
    len--;
  }
  if (len >= cap)
    len = cap - 1;
  memcpy(dst, src, len);
  dst[len] = '\0';
}

void protocol_parse_line(const char *line, parsed_command_t *out) {
  if (!out)
    return;
  zero_command(out);
  if (!line)
    return;

  // Trimmed copy used for verb extraction and the `raw` field on UNKNOWN.
  char trimmed[256];
  copy_trim(line, trimmed, sizeof(trimmed));
  const char *p = skip_ws(trimmed);
  if (!*p) {
    out->kind = CMD_EMPTY;
    return;
  }

  char verb[32];
  const char *rest = read_verb(p, verb, sizeof(verb));
  to_upper_inplace(verb);

  if (strcmp(verb, "START") == 0) {
    char *endp = NULL;
    long size = strtol(rest, &endp, 10);
    if (endp == rest || size <= 0) {
      out->kind = CMD_INVALID;
      out->width = out->height = -1;
    } else {
      out->kind = CMD_START;
      out->width = out->height = (int)size;
    }
    return;
  }

  if (strcmp(verb, "RECTSTART") == 0) {
    int w = -1, h = -1;
    if (parse_xy(&rest, &w, &h)) {
      out->kind = CMD_RECTSTART;
      out->width = w;
      out->height = h;
    } else {
      out->kind = CMD_INVALID;
    }
    return;
  }

  if (strcmp(verb, "RESTART") == 0) {
    out->kind = CMD_RESTART;
    return;
  }

  if (strcmp(verb, "BEGIN") == 0) {
    out->kind = CMD_BEGIN;
    return;
  }

  if (strcmp(verb, "TURN") == 0) {
    int gx = -1, gy = -1;
    if (parse_xy(&rest, &gx, &gy)) {
      out->kind = CMD_TURN;
      out->x = gx;
      out->y = gy;
    } else {
      out->kind = CMD_INVALID;
    }
    return;
  }

  if (strcmp(verb, "TAKEBACK") == 0) {
    int gx = -1, gy = -1;
    if (parse_xy(&rest, &gx, &gy)) {
      out->kind = CMD_TAKEBACK;
      out->x = gx;
      out->y = gy;
    } else {
      out->kind = CMD_INVALID;
    }
    return;
  }

  if (strcmp(verb, "BOARD") == 0) {
    out->kind = CMD_BOARD;
    return;
  }

  if (strcmp(verb, "INFO") == 0) {
    // Split rest into key + value (rest of line after first whitespace run).
    const char *key_start = skip_ws(rest);
    const char *q = key_start;
    while (*q && !isspace((unsigned char)*q))
      q++;
    size_t key_len = (size_t)(q - key_start);
    if (key_len == 0) {
      out->kind = CMD_INVALID;
      return;
    }
    if (key_len >= sizeof(out->info_key))
      key_len = sizeof(out->info_key) - 1;
    memcpy(out->info_key, key_start, key_len);
    out->info_key[key_len] = '\0';

    const char *val = skip_ws(q);
    size_t vlen = strlen(val);
    if (vlen >= sizeof(out->info_value))
      vlen = sizeof(out->info_value) - 1;
    memcpy(out->info_value, val, vlen);
    out->info_value[vlen] = '\0';

    out->kind = CMD_INFO;
    return;
  }

  if (strcmp(verb, "END") == 0) {
    out->kind = CMD_END;
    return;
  }

  if (strcmp(verb, "ABOUT") == 0) {
    out->kind = CMD_ABOUT;
    return;
  }

  if (strcmp(verb, "SWAP2BOARD") == 0) {
    out->kind = CMD_SWAP2BOARD;
    return;
  }

  // Unknown verb — preserve original (trimmed) line for the UNKNOWN reply.
  out->kind = CMD_UNKNOWN;
  size_t copy_len = strlen(trimmed);
  if (copy_len >= sizeof(out->raw))
    copy_len = sizeof(out->raw) - 1;
  memcpy(out->raw, trimmed, copy_len);
  out->raw[copy_len] = '\0';
}

int protocol_parse_board_row(const char *line, int *x, int *y, int *field) {
  if (!line || !x || !y || !field)
    return 0;
  char trimmed[128];
  copy_trim(line, trimmed, sizeof(trimmed));
  const char *p = skip_ws(trimmed);
  if (!*p)
    return 0;

  // Defensively handle the literal terminator "DONE" — caller should
  // detect it before this function is invoked, but no harm in failing here.
  if (strncasecmp(p, "DONE", 4) == 0)
    return 0;

  char *endp = NULL;
  long lx = strtol(p, &endp, 10);
  if (endp == p)
    return 0;
  p = skip_ws(endp);
  if (*p != ',')
    return 0;
  p++;
  p = skip_ws(p);
  long ly = strtol(p, &endp, 10);
  if (endp == p)
    return 0;
  p = skip_ws(endp);
  if (*p != ',')
    return 0;
  p++;
  p = skip_ws(p);
  long lf = strtol(p, &endp, 10);
  if (endp == p)
    return 0;

  *x = (int)lx;
  *y = (int)ly;
  *field = (int)lf;
  return 1;
}

size_t protocol_format_move(int gx, int gy, char *out, size_t out_len) {
  if (!out || out_len < 8)
    return 0;
  int n = snprintf(out, out_len, "%d,%d", gx, gy);
  if (n < 0 || (size_t)n >= out_len)
    return 0;
  return (size_t)n;
}
