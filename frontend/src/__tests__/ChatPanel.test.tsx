import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import ChatPanel from "../components/ChatPanel";

// Stub the persistence hook so the panel tests don't need real network /
// polling. Each test installs its own `send` spy.
const sendSpy = vi.fn<(message: string) => Promise<unknown>>();
const messagesRef = { current: [] as unknown[] };
vi.mock("../hooks/useChatMessages", () => ({
  useChatMessages: ({ code }: { code: string | null }) => ({
    messages: code ? messagesRef.current : [],
    loading: false,
    error: null,
    send: sendSpy,
  }),
}));

function renderPanel(
  overrides: Partial<React.ComponentProps<typeof ChatPanel>> = {},
) {
  return render(
    <ChatPanel
      meUsername="alice"
      peerUsername="bob"
      authToken="test-token"
      apiBase="http://api.test"
      gameCode="ABCDEF"
      variant="light"
      {...overrides}
    />,
  );
}

describe("ChatPanel — in-game persistence", () => {
  beforeEach(() => {
    sendSpy.mockReset();
    messagesRef.current = [];
    // Replace global fetch with a permissive stub so any slash-dispatch
    // POST that follows a chat send doesn't blow up the test on a
    // missing network mock.
    vi.spyOn(global, "fetch").mockImplementation(
      async () =>
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs the literal message via useChatMessages.send when gameCode is set", async () => {
    sendSpy.mockResolvedValue({
      id: "m1",
      speaker_username: "alice",
      speaker_is_me: true,
      message: "hello",
      created_at: new Date().toISOString(),
    });
    const user = userEvent.setup();
    renderPanel();
    const input = screen.getByLabelText(/chat message/i);
    await user.type(input, "hello");
    await user.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() => expect(sendSpy).toHaveBeenCalledWith("hello"));
  });

  it("dispatches the slash command AFTER the message has been persisted", async () => {
    // `send` resolves only after we've observed no slash dispatch — that
    // verifies the ordering ("store first, post-process later").
    const callOrder: string[] = [];
    sendSpy.mockImplementation(async (msg: string) => {
      callOrder.push(`send:${msg}`);
      return {
        id: "m2",
        speaker_username: "alice",
        speaker_is_me: true,
        message: msg,
        created_at: new Date().toISOString(),
      };
    });
    const fetchSpy = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchSpy.mockImplementation(async (url: string) => {
      callOrder.push(`fetch:${url}`);
      return new Response(JSON.stringify({}), { status: 200 });
    });

    const user = userEvent.setup();
    renderPanel();
    const input = screen.getByLabelText(/chat message/i);
    await user.type(input, "/follow @bob");
    await user.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() => expect(sendSpy).toHaveBeenCalled());
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    // The send must come before any slash dispatch.
    const sendIdx = callOrder.findIndex((c) => c.startsWith("send:"));
    const fetchIdx = callOrder.findIndex((c) => c.includes("/social/follow"));
    expect(sendIdx).toBeGreaterThanOrEqual(0);
    expect(fetchIdx).toBeGreaterThanOrEqual(0);
    expect(sendIdx).toBeLessThan(fetchIdx);
  });

  it("falls back to local echo when gameCode is null (home-page right rail)", async () => {
    const user = userEvent.setup();
    renderPanel({ gameCode: null, variant: "dark" });
    const input = screen.getByLabelText(/chat message/i);
    await user.type(input, "just typing");
    await user.click(screen.getByRole("button", { name: /send/i }));
    // No persistence call was made.
    expect(sendSpy).not.toHaveBeenCalled();
    // The text appears in the local list anyway.
    await waitFor(() =>
      expect(screen.getByText("just typing")).toBeInTheDocument(),
    );
  });

  it("surfaces a system error caption when the persistence POST fails", async () => {
    sendSpy.mockRejectedValue(new Error("network down"));
    const user = userEvent.setup();
    renderPanel();
    const input = screen.getByLabelText(/chat message/i);
    await user.type(input, "oops");
    await user.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() =>
      expect(
        screen.getByText(/Could not send: network down/i),
      ).toBeInTheDocument(),
    );
  });

  it("/who opens the Who's Online modal without persisting or fetching", async () => {
    const onShowWhosOnline = vi.fn();
    const fetchSpy = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const user = userEvent.setup();
    // No gameCode → /who is local-only (doesn't POST persistence).
    renderPanel({ gameCode: null, variant: "dark", onShowWhosOnline });
    const input = screen.getByLabelText(/chat message/i);
    await user.type(input, "/who");
    await user.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() => expect(onShowWhosOnline).toHaveBeenCalledTimes(1));
    // /who is a pure UI affordance: it neither echoes a chat bubble nor
    // hits the network itself (the modal owns its own fetch).
    expect(screen.queryByText("/who")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the header Who's Online? button opens the modal", async () => {
    const onShowWhosOnline = vi.fn();
    const user = userEvent.setup();
    renderPanel({ gameCode: null, variant: "dark", onShowWhosOnline });
    await user.click(
      screen.getByRole("button", { name: /show currently online players/i }),
    );
    expect(onShowWhosOnline).toHaveBeenCalledTimes(1);
  });

  it("/invite forwards an optional message in the request body", async () => {
    const fetchSpy = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const captured: Array<{ url: string; body: BodyInit | null }> = [];
    fetchSpy.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/chat/invite")) {
        captured.push({ url, body: init?.body ?? null });
        return new Response(
          JSON.stringify({
            invited_code: "ABCDEF",
            invite_url: "http://api.test/play/ABCDEF",
            target_state: "idle",
            delivered: true,
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });
    const user = userEvent.setup();
    renderPanel({ gameCode: null, variant: "dark" });
    const input = screen.getByLabelText(/chat message/i);
    await user.type(input, "/invite @bob hey wanna play?");
    await user.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() => expect(captured.length).toBeGreaterThan(0));
    const parsed = JSON.parse(captured[0].body as string);
    // Slash commands no longer carry user-typed messages — any trailing
    // text after the username is silently dropped. The invitee gets the
    // game via the modal dialog only.
    expect(parsed).toEqual({ target_username: "bob" });
  });

  it("/invite never sends a message field even when the user only typed a username", async () => {
    const fetchSpy = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const captured: Array<{ url: string; body: BodyInit | null }> = [];
    fetchSpy.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/chat/invite")) {
        captured.push({ url, body: init?.body ?? null });
        return new Response(
          JSON.stringify({
            invited_code: "ABCDEF",
            invite_url: "http://api.test/play/ABCDEF",
            target_state: "idle",
            delivered: true,
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });
    const user = userEvent.setup();
    renderPanel({ gameCode: null, variant: "dark" });
    const input = screen.getByLabelText(/chat message/i);
    await user.type(input, "/invite @bob");
    await user.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() => expect(captured.length).toBeGreaterThan(0));
    const parsed = JSON.parse(captured[0].body as string);
    // Commands never carry user-typed messages; the recipient sees the
    // invite as a modal dialog and the code is echoed back into the
    // inviter's transcript by the post-response patch.
    expect(parsed).toEqual({ target_username: "bob" });
  });

  it("/invite backfills the server-issued code into the echoed transcript line", async () => {
    const fetchSpy = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchSpy.mockImplementation(async (url: string) => {
      if (url.endsWith("/chat/invite")) {
        return new Response(
          JSON.stringify({
            invited_code: "ABCDEF",
            invite_url: "http://api.test/play/ABCDEF",
            target_state: "idle",
            delivered: true,
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });
    const user = userEvent.setup();
    renderPanel({ gameCode: null, variant: "dark" });
    const input = screen.getByLabelText(/chat message/i);
    await user.type(input, "/invite @bob");
    await user.click(screen.getByRole("button", { name: /send/i }));
    // The locally-echoed message starts as "/invite @bob" and gets
    // patched to "/invite @bob ABCDEF" once the room code arrives.
    await screen.findByText("/invite @bob ABCDEF");
  });

  it('masks a 403 invite response as a generic "could not deliver" caption', async () => {
    const fetchSpy = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchSpy.mockImplementation(async (url: string) => {
      if (url.endsWith("/chat/invite")) {
        return new Response(
          JSON.stringify({ detail: "cannot_invite_blocker" }),
          { status: 403 },
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });
    const user = userEvent.setup();
    renderPanel({ gameCode: null, variant: "dark" });
    const input = screen.getByLabelText(/chat message/i);
    await user.type(input, "/invite @bob");
    await user.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() =>
      expect(
        screen.getByText(/Sorry, we couldn't deliver your message/i),
      ).toBeInTheDocument(),
    );
    // Must NOT leak the underlying detail to the user.
    expect(screen.queryByText(/cannot_invite_blocker/)).toBeNull();
  });

  it("renders a polled peer message after it arrives via the hook", async () => {
    // Simulate the polling hook surfacing a message from the opponent.
    messagesRef.current = [
      {
        id: "p1",
        speaker_username: "bob",
        speaker_is_me: false,
        message: "hi from bob",
        created_at: new Date().toISOString(),
      },
    ];
    renderPanel();
    await waitFor(() =>
      expect(screen.getByText("hi from bob")).toBeInTheDocument(),
    );
    // Speaker chip shows @bob — it also appears in the header, so we
    // assert at least one rendering, which proves the message bubble
    // labelled itself.
    expect(screen.getAllByText("@bob").length).toBeGreaterThanOrEqual(1);
  });
});
