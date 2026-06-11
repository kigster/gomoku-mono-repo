import { Browser, BrowserContext, Page, APIRequestContext, expect } from "@playwright/test";
import { Pool } from "pg";
import { BOARD_PX, PADDING } from "../src/constants";

// ---------------------------------------------------------------------------
// Shared helpers for the Playwright two-human e2e suite.
// ---------------------------------------------------------------------------

export const API_BASE =
  process.env.PW_API_BASE || process.env.CYPRESS_API_BASE || "http://localhost:8000";

const PG_PORT = process.env.POSTGRESQL_PORT || "5433";
export const DB_URL =
  process.env.PW_DB_URL ||
  process.env.CYPRESS_DB_URL ||
  `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/gomoku`;

// App reads these from sessionStorage on mount (see frontend/src/App.tsx).
const TOKEN_KEY = "gomoku_auth_token";
const USER_KEY = "gomoku_username";

// Board geometry is imported from the app's single source of truth
// (src/constants.ts) so the click math can never drift from what the board
// actually renders. Re-exported for any spec that needs the raw values.
export { BOARD_PX, PADDING };

export interface TestUser {
  username: string;
  password: string;
  email: string;
  token: string;
}

export function rand(): string {
  return Math.random().toString(36).slice(2, 10);
}

let pool: Pool | null = null;
export function db(): Pool {
  if (!pool) pool = new Pool({ connectionString: DB_URL, max: 4 });
  return pool;
}
export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

// Register a user through the auth API and return their JWT.
export async function signup(
  request: APIRequestContext,
  username: string,
  password: string,
  email: string,
): Promise<TestUser> {
  const resp = await request.post(`${API_BASE}/auth/signup`, {
    data: { username, password, email },
  });
  expect(resp.ok(), `signup ${username} -> ${resp.status()}`).toBeTruthy();
  const body = await resp.json();
  const token = body.access_token as string;
  expect(token, "access_token").toBeTruthy();
  return { username, password, email, token };
}

// Open a fresh BrowserContext authenticated as `user` — the equivalent of a
// second incognito window. Seeds sessionStorage before any app script runs so
// App.tsx skips the auth modal.
export async function openAs(
  browser: Browser,
  user: TestUser,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  await context.addInitScript(
    ([token, username, tokenKey, userKey]) => {
      window.sessionStorage.setItem(tokenKey, token);
      window.sessionStorage.setItem(userKey, username);
    },
    [user.token, user.username, TOKEN_KEY, USER_KEY] as const,
  );
  const page = await context.newPage();
  return { context, page };
}

// Click a board intersection. The board is one big <svg> with pixel hit
// detection, so we measure the rendered rect and click the right offset.
export async function placeStone(
  page: Page,
  boardSize: 15 | 19,
  row: number,
  col: number,
): Promise<void> {
  const svg = page.locator('[data-testid="board-svg"]');
  await expect(svg).toBeVisible();
  const box = await svg.boundingBox();
  if (!box) throw new Error("board-svg has no bounding box");
  const cellSize = (BOARD_PX - 2 * PADDING) / (boardSize - 1);
  const scaleX = box.width / BOARD_PX;
  const scaleY = box.height / BOARD_PX;
  const x = box.x + (PADDING + col * cellSize) * scaleX;
  const y = box.y + (PADDING + row * cellSize) * scaleY;
  await page.mouse.click(x, y);
}

// Pull the 6-char invite code out of the waiting screen's read-only URL field.
export async function readInviteCode(page: Page): Promise<string> {
  let code: string | null = null;
  await expect
    .poll(
      async () => {
        code = await page.evaluate(() => {
          const inputs = Array.from(
            document.querySelectorAll("input"),
          ) as HTMLInputElement[];
          for (const i of inputs) {
            const m = i.value.match(/\/play\/([A-Z2-9]{6})/);
            if (m) return m[1];
          }
          return null;
        });
        return code;
      },
      { timeout: 15_000, message: "waiting-screen invite code" },
    )
    .not.toBeNull();
  return code as unknown as string;
}

// Remove scratch users + their game rows (games.user_id has no ON DELETE
// CASCADE, so dependent rows go first).
export async function cleanupUsers(usernames: string[]): Promise<void> {
  if (!usernames.length) return;
  const client = await db().connect();
  try {
    await client.query("BEGIN");
    const ids = await client.query(
      "SELECT id FROM users WHERE username = ANY($1::text[])",
      [usernames],
    );
    const uids = ids.rows.map((r) => r.id);
    if (uids.length) {
      await client.query(
        "DELETE FROM games WHERE user_id = ANY($1::uuid[]) OR opponent_id = ANY($1::uuid[])",
        [uids],
      );
      await client.query(
        "DELETE FROM multiplayer_games WHERE host_user_id = ANY($1::uuid[]) OR guest_user_id = ANY($1::uuid[])",
        [uids],
      );
      await client.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [uids]);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
