//
//  time_budget.c
//  gomoku-c — Gomocup brain
//

#include "time_budget.h"

#include <string.h>

// Tournament defaults if the manager never sends timeout_turn / timeout_match.
// 30 s / 180 s match the Standard category caps
// (https://gomocup.org/detail-information/).
#define DEFAULT_TURN_MS 30000
#define DEFAULT_MATCH_MS 180000

void time_budget_init(time_budget_t *tb) {
  if (!tb)
    return;
  memset(tb, 0, sizeof(*tb));
  tb->timeout_turn_ms = DEFAULT_TURN_MS;
  tb->timeout_match_ms = DEFAULT_MATCH_MS;
  tb->time_left_ms = DEFAULT_MATCH_MS;
  tb->time_left_estimate_ms = DEFAULT_MATCH_MS;
  tb->time_left_received = 0;
}

void time_budget_set_turn(time_budget_t *tb, int ms) {
  if (!tb)
    return;
  tb->timeout_turn_ms = ms;
}

void time_budget_set_match(time_budget_t *tb, int ms) {
  if (!tb)
    return;
  tb->timeout_match_ms = ms;
  if (!tb->time_left_received) {
    tb->time_left_ms = ms;
    tb->time_left_estimate_ms = ms;
  }
}

void time_budget_set_time_left(time_budget_t *tb, int ms) {
  if (!tb)
    return;
  tb->time_left_ms = ms;
  tb->time_left_estimate_ms = ms;
  tb->time_left_received = 1;
}

double time_budget_compute_seconds(const time_budget_t *tb) {
  if (!tb)
    return 0.0;

  // timeout_turn == 0 means "respond instantly"; the caller should cap
  // depth in that mode. We still return 0.0 so the engine's timeout check
  // short-circuits if it ever sees this value.
  if (tb->timeout_turn_ms == 0)
    return 0.0;

  // Use whichever value is authoritative for remaining match time.
  int remaining_ms =
      tb->time_left_received ? tb->time_left_ms : tb->time_left_estimate_ms;

  // Reserve safety margin against the match clock.
  int match_room_ms = remaining_ms - GOMOCUP_SAFETY_MARGIN_MS;
  if (match_room_ms < 0)
    match_room_ms = 0;

  int budget_ms = tb->timeout_turn_ms;
  if (match_room_ms < budget_ms)
    budget_ms = match_room_ms;

  // Floor: even if the manager-reported time_left is dangerously low,
  // give the engine 50ms so iterative deepening can complete depth 1
  // and produce a legal move. Failing to move means a forfeit; better
  // to blow the soft margin than the hard one.
  if (budget_ms < 50)
    budget_ms = 50;

  return budget_ms / 1000.0;
}

void time_budget_record_elapsed(time_budget_t *tb, double elapsed_seconds) {
  if (!tb)
    return;
  int elapsed_ms = (int)(elapsed_seconds * 1000.0 + 0.5);
  tb->time_left_estimate_ms -= elapsed_ms;
  if (tb->time_left_estimate_ms < 0)
    tb->time_left_estimate_ms = 0;
  // Mirror the decrement onto the authoritative value too — the manager will
  // overwrite this on the next INFO time_left, but if it forgets we still
  // avoid spending budget we no longer have.
  tb->time_left_ms -= elapsed_ms;
  if (tb->time_left_ms < 0)
    tb->time_left_ms = 0;
}
