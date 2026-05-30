# Deployment Options for Gomoku

A walk-through of the cheapest ways to host this game so it can scale on
demand, with a special eye toward the **single-threaded C engine** (which is
what makes this app interesting to deploy).

______________________________________________________________________

## 1. What we are actually deploying

Three logical components, plus a database:

| Component | Language | Concurrency model | CPU profile |
| -------------- | ------------------------------------------ | --------------------------------- | ------------------------------------------- |
| `frontend` | React + Vite (static) | served as static files | none — bundled into the API image |
| `gomoku-api` | FastAPI / Python (async) | concurrency 80+ per process | mostly I/O-bound (DB, httpx) |
| `gomoku-httpd` | C, **single-threaded**, **single-request** | one request per process at a time | CPU-bound, 50 ms – 5 s per move (depth 2–5) |
| Postgres | external | connection-pooled | tiny — see §3 |

The headache is `gomoku-httpd`. It pegs one core for the duration of a search
and refuses any second request. Whatever we deploy on must be able to:

1. **Fan out** requests across N worker processes, each on its own core,
1. **Queue** inbound requests when all N workers are busy (so a 200 ms wait
   looks like latency, not a 503), and
1. **Scale** N up/down with traffic, ideally cheaply when idle.

This is exactly the role envoy/haproxy/kamal-proxy plays. Cloud Run technically
fans out (it spins a new instance per concurrent request when concurrency=1),
but it does **not** queue — once the per-region instance cap is hit, callers
get 429s. That is the architectural gap you correctly flagged.

______________________________________________________________________

## 2. Architecture (target)

```
                        ┌──────────────────────┐
                        │  TLS termination     │   Caddy / Cloud Run / Fly edge
                        └──────────┬───────────┘
                                   │
                        ┌──────────▼───────────┐
                        │   gomoku-api (N≥2)   │   FastAPI: auth, scoring,
                        │   serves the SPA     │   leaderboard, /play proxy
                        └────┬───────────┬─────┘
                             │           │
                       Postgres        ┌─▼──────────────┐
                                       │ gomoku-proxy   │   envoy (or kamal-proxy
                                       │ queue + LB     │    or haproxy)
                                       └─┬────┬────┬────┘
                                         │    │    │      LEAST_REQUEST,
                                       ┌─▼┐ ┌─▼┐ ┌─▼┐    health checks,
                                       │w1│ │w2│ │wN│    inbound queue,
                                       └──┘ └──┘ └──┘    circuit breaker
                                       gomoku-httpd workers (1 vCPU each)
```

Why a dedicated proxy in front of `gomoku-httpd`:

- **Inbound queue** — `max_pending_requests: 1000` in envoy means a burst of
  500 concurrent moves does not error out; it just waits a few hundred ms.
- **Active health checks** — Cloud Run's load balancing is opportunistic; envoy
  pulls a stuck worker out of rotation in 2 s.
- **LEAST_REQUEST policy** — far better than round-robin when each request
  takes wildly different times (depth 2 ≈ 50 ms, depth 5 ≈ 5 s).
- **Outlier detection** — eject a worker that has 5xx'd 5 times in 10 s.

The same proxy can sit in front of `gomoku-api` to give it a queue too, but
FastAPI is async and rarely the bottleneck.

______________________________________________________________________

## 3. Scalability sizing — does the math actually require autoscale?

Players in a Gomoku game think for **5–30 s** between moves. So one "active
player" generates roughly **0.05 req/s** of AI moves. Average move depth on
default settings (depth 3, radius 2) finishes in **~150 ms** on a Cloud Run
1-vCPU instance.

| Concurrent players | req/s to httpd | Workers needed (Erlang C, 95 %ile < 1 s) | Workers needed (worst case, depth 5 ≈ 3 s) |
| -----------------: | -------------: | ---------------------------------------: | -----------------------------------------: |
| 100 | 5 | 2 | 16 |
| 1 000 | 50 | 10 | 60 |
| 10 000 | 500 | 80 | 500 |

**Database load at 1 000 concurrent players:**

- ~50 game writes/s during play (one row update per move) — utterly trivial.
- Leaderboard reads: cacheable, ~1 RPS of distinct queries.
- Storage: 10 KB/game × 50k games/day = **500 MB/day**, ≈ 15 GB/month.
- Connection footprint: 2-4 conns per `gomoku-api` instance, so ≤ 40 conns.

**The DB is comfortable on Neon free tier (0.5 GB) up to ~50 active players.
A €4/month Hetzner Postgres VM holds 100k players easily.** For our actual
traffic (single-digit DAU during your job hunt), every option below is
overpowered.

What this means for "auto-scaling": you do not need elastic scaling for
correctness — you need it for **cost**. The realistic peak is 10–100
concurrent players (after a launch / blog post), not 10 000. So the question
is "what costs $0 when nobody is playing and degrades gracefully under a
Hacker News hug?", not "what scales to a million users."

______________________________________________________________________

## 4. The contenders

