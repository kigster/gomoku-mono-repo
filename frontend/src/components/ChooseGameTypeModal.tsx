import { useCallback, useEffect, useRef, useState } from "react";
import ModalShell from "./ModalShell";
import CopyableLinkRow from "./CopyableLinkRow";
import {
  newGame as apiNewGame,
  cancelGame as apiCancelGame,
  type Color,
  type MultiplayerGameView,
} from "../lib/multiplayerClient";
import { useMultiplayerHostPolling } from "../hooks/useMultiplayerHostPolling";

type GameType = "ai" | "human";
type ColorChooser = "host" | "guest";

/**
 * Extract a 6-char Crockford-base32 code from raw user input. Accepts
 * either a bare code (`AB7K3X`) or a full URL containing `/play/<code>`.
 * Returns the uppercased code, or null if no valid code is present.
 */
export function extractInviteCode(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Crockford-base32 alphabet (no I/L/O/U/0/1) — see api/app/multiplayer/codes.py.
  const ALPHA = "[2-9A-HJ-NP-Z]{6}";
  const urlMatch = trimmed.match(
    new RegExp(`/play/(${ALPHA})(?:[/?#].*)?$`, "i"),
  );
  if (urlMatch) return urlMatch[1].toUpperCase();
  const bareMatch = trimmed.match(new RegExp(`^${ALPHA}$`, "i"));
  if (bareMatch) return bareMatch[0].toUpperCase();
  return null;
}

interface Props {
  /** Auth token used to call the multiplayer API. */
  authToken: string;
  /** User picked AI; let the host close us and start an AI game. */
  onAIChosen: () => void;
  /**
   * Guest joined — navigate to /play/{code} (or whatever the multiplayer
   * page route is) so both players land in the same game UI.
   */
  onGuestJoined: (code: string) => void;
  /**
   * Modal closed without a started multiplayer game. Caller should drop
   * the user into the AI flow per `.features/009.choose-game-type-modal-and-invite-link.done/plan.md` §1.
   */
  onClose: () => void;
}

