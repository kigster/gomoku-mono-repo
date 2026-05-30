import { useState } from "react";
import { showError, showInfo } from "./AlertPanel";

interface AuthModalProps {
  onAuth: (username: string, token: string) => void;
  currentName?: string;
  onClose?: () => void;
  apiBase: string;
  initialView?: View;
}

type View = "login" | "signup" | "forgot" | "reset";

const USERNAME_RE = /^[\w\u00C0-\u024F\-^]{2,30}$/;

export default function AuthModal({
  onAuth,
  currentName,
  onClose,
  apiBase,
  initialView,
}: AuthModalProps) {
  const [view, setView] = useState<View>(initialView ?? "login");
  const [username, setUsername] = useState(currentName ?? "");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [email, setEmail] = useState("");
  const [resetToken] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("token") ?? "";
  });
  const [loading, setLoading] = useState(false);
  const [fieldError, setFieldError] = useState("");

  const switchView = (v: View) => {
    setView(v);
    setFieldError("");
    setPassword("");
    setConfirmPassword("");
  };

  const inputClass = `w-full px-4 py-3 rounded-lg bg-neutral-700 border border-neutral-600
    text-neutral-100 placeholder-neutral-500 focus:outline-none
    focus:border-amber-500 focus:ring-1 focus:ring-amber-500`;

  // ── Forgot Password ────────────────────────────────────────────────
  const handleForgot = async (e: React.FormEvent) => {
    e.preventDefault();
    setFieldError("");
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setFieldError("Please enter a valid email address");
      return;
    }
    setLoading(true);
    try {
      const resp = await fetch(`${apiBase}/auth/password-reset`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        throw new Error(data.detail || "Request failed");
      }
      showInfo(
        "If an account with that email exists, a reset link has been sent.",
      );
      switchView("login");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Something went wrong";
      const detail = err instanceof Error ? err.stack : String(err);
      showError(msg, detail);
      setFieldError(msg);
    } finally {
      setLoading(false);
    }
  };

  // ── Reset Password (from email link) ───────────────────────────────
  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setFieldError("");
    if (password.length < 7) {
      setFieldError("Password must be at least 7 characters");
      return;
    }
    if (password !== confirmPassword) {
      setFieldError("Passwords do not match");
      return;
    }
    setLoading(true);
    try {
      const resp = await fetch(`${apiBase}/auth/password-reset/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: resetToken, new_password: password }),
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        throw new Error(data.detail || "Reset failed");
      }
      showInfo("Password updated! You can now log in.");
      // Clear the token from the URL
      window.history.replaceState({}, "", window.location.pathname);
      switchView("login");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Something went wrong";
      const detail = err instanceof Error ? err.stack : String(err);
      showError(msg, detail);
      setFieldError(msg);
    } finally {
      setLoading(false);
    }
  };

  // ── Login / Signup ─────────────────────────────────────────────────
  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setFieldError("");

    if (!USERNAME_RE.test(username)) {
      setFieldError("Username: 2-30 chars, letters/digits/dash/caret only");
      return;
    }
    if (password.length < 7) {
      setFieldError("Password must be at least 7 characters");
      return;
    }
    if (view === "signup" && password !== confirmPassword) {
      setFieldError("Passwords do not match");
      return;
    }
    if (
      view === "signup" &&
      email &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ) {
      setFieldError("Please enter a valid email address");
      return;
    }

    setLoading(true);
    try {
      const endpoint = view === "login" ? "/auth/login" : "/auth/signup";
      const body: Record<string, string> = { username, password };
      if (view === "signup" && email) body.email = email;

      const resp = await fetch(`${apiBase}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        throw new Error(
          data.detail || `${view === "login" ? "Login" : "Signup"} failed`,
        );
      }

      const data = await resp.json();
      onAuth(data.username, data.access_token);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Something went wrong";
      const detail = err instanceof Error ? err.stack : String(err);
      showError(msg, detail);
      setFieldError(msg);
    } finally {
      setLoading(false);
    }
  };

  // ── Render ─────────────────────────────────────────────────────────
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-neutral-800 rounded-2xl shadow-2xl p-8 max-w-md w-full mx-4 relative">
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="absolute top-3 right-4 text-neutral-500 hover:text-neutral-200
                       text-2xl leading-none transition-colors"
            aria-label="Close"
          >
            &times;
          </button>
        )}

        <h2 className="text-2xl font-bold mb-1 text-center text-white">
          Welcome to <span className="font-heading text-amber-400">Gomoku</span>
        </h2>

        {/* ── Forgot Password View ──────────────────────────────── */}
        {view === "forgot" && (
          <form onSubmit={handleForgot}>
            <p className="text-neutral-300 text-center mb-5 mt-3 text-base font-semibold">
              Reset Your Password
            </p>
            <p className="text-neutral-500 text-center mb-5 text-sm">
              Enter the email address associated with your account and we'll
              send you a reset link.
            </p>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Email address"
              autoFocus
              autoComplete="email"
              className={`${inputClass} mb-3`}
            />
            {fieldError && (
              <p className="text-red-400 text-sm mb-3 text-center">
                {fieldError}
              </p>
            )}
            <button
              type="submit"
              disabled={loading || !email.trim()}
              className="w-full py-3 rounded-lg font-semibold text-lg
                         bg-amber-600 hover:bg-amber-500 disabled:bg-neutral-600
                         disabled:text-neutral-400 transition-colors mb-3"
            >
              {loading ? "Sending..." : "Send Reset Link"}
            </button>
            <p className="text-center">
              <button
                type="button"
                onClick={() => switchView("login")}
                className="text-amber-400 hover:text-amber-300 text-sm transition-colors"
              >
                Back to Login
              </button>
            </p>
          </form>
        )}

        {/* ── Reset Password View (from email link) ─────────────── */}
        {view === "reset" && (
          <form onSubmit={handleReset}>
            <p className="text-neutral-300 text-center mb-5 mt-3 text-base font-semibold">
              Choose a New Password
            </p>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="New password"
              autoFocus
              autoComplete="new-password"
              className={`${inputClass} mb-3`}
            />
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Confirm new password"
              autoComplete="new-password"
              className={`${inputClass} mb-3`}
            />
            {fieldError && (
              <p className="text-red-400 text-sm mb-3 text-center">
                {fieldError}
              </p>
            )}
            <button
              type="submit"
              disabled={loading || !password || !confirmPassword}
              className="w-full py-3 rounded-lg font-semibold text-lg
                         bg-amber-600 hover:bg-amber-500 disabled:bg-neutral-600
                         disabled:text-neutral-400 transition-colors"
            >
              {loading ? "Updating..." : "Update Password"}
            </button>
          </form>
        )}

        {/* ── Login / Signup View ───────────────────────────────── */}
        {(view === "login" || view === "signup") && (
          <form onSubmit={handleAuth}>
            <p className="text-neutral-300 text-center mb-5 text-base font-semibold">
              Please Choose a Username &amp; Password
            </p>
            <p className="text-neutral-500 text-center mb-5 text-sm">
              Your username will enter the global score board, so it must be
              unique and easy to remember. Your password protects your scores.
            </p>

            {/* Tabs */}
            <div className="flex mb-5 rounded-lg overflow-hidden border border-neutral-600">
              <button
                type="button"
                onClick={() => switchView("login")}
                className={`flex-1 py-2.5 text-sm font-semibold transition-colors
                  ${
                    view === "login"
                      ? "bg-amber-600 text-white"
                      : "bg-neutral-700 text-neutral-400 hover:text-neutral-200"
                  }`}
              >
                Login
              </button>
              <button
                type="button"
                onClick={() => switchView("signup")}
                className={`flex-1 py-2.5 text-sm font-semibold transition-colors
                  ${
                    view === "signup"
                      ? "bg-amber-600 text-white"
                      : "bg-neutral-700 text-neutral-400 hover:text-neutral-200"
                  }`}
              >
                Sign Up
              </button>
            </div>

            {/* Username */}
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Username"
              autoFocus
              autoComplete="username"
              className={`${inputClass} mb-3`}
            />

            {/* Password */}
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              autoComplete={
                view === "login" ? "current-password" : "new-password"
              }
              className={`${inputClass} mb-3`}
            />

            {/* Confirm Password (signup only) */}
            {view === "signup" && (
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Confirm Password"
                autoComplete="new-password"
                className={`${inputClass} mb-3`}
              />
            )}

            {/* Email (signup only, optional) */}
            {view === "signup" && (
              <>
                <p className="text-neutral-500 text-xs mb-1.5">
                  Your email is optional, but helps for password resets.
                </p>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="Email (optional)"
                  autoComplete="email"
                  className={`${inputClass} mb-3`}
                />
              </>
            )}

            {/* Validation error */}
            {fieldError && (
              <p className="text-red-400 text-sm mb-3 text-center">
                {fieldError}
              </p>
            )}

            {/* Submit */}
            <button
              type="submit"
              disabled={loading || !username.trim() || !password}
              className="w-full py-3 rounded-lg font-semibold text-lg
                         bg-amber-600 hover:bg-amber-500 disabled:bg-neutral-600
                         disabled:text-neutral-400 transition-colors"
            >
              {loading
                ? "Please wait..."
                : view === "login"
                  ? "Login"
                  : "Create Account"}
            </button>

            {/* Forgot password link (login only) */}
            {view === "login" && (
              <p className="text-center mt-3">
                <button
                  type="button"
                  onClick={() => switchView("forgot")}
                  className="text-amber-400 hover:text-amber-300 text-sm transition-colors"
                >
                  Forgot your password?
                </button>
              </p>
            )}
          </form>
        )}
      </div>
    </div>
  );
}
