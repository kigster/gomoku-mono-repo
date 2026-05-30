import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import LeaderboardModal from "../components/LeaderboardModal";

const mockOnClose = vi.fn();

const sampleEntries = [
  {
    username: "GrandMaster",
    elo_rating: 2210,
    elo_games_count: 42,
    score: 6500,
    rating: 89.7,
    depth: 6,
    radius: 4,
    total_moves: 35,
    human_time_s: 45.2,
    geo_country: "Japan",
    geo_city: "Tokyo",
    played_at: "2026-03-30T12:00:00Z",
  },
  {
    username: "Beginner",
    elo_rating: 1517,
    elo_games_count: 3,
    score: 1200,
    rating: 16.6,
    depth: 1,
    radius: 1,
    total_moves: 20,
    human_time_s: 10.0,
    geo_country: null,
    geo_city: null,
    played_at: "2026-03-29T08:00:00Z",
  },
];

describe("LeaderboardModal", () => {
  beforeEach(() => {
    mockOnClose.mockReset();
    vi.restoreAllMocks();
  });

  it("shows loading state initially", () => {
    vi.spyOn(globalThis, "fetch").mockReturnValue(new Promise(() => {}));
    render(<LeaderboardModal apiBase="" onClose={mockOnClose} />);
    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("renders leaderboard entries", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ entries: sampleEntries }),
    } as Response);

    render(<LeaderboardModal apiBase="" onClose={mockOnClose} />);

    await waitFor(() => {
      expect(screen.getByText("GrandMaster")).toBeInTheDocument();
      expect(screen.getByText("Beginner")).toBeInTheDocument();
    });
    expect(screen.getByText("2210")).toBeInTheDocument();
    expect(screen.getByText("1517")).toBeInTheDocument();
  });

  it("shows empty state when no entries", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ entries: [] }),
    } as Response);

    render(<LeaderboardModal apiBase="" onClose={mockOnClose} />);

    await waitFor(() => {
      expect(screen.getByText(/No scores yet/)).toBeInTheDocument();
    });
  });

  it("shows error state on fetch failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: false,
    } as Response);

    render(<LeaderboardModal apiBase="" onClose={mockOnClose} />);

    await waitFor(() => {
      expect(screen.getByText(/Failed to load/)).toBeInTheDocument();
    });
  });

  it("calls onClose when X button clicked", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ entries: [] }),
    } as Response);

    render(<LeaderboardModal apiBase="" onClose={mockOnClose} />);
    await user.click(screen.getByLabelText("Close"));
    expect(mockOnClose).toHaveBeenCalledOnce();
  });
});
