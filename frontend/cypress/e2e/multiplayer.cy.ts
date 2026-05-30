/// <reference types="cypress" />

// End-to-end multiplayer smoke test.
//
// Cypress drives one browser context at a time, so we simulate the second
// "incognito browser" by swapping the JWT in localStorage between Alice and
// Bob between every move (see commands.ts → cy.useUser).
//
// Flow:
//   1. Sign up Alice and Bob via /auth/signup (fresh randomised usernames).
//   2. As Alice (host, plays X), open ChooseGameTypeModal → pick Another
//      Player → Start; capture the invite link from the waiting screen.
//   3. As Bob, visit /play/<code>; auto-join fires; Bob plays O.
//   4. Alternate moves through the UI on row 7, cols 0..4 for X (winning
//      five-in-a-row) and row 8, cols 0..3 for O.
//   5. Verify the game-over copy on each player's screen.
//   6. Query the games table directly: confirm two rows (one per player)
//      with game_type='multiplayer' and opponent_id cross-linked.

interface User {
  username: string;
  password: string;
  email: string;
  token: string;
}

function rand(): string {
  return Math.random().toString(36).slice(2, 10);
}

const BOARD_SIZE: 15 = 15;
// X (Alice) wins by completing row 7, columns 0..4.
//   row, col, player ('X' = alice, 'O' = bob)
const MOVES: { row: number; col: number; player: "X" | "O" }[] = [
  { row: 7, col: 0, player: "X" },
  { row: 8, col: 0, player: "O" },
  { row: 7, col: 1, player: "X" },
  { row: 8, col: 1, player: "O" },
  { row: 7, col: 2, player: "X" },
  { row: 8, col: 2, player: "O" },
  { row: 7, col: 3, player: "X" },
  { row: 8, col: 3, player: "O" },
  { row: 7, col: 4, player: "X" }, // winner
];

