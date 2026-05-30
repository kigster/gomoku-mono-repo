import { defineConfig } from 'cypress'
import { Pool } from 'pg'

// e2e config — points at the local cluster (vite dev or nginx).
//   - CYPRESS_BASE_URL    defaults to http://localhost:5173 (vite)
//   - CYPRESS_API_BASE    defaults to http://localhost:8000 (FastAPI direct)
//   - CYPRESS_DB_URL      defaults to the local Postgres dev DB
//   - POSTGRESQL_PORT     port for the local Postgres (default 5433,
//                         exported by the repo-root .envrc)
//
// All four are overridable from the env so the same suite can be aimed
// at the nginx-fronted cluster (https://dev.gomoku.games) by exporting:
//   CYPRESS_BASE_URL=https://dev.gomoku.games \
//   CYPRESS_API_BASE=https://dev.gomoku.games \
//   CYPRESS_DB_URL=postgresql://postgres@127.0.0.1:5433/gomoku

const baseUrl = process.env.CYPRESS_BASE_URL || 'http://localhost:5173'
const apiBase = process.env.CYPRESS_API_BASE || 'http://localhost:8000'
const port    = process.env.POSTGRESQL_PORT || '5433'
const dbUrl =
  process.env.CYPRESS_DB_URL ||
  `postgresql://postgres:postgres@127.0.0.1:${port}/gomoku`

let pool: Pool | null = null
function db(): Pool {
  if (!pool) pool = new Pool({ connectionString: dbUrl, max: 4 })
  return pool
}

export default defineConfig({
  e2e: {
    baseUrl,
    specPattern: 'cypress/e2e/**/*.cy.{ts,tsx}',
    supportFile: 'cypress/support/e2e.ts',
    fixturesFolder: 'cypress/fixtures',
    screenshotsFolder: 'cypress/screenshots',
    videosFolder: 'cypress/videos',
    video: false,
    viewportWidth: 1400,
    viewportHeight: 900,
    defaultCommandTimeout: 8000,
    requestTimeout: 15000,
    chromeWebSecurity: false,
    env: {
      apiBase,
      dbUrl,
    },
    setupNodeEvents(on) {
      on('task', {
        // Run a parameterised SQL query against the dev DB and return rows.
        async dbQuery({ sql, params }: { sql: string; params?: unknown[] }) {
          const res = await db().query(sql, params ?? [])
          return res.rows
        },
        // Delete the two scratch users created by a test run, plus any
        // multiplayer/games rows they touched. The `games.user_id` FK has
        // no ON DELETE CASCADE, so we have to remove dependent rows
        // explicitly before deleting the users themselves.
        async dbCleanupUsers(usernames: string[]) {
          if (!usernames.length) return null
          const client = await db().connect()
          try {
            await client.query('BEGIN')
            // Look up the user_ids first — easier than dealing with
            // multiplayer_games' host/guest FKs by username.
            const ids = await client.query(
              'SELECT id FROM users WHERE username = ANY($1::text[])',
              [usernames],
            )
            const uids = ids.rows.map((r) => r.id)
            if (uids.length) {
              await client.query(
                'DELETE FROM games WHERE user_id = ANY($1::uuid[]) OR opponent_id = ANY($1::uuid[])',
                [uids],
              )
              await client.query(
                'DELETE FROM multiplayer_games WHERE host_user_id = ANY($1::uuid[]) OR guest_user_id = ANY($1::uuid[])',
                [uids],
              )
              await client.query(
                'DELETE FROM users WHERE id = ANY($1::uuid[])',
                [uids],
              )
            }
            await client.query('COMMIT')
          } catch (e) {
            await client.query('ROLLBACK')
            throw e
          } finally {
            client.release()
          }
          return null
        },
      })
    },
  },
})
