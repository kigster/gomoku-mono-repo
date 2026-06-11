# Gomoku 1.2.1 — refereeing AI-vs-AI tournaments, and cloud updates

How do you know if a change made the AI stronger? You make versions play each
other, many times, and count wins. This release adds a Ruby-based tournament
runner that organizes those AI-vs-AI matches and reports results, plus a cleanup
of the evaluation scripts around it.

It also adds a workflow to push updates to the cloud (Cloud Run) and expands the
local test cluster.
