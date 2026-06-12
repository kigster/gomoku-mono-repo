import { StrictMode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import ChooseGameTypeModal, {
  extractInviteCode,
} from "../components/ChooseGameTypeModal";

vi.mock("../lib/multiplayerClient", async () => {
  const actual = await vi.importActual<
    typeof import("../lib/multiplayerClient")
  >("../lib/multiplayerClient");
  return {
    ...actual,
    newGame: vi.fn(),
    cancelGame: vi.fn(),
    getGame: vi.fn(),
  };
});

vi.mock("../hooks/useMultiplayerHostPolling", () => ({
  useMultiplayerHostPolling: () => ({
    view: null,
    secondsWaited: 0,
    expired: false,
    error: null,
  }),
}));

import {
  newGame,
  cancelGame,
  type MultiplayerGameView,
} from "../lib/multiplayerClient";

const mockNewGame = newGame as unknown as ReturnType<typeof vi.fn>;
const mockCancelGame = cancelGame as unknown as ReturnType<typeof vi.fn>;

const FAKE_GAME: MultiplayerGameView = {
  code: "AB7K3X",
  state: "waiting",
  board_size: 15,
  rule_set: "freestyle",
  host: { username: "host", color: "X" },
  guest: null,
  moves: [],
  next_to_move: "X",
  winner: null,
  your_color: "X",
  your_turn: false,
  version: 0,
  color_chosen_by: "host",
  expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
  created_at: new Date().toISOString(),
  finished_at: null,
  invite_url: "http://localhost/play/AB7K3X",
};

function renderModal(
  handlers: Partial<{
    onAIChosen: () => void;
    onGuestJoined: (code: string) => void;
    onClose: () => void;
  }> = {},
) {
  return render(
    <ChooseGameTypeModal
      authToken="test-token"
      onAIChosen={handlers.onAIChosen ?? vi.fn()}
      onGuestJoined={handlers.onGuestJoined ?? vi.fn()}
      onClose={handlers.onClose ?? vi.fn()}
    />,
  );
}

describe("extractInviteCode", () => {
  it.each([
    ["AB7K3X", "AB7K3X"],
    ["ab7k3x", "AB7K3X"],
    ["  ab7k3x  ", "AB7K3X"],
    ["https://dev.gomoku.games/play/AB7K3X", "AB7K3X"],
    ["http://localhost:5173/play/ab7k3x", "AB7K3X"],
    ["/play/AB7K3X", "AB7K3X"],
    ["/play/AB7K3X?ref=foo", "AB7K3X"],
  ])("parses %s as %s", (input, expected) => {
    expect(extractInviteCode(input)).toBe(expected);
  });

  it.each([
    "",
    "   ",
    "AB7K3", // too short
    "AB7K3XX", // too long
    "AB1K3X", // contains '1' (excluded)
    "ABOK3X", // contains 'O' (excluded)
    "NOPE!!",
    "https://dev.gomoku.games/auth/signup",
  ])("rejects invalid input %s", (input) => {
    expect(extractInviteCode(input)).toBeNull();
  });
});

describe("ChooseGameTypeModal", () => {
  beforeEach(() => {
    // Full reset (not just clear) so that previous tests' Once-queues and
    // implementations don't leak into later tests' fresh setups.
    vi.resetAllMocks();
  });

  it("renders the title with Another Player selected by default and the form expanded", () => {
    mockNewGame.mockResolvedValue(FAKE_GAME);
    renderModal();
    expect(screen.getByText("Choose Game Type")).toBeInTheDocument();
    const ai = screen.getByLabelText(/AI/i, { selector: "input" });
    const human = screen.getByLabelText(/Another Player/i, {
      selector: "input",
    });
    expect(human).toBeChecked();
    expect(ai).not.toBeChecked();
    // Default is human → sub-questions and the join-by-code section are
    // visible without any extra click.
    expect(
      screen.getByText(/Who chooses the playing color/),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText(/Invitation code or link/i),
    ).toBeInTheDocument();
  });

  it("reveals the color-chooser sub-radios when Another Player is picked", async () => {
    const user = userEvent.setup();
    renderModal();
    await user.click(
      screen.getByLabelText(/Another Player/i, { selector: "input" }),
    );
    expect(
      screen.getByText(/Who chooses the playing color/),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText(/I will choose/i, { selector: "input" }),
    ).toBeChecked();
    // X/O choices show because "I will choose" is the default.
    expect(screen.getByText(/Your color/)).toBeInTheDocument();
  });

  it("hides X/O choices when Opponent will choose is selected", async () => {
    const user = userEvent.setup();
    renderModal();
    await user.click(
      screen.getByLabelText(/Another Player/i, { selector: "input" }),
    );
    await user.click(
      screen.getByLabelText(/Opponent will choose/i, { selector: "input" }),
    );
    expect(screen.queryByText(/Your color/)).toBeNull();
  });

  it("switching to AI then Start fires onAIChosen and cancels the auto-issued invite", async () => {
    const user = userEvent.setup();
    const onAIChosen = vi.fn();
    mockNewGame.mockResolvedValue(FAKE_GAME);
    mockCancelGame.mockResolvedValue({ ...FAKE_GAME, state: "cancelled" });
    renderModal({ onAIChosen });
    // Modal mounts with "Another Player" → POST fires once on mount.
    await waitFor(() => expect(mockNewGame).toHaveBeenCalledTimes(1));
    // Wait for setGame(FAKE_GAME) to commit so the cancel branch in the
    // toggle handler has a code to cancel.
    await screen.findByDisplayValue(FAKE_GAME.invite_url);
    // Flip to AI: the auto-issued invite is cancelled; Start dispatches AI.
    await user.click(screen.getByLabelText(/AI/i, { selector: "input" }));
    await waitFor(() =>
      expect(mockCancelGame).toHaveBeenCalledWith("test-token", FAKE_GAME.code),
    );
    await user.click(screen.getByRole("button", { name: /^Start$/ }));
    expect(onAIChosen).toHaveBeenCalledTimes(1);
  });

  it("picking Another Player auto-POSTs /multiplayer/new and shows the invite link", async () => {
    const user = userEvent.setup();
    mockNewGame.mockResolvedValueOnce(FAKE_GAME);
    renderModal();

    await user.click(
      screen.getByLabelText(/Another Player/i, { selector: "input" }),
    );

    await waitFor(() => {
      expect(mockNewGame).toHaveBeenCalledWith("test-token", {
        host_color: "X",
      });
    });
    await waitFor(() => {
      expect(
        screen.getByText(/Waiting for your opponent to join/),
      ).toBeInTheDocument();
    });
    expect(screen.getByDisplayValue(FAKE_GAME.invite_url)).toBeInTheDocument();
  });

  it("Opponent-chooses sends host_color: null", async () => {
    const user = userEvent.setup();
    mockNewGame
      // Initial auto-create with host_color='X'.
      .mockResolvedValueOnce(FAKE_GAME)
      // Re-create after switching to "Opponent will choose".
      .mockResolvedValueOnce({
        ...FAKE_GAME,
        color_chosen_by: "guest",
        host: { ...FAKE_GAME.host, color: null },
        your_color: null,
      });
    mockCancelGame.mockResolvedValue({ ...FAKE_GAME, state: "cancelled" });
    renderModal();
    await user.click(
      screen.getByLabelText(/Another Player/i, { selector: "input" }),
    );
    await waitFor(() => expect(mockNewGame).toHaveBeenCalledTimes(1));
    await user.click(
      screen.getByLabelText(/Opponent will choose/i, { selector: "input" }),
    );
    await waitFor(() => {
      expect(mockNewGame).toHaveBeenLastCalledWith("test-token", {
        host_color: null,
      });
    });
  });

  it("closing in waiting state calls /cancel and onClose", async () => {
    const user = userEvent.setup();
    mockNewGame.mockResolvedValueOnce(FAKE_GAME);
    mockCancelGame.mockResolvedValueOnce({ ...FAKE_GAME, state: "cancelled" });
    const onClose = vi.fn();
    renderModal({ onClose });

    await user.click(
      screen.getByLabelText(/Another Player/i, { selector: "input" }),
    );
    await waitFor(() =>
      expect(
        screen.getByText(/Waiting for your opponent to join/),
      ).toBeInTheDocument(),
    );

    // ModalShell's close button has aria-label "Close" (via ModalCloseButton).
    const closeButton = screen.getByLabelText(/close/i);
    await user.click(closeButton);

    await waitFor(() => {
      expect(mockCancelGame).toHaveBeenCalledWith("test-token", FAKE_GAME.code);
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("shows the join-by-code section by default; hides it when AI is picked", async () => {
    const user = userEvent.setup();
    mockNewGame.mockResolvedValue(FAKE_GAME);
    mockCancelGame.mockResolvedValue({ ...FAKE_GAME, state: "cancelled" });
    renderModal();
    // Default = Another Player → join-by-code section is mounted.
    expect(
      screen.getByLabelText(/Invitation code or link/i),
    ).toBeInTheDocument();
    // Wait for the auto-create POST to settle before flipping to AI so the
    // toggle handler's "cancel previous invite" branch has a code to cancel.
    await waitFor(() => expect(mockNewGame).toHaveBeenCalledTimes(1));
    // Flip to AI → join-by-code section is unmounted.
    await user.click(screen.getByLabelText(/AI/i, { selector: "input" }));
    await waitFor(() =>
      expect(screen.queryByLabelText(/Invitation code or link/i)).toBeNull(),
    );
  });

  it("joining via pasted bare code calls onGuestJoined with the code", async () => {
    const user = userEvent.setup();
    const onGuestJoined = vi.fn();
    mockNewGame.mockResolvedValue(FAKE_GAME);
    mockCancelGame.mockResolvedValue({ ...FAKE_GAME, state: "cancelled" });
    renderModal({ onGuestJoined });
    // Wait for the auto-create to settle so the input is enabled
    // (`disabled={creating}` on JoinByCodeSection).
    await waitFor(() => expect(mockNewGame).toHaveBeenCalledTimes(1));
    const input = await screen.findByLabelText(/Invitation code or link/i);
    await waitFor(() => expect(input).not.toBeDisabled());
    // Pick a code that differs from FAKE_GAME.code — otherwise the
    // self-paste guard rejects with "That's your own invitation".
    await user.type(input, "CD9P4Y");
    await user.click(screen.getByRole("button", { name: "Join" }));
    await waitFor(() => expect(onGuestJoined).toHaveBeenCalledWith("CD9P4Y"));
  });

  it("joining via a full /play URL extracts and uppercases the code", async () => {
    const user = userEvent.setup();
    const onGuestJoined = vi.fn();
    mockNewGame.mockResolvedValue(FAKE_GAME);
    mockCancelGame.mockResolvedValue({ ...FAKE_GAME, state: "cancelled" });
    renderModal({ onGuestJoined });
    await waitFor(() => expect(mockNewGame).toHaveBeenCalledTimes(1));
    const input = await screen.findByLabelText(/Invitation code or link/i);
    await waitFor(() => expect(input).not.toBeDisabled());
    await user.type(input, "https://dev.gomoku.games/play/abcdef");
    await user.click(screen.getByRole("button", { name: "Join" }));
    await waitFor(() => expect(onGuestJoined).toHaveBeenCalledWith("ABCDEF"));
  });

  it("rejects garbage input with an inline error", async () => {
    const user = userEvent.setup();
    const onGuestJoined = vi.fn();
    mockNewGame.mockResolvedValue(FAKE_GAME);
    renderModal({ onGuestJoined });
    await waitFor(() => expect(mockNewGame).toHaveBeenCalledTimes(1));
    const input = await screen.findByLabelText(/Invitation code or link/i);
    await waitFor(() => expect(input).not.toBeDisabled());
    await user.type(input, "NOPE!!");
    await user.click(screen.getByRole("button", { name: "Join" }));
    expect(onGuestJoined).not.toHaveBeenCalled();
    expect(screen.getByText(/Enter a 6-character code/)).toBeInTheDocument();
  });

  it("shows an inline error when newGame fails", async () => {
    const user = userEvent.setup();
    mockNewGame.mockRejectedValueOnce(new Error("Network down"));
    renderModal();
    await user.click(
      screen.getByLabelText(/Another Player/i, { selector: "input" }),
    );
    expect(await screen.findByText("Network down")).toBeInTheDocument();
  });

  // Regression guard for the StrictMode mount/unmount/remount hang (the bug
  // this component's auto-create effect was reworked to fix). Under StrictMode
  // the effect runs, is torn down, then runs again. The first run's create
  // must be discarded-and-cancelled (so it doesn't leak a waiting row) while
  // the remount recreates a fresh invite — instead of early-returning on a
  // stale ref and hanging forever on "Generating your invitation link…".
  it("under StrictMode, recreates the invite and cancels the orphaned game", async () => {
    const firstGame: MultiplayerGameView = {
      ...FAKE_GAME,
      code: "FIRST2",
      invite_url: "http://localhost/play/FIRST2",
    };
    const secondGame: MultiplayerGameView = {
      ...FAKE_GAME,
      code: "SECND3",
      invite_url: "http://localhost/play/SECND3",
    };
    mockNewGame
      .mockResolvedValueOnce(firstGame)
      .mockResolvedValueOnce(secondGame);
    mockCancelGame.mockResolvedValue({ ...FAKE_GAME, state: "cancelled" });

    render(
      <StrictMode>
        <ChooseGameTypeModal
          authToken="test-token"
          onAIChosen={vi.fn()}
          onGuestJoined={vi.fn()}
          onClose={vi.fn()}
        />
      </StrictMode>,
    );

    // The double-invoked effect issues two creates: the discarded first run
    // and the committed remount.
    await waitFor(() => expect(mockNewGame).toHaveBeenCalledTimes(2));
    // The remount's invite link is shown — proof the modal did NOT hang.
    expect(
      await screen.findByDisplayValue(secondGame.invite_url),
    ).toBeInTheDocument();
    // The orphaned first game is actively cancelled, not leaked.
    await waitFor(() =>
      expect(mockCancelGame).toHaveBeenCalledWith("test-token", firstGame.code),
    );
  });
});