I evaluated five. Each entry has the **why**, the **shape of the deployment**,
the **monthly cost at 0 / 100 / 1 000 concurrent players**, and the
**operational tax**.

### Option A — Google Cloud Run (current, with envoy added)

What changes from today: introduce `gomoku-proxy` as a third Cloud Run service
running envoy, sitting between `gomoku-api` and `gomoku-httpd`. Or, simpler,
move `gomoku-httpd` and an envoy sidecar into a single Cloud Run service that
runs N copies of httpd locally and an envoy on port 8787. Cloud Run
multi-container is GA since 2023, so this is a real option.

```
api → envoy(:8787) → httpd(:9001..9008)   # all in one Cloud Run service
```

- **Pro:** scale-to-zero, managed TLS, you already own the Terraform, the
  build pipeline works.
- **Pro:** envoy + 8 httpd workers in one instance amortises cold starts and
  reuses a single 4-vCPU instance instead of 8 instances of 1 vCPU.
- **Con:** Cloud Run pricing per vCPU-second is the highest of any option here
  (~$0.000024/vCPU-s).
- **Con:** request-time billing means a long depth-5 search at $0.000024 ×
  5 s = $0.00012 per move. At 50 req/s that is ~$15/day. Fine for a hobby,
  not fine if a bot scrapes you.
- **Con:** **2-minute request timeout** can bite depth-5 searches, but
  configurable up to 60 minutes on second-gen execution.

**Costs**

| | Idle | 100 concurrent | 1 000 concurrent |
| ------------- | ---: | -------------: | ---------------: |
| Cloud Run | $0 | ~$5/mo | ~$80/mo |
| Neon Postgres | $0 | $0 | ~$19/mo |
| Egress | $0 | ~$1 | ~$10 |
| **Total** | $0 | ~$6 | ~$110 |

### Option B — Hetzner Cloud + Kamal

Kamal is Basecamp's deployment tool: it ssh's into a VM (or several), runs
`docker run` for each role (web/proxy/worker), and ships
`kamal-proxy` (Caddy-based) for TLS + zero-downtime deploys + **inbound
request queueing**. Kamal's proxy already does the thing you want envoy for.

```
hetzner-cax21 (4 vCPU ARM, 8 GB, €7.5/mo)
  ├── kamal-proxy         (TLS, queue, draining)
  ├── gomoku-api × 2
  ├── gomoku-httpd × 4    (one per vCPU)
  └── postgres            (or use a separate cheap VM)
```

Vertical scale by changing instance type (`cax11` €4 → `cax41` €30); add a
second VM with `kamal accessory` for blue/green or a worker pool. Hetzner ARM
boxes are absurdly cheap and the C build cross-compiles to arm64 trivially.

- **Pro:** deterministic monthly cost, no surprise bill.
- **Pro:** kamal-proxy handles the queue requirement out of the box.
- **Pro:** EU region is fine — Cloud Run latency from EU is the same to the US.
- **Con:** no scale-to-zero. You always pay for the box.
- **Con:** you own backups, OS patches, Postgres upgrades.
- **Con:** Hetzner has had multi-hour outages; no SLA worth speaking of.

**Costs (CAX21, 4 vCPU / 8 GB ARM):**

| | Idle | 100 concurrent | 1 000 concurrent |
| ---------- | ---: | --------------: | -------------------: |
| Hetzner VM | €7.5 | €7.5 | €30 (CAX41, 16 vCPU) |
| Postgres | $0 | $0 | included on same box |
| Egress | €0 | €0 (20 TB free) | €0 |
| **Total** | €7.5 | €7.5 | ~€30 |

### Option C — Hetzner + plain docker-compose + Caddy

The "just put it on a box" option. One `docker-compose.yml` that brings up
Caddy (TLS), api, an envoy or haproxy, N httpd workers, and Postgres. SSH in,
`git pull`, `docker compose up -d`. No orchestration framework.

- **Pro:** zero learning curve. You can read the entire deploy in 10 minutes.
- **Pro:** cheapest of all options (€4–€8/mo on a CAX11/CAX21).
- **Pro:** Caddy gets you Let's Encrypt for free, no certbot dance.
- **Con:** deploys are not zero-downtime unless you script it.
- **Con:** scaling means resizing the box and restarting, or manually
  bringing up a second box behind a load balancer.

This is the **honest minimum viable deployment**. If the goal is "make
gomoku.games work and stop fiddling," this is it.

**Costs:** identical to Option B (€7.5/mo) but with worse ergonomics.

### Option D — Fly.io

Fly is conceptually Cloud Run + WireGuard mesh. You define machines per region;
each machine is a tiny VM that boots in ~300 ms. Their `fly-proxy` does
request-level load balancing with `concurrency` hard limits per machine, so a
machine at concurrency=1 will not get a second request — fly buffers it.

- **Pro:** scale-to-zero (`auto_stop_machines = true`) and ~300 ms cold start.
- **Pro:** the per-machine concurrency hint makes single-threaded backends a
  first-class citizen — exactly what gomoku-httpd needs.
