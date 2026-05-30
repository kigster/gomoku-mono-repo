/// <reference types="cypress" />

// ---------------------------------------------------------------------------
// Cypress only drives one browser context at a time, so the "two incognito
// browsers" requirement is simulated by swapping sessionStorage between the
// two users via `cy.useUser(...)`. Each call clears local state, writes the
// other user's auth token, and the next `cy.visit(...)` lands on the page
// authenticated as that user — the same effect as opening a second incognito
// window.
//
// (The React app reads `gomoku_username` / `gomoku_auth_token` from
// sessionStorage, not localStorage — see frontend/src/App.tsx.)
// ---------------------------------------------------------------------------

interface AuthedUser {
  username: string;
  password: string;
  email: string;
  token: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Cypress {
    interface Chainable {
      apiSignup(
        username: string,
        password: string,
        email: string,
      ): Chainable<AuthedUser>;
      useUser(user: AuthedUser): Chainable<void>;
      placeStone(boardSize: 15 | 19, row: number, col: number): Chainable<void>;
      apiNewMultiplayerGame(
        token: string,
        hostColor: "X" | "O",
      ): Chainable<{ code: string }>;
    }
  }
}

const STORAGE_KEY = "gomoku_username";
const TOKEN_KEY = "gomoku_auth_token";

Cypress.Commands.add("apiSignup", (username, password, email) => {
  const apiBase = Cypress.env("apiBase") as string;
  return cy
    .request({
      method: "POST",
      url: `${apiBase}/auth/signup`,
      body: { username, password, email },
      failOnStatusCode: true,
    })
    .then((resp) => {
      expect(resp.status, "signup status").to.eq(200);
      const token = resp.body.access_token as string;
      expect(token, "access_token").to.be.a("string").and.not.be.empty;
      return { username, password, email, token };
    });
});

Cypress.Commands.add("useUser", (user) => {
  // Drop everything left over from the previous user. The auth keys live in
  // sessionStorage (per-tab), so we have to seed them on a *post-visit*
  // window. To make `cy.useUser` ergonomic, we stash the user on the
  // current Cypress runtime and write the keys via Cypress.on('window:before:load').
  cy.clearAllCookies();
  cy.clearAllLocalStorage();
  cy.clearAllSessionStorage();
  (Cypress as unknown as { __nextUser?: AuthedUser }).__nextUser = user;
});

// Seed sessionStorage on every page load so the App.tsx mount sees the
// stashed user and skips the AuthModal. Runs in the spec context — the
// stashed user is reset by the next `cy.useUser` call.
Cypress.on("window:before:load", (win) => {
  const u = (Cypress as unknown as { __nextUser?: AuthedUser }).__nextUser;
  if (!u) return;
  win.sessionStorage.setItem(TOKEN_KEY, u.token);
  win.sessionStorage.setItem(STORAGE_KEY, u.username);
});

Cypress.Commands.add("apiNewMultiplayerGame", (token, hostColor) => {
  const apiBase = Cypress.env("apiBase") as string;
  return cy
    .request({
      method: "POST",
      url: `${apiBase}/multiplayer/new`,
      headers: { Authorization: `Bearer ${token}` },
      body: { host_color: hostColor, board_size: 15 },
    })
    .then((resp) => {
      expect(resp.status, "new mp game status").to.eq(200);
      return { code: resp.body.code as string };
    });
});

// Click a board intersection. The Board component is one big <svg> with
// pixel-coordinate hit detection (see frontend/src/components/Board.tsx),
// so we measure the rendered rect and dispatch a click at the right offset.
Cypress.Commands.add("placeStone", (boardSize, row, col) => {
  // Must mirror constants.ts BOARD_PX (600) and Board.tsx PADDING (24).
  const BOARD_PX = 600;
  const PADDING = 24;
  const cellSize = (BOARD_PX - 2 * PADDING) / (boardSize - 1);
  cy.get('[data-testid="board-svg"]').then(($svg) => {
    const rect = ($svg[0] as SVGSVGElement).getBoundingClientRect();
    const scaleX = rect.width / BOARD_PX;
    const scaleY = rect.height / BOARD_PX;
    const x = (PADDING + col * cellSize) * scaleX;
    const y = (PADDING + row * cellSize) * scaleY;
    cy.wrap($svg).click(x, y);
  });
});

export {};
