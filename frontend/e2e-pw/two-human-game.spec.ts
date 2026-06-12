import { test, expect } from "@playwright/test";
import {
  signup,
  openAs,
  placeStone,
  readInviteCode,
  cleanupUsers,
  closeDb,
  db,
  rand,
  TestUser,
} from "./support";

// ===========================================================================
// True two-human multiplayer game.
//
// Two concurrent BrowserContexts ("Alice" and "Bob") play a full game of
// Gomoku through the real UI. Neither reloads to see the other's move — the
// live app propagates each stone across the two browsers on its own. This is
// the "pretending to be humans" acceptance test: two independent sessions,
// one board, a real win, a real Elo update.
//
// Move script (mirrors the Cypress smoke): X (Alice, Black, host) completes
// row 7 cols 0..4 for five-in-a-row; O (Bob, White) answers on row 8.
// ===========================================================================

const BOARD_SIZE = 15 as const;
const MOVES: { row: number; col: number; player: "X" | "O" }[] = [
  { row: 7, col: 0, player: "X" },
  { row: 8, col: 0, player: "O" },
  { row: 7, col: 1, player: "X" },
  { row: 8, col: 1, player: "O" },
  { row: 7, col: 2, player: "X" },
  { row: 8, col: 2, player: "O" },
  { row: 7, col: 3, player: "X" },
  { row: 8, col: 3, player: "O" },
  { row: 7, col: 4, player: "X" }, // winning stone
];

test.describe("Two-human multiplayer game (real dual browser contexts)", () => {
  const suffix = rand();
  const aliceName = `pw_alice_${suffix}`;
  const bobName = `pw_bob_${suffix}`;

  test.afterAll(async () => {
    await cleanupUsers([aliceName, bobName]);
    await closeDb();
  });

  test("two humans play a full game; the win and Elo update persist", async ({
    browser,
    request,
  }) => {
    // ---- 1. Register both players via the auth API. ----------------------
    const alice: TestUser = await signup(
      request,
      aliceName,
      "pw-test-pw",
      `${aliceName}@example.com`,
    );
    const bob: TestUser = await signup(
      request,
      bobName,
      "pw-test-pw",
      `${bobName}@example.com`,
    );

    // ---- 2. Open two independent browser sessions. -----------------------
    const { context: aCtx, page: aPage } = await openAs(browser, alice);
    const { context: bCtx, page: bPage } = await openAs(browser, bob);

    try {
      // ---- 3. Alice (host) creates a human invite via the modal. ---------
      // The modal opens defaulted to Another Player / "I will choose" /
      // Black (X) and auto-creates the invite, so no option clicks are
      // needed — clicking them would race the `creating`-disabled state.
      await aPage.goto("/");
      await aPage.getByRole("button", { name: /^New Multiplayer Game$/ }).click();

      const code = await readInviteCode(aPage);
      expect(code, "6-char invite code").toMatch(/^[A-Z2-9]{6}$/);

      // ---- 4. Bob joins via /play/<code>; the game starts. ---------------
      await bPage.goto(`/play/${code}`);
      await expect(
        bPage.getByText(`${aliceName} vs ${bobName}`),
        "Bob sees the matchup header",
      ).toBeVisible({ timeout: 20_000 });

      // Alice moves from her waiting screen into the live board.
      await aPage.goto(`/play/${code}`);
      await expect(
        aPage.getByText(`${aliceName} vs ${bobName}`),
        "Alice sees the matchup header",
      ).toBeVisible({ timeout: 20_000 });

      // ---- 5. Play the game. Each player's move propagates to the other
      //         browser with no reload (the heart of the two-human test). --
      for (let i = 0; i < MOVES.length; i++) {
        const m = MOVES[i];
        const mover = m.player === "X" ? aPage : bPage;
        const last = i === MOVES.length - 1;

        // Scope to the board's own turn-status line (data-testid) rather than
        // a bare text match: "Waiting for opponent" is also rendered by the
        // modal and waiting screens, so an unscoped regex could resolve to
        // stale UI instead of the live game state.
        await expect(
          mover.getByTestId("turn-status"),
          `move ${i + 1}: ${m.player} sees their turn (propagated live)`,
        ).toHaveText("Your move.", { timeout: 30_000 });

        await placeStone(mover, BOARD_SIZE, m.row, m.col);

        if (last) {
          await expect(
            mover.getByText(/wins against|Game Over/),
            `move ${i + 1}: the winning stone ends the game`,
          ).toBeVisible({ timeout: 15_000 });
        } else {
          await expect(
            mover.getByTestId("turn-status"),
            `move ${i + 1}: the stone is accepted, turn passes to the opponent`,
          ).toHaveText("Waiting for opponent…", { timeout: 15_000 });
        }
      }

      // ---- 6. Both browsers show the game-over outcome. ------------------
      await expect(
        aPage.getByText(`@${aliceName} wins against @${bobName}`),
        "Alice sees the win",
      ).toBeVisible({ timeout: 20_000 });

      await expect(
        bPage.getByText("Game Over"),
        "Bob sees Game Over",
      ).toBeVisible({ timeout: 20_000 });
      await expect(
        bPage.getByText(new RegExp(`Lost to @${aliceName} in \\d+ seconds?\\.`)),
        "Bob sees the loss line",
      ).toBeVisible();

      // ---- 7. Two `games` rows, cross-linked, with the Elo update. ------
      const { rows } = await db().query(
        `SELECT g.username, g.game_type, g.winner, g.human_player,
                opp.username AS opp_name,
                g.elo_before, g.elo_after, g.opponent_elo_before
           FROM games g
           LEFT JOIN users opp ON opp.id = g.opponent_id
          WHERE g.username IN ($1, $2)
          ORDER BY g.username`,
        [aliceName, bobName],
      );
      expect(rows, "one games row per player").toHaveLength(2);
      const byName: Record<string, Record<string, unknown>> = {};
      for (const r of rows) byName[r.username as string] = r;
      const a = byName[aliceName];
      const b = byName[bobName];

      expect(a.game_type).toBe("multiplayer");
      expect(b.game_type).toBe("multiplayer");
      expect(a.opp_name).toBe(bobName);
      expect(b.opp_name).toBe(aliceName);
      expect(a.winner).toBe("X");
      expect(b.winner).toBe("X");
      expect(a.human_player).toBe("X");
      expect(b.human_player).toBe("O");

      // Both started at 1500; equal opponents, K=40 → +20 / -20.
      expect(Number(a.elo_before)).toBe(1500);
      expect(Number(a.elo_after)).toBe(1520);
      expect(Number(a.opponent_elo_before)).toBe(1500);
      expect(Number(b.elo_before)).toBe(1500);
      expect(Number(b.elo_after)).toBe(1480);
      expect(Number(b.opponent_elo_before)).toBe(1500);
    } finally {
      await aCtx.close();
      await bCtx.close();
    }
  });
});
