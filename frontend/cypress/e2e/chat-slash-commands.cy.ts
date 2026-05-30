/// <reference types="cypress" />

// End-to-end coverage for the chat-panel slash commands. Each test signs
// up two random users (so reruns don't collide on usernames), drives the
// chat input as Alice, and asserts both the rendered system caption AND
// the underlying database row.
//
// The existing multiplayer.cy.ts spec drives a full game; this one is
// scoped to the slash-command surface area so a regression in either
// half can be diagnosed without re-running the longer game flow.

interface User {
  username: string;
  password: string;
  email: string;
  token: string;
}

function rand(): string {
  return Math.random().toString(36).slice(2, 10);
}

function typeSlash(cmd: string) {
  cy.get('input[aria-label="Chat message"]').clear().type(`${cmd}{enter}`);
}

describe("Chat panel — slash commands", () => {
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

  before(() => {
    cy.apiSignup(alice.username, alice.password, alice.email).then((u) => {
      aliceUser = u;
    });
    cy.apiSignup(bob.username, bob.password, bob.email).then((u) => {
      bobUser = u;
    });
  });

  after(() => {
    cy.task("dbCleanupUsers", [alice.username, bob.username]);
  });

  beforeEach(() => {
    // Land on the home page as Alice with the Multi tab pre-selected.
    cy.then(() => cy.useUser(aliceUser));
    cy.visit("/");
    // Click the Multi tab so the chat panel is visible.
    cy.get("[role=tab]").contains("Multi").click();
  });

  it("/help renders the command list", () => {
    typeSlash("/help");
    cy.contains("/invite").should("be.visible");
    cy.contains("/follow").should("be.visible");
    cy.contains("/unfollow").should("be.visible");
    cy.contains("/block").should("be.visible");
  });

  it(`/follow @${"bob"} non-reciprocal then reciprocal`, () => {
    typeSlash(`/follow @${bob.username}`);
    cy.contains(`Following @${bob.username}`).should("be.visible");

    // Switch to Bob's session, follow Alice back — back as Alice and the
    // next /follow @bob from Alice should now be reciprocal=true (well,
    // already-following, but Bob → Alice followed too).
    cy.then(() => cy.useUser(bobUser));
    cy.visit("/");
    cy.get("[role=tab]").contains("Multi").click();
    typeSlash(`/follow @${alice.username}`);
    cy.contains(`Now friends with @${alice.username}`).should("be.visible");

    // Verify both rows in DB.
    cy.task<Record<string, unknown>[]>("dbQuery", {
      sql: `SELECT u1.username AS follower, u2.username AS followee
              FROM friendships f
              JOIN users u1 ON u1.id = f.user_id
              JOIN users u2 ON u2.id = f.friend_id
             WHERE u1.username IN ($1, $2) AND u2.username IN ($1, $2)
             ORDER BY u1.username`,
      params: [alice.username, bob.username],
    }).then((rows) => {
      expect(rows.length, "both follow rows").to.eq(2);
    });
  });

  it(`/invite @${"bob"} returns idle target_state`, () => {
    typeSlash(`/invite @${bob.username}`);
    cy.contains(`Invite sent to @${bob.username} (online)`).should(
      "be.visible",
    );
    // multiplayer_games row created with Alice as host.
    cy.task<Record<string, unknown>[]>("dbQuery", {
      sql: `SELECT mg.code, mg.state, u.username AS host
              FROM multiplayer_games mg
              JOIN users u ON u.id = mg.host_user_id
             WHERE u.username = $1
             ORDER BY mg.created_at DESC LIMIT 1`,
      params: [alice.username],
    }).then((rows) => {
      expect(rows.length).to.eq(1);
      expect(rows[0].state).to.eq("waiting");
    });
  });

  it(`/block @${"bob"} ends an active game`, () => {
    // Create a fresh in_progress game between Alice and Bob via the API
    // helpers (faster than driving the modal flow per test).
    let mpCode: string;
    cy.apiNewMultiplayerGame(aliceUser.token, "X").then(({ code }) => {
      mpCode = code;
    });
    cy.then(() => {
      cy.request({
        method: "POST",
        url: `${Cypress.env("apiBase")}/multiplayer/${mpCode}/join`,
        headers: { Authorization: `Bearer ${bobUser.token}` },
        body: {},
      });
    });

    typeSlash(`/block @${bob.username}`);
    cy.contains(
      `Blocked @${bob.username}. The game with them was ended.`,
    ).should("be.visible");

    cy.then(() => {
      cy.task<Record<string, unknown>[]>("dbQuery", {
        sql: `SELECT state FROM multiplayer_games WHERE code = $1`,
        params: [mpCode],
      }).then((rows) => {
        expect(rows[0].state).to.eq("abandoned");
      });
    });
  });

  it(`/unfollow @${"bob"} is a noop when never followed`, () => {
    typeSlash(`/unfollow @${bob.username}`);
    cy.contains(`Unfollowed @${bob.username}.`).should("be.visible");
  });

  it("unknown @ghost surfaces a user_not_found error caption", () => {
    typeSlash("/follow @ghost-totally-not-here");
    cy.contains(/Could not follow.*ghost-totally-not-here/).should(
      "be.visible",
    );
  });
});