export default function ChooseGameTypeModal({
  authToken,
  onAIChosen,
  onGuestJoined,
  onClose,
}: Props) {
  // Default to "Another Player" so the modal opens already expanded with a
  // ready-to-share invite link/code. AI is one click away — picking it
  // cancels any in-flight invite (see the createdKeyRef effect below).
  const [gameType, setGameType] = useState<GameType>("human");
  const [chooser, setChooser] = useState<ColorChooser>("host");
  const [hostColor, setHostColor] = useState<Color>("X");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [game, setGame] = useState<MultiplayerGameView | null>(null);
  // Lifted out of JoinByCodeSection so the parent can grey the host's
  // "Start" button while the user is typing an opponent's code.
  const [joinValue, setJoinValue] = useState("");

  // Polling: only active once we have a created game.
  const {
    view: latest,
    secondsWaited,
    expired,
  } = useMultiplayerHostPolling({
    token: authToken,
    code: game?.code ?? null,
  });

  // The actively-relevant view: prefer the latest poll, fall back to the
  // initial create response.
  const active = (latest as MultiplayerGameView | null) ?? game;
  const inWaitingPhase = !!active && active.state === "waiting";
  const cancelledRemotely = !!active && active.state === "cancelled";
  const hasGuestJoined =
    !!active && (active.state === "in_progress" || !!active.guest);
  const userIsJoining = joinValue.trim().length > 0;

  // Auto-navigate once the guest has joined our hosted game — but not if
  // the user is also typing into the paste-opponent-code input (in which
  // case they're switching to the join flow and should click Join).
  useEffect(() => {
    if (latest && latest.state === "in_progress" && game && !userIsJoining) {
      onGuestJoined(game.code);
    }
  }, [latest, game, onGuestJoined, userIsJoining]);

  useEffect(() => {
    if (cancelledRemotely) onClose();
  }, [cancelledRemotely, onClose]);

  // 15-minute hard cap — issue an explicit cancel POST so the row goes to
  // state='cancelled' immediately (don't rely on lazy expiry), then close.
  useEffect(() => {
    if (!expired || !game) return;
    let cancelled = false;
    void (async () => {
      try {
        await apiCancelGame(authToken, game.code);
      } catch {
        // Server-side lazy-expire path covers it eventually.
      }
      if (!cancelled) onClose();
    })();
    return () => {
      cancelled = true;
    };
  }, [expired, game, authToken, onClose]);

  // ----- Auto-create the invite the moment "Another Player" is picked ----
  //
  // The host should not have to click "Start" to see their link — the
  // paste-opponent-code box and the host's own auto-generated link must
  // both be visible at once. When the host changes their colour choice we
  // cancel the existing invite and create a fresh one (so the link always
  // matches the visible config).
  const desiredHostColor: Color | null = chooser === "host" ? hostColor : null;
  const configKey =
    gameType === "human" ? `human:${desiredHostColor ?? "guest"}` : "ai";
  const createdKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (gameType !== "human") {
      // Switched back to AI — cancel any in-flight invite and clear it.
      if (createdKeyRef.current && game) {
        const oldCode = game.code;
        void apiCancelGame(authToken, oldCode).catch(() => {});
        setGame(null);
      }
      createdKeyRef.current = null;
      return;
    }
    if (createdKeyRef.current === configKey) return;

    let cancelled = false;
    const previousCode = game?.code;
    createdKeyRef.current = configKey;
    setCreating(true);
    setCreateError(null);
    (async () => {
      if (previousCode) {
        try {
          await apiCancelGame(authToken, previousCode);
        } catch {
          // Lazy-expire path covers it eventually.
        }
      }
      try {
        const created = await apiNewGame(authToken, {
          host_color: desiredHostColor,
        });
        if (!cancelled) setGame(created);
      } catch (err) {
        if (!cancelled) {
          setCreateError(
            err instanceof Error ? err.message : "Could not create game",
          );
          createdKeyRef.current = null; // allow retry on next render
        }
      } finally {
        if (!cancelled) setCreating(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // game?.code intentionally omitted: we only re-run when the desired
    // config changes, not when the created game's code arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configKey, gameType, authToken]);

  // ----- Handlers --------------------------------------------------------

  const handleStartAI = useCallback(() => {
    onAIChosen();
  }, [onAIChosen]);

  const handleStartHost = useCallback(() => {
    if (game && hasGuestJoined) onGuestJoined(game.code);
  }, [game, hasGuestJoined, onGuestJoined]);

  const handleClose = useCallback(async () => {
    if (game && active && active.state === "waiting") {
      try {
        await apiCancelGame(authToken, game.code);
      } catch {
        // Lazy-expire path covers it eventually.
      }
    }
    onClose();
  }, [game, active, authToken, onClose]);

  // ----- Render ----------------------------------------------------------

  return (
    <ModalShell
      title="Choose Game Type"
      widthClassName="max-w-xl"
      onClose={handleClose}
    >
      <div className="space-y-6">
        <fieldset>
          <legend className="sr-only">Game type</legend>
          <div className="grid grid-cols-2 gap-3">
            {/*
             * Game-type radios stay enabled while an invite is in flight —
             * the auto-create useEffect on the human side opens an invite
             * the moment the modal mounts, so disabling on `inWaitingPhase`
             * would mean the user could never flip back to AI. The cancel
             * branch in the same effect cleans up the orphaned invite.
             */}
            <RadioCard
              checked={gameType === "human"}
              onChange={() => setGameType("human")}
              label="Another Player"
              hint="Default — share a link with a friend"
              disabled={creating}
            />
            <RadioCard
              checked={gameType === "ai"}
              onChange={() => setGameType("ai")}
              label="AI"
              hint="Play against the engine"
              disabled={creating}
            />
          </div>
        </fieldset>

        {gameType === "human" && (
          <>
            <fieldset>
              <legend className="mb-2 text-sm font-medium text-neutral-300">
                Who chooses the playing color?
              </legend>
              <div className="grid grid-cols-2 gap-3">
                <RadioCard
                  checked={chooser === "host"}
                  onChange={() => setChooser("host")}
                  label="I will choose"
                  disabled={creating}
                />
                <RadioCard
                  checked={chooser === "guest"}
                  onChange={() => setChooser("guest")}
                  label="Opponent will choose"
                  disabled={creating}
                />
              </div>
            </fieldset>

            {chooser === "host" && (
              <fieldset>
                <legend className="mb-2 text-sm font-medium text-neutral-300">
                  Your color
                </legend>
                <div className="grid grid-cols-2 gap-3">
                  <RadioCard
                    checked={hostColor === "X"}
                    onChange={() => setHostColor("X")}
                    label="Black (X)"
                    hint="Moves first"
                    disabled={creating}
                  />
                  <RadioCard
                    checked={hostColor === "O"}
                    onChange={() => setHostColor("O")}
                    label="White (O)"
                    disabled={creating}
                  />
                </div>
              </fieldset>
            )}
          </>
        )}

        {createError && (
          <p className="rounded-md border border-red-500/50 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            {createError}
          </p>
        )}

        {gameType === "ai" && (
          <div className="flex justify-end pt-2">
            <button
              type="button"
              onClick={handleStartAI}
              className="rounded-md bg-amber-500 px-6 py-3 text-base font-bold text-neutral-900 shadow transition hover:bg-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-300/50"
            >
              Start
            </button>
          </div>
        )}

        {gameType === "human" && (
          <>
            <InviteSection
              inviteUrl={inWaitingPhase && active ? active.invite_url : null}
              code={game?.code ?? null}
              creating={creating}
              hasGuestJoined={hasGuestJoined}
              secondsWaited={secondsWaited}
            />

            <div className="flex justify-end pt-2">
              <button
                type="button"
                onClick={handleStartHost}
                disabled={!hasGuestJoined || userIsJoining || creating}
                className={`rounded-md px-6 py-3 text-base font-bold shadow transition focus:outline-none focus:ring-2 focus:ring-amber-300/50 ${
                  !hasGuestJoined || userIsJoining || creating
                    ? "cursor-not-allowed bg-neutral-700 text-neutral-500"
                    : "bg-amber-500 text-neutral-900 hover:bg-amber-400"
                }`}
              >
                Start
              </button>
            </div>

            <JoinByCodeSection
              value={joinValue}
              onChange={setJoinValue}
              ownCode={game?.code ?? null}
              onJoin={async (code) => {
                // If the host is currently waiting on their own game, mark
                // it cancelled before pivoting to the opponent's game.
                if (game && active && active.state === "waiting") {
                  try {
                    await apiCancelGame(authToken, game.code);
                  } catch {
                    // Lazy-expire path covers it eventually.
                  }
                }
                onGuestJoined(code);
              }}
              disabled={creating}
            />
          </>
        )}
      </div>
    </ModalShell>
  );
}

// ===========================================================================
// Sub-components
// ===========================================================================

function RadioCard({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <label
      className={`flex cursor-pointer items-start gap-3 rounded-lg border px-4 py-3 transition ${
        checked
          ? "border-amber-400 bg-amber-500/10"
          : "border-neutral-600 bg-neutral-700/40 hover:border-neutral-400"
      } ${disabled ? "cursor-not-allowed opacity-50" : ""}`}
    >
      <input
        type="radio"
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        className="mt-1 h-4 w-4 accent-amber-500"
      />
      <span className="flex-1">
        <span className="block text-sm font-semibold text-white">{label}</span>
        {hint && <span className="block text-xs text-neutral-400">{hint}</span>}
      </span>
    </label>
  );
}

function JoinByCodeSection({
  value,
  onChange,
  ownCode,
  onJoin,
  disabled,
}: {
  /** Controlled value — lifted to parent so the host's "Start" button can grey while typing. */
  value: string;
  onChange: (next: string) => void;
  /** Caller's currently-hosted code, if any — used to reject self-paste. */
  ownCode: string | null;
  onJoin: (code: string) => void | Promise<void>;
  disabled?: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const hasInput = value.trim().length > 0;

  function submit() {
    const code = extractInviteCode(value);
    if (!code) {
      setError("Enter a 6-character code or a /play/<CODE> link.");
      return;
    }
    if (ownCode && code === ownCode) {
      setError("That's your own invitation — share it with your opponent.");
      return;
    }
    setError(null);
    // Whoever's code is entered becomes the active game. The opponent
    // (the host of that code) stays the host; the caller joins as guest.
    void onJoin(code);
  }

  return (
    <div className="space-y-2 border-t border-neutral-700 pt-5">
      <label className="block text-sm font-medium text-neutral-300">
        Got an invitation? Paste the link or 6-character code:
      </label>
      <div className="flex items-stretch gap-2">
        <input
          type="text"
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="AB7K3X or https://…/play/AB7K3X"
          disabled={disabled}
          aria-label="Invitation code or link"
          className="min-w-0 flex-1 rounded-md border border-neutral-600 bg-neutral-900 px-3 py-2 font-mono text-sm text-neutral-100 placeholder:text-neutral-500 focus:outline-none focus:ring-2 focus:ring-amber-500/50 disabled:opacity-60"
        />
        <button
          type="button"
          onClick={submit}
          disabled={disabled || !hasInput}
          className={
            hasInput
              ? // Primary action — large + yellow once the user has typed something.
                "rounded-md bg-amber-500 px-6 py-3 text-base font-bold text-neutral-900 shadow transition hover:bg-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-300/50 disabled:cursor-not-allowed disabled:opacity-60"
              : // Inactive — neutral grey while empty.
                "rounded-md border border-neutral-600 bg-neutral-700 px-4 py-2 text-sm font-semibold text-neutral-100 transition hover:bg-neutral-600 disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-amber-500/50"
          }
        >
          Join
        </button>
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}

function InviteSection({
  inviteUrl,
  code,
  creating,
  hasGuestJoined,
  secondsWaited,
}: {
  /** Server-issued invite URL, or null while we're (re)creating it. */
  inviteUrl: string | null;
  /** Bare 6-char code (`AB7K3X`) — sharable separately from the URL. */
  code: string | null;
  creating: boolean;
  hasGuestJoined: boolean;
  secondsWaited: number;
}) {
  // Countdown from the 15-minute invite TTL. Clamp at 0 so we never show
  // a negative remainder if the polling cap fires a beat after the timer.
  const remaining = Math.max(0, 15 * 60 - secondsWaited);
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;
  const headline = hasGuestJoined
    ? "Opponent joined! Click Start to begin."
    : inviteUrl
      ? "Waiting for your opponent to join…"
      : creating
        ? "Generating your invitation link…"
        : "Preparing your invitation link…";
  return (
    <div className="space-y-3 border-t border-neutral-700 pt-5">
      <p className="text-base font-semibold text-amber-300">{headline}</p>
      {inviteUrl && !hasGuestJoined && (
        <p className="text-xs tabular-nums text-neutral-400">
          Waiting for opponent for: {minutes} min, {seconds} sec
        </p>
      )}
      <CopyableLinkRow url={inviteUrl ?? ""} />
      <CopyableLinkRow url={code ?? ""} />
      <p className="text-xs leading-relaxed text-neutral-400">
        Send the link or just the 6-character code to your opponent. They have
        15 minutes to accept.
      </p>
    </div>
  );
}
