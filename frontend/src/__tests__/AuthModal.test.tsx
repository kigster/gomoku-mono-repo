import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import AuthModal from "../components/AuthModal";
import AlertPanel from "../components/AlertPanel";

const mockOnAuth = vi.fn();

function renderAuth(props = {}) {
  return render(
    <>
      <AlertPanel />
      <AuthModal onAuth={mockOnAuth} apiBase="" {...props} />
    </>,
  );
}

describe("AuthModal", () => {
  beforeEach(() => {
    mockOnAuth.mockReset();
    vi.restoreAllMocks();
  });

  it("renders login tab by default", () => {
    renderAuth();
    expect(screen.getByText("Welcome to")).toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText("Confirm Password"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Forgot your password?")).toBeInTheDocument();
  });

  it("switches to signup tab and shows signup fields", async () => {
    const user = userEvent.setup();
    renderAuth();

    await user.click(screen.getByRole("button", { name: "Sign Up" }));
    expect(screen.getByPlaceholderText("Confirm Password")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Email (optional)")).toBeInTheDocument();
  });

  it("shows forgot password view when link is clicked", async () => {
    const user = userEvent.setup();
    renderAuth();

    await user.click(screen.getByText("Forgot your password?"));
    expect(screen.getByText("Reset Your Password")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Email address")).toBeInTheDocument();
    expect(screen.getByText("Back to Login")).toBeInTheDocument();
  });

  it("shows reset password view when initialView is reset", () => {
    renderAuth({ initialView: "reset" });
    expect(screen.getByText("Choose a New Password")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("New password")).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText("Confirm new password"),
    ).toBeInTheDocument();
  });

  it("validates username length", async () => {
    const user = userEvent.setup();
    renderAuth();

    await user.click(screen.getByRole("button", { name: "Sign Up" }));
    await user.type(screen.getByPlaceholderText("Username"), "a");
    await user.type(screen.getByPlaceholderText("Password"), "password1");
    await user.type(
      screen.getByPlaceholderText("Confirm Password"),
      "password1",
    );
    await user.click(screen.getByRole("button", { name: "Create Account" }));

    expect(screen.getByText(/2-30 chars/)).toBeInTheDocument();
    expect(mockOnAuth).not.toHaveBeenCalled();
  });

  it("validates password length", async () => {
    const user = userEvent.setup();
    renderAuth();

    await user.click(screen.getByRole("button", { name: "Sign Up" }));
    await user.type(screen.getByPlaceholderText("Username"), "testuser");
    await user.type(screen.getByPlaceholderText("Password"), "short");
    await user.type(screen.getByPlaceholderText("Confirm Password"), "short");
    await user.click(screen.getByRole("button", { name: "Create Account" }));

    expect(screen.getByText(/at least 7 characters/)).toBeInTheDocument();
    expect(mockOnAuth).not.toHaveBeenCalled();
  });

  it("validates password confirmation match", async () => {
    const user = userEvent.setup();
    renderAuth();

    await user.click(screen.getByRole("button", { name: "Sign Up" }));
    await user.type(screen.getByPlaceholderText("Username"), "testuser");
    await user.type(screen.getByPlaceholderText("Password"), "password1");
    await user.type(
      screen.getByPlaceholderText("Confirm Password"),
      "different",
    );
    await user.click(screen.getByRole("button", { name: "Create Account" }));

    expect(screen.getByText(/do not match/)).toBeInTheDocument();
    expect(mockOnAuth).not.toHaveBeenCalled();
  });

  it("calls onAuth on successful signup", async () => {
    const user = userEvent.setup();
    const mockResponse = { access_token: "tok123", username: "newuser" };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    } as Response);

    renderAuth();

    await user.click(screen.getByRole("button", { name: "Sign Up" }));
    await user.type(screen.getByPlaceholderText("Username"), "newuser");
    await user.type(screen.getByPlaceholderText("Password"), "password1");
    await user.type(
      screen.getByPlaceholderText("Confirm Password"),
      "password1",
    );
    await user.click(screen.getByRole("button", { name: "Create Account" }));

    await waitFor(() => {
      expect(mockOnAuth).toHaveBeenCalledWith("newuser", "tok123");
    });
  });

  it("shows error on failed signup", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: false,
      json: () => Promise.resolve({ detail: "Username already taken" }),
    } as Response);

    renderAuth();

    await user.click(screen.getByRole("button", { name: "Sign Up" }));
    await user.type(screen.getByPlaceholderText("Username"), "taken");
    await user.type(screen.getByPlaceholderText("Password"), "password1");
    await user.type(
      screen.getByPlaceholderText("Confirm Password"),
      "password1",
    );
    await user.click(screen.getByRole("button", { name: "Create Account" }));

    await waitFor(() => {
      const matches = screen.getAllByText("Username already taken");
      expect(matches.length).toBeGreaterThanOrEqual(1);
    });
    expect(mockOnAuth).not.toHaveBeenCalled();
  });

  it("calls onAuth on successful login", async () => {
    const user = userEvent.setup();
    const mockResponse = { access_token: "tok456", username: "existing" };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    } as Response);

    renderAuth();

    // Login is already the active tab — target the submit button (not the tab)
    await user.type(screen.getByPlaceholderText("Username"), "existing");
    await user.type(screen.getByPlaceholderText("Password"), "password1");
    await user.click(screen.getAllByRole("button", { name: "Login" })[1]);

    await waitFor(() => {
      expect(mockOnAuth).toHaveBeenCalledWith("existing", "tok456");
    });
  });

  it("shows close button when onClose is provided", () => {
    const onClose = vi.fn();
    renderAuth({ onClose });
    expect(screen.getByLabelText("Close")).toBeInTheDocument();
  });

  it("does not show close button for initial auth", () => {
    renderAuth();
    expect(screen.queryByLabelText("Close")).not.toBeInTheDocument();
  });
});
