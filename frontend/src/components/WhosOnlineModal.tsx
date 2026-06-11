import { useEffect, useMemo, useRef, useState } from "react";
import ModalShell from "./ModalShell";
import PlayingIndicator from "./PlayingIndicator";
import crownIcon from "../../assets/images/crown-transparent.png";

// One row of GET /social/online — mirrors OnlineUserEntry in
// api/app/routers/social.py.
export type OnlineState = "human-battle" | "ai-battle" | "chatting" | "idle";

export interface OnlineUser {
  user_id: string;
  username: string;
  state: OnlineState;
  active_game_id: string | null;
  opponent_username: string | null;
  last_seen_at: string;
  elo_rating: number;
  // NOT NULL on the wire (migration 0016); always present.
  session_started_at: string;
  is_friend: boolean;
  is_follower: boolean;
  is_following: boolean;
  is_blocked: boolean;
  is_champion: boolean;
}

export type WhosOnlineFilter =
  | "available"
  | "unavailable"
  | "friends"
  | "followers"
  | "blocked";

// The Elo half-width that counts as "similar level" for the
// can-play filter. Matches the value confirmed with product.
export const SIMILAR_ELO_BAND = 250;

// Poll cadence while the modal is open. The list is small and the
// query is cheap; 4s keeps it lively without hammering the API.
const POLL_MS = 4000;

// Typed as a Record so the compiler forces a label for every
// WhosOnlineFilter member — a new filter can't be added to the union
// without also giving the dropdown a label for it.
const FILTER_LABELS: Record<WhosOnlineFilter, string> = {
  available: "Available, can play (similar level)",
  unavailable: "Unavailable",
  friends: "My friends only",
  followers: "My followers",
  blocked: "Users I blocked",
};

// Dropdown render order, derived from the label map so every labelled
// filter is reachable (insertion order is stable in JS objects).
const FILTER_ORDER = Object.keys(FILTER_LABELS) as WhosOnlineFilter[];

function isPlaying(u: OnlineUser): boolean {
  return u.state === "human-battle" || u.state === "ai-battle";
}

// Pure, testable: apply the active filter (always excluding the caller),
// then sort by recency (most-recently-active first).
export function filterOnlineUsers(
  users: OnlineUser[],
  filter: WhosOnlineFilter,
  callerElo: number,
  selfUsername: string,
): OnlineUser[] {
  const self = selfUsername.toLowerCase();
  const others = users.filter((u) => u.username.toLowerCase() !== self);

  // NOTE: "available" and "unavailable" are not strictly complementary.
  // An idle, in-band user matches BOTH (available because not playing;
  // unavailable because idle), and a "chatting" user matches available
  // but not unavailable. The product semantics here are still open — see
  // PR #113 review — so the current behaviour is preserved deliberately
  // rather than guessed at.
  let matched: OnlineUser[];
  switch (filter) {
    case "available":
      // Not in a game, not someone you've blocked, and within the
      // similar-level Elo band.
      matched = others.filter(
        (u) =>
          !isPlaying(u) &&
          !u.is_blocked &&
          Math.abs(u.elo_rating - callerElo) <= SIMILAR_ELO_BAND,
      );
      break;
    case "unavailable":
      // Playing OR idle — anyone who isn't ready to start a game now.
      matched = others.filter((u) => isPlaying(u) || u.state === "idle");
      break;
    case "friends":
      matched = others.filter((u) => u.is_friend);
      break;
    case "followers":
      matched = others.filter((u) => u.is_follower);
      break;
    case "blocked":
      matched = others.filter((u) => u.is_blocked);
      break;
    default: {
      // Exhaustiveness guard: a new WhosOnlineFilter member without a
      // case here is a compile error.
      const _exhaustive: never = filter;
      return _exhaustive;
    }
  }

  return [...matched].sort(
    (a, b) =>
      new Date(b.last_seen_at).getTime() - new Date(a.last_seen_at).getTime(),
  );
}

