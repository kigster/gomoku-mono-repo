//
//  time_budget.h
//  gomoku-c — Gomocup brain
//
//  Per-turn budget computation. The Gomocup spec gives the brain two clocks:
//  timeout_turn (ms — strict per-move) and timeout_match / time_left
//  (ms — match-wide). The match-wide clock is authoritative when the manager
//  sends INFO time_left; otherwise we estimate it locally.
//

#ifndef GOMOCUP_TIME_BUDGET_H
#define GOMOCUP_TIME_BUDGET_H

// Reserve this many ms before the manager's deadline for response transmission
// and protocol overhead. 200 ms covers a slow context switch on a contended VM.
#define GOMOCUP_SAFETY_MARGIN_MS 200

typedef struct {
  // Manager-supplied limits, all in ms. 0 means "unset / no limit".
  int timeout_turn_ms;  // strict per-move
  int timeout_match_ms; // overall match
  int time_left_ms;     // remaining match time (manager's authoritative value)

  // Local cache so we can keep a running estimate of time_left between INFO
  // messages. Updated after each move using elapsed wall clock.
  int time_left_estimate_ms;

  // True once the manager has sent at least one INFO time_left in this match.
  int time_left_received;
} time_budget_t;

void time_budget_init(time_budget_t *tb);

void time_budget_set_turn(time_budget_t *tb, int ms);
void time_budget_set_match(time_budget_t *tb, int ms);
void time_budget_set_time_left(time_budget_t *tb, int ms);

/**
 * Compute the budget (in seconds, fractional) the engine should use for
 * the next move. Returns 0.0 to signal "play instantly" (the protocol's
 * documented meaning of timeout_turn = 0); the caller should cap depth
 * and skip iterative deepening in that case.
 *
 * The returned value is min(turn_budget, time_left_minus_margin), with
 * a generous floor so iterative deepening always has time to compute
 * at least depth 1.
 */
double time_budget_compute_seconds(const time_budget_t *tb);

/**
 * Bookkeeping after a move: subtract elapsed seconds from the local
 * time_left_estimate_ms cache. The next INFO time_left from the manager
 * will reset that estimate, but if the manager forgets to send one we
 * still avoid blowing the match clock.
 */
void time_budget_record_elapsed(time_budget_t *tb, double elapsed_seconds);

#endif // GOMOCUP_TIME_BUDGET_H
