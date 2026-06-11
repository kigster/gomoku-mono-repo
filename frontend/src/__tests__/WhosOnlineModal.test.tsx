import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import WhosOnlineModal, {
  filterOnlineUsers,
  type OnlineUser,
} from "../components/WhosOnlineModal";

// Minimal OnlineUser factory — only the fields a test cares about need
// overriding; the rest default to a plain idle, unrelated user.
function mkUser(over: Partial<OnlineUser> & { username: string }): OnlineUser {
  return {
    user_id: over.username,
    state: "idle",
    active_game_id: null,
    opponent_username: null,
    last_seen_at: "2026-06-10T12:00:00.000Z",
    elo_rating: 1500,
    session_started_at: "2026-06-10T11:00:00.000Z",
    is_friend: false,
    is_follower: false,
    is_following: false,
    is_blocked: false,
    is_champion: false,
    ...over,
  };
}

describe("filterOnlineUsers", () => {
  const callerElo = 1500;
  const self = "alice";
  const users: OnlineUser[] = [
    mkUser({ username: "alice", elo_rating: 1500 }), // self — always dropped
    mkUser({ username: "bob", elo_rating: 1550, last_seen_at: "2026-06-10T12:00:09.000Z" }),
    mkUser({ username: "carol", elo_rating: 1900 }), // outside ±250
    mkUser({ username: "dave", state: "human-battle" }), // playing
    mkUser({
      username: "erin",
      is_friend: true,
      is_follower: true,
      last_seen_at: "2026-06-10T12:00:05.000Z",
    }),
    mkUser({ username: "frank", is_follower: true, last_seen_at: "2026-06-10T12:00:01.000Z" }),
    mkUser({ username: "grace", is_blocked: true }),
  ];

  const names = (us: OnlineUser[]) => us.map((u) => u.username);

  it("always excludes the caller", () => {
    for (const f of ["available", "unavailable", "friends", "followers", "blocked"] as const) {
      expect(names(filterOnlineUsers(users, f, callerElo, self))).not.toContain("alice");
    }
  });

  it("available = not playing, not blocked, within ±250 Elo", () => {
    const got = names(filterOnlineUsers(users, "available", callerElo, self));
    expect(got).toEqual(expect.arrayContaining(["bob", "erin", "frank"]));
    expect(got).not.toContain("carol"); // 400 Elo away
    expect(got).not.toContain("dave"); // playing
    expect(got).not.toContain("grace"); // blocked
  });

  it("sorts by recency (newest last_seen_at first)", () => {
    // bob 12:00:09 > erin 12:00:05 > frank 12:00:01
    expect(names(filterOnlineUsers(users, "available", callerElo, self))).toEqual([
      "bob",
      "erin",
      "frank",
    ]);
  });

  it("unavailable = playing OR idle", () => {
    const got = names(filterOnlineUsers(users, "unavailable", callerElo, self));
    expect(got).toContain("dave"); // playing
    expect(got).toContain("bob"); // idle
  });

  it("friends = mutual follow only", () => {
    expect(names(filterOnlineUsers(users, "friends", callerElo, self))).toEqual(["erin"]);
  });

  it("followers = anyone who follows the caller", () => {
    const got = names(filterOnlineUsers(users, "followers", callerElo, self));
    expect(got).toEqual(expect.arrayContaining(["erin", "frank"]));
    expect(got).not.toContain("bob");
  });

  it("blocked = users the caller blocked", () => {
    expect(names(filterOnlineUsers(users, "blocked", callerElo, self))).toEqual(["grace"]);
  });
});

describe("WhosOnlineModal render", () => {
  beforeEach(() => {
    vi.spyOn(global, "fetch").mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            caller_elo: 1500,
            users: [
              { ...mkUser({ username: "alice" }) }, // self, dropped
              {
                ...mkUser({
                  username: "champ",
                  is_champion: true,
                  last_seen_at: "2026-06-10T12:00:09.000Z",
                }),
              },
              { ...mkUser({ username: "erin", is_friend: true, is_follower: true }) },
              { ...mkUser({ username: "carol", elo_rating: 1900 }) }, // outside band
              { ...mkUser({ username: "dave", state: "ai-battle" }) }, // playing
              { ...mkUser({ username: "grace", is_blocked: true }) },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
  });
  afterEach(() => vi.restoreAllMocks());

  function renderModal() {
    return render(
      <WhosOnlineModal
        apiBase="http://api.test"
        authToken="t"
        currentUsername="alice"
        onClose={() => {}}
      />,
    );
  }

  it("shows the champion crown and a friend's green row, hides off-band users", async () => {
    renderModal();
    // Default filter is "available": champ + erin qualify; carol (band)
    // and dave (playing) and grace (blocked) do not.
    await waitFor(() => expect(screen.getByText("champ")).toBeInTheDocument());
    expect(screen.getByText("erin")).toBeInTheDocument();
    expect(screen.queryByText("carol")).toBeNull();
    expect(screen.queryByText("dave")).toBeNull();

    // Champion crown.
    expect(screen.getByAltText("Champion")).toBeInTheDocument();

    // Friend row paints dark green (#14532d → rgb(20, 83, 45)).
    const erinRow = screen.getByText("erin").closest("tr")!;
    expect(erinRow.style.backgroundColor).toBe("rgb(20, 83, 45)");
  });

  it("switches filters via the dropdown — blocked rows are dark red, playing shows the indicator", async () => {
    const user = userEvent.setup();
    renderModal();
    await waitFor(() => expect(screen.getByText("champ")).toBeInTheDocument());

    // Blocked filter → grace, dark red (#450a0a → rgb(69, 10, 10)).
    await user.click(screen.getByRole("button", { name: /filter/i }));
    await user.click(screen.getByRole("option", { name: /users i blocked/i }));
    await waitFor(() => expect(screen.getByText("grace")).toBeInTheDocument());
    const graceRow = screen.getByText("grace").closest("tr")!;
    expect(graceRow.style.backgroundColor).toBe("rgb(69, 10, 10)");

    // Unavailable filter → dave is playing, shown via the indicator.
    await user.click(screen.getByRole("button", { name: /filter/i }));
    await user.click(screen.getByRole("option", { name: /unavailable/i }));
    await waitFor(() => expect(screen.getByText("dave")).toBeInTheDocument());
    const daveRow = screen.getByText("dave").closest("tr")!;
    expect(within(daveRow).getByRole("img", { name: /in a game/i })).toBeInTheDocument();
  });
});