- **Pro:** their managed Postgres or Supabase add-on covers the DB.
- **Con:** smaller company, more frequent regional incidents than GCP.
- **Con:** pricing is per-second of machine uptime; more like Cloud Run than
  Hetzner.

**Costs:**

| | Idle | 100 concurrent | 1 000 concurrent |
| ------------ | ---: | -------------: | ---------------: |
| Fly machines | $0 | ~$5/mo | ~$60/mo |
| Postgres | $0 | ~$5/mo | ~$25/mo |
| **Total** | $0 | ~$10/mo | ~$85/mo |

### Option E — Hetzner + k3s (lightweight Kubernetes)

A single-node k3s cluster on a CAX21, with HPA on a Deployment of httpd
workers fronted by an envoy IngressGateway. This is the "I want real
autoscaling" answer without paying GKE prices.

- **Pro:** real HPA on CPU/memory/custom metrics. The setup matches what
  you'd write for a serious GCP/EKS deployment, so the IaC is portable.
- **Pro:** envoy gateway fits naturally as an ingress controller.
- **Con:** k8s is overkill for this app and you will spend a weekend on it.
- **Con:** you still need somewhere to run k3s, so cost is Hetzner-equivalent.

Worth it only if **K8s on the resume** is a goal. (For a job hunt, that
might genuinely be the deciding factor — call it.)

**Costs:** same as Option B/C (~€8–€30/mo).

______________________________________________________________________

## 5. Database recommendation

DB sizing (§3) shows we are nowhere near needing managed Postgres beefier
than free tier. The four sane choices, ranked:

1. **Neon free tier** — keep it. 0.5 GB / 190 compute hours. Re-evaluate at
   1 k DAU.
1. **Postgres on the same VM** (Option B/C/E) — `pg_basebackup` to a daily
   Hetzner storage box for $1/mo. Zero ops if you accept that.
1. **Supabase free tier** — like Neon but with auth/storage you might want
   later. Not worth migrating today.
1. **SQLite + Litestream** — genuinely viable here. Game data is tiny,
   single-writer is fine because all writes go through one `gomoku-api`
   cluster. Litestream replicates to S3-compatible storage. Zero $ DB.
   Caveat: leaderboards on SQLite are fine to ~1 M games.

I would not bother migrating off Neon until something forces it.

______________________________________________________________________

## 6. Cost summary at a glance

| | Idle | 100 players | 1 000 players | Ops effort |
| ---------------------------------------------- | ---: | ----------: | ------------: | ---------- |
| A. Cloud Run (current + envoy multi-container) | $0 | ~$6/mo | ~$110/mo | low |
| B. Hetzner + Kamal | €7.5 | €7.5/mo | ~€30/mo | low–medium |
| C. Hetzner + docker-compose | €7.5 | €7.5/mo | ~€30/mo | low |
| D. Fly.io | $0 | ~$10/mo | ~$85/mo | low |
| E. Hetzner + k3s | €7.5 | €7.5/mo | ~€30/mo | high |

______________________________________________________________________

## 7. Recommendation

**Short term (next 2–4 weeks):** **Option A — fix Cloud Run by adding envoy
as a sidecar to `gomoku-httpd`.** It is the smallest delta from where you are.
Two concrete changes:

1. Add a multi-container Cloud Run service `gomoku-engine` containing
   `envoy` (port 8787, public-internal) + 4× `gomoku-httpd` (ports
   9001–9004, localhost). Keep concurrency=N (N=4) at the Cloud Run level,
   let envoy distribute internally with LEAST_REQUEST.
1. Point `gomoku-api`'s `GOMOKU_HTTPD_URL` at the new service.

You keep scale-to-zero, you fix the queuing problem, the Terraform diff is
~80 lines, and you don't change the front-of-house at all.

**Medium term (if traffic ever justifies it, or you want a fixed bill):**
**Option B — migrate to Hetzner + Kamal.** kamal-proxy already does what
envoy would do for you. €7.5/mo gets a 4-vCPU ARM box that handles 100
concurrent players with headroom. Migration is mechanical because everything
is already containerised.

**Skip for now:** Fly.io (no big advantage over Cloud Run for your traffic),
k3s (resume value only), full GKE (10× the cost).

______________________________________________________________________

## 8. Open questions before committing

1. Is `gomoku.games` apex going to point at this directly, or stay on
   `app.gomoku.games`? Apex DNS shapes Option B/C (need an A record, not a
   CNAME). Cloud Run handles both.
1. How married are we to GCP for the rest of `agentica.group` /
   `qualified.at`? If those end up on Hetzner, consolidation argues for B.
1. Is the goal "cheap and stable" or "interview-talking-point"? Option A is
   the former, Option E is the latter. Pick one consciously.
1. Do we want CI to deploy on push? Cloud Run + GitHub Actions is one YAML
   file; Kamal + GHA is also one YAML file; k3s is a small adventure.
