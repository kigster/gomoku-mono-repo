import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import AlertPanel, {
  showError,
  showInfo,
  showWarning,
} from "../components/AlertPanel";

describe("AlertPanel", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  it("renders nothing initially", () => {
    const { container } = render(<AlertPanel />);
    expect(container.querySelectorAll("[role]")).toHaveLength(0);
  });

  it("shows an error alert when showError is called", () => {
    render(<AlertPanel />);
    act(() => showError("Something broke"));
    expect(screen.getByText("Something broke")).toBeInTheDocument();
  });

  it("shows an info alert when showInfo is called", () => {
    render(<AlertPanel />);
    act(() => showInfo("Game saved"));
    expect(screen.getByText("Game saved")).toBeInTheDocument();
  });

  it("shows a warning alert when showWarning is called", () => {
    render(<AlertPanel />);
    act(() => showWarning("Watch out"));
    expect(screen.getByText("Watch out")).toBeInTheDocument();
  });

  it("shows multiple alerts simultaneously", () => {
    render(<AlertPanel />);
    act(() => {
      showError("Error 1");
      showInfo("Info 1");
      showError("Error 2");
    });
    expect(screen.getByText("Error 1")).toBeInTheDocument();
    expect(screen.getByText("Info 1")).toBeInTheDocument();
    expect(screen.getByText("Error 2")).toBeInTheDocument();
  });

  it("auto-dismisses info alerts after 5s + 1s fade-out", () => {
    render(<AlertPanel />);
    act(() => showInfo("Temporary"));
    expect(screen.getByText("Temporary")).toBeInTheDocument();

    // Still in DOM during fade-out (5s auto-dismiss + fading)
    act(() => {
      vi.advanceTimersByTime(5500);
    });
    expect(screen.getByText("Temporary")).toBeInTheDocument();

    // Removed after 1s fade completes
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(screen.queryByText("Temporary")).not.toBeInTheDocument();
  });

  it("auto-dismisses error alerts after 8s + 1s fade-out", () => {
    render(<AlertPanel />);
    act(() => showError("Persistent error"));
    expect(screen.getByText("Persistent error")).toBeInTheDocument();

    // Still present after 5s
    act(() => {
      vi.advanceTimersByTime(5100);
    });
    expect(screen.getByText("Persistent error")).toBeInTheDocument();

    // Still in DOM during fade-out
    act(() => {
      vi.advanceTimersByTime(3400);
    });
    expect(screen.getByText("Persistent error")).toBeInTheDocument();

    // Removed after fade completes
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(screen.queryByText("Persistent error")).not.toBeInTheDocument();
  });

  it("dismisses alert when [x] is clicked", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<AlertPanel />);
    act(() => {
      showInfo("Dismissable");
      vi.advanceTimersByTime(20);
    });
    expect(screen.getByText("Dismissable")).toBeInTheDocument();

    await user.click(screen.getByLabelText("Dismiss"));

    // Still fading
    expect(screen.getByText("Dismissable")).toBeInTheDocument();

    // Gone after 1s fade
    act(() => {
      vi.advanceTimersByTime(1100);
    });
    expect(screen.queryByText("Dismissable")).not.toBeInTheDocument();
  });

  it("does not render a detail expansion control", () => {
    render(<AlertPanel />);
    act(() => {
      showError("Has detail", "Stack trace here");
      showError("No detail");
      showInfo("Info msg");
    });
    expect(screen.queryByLabelText("More info")).not.toBeInTheDocument();
  });

  it("does not render hidden error detail text", () => {
    render(<AlertPanel />);
    act(() => {
      showError("Oops", "Detailed stack trace here");
      vi.advanceTimersByTime(20);
    });

    expect(screen.getByText("Oops")).toBeInTheDocument();
    expect(
      screen.queryByText("Detailed stack trace here"),
    ).not.toBeInTheDocument();
  });
});