// Exact hexes per the design spec.
const FRIEND_BG = "#14532d"; // dark green
const FRIEND_TEXT = "#ffffff";
const BLOCKED_BG = "#450a0a"; // dark red
const BLOCKED_TEXT = "#F03040";

// Icons against a user are 25px on phones, 70px on desktop.
const ICON_CLASS = "h-[25px] w-[25px] shrink-0 sm:h-[70px] sm:w-[70px]";

function formatSince(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function statusLabel(state: OnlineState): string {
  switch (state) {
    case "human-battle":
      return "Playing (human)";
    case "ai-battle":
      return "Playing (AI)";
    case "chatting":
      return "Chatting";
    case "idle":
      return "Idle";
  }
}

interface WhosOnlineModalProps {
  apiBase: string;
  authToken: string;
  // Logged-in username — excluded from the list.
  currentUsername: string;
  onClose: () => void;
}

export default function WhosOnlineModal({
  apiBase,
  authToken,
  currentUsername,
  onClose,
}: WhosOnlineModalProps) {
  const [users, setUsers] = useState<OnlineUser[]>([]);
  const [callerElo, setCallerElo] = useState<number>(1500);
  const [filter, setFilter] = useState<WhosOnlineFilter>("available");
  const [menuOpen, setMenuOpen] = useState(false);
  // Only the very first load shows the spinner; background polls refresh
  // silently so the table doesn't flicker every 4s.
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // True when the last good load is older than a couple of poll cycles —
  // the table is still shown, but flagged as possibly stale.
  const [stale, setStale] = useState(false);
  const loadedOnce = useRef(false);
  const lastSuccessAt = useRef(0);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const resp = await fetch(`${apiBase}/social/online?limit=200&offset=0`, {
          headers: { Authorization: `Bearer ${authToken}` },
        });
        if (!resp.ok) throw new Error(`Failed to load online users (${resp.status})`);
        const body = (await resp.json()) as {
          users?: OnlineUser[];
          caller_elo?: number;
        };
        if (cancelled) return;
        // Guard against a malformed payload rather than pushing
        // `undefined` into state (which would crash the filter/render).
        setUsers(Array.isArray(body.users) ? body.users : []);
        setCallerElo(body.caller_elo ?? 1500);
        setError("");
        setStale(false);
        lastSuccessAt.current = Date.now();
      } catch (e) {
        if (cancelled) return;
        // Don't clobber a good table on a transient poll failure; only
        // surface a hard error if we've never managed to load. Once
        // we've gone a couple of poll cycles with no success, flag the
        // shown data as stale instead of silently lying that it's live.
        if (!loadedOnce.current) {
          setError(e instanceof Error ? e.message : "unknown error");
        } else {
          console.warn("Who's Online poll failed; showing last known list", e);
          if (Date.now() - lastSuccessAt.current > 2 * POLL_MS) {
            setStale(true);
          }
        }
      } finally {
        if (!cancelled) {
          loadedOnce.current = true;
          setLoading(false);
        }
      }
    }

    void load();
    const id = window.setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [apiBase, authToken]);

  const visible = useMemo(
    () => filterOnlineUsers(users, filter, callerElo, currentUsername),
    [users, filter, callerElo, currentUsername],
  );

  const activeLabel = FILTER_LABELS[filter];

  // The Filter dropdown nav: centered button, left-aligned menu items,
  // a divider after the first ("available") option.
  const nav = (
    <nav className="relative flex justify-center">
      <button
        type="button"
        onClick={() => setMenuOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={menuOpen}
        className="inline-flex items-center gap-2 rounded-md border border-neutral-600
                   bg-neutral-900 px-4 py-2 text-sm font-semibold text-neutral-200
                   hover:bg-neutral-700 focus:outline-none focus:ring-2 focus:ring-amber-500/50"
      >
        <span className="text-neutral-400">Filter:</span>
        <span className="text-amber-300">{activeLabel}</span>
        <svg
          width="14"
          height="14"
          viewBox="0 0 20 20"
          fill="currentColor"
          className={`transition-transform ${menuOpen ? "rotate-180" : ""}`}
          aria-hidden="true"
        >
          <path d="M5.5 7.5 10 12l4.5-4.5z" />
        </svg>
      </button>

      {menuOpen && (
        <ul
          role="listbox"
          className="absolute top-full z-20 mt-1 w-72 overflow-hidden rounded-md border
                     border-neutral-600 bg-neutral-900 py-1 text-left shadow-xl shadow-black/50"
        >
          {FILTER_ORDER.map((key, i) => (
            <li key={key}>
              {i === 1 && <hr className="my-1 border-neutral-700" />}
              <button
                type="button"
                role="option"
                aria-selected={filter === key}
                onClick={() => {
                  setFilter(key);
                  setMenuOpen(false);
                }}
                className={`block w-full px-4 py-2 text-left text-sm transition-colors
                           hover:bg-neutral-700 ${
                             filter === key
                               ? "font-semibold text-amber-300"
                               : "text-neutral-300"
                           }`}
              >
                {FILTER_LABELS[key]}
              </button>
            </li>
          ))}
        </ul>
      )}
    </nav>
  );

  return (
    <ModalShell
      title="Who's Online"
      onClose={onClose}
      widthClassName="max-w-2xl"
      dialogClassName="h-[88vh]"
      bodyClassName="px-0 py-0 sm:px-0"
      subheader={nav}
    >
      {loading && (
        <p className="py-8 text-center text-neutral-400">Loading…</p>
      )}
      {error && !loading && (
        <p className="py-8 text-center text-red-400">{error}</p>
      )}
      {stale && !loading && !error && (
        <p className="px-4 py-2 text-center text-xs text-amber-400/80">
          Reconnecting… showing the last known list.
        </p>
      )}
      {!loading && !error && visible.length === 0 && (
        <p className="py-8 text-center text-neutral-400">
          No players match this filter.
        </p>
      )}

      {!loading && !error && visible.length > 0 && (
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-neutral-800">
            <tr className="border-b border-neutral-700 text-left text-neutral-400">
              <th className="px-4 py-3 font-semibold">username</th>
              <th className="px-4 py-3 font-semibold">Elo Score</th>
              <th className="px-4 py-3 font-semibold">Since (LTZ)</th>
              <th className="px-4 py-3 font-semibold">Status</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((u) => {
              const blocked = u.is_blocked;
              const friend = u.is_friend;
              // Blocked wins over friend (a block wipes friendship
              // server-side, but guard the precedence anyway).
              const rowStyle = blocked
                ? { backgroundColor: BLOCKED_BG, color: BLOCKED_TEXT }
                : friend
                  ? { backgroundColor: FRIEND_BG, color: FRIEND_TEXT }
                  : undefined;
              return (
                <tr
                  key={u.user_id}
                  style={rowStyle}
                  className={`border-b border-neutral-700/50 align-middle ${
                    rowStyle ? "" : "text-neutral-300"
                  }`}
                >
                  <td className="px-4 py-2 font-medium">
                    <span className="inline-flex items-center gap-2">
                      <span className="truncate">{u.username}</span>
                      {u.is_champion && (
                        <img
                          src={crownIcon}
                          alt="Champion"
                          title="Current champion"
                          className={ICON_CLASS}
                        />
                      )}
                    </span>
                  </td>
                  <td className="px-4 py-2 tabular-nums">{u.elo_rating}</td>
                  <td className="px-4 py-2 whitespace-nowrap">
                    {formatSince(u.session_started_at)}
                  </td>
                  <td className="px-4 py-2">
                    {isPlaying(u) ? (
                      <span
                        className="inline-flex items-center gap-2"
                        title={statusLabel(u.state)}
                      >
                        <PlayingIndicator className={ICON_CLASS} />
                      </span>
                    ) : (
                      <span>{statusLabel(u.state)}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </ModalShell>
  );
}
