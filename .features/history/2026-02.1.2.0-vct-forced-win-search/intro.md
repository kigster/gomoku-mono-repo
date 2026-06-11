# Gomoku 1.2.0 — the AI learns to see forced wins

A strong Gomoku player can sometimes see a sequence of threats that the opponent
*must* respond to, ending in an unavoidable win — a "forced win." This release
teaches the AI to search for exactly those (a technique called VCT, Victory by
Continuous Threats). When such a winning sequence exists, the computer now finds
and plays it instead of drifting.

It also gains clearer scoring reports (why it valued a position the way it did)
and more precise blocking.
