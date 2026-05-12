/// <reference types="cypress" />

// Simpler companions to multiplayer.cy.ts that lock down the two recent
// product changes:
//
//   1. ChooseGameTypeModal opens with "Another Player" pre-selected, the
//      colour-chooser visible, and a host-issued invite URL/code already
//      filled in (no "click Start to generate" step).
//   2. Two users registered from one Cypress run, simulated as two
//      browsers via cy.useUser, can land in the in-game layout — board
//      on the right, ChatPanel in the left rail's "Multi" tab (the same
//      tabbed sidebar the home page uses).
//
// Each test cleans up its scratch users at the end so the suite can be
// re-run against the same DB without uniqueness collisions.

interface User {
  username: string
  password: string
  email: string
  token: string
}

function rand (): string {
  return Math.random().toString(36).slice(2, 10)
}

describe('New Multiplayer modal defaults to Another Player', () => {
  const suffix = rand()
  const alice = {
    username: `alice_dft_${suffix}`,
    password: 'cypress-test-pw',
    email: `alice_dft_${suffix}@example.com`,
  }
  let aliceUser: User

  after(() => {
    cy.task('dbCleanupUsers', [alice.username])
  })

  it('shows the human-vs-human form expanded with a ready-made invite link', () => {
    cy.apiSignup(alice.username, alice.password, alice.email).then(u => {
      aliceUser = u
    })
    cy.then(() => cy.useUser(aliceUser))
    cy.visit('/')

    // Click the "New Multiplayer Game" CTA — modal opens.
    cy.contains('button', /^New Multiplayer Game$/).click()

    // "Another Player" is the default radio.
    cy.contains('label', /^Another Player/)
      .find('input[type="radio"]')
      .should('be.checked')

    // The colour-chooser fieldset (only rendered for the human path) is
    // visible — i.e. the modal is already expanded.
    cy.contains('legend', /Who chooses the playing color\?/).should('be.visible')

    // The invite URL is auto-generated and shown in a read-only input
    // (CopyableLinkRow). Wait up to 10 s for the POST /multiplayer/new
    // round-trip to land.
    cy.get('input[readonly][value*="/play/"]', { timeout: 10000 })
      .invoke('val')
      .should('match', /\/play\/[A-Z2-9]{6}$/)

    // The bare 6-char code is also shown as a copyable row.
    cy.get('input[readonly]')
      .filter((_, el) => /^[A-Z2-9]{6}$/.test((el as HTMLInputElement).value))
      .should('have.length.at.least', 1)

    // The paste-opponent-code input is rendered alongside the host's link
    // so the user can either share OR accept a code from the same surface.
    cy.contains('label', /Got an invitation\?/).should('be.visible')
    cy.get('input[aria-label="Invitation code or link"]').should('be.visible')
  })
})

describe('Two-browser multiplayer smoke', () => {
  const suffix = rand()
  const alice = {
    username: `alice_smk_${suffix}`,
    password: 'cypress-test-pw',
    email: `alice_smk_${suffix}@example.com`,
  }
  const bob = {
    username: `bob_smk_${suffix}`,
    password: 'cypress-test-pw',
    email: `bob_smk_${suffix}@example.com`,
  }

  let aliceUser: User
  let bobUser: User
  let inviteCode: string

  after(() => {
    cy.task('dbCleanupUsers', [alice.username, bob.username])
  })

  it('two registrations land in the in-game layout with chat panel + board', () => {
    cy.apiSignup(alice.username, alice.password, alice.email).then(u => {
      aliceUser = u
    })
    cy.apiSignup(bob.username, bob.password, bob.email).then(u => {
      bobUser = u
    })

    // ---- Browser 1 (Alice): open modal, capture the auto-issued code. ---
    cy.then(() => cy.useUser(aliceUser))
    cy.visit('/')
    cy.contains('button', /^New Multiplayer Game$/).click()
    cy.get('input[readonly][value*="/play/"]', { timeout: 10000 })
      .invoke('val')
      .then(val => {
        const m = String(val).match(/\/play\/([A-Z2-9]{6})/)
        expect(m, `code in waiting URL: ${val}`).to.not.be.null
        inviteCode = (m as RegExpMatchArray)[1]
      })

    // ---- Browser 2 (Bob): visit /play/<code>, auto-join, see in-game UI. ----
    cy.then(() => cy.useUser(bobUser))
    cy.then(() => cy.visit(`/play/${inviteCode}`))

    // Header shows "alice vs bob" — both players present.
    cy.contains(`${alice.username} vs ${bob.username}`, { timeout: 15000 })
      .should('be.visible')

    // The ChatPanel in the left-rail "Multi" tab (auto-selected on
    // /play/<code>) has a header reading "Chat with @alice" from
    // Bob's perspective (peer = host).
    cy.contains(/Chat with/i).should('be.visible')
    cy.contains(`@${alice.username}`).should('be.visible')

    // The chat draft input is editable and accepts /help.
    cy.get('input[aria-label="Chat message"]').type('/help{enter}')
    cy.contains(/\/invite @user/).should('be.visible')

    // ---- Browser 1 (Alice) catches up — sees the same in-game layout. ---
    cy.then(() => cy.useUser(aliceUser))
    cy.then(() => cy.visit(`/play/${inviteCode}`))
    cy.contains(`${alice.username} vs ${bob.username}`, { timeout: 15000 })
      .should('be.visible')
    cy.contains(/Chat with/i).should('be.visible')
    cy.contains(`@${bob.username}`).should('be.visible')
  })
})
