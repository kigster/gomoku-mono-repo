"""Live (per-game) Elo updates calibrated to match Gomocup's BayesElo.

Gomocup ranks engines with Bayesian Elo using ``eloAdvantage=0`` and
``eloDraw=0.01`` — i.e. no first-mover bonus and draws treated as
essentially impossible. The live formula here is **classical** Elo (the
K-factor / expected-score update) parameterised so the numbers it
produces converge on what a future BayesElo recalibration job would
compute over the full game history.

Concretely:

- ``expected(rating_a, rating_b)`` is the standard Elo expectation,
  symmetric and free of any first-mover term.
- ``update(rating_a, rating_b, score_a, k)`` applies one game's worth
  of update where ``score_a in (0, 0.5, 1)``.
- ``k_factor(games_played, rating)`` follows the FIDE/USCF schedule:
  K=40 for the first 20 games (provisional), K=24 up to 100 games,
  K=16 thereafter, K=10 once the rating crosses 2400.
- ``ai_tier_rating(depth, radius)`` returns a fixed Elo for each
  ``(depth, radius)`` AI tier so a human win against depth-5 grants
  more rating than a win against depth-3.

References:
- ``reference/gomocup-bayesian-elo-system.md`` for the full design rationale.
- Coulom, R. *Bayesian Elo Rating* — https://www.remi-coulom.fr/Bayesian-Elo/
- Gomocup ratings page — https://gomocup.org/elo-ratings/
"""

INITIAL_RATING = 1500


# Rough strength estimates for each (depth, radius) AI tier. Derived from
# reference/gomocup-bayesian-elo-system.md §4 with extra interpolation for the radius
# variants the web flow exposes (the doc's six-tier table only covers
# specific (depth, radius) pairs). Will be empirically corrected once
# enough humans play each tier.
AI_TIER_RATINGS: dict[tuple[int, int], int] = {
    # depth 2 (easy)
    (2, 1): 700,
    (2, 2): 800,
    (2, 3): 900,
    (2, 4): 950,
    # depth 3 (novice)
    (3, 1): 1050,
    (3, 2): 1200,
    (3, 3): 1300,
    (3, 4): 1350,
    # depth 4 (medium)
    (4, 1): 1500,
    (4, 2): 1600,
    (4, 3): 1700,
    (4, 4): 1750,
    # depth 5 (hard)
    (5, 1): 1850,
    (5, 2): 1950,
    (5, 3): 2050,
    (5, 4): 2100,
    # depth 6+ for the TUI users; the web flow caps at 5.
    (6, 3): 2400,
    (6, 4): 2500,
}


def expected(rating_a: int, rating_b: int) -> float:
    """Probability that A beats B under standard Elo (no first-move bonus)."""
    return 1.0 / (1.0 + 10.0 ** ((rating_b - rating_a) / 400.0))


def k_factor(games_played: int, rating: int) -> int:
    """K-factor schedule mirroring FIDE/USCF practice."""
    if games_played < 20:
        return 40
    if games_played < 100:
        return 24
    if rating >= 2400:
        return 10
    return 16


def update(rating_a: int, rating_b: int, score_a: float, k: int) -> int:
    """Apply one Elo update.

    ``score_a`` is the actual outcome from A's perspective:
    1.0 for a win, 0.5 for a draw, 0.0 for a loss. Returns the new
    rounded integer rating for A. The opposite update for B is
    ``update(rating_b, rating_a, 1 - score_a, k_b)`` — note that K may
    differ between players (a provisional player's swing is bigger).
    """
    if score_a < 0.0 or score_a > 1.0:
        raise ValueError(f"score_a must be in [0,1], got {score_a}")
    exp_a = expected(rating_a, rating_b)
    return round(rating_a + k * (score_a - exp_a))


def ai_tier_rating(depth: int, radius: int) -> int:
    """Rating to use for an AI opponent at the given (depth, radius).

    Falls back to a closed-form estimate for tiers we haven't tabulated
    so the TUI's wider depth range (1-10) and any future radius value
    don't crash the live update.
    """
    seeded = AI_TIER_RATINGS.get((depth, radius))
    if seeded is not None:
        return seeded
    # Closed-form fallback: 600 baseline + 250 per ply + 50 per radius cell.
    # Calibrated so depth=5 / radius=3 lands around 2050 (matches the seeded
    # value), and the curve stays monotone across the (depth, radius) plane.
    return max(400, 600 + 250 * depth + 50 * radius)