describe("Two-user multiplayer game", () => {
  const suffix = rand();
  const alice = {
    username: `alice_${suffix}`,
    password: "cypress-test-pw",
    email: `alice_${suffix}@example.com`,
  };
  const bob = {
    username: `bob_${suffix}`,
    password: "cypress-test-pw",
    email: `bob_${suffix}@example.com`,
  };

  let aliceUser: User;
  let bobUser: User;
  let inviteCode: string;

  after(() => {
    cy.task("dbCleanupUsers", [alice.username, bob.username]);
  });

  it("registers two users, plays a full game via the UI, and persists both rows", () => {
    // ---- 1. Sign up both players via the auth API. -----------------------
    cy.apiSignup(alice.username, alice.password, alice.email).then((u) => {
      aliceUser = u;
    });
    cy.apiSignup(bob.username, bob.password, bob.email).then((u) => {
      bobUser = u;
    });

    // ---- 2. Alice creates an invite via the UI (modal flow). ------------
    cy.then(() => cy.useUser(aliceUser));
    cy.visit("/");
    cy.contains("button", /^New Multiplayer Game$/).click();
    cy.contains("label", /^Another Player/).click();
    cy.contains("label", /^I will choose$/).click();
    cy.contains("label", /^Black \(X\)/).click();
    // No "Start" click for human mode — the invite link auto-generates.

    // The waiting view shows a copyable input with the full invite URL.
    // Pull the 6-char code out of it so Bob can navigate directly.
    cy.get('input[readonly][value*="/play/"]', { timeout: 10000 })
      .invoke("val")
      .then((val) => {
        const m = String(val).match(/\/play\/([A-Z2-9]{6})/);
        expect(m, `code in waiting URL: ${val}`).to.not.be.null;
        inviteCode = (m as RegExpMatchArray)[1];
        cy.log(`Invite code: ${inviteCode}`);
      });

    // ---- 3. Bob visits /play/<code> — auto-join → game starts. ----------
    cy.then(() => cy.useUser(bobUser));
    cy.then(() => cy.visit(`/play/${inviteCode}`));
    cy.contains(`${alice.username} vs ${bob.username}`, {
      timeout: 15000,
    }).should("be.visible");

    // ---- 4. Alternate moves through the UI. -----------------------------
    for (let i = 0; i < MOVES.length; i++) {
      const move = MOVES[i];
      const user = move.player === "X" ? () => aliceUser : () => bobUser;
      cy.log(
        `Move ${i + 1}/${MOVES.length}: ${move.player} → (${move.row},${move.col})`,
      );
      cy.then(() => cy.useUser(user()));
      cy.then(() => cy.visit(`/play/${inviteCode}`));

      // Wait until it's our turn. The other player's move is propagated to
      // us via the polling hook (every 1.5s, geometrically backing off).
      cy.contains(/Your move\./, { timeout: 30000 }).should("be.visible");

      cy.placeStone(BOARD_SIZE, move.row, move.col);
      // After clicking, the board state must reflect our move before we
      // hand off to the next user.
      cy.contains(/Waiting for opponent|wins against|Game Over/, {
        timeout: 10000,
      }).should("be.visible");
    }

    // ---- 5. Verify game-over UI on both screens. ------------------------
    // Alice's screen — winner.
    cy.then(() => cy.useUser(aliceUser));
    cy.then(() => cy.visit(`/play/${inviteCode}`));
    cy.contains(`@${alice.username} wins against @${bob.username}`, {
      timeout: 20000,
    }).should("be.visible");

    // Bob's screen — loser.
    cy.then(() => cy.useUser(bobUser));
    cy.then(() => cy.visit(`/play/${inviteCode}`));
    cy.contains("Game Over", { timeout: 20000 }).should("be.visible");
    cy.contains(
      new RegExp(`Lost to @${alice.username} in \\d+ seconds?\\.`),
    ).should("be.visible");

    // ---- 6. Verify two `games` rows + cross-linked opponent_id + Elo. ---
    cy.task<Record<string, unknown>[]>("dbQuery", {
      sql: `SELECT g.id, g.username, g.game_type, g.winner,
                   g.human_player, g.opponent_id, opp.username AS opp_name,
                   g.elo_before, g.elo_after, g.opponent_elo_before
            FROM games g
            LEFT JOIN users opp ON opp.id = g.opponent_id
            WHERE g.username IN ($1, $2)
            ORDER BY g.username`,
      params: [alice.username, bob.username],
    }).then((rows) => {
      expect(rows, "rows for alice + bob").to.have.lengthOf(2);
      const byName: Record<string, Record<string, unknown>> = {};
      for (const r of rows) byName[r.username as string] = r;

      const a = byName[alice.username];
      const b = byName[bob.username];
      expect(a, "alice row").to.exist;
      expect(b, "bob row").to.exist;

      expect(a.game_type, "alice game_type").to.eq("multiplayer");
      expect(b.game_type, "bob game_type").to.eq("multiplayer");

      expect(a.opp_name, "alice opponent username").to.eq(bob.username);
      expect(b.opp_name, "bob opponent username").to.eq(alice.username);

      // X = Black = Alice.
      expect(a.winner, "alice.winner").to.eq("X");
      expect(b.winner, "bob.winner").to.eq("X");
      expect(a.human_player, "alice plays X").to.eq("X");
      expect(b.human_player, "bob plays O").to.eq("O");

      // Elo: both started at 1500; equal opponents + K=40, so Alice
      // gains 20 (1520) and Bob loses 20 (1480). Allow ±1 for rounding.
      expect(a.elo_before, "alice elo_before").to.eq(1500);
      expect(a.elo_after, "alice elo_after").to.eq(1520);
      expect(a.opponent_elo_before, "alice opp elo").to.eq(1500);
      expect(b.elo_before, "bob elo_before").to.eq(1500);
      expect(b.elo_after, "bob elo_after").to.eq(1480);
      expect(b.opponent_elo_before, "bob opp elo").to.eq(1500);
    });
  });
});
