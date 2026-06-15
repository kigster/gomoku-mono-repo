# AGENTS.md

For repo conventions, architecture, feature workflow, and hard rules, see
[`CLAUDE.md`](CLAUDE.md) (root) and [`frontend/CLAUDE.md`](frontend/CLAUDE.md).
This file only adds notes specific to the Cursor Cloud Linux VM.

## Cursor Cloud specific instructions

The startup update script already installs/refreshes language deps (`uv sync`
for `api/`, `npm install` for `frontend/`). System toolchain (`uv`, `just`,
PostgreSQL 16, `g++`/`cmake`, `clang`) is baked into the VM snapshot. The notes
below cover the non-obvious gotchas of running this stack on Linux.

### `bin/gctl` is macOS-oriented — start services individually on this VM

`bin/gctl` (the documented cluster orchestrator) assumes Homebrew, Bashmatic,
`sudo` nginx on 80/443, and a brew-installed Envoy. None of that is set up here,
so do **not** rely on `gctl start` on the cloud VM. Start the dev components
directly instead (each is the same dev command the per-component docs use):

- **PostgreSQL** runs as a system cluster on **port 5432** (not the Homebrew
  `5433` the repo defaults assume). It does not auto-start — bring it up with:
  `sudo pg_ctlcluster 16 main start` (check with `pg_lsclusters`). `pg_hba.conf`
  is set to `trust` for local socket + `127.0.0.1`/`::1`, and the `postgres`
  role password is `postgres`. Databases `gomoku` and `gomoku_test` already
  exist.
- **Game engine** (C `gomoku-httpd`): a single worker is enough for dev. Build
  with `make -C gomoku-c install` (binary lands in `./bin/`), then run e.g.
  `./bin/gomoku-httpd -b 0.0.0.0:9500 -a 9600 -L debug -l log/gomoku-httpd-9500.log`.
- **API** (FastAPI): `cd api && ENVIRONMENT=development GOMOKU_HTTPD_URL=http://localhost:9500 uv run uvicorn app.main:app --reload --host 0.0.0.0 --port 8000`.
- **Frontend** (Vite): `cd frontend && npm run dev` (serves on `:5173`, proxies
  API routes to `:8000`).

### Engine URL: Routing Setup in Development

The development script

```bash
bin/gctl [start [-r]] | stop]
'`'

Does the following:
* generates the nginx.conf from a template. 


> [!IMPORTANT]
>
> please install nginx via brew, overwrite its nginx.conf with the symlink to the generated version in the iac folder

* it starts Envoy starts. 
* It also starts the GoMoku HTTPD cluster, either the c version or Rust if the -r flag is used. 
* Additionally, it starts the FastAPI server, which responds to API requests and serves the static HTML compiled from the frontend folder. 
* The frontend is not served using bytes; it's compiled and served from the FastAPI folder.

The API reaches the engine via `GOMOKU_HTTPD_URL` (defaults to `http://localhost:10000`, i.e. Envoy). 

Envoy/nginx are **not** installed on this
VM, so point the API straight at a single worker with
`GOMOKU_HTTPD_URL=http://localhost:9500`. The API proxies `POST /game/play` →
engine `POST /gomoku/play`.

### Database port for migrations and tests

Because Postgres is on **5432** (repo default is 5433), export `POSTGRESQL_PORT=5432` for any test/migration command, e.g.:

- Migrate: `cd api && DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/gomoku uv run alembic upgrade head` (repeat for `gomoku_test`). Run migrations after pulling new revisions before starting the API or tests.
- API tests: `cd api && POSTGRESQL_PORT=5432 ENVIRONMENT=test uv run --group test pytest -n 5`
  (xdist conftest creates per-worker `gomoku_test_gw{N}` DBs automatically).
- Frontend tests: `cd frontend && npm test` (vitest).
- C daemon tests: `make -C gomoku-c test-daemon`.

### C/C++ test toolchain caveat

The googletest harness (`make -C gomoku-c test*`) compiles with `c++`, which is
`clang++`, and clang selects the **GCC 14** toolchain. `libstdc++-14-dev` is
installed so this links; if a test build ever fails with
`cannot find -lstdc++`, that dev package (matching clang's selected GCC version)
is missing.
