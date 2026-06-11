# Plan — 1.1.0 Envoy load balancer and gctl cluster manager

## Steps

1. **Add Envoy support** as an alternative front proxy (#44) with generated
   config; keep HAProxy working during transition.
2. **Harden the balancer.** Revert maxconn to drain/ready semantics; add 503-retry
   to the test client so transient unavailability doesn't fail requests (#43).
3. **Consolidate cluster ops.** Replace `start-cluster` with one comprehensive
   `gomoku-cluster` / `gctl` script covering start/stop/status/config.
4. **Rename `board` → `board_size`** across engine, UI, and JSON for clarity.
5. **Fix high CPU** and refresh colors.
6. **Grow the eval corpus.** Record representative games; add `llm_eval.py`.
7. Bump to `1.1.0`, tag.

## Testing strategy

- Cluster bring-up/tear-down via the new manager; load test through Envoy with
  retries.
- Eval corpus runs to track AI quality over time.

## Deviations from the code

Maintaining both HAProxy and Envoy doubles the proxy-config surface. Once Envoy
is proven, dropping HAProxy (or vice versa) leaves a single balancer to document
and operate. The 30-commit span also mixes a wide-reaching rename with feature
work; isolating the `board → board_size` rename into its own commit keeps the
feature diffs reviewable.
