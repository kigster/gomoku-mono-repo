import { useEffect, useMemo, useRef, useState } from "react";
import { useChatMessages } from "../hooks/useChatMessages";

interface ChatMessage {
  id: string;
  // Username of the speaker. `me` flags the active user's own messages so
  // the bubble is right-coloured (white-on-blue) and left-anchored per
  // the design spec.
  speaker: string;
  me: boolean;
  body: string;
  // Local timestamp for grouping / display. ISO so it survives JSON.
  at: string;
  // True for system-generated lines like "/invite sent to @bob". Rendered
  // as a centred caption rather than a chat bubble.
  system?: boolean;
  // "info" (blue) | "error" (red) — colour of the system caption.
  systemKind?: "info" | "error";
}

interface ChatPanelProps {
  // Currently authed username — used to render bubbles "as me".
  meUsername: string;
  // Username of the person on the other end. `null` when there's no
  // active conversation yet (we then show a friendly placeholder header
  // asking the user to /invite someone).
  peerUsername: string | null;
  // Auth token; passed to the slash-command endpoints.
  authToken: string;
  // Backend base URL.
  apiBase: string;
  // Multiplayer game code — when set, messages are persisted via
  // `/chat/{code}/messages` and polled so both players see them. When
  // null (home-page right-rail), the panel falls back to local-only
  // echo of typed text (no persistence, no peer delivery — slash
  // commands still work because they post directly to their own
  // endpoints).
  gameCode?: string | null;
  // Fires when a slash command terminated the active multiplayer game.
  // Today only `/block` triggers this — `/unfollow` is intentionally a
  // pure social-graph operation that does NOT cascade into game
  // termination (matches the server-side contract; see
  // app/routers/social.py module docstring).
  onActiveGameTerminated?: () => void;
  // 'dark' (default) — right-rail panel on the dark home page.
  // 'light' — in-game panel embedded in the multiplayer board view.
  //          White card, blue-on-white own bubbles right, gray-on-white
  //          peer bubbles left, per the spec.
  variant?: "dark" | "light";
  // 'card' (default) — fixed height card with internal scroll, suitable
  // for the right rail. 'fill' — stretch to the parent's full height,
  // used when the chat panel replaces the full left column during a
  // multiplayer game.
  height?: "card" | "fill";
  // Opens the Who's Online modal. Wired to both the header "Who's
  // Online?" button and the `/who` slash command — the panel itself
  // doesn't own the modal, App/MultiplayerGamePage do.
  onShowWhosOnline?: () => void;
}

// Slash commands the chat panel understands. Each one captures the target
// username (no leading `@`) and dispatches to a different REST endpoint.
//
// /invite   @user → POST /chat/invite      (game invite, presence-aware,
//                                            rate-limited per caller on a
//                                            rolling window: 7/hour, 15/24h.
//                                            429 detail is structured —
//                                            see formatErrorDetail below)
// /block    @user → POST /social/block     (hard block; if the two are in
//                                            an active game it terminates
//                                            immediately and the UI returns
//                                            to the standard idle view)
// /follow   @user → POST /social/follow    (one-directional; mutual = friend)
// /unfollow @user → POST /social/unfollow  (drops the follow; idempotent;
//                                            does NOT terminate any active
//                                            game — only /block does that)
//
// The followee can send invites to anyone who follows them even when the
// follow isn't reciprocal — only mutual follows count as "friends".
const SLASH_USERNAME = "([\\wÀ-ɏ0-9\\-\\^]{2,30})";
// /invite picks up an optional freeform tail after the username — that
// text is forwarded to /chat/invite as the `message` field and rendered
// in the invitee's modal. The other three slash commands stay strict
// "verb + target" because they have no message payload.
const SLASH_RE: Record<SlashAction, RegExp> = {
  invite: new RegExp(
    `^\\s*/invite\\s+@?${SLASH_USERNAME}(?:\\s+(.+))?\\s*$`,
    "i",
  ),
  block: new RegExp(`^\\s*/block\\s+@?${SLASH_USERNAME}\\s*$`, "i"),
  follow: new RegExp(`^\\s*/follow\\s+@?${SLASH_USERNAME}\\s*$`, "i"),
  unfollow: new RegExp(`^\\s*/unfollow\\s+@?${SLASH_USERNAME}\\s*$`, "i"),
};
// `/help` takes no argument; matched separately so the user gets the
// command list without typing a target username.
const HELP_RE = /^\s*\/help\s*$/i;
// `/who` opens the Who's Online modal (see WhosOnlineModal). It takes no
// arguments — the modal owns filtering and scrolling.
const WHO_RE = /^\s*\/who\s*$/i;

// One short line per command, joined with newlines for a clean monospaced
// help overlay in the chat. Kept terse — the chat panel is narrow.
const HELP_TEXT = [
  "/invite @user             — invite the user to a game",
  "/follow @user             — follow them (mutual = friends)",
  "/unfollow @user           — drop the follow (does not end any game)",
  "/block @user              — block them (ends an active game)",
  "/who                      — open the Who's Online list",
  "/help                     — this list",
].join("\n");

type SlashAction = "invite" | "block" | "follow" | "unfollow";

interface SlashSpec {
  endpoint: string;
  // Past-tense success caption for the system message.
  successCaption: (target: string, body: SlashResponseBody) => string;
  errorCaption: (target: string, msg: string) => string;
}

interface SlashResponseBody {
  delivered?: boolean;
  target_state?: "in_game" | "idle" | "offline";
  reciprocal?: boolean;
  // True iff `/block` terminated an active multiplayer game between the
  // two. The chat panel surfaces this in the system caption AND fires
  // onActiveGameTerminated upstream so App.tsx drops the user back to
  // the idle view. /unfollow no longer touches games (the field is
  // never set on its response).
  game_terminated?: boolean;
  // /unfollow always returns this; included here so the SlashResponseBody
  // type covers all four endpoints' shapes.
  unfollowed?: boolean;
  // /invite returns the freshly-allocated room code so the caller can
  // echo "/invite @user CODE" back into the chat (giving them a
  // copyable shortcut if the recipient's modal never fires) and link
  // the recipient straight to /play/<code>.
  invited_code?: string;
  invite_url?: string;
}

const SLASH_SPECS: Record<SlashAction, SlashSpec> = {
  invite: {
    endpoint: "/chat/invite",
    successCaption: (target, body) => {
      const where =
        body.target_state === "in_game"
          ? "in a game"
          : body.target_state === "idle"
            ? "online"
            : "offline";
      return `Invite sent to @${target} (${where}).`;
    },
    errorCaption: (target, msg) => `Could not invite @${target}: ${msg}`,
  },
  block: {
    endpoint: "/social/block",
    successCaption: (target, body) =>
      body.game_terminated
        ? `Blocked @${target}. The game with them was ended.`
        : `Blocked @${target}. They won't be able to chat with you or invite you to a game.`,
    errorCaption: (target, msg) => `Could not block @${target}: ${msg}`,
  },
  follow: {
    endpoint: "/social/follow",
    // Reciprocal flag from the server tells us whether the follow makes
    // the pair into mutual friends — surfaced in the success caption so
    // the user understands the directional model.
    successCaption: (target, body) =>
      body.reciprocal
        ? `Now friends with @${target} (you both follow each other).`
        : `Following @${target}. They can invite you to games; ask them to /follow you back to be friends.`,
    errorCaption: (target, msg) => `Could not follow @${target}: ${msg}`,
  },
  unfollow: {
    endpoint: "/social/unfollow",
    // No game_terminated branch — unfollow is a pure social-graph
    // operation (see app/routers/social.py). If the user wants to end
    // a game with someone, /block is the explicit verb.
    successCaption: (target) => `Unfollowed @${target}.`,
    errorCaption: (target, msg) => `Could not unfollow @${target}: ${msg}`,
  },
};


// FastAPI returns errors as `{detail: string | object}`. The /chat/invite
// 429 returns a structured detail `{error, retry_at}`; render it as a
// human sentence with a locale-formatted retry time. All other endpoints
// return a string detail and we pass it through unchanged.
async function formatErrorDetail(resp: Response): Promise<string> {
  const raw = await resp.text().catch(() => "");
  if (!raw) return `HTTP ${resp.status}`;
  try {
    const parsed = JSON.parse(raw) as { detail?: unknown };
    const detail = parsed.detail;
    if (typeof detail === "string") return detail;
    if (
      detail !== null &&
      typeof detail === "object" &&
      "error" in detail &&
      typeof (detail as { error: unknown }).error === "string"
    ) {
      const obj = detail as { error: string; retry_at?: string };
      if (obj.retry_at) {
        const when = new Date(obj.retry_at);
        if (!Number.isNaN(when.getTime())) {
          return `${obj.error} Try again at ${when.toLocaleTimeString()}.`;
        }
      }
      return obj.error;
    }
  } catch {
    // Body wasn't JSON — fall through and return it as-is.
  }
  return raw;
}

export default function ChatPanel({
  meUsername,
  peerUsername,
  authToken,
  apiBase,
  gameCode = null,
  onActiveGameTerminated,
  variant = "dark",
  height = "card",
  onShowWhosOnline,
}: ChatPanelProps) {
  const isLight = variant === "light";
  // Both variants are deterministic-height containers. The in-game `fill`
  // variant used to be `h-full min-h-[20rem]`, but with no bounded parent
  // the chat would grow with content (each new message stretched the
  // game-panel row taller) instead of scrolling internally. A
  // viewport-relative fixed height breaks that feedback loop: the chat
  // panel's outer box is always the same size, the messages region
  // scrolls, and `items-stretch` on the parent row stops being driven by
  // the chat's intrinsic content height.
  const sizeClass =
    height === "fill"
      ? "h-[60vh] min-h-[20rem] max-h-[42rem]"
      : "h-[22rem] lg:h-[26rem]";
  const [draft, setDraft] = useState("");
  // `messages` holds two kinds of entries interleaved by time:
  //   - persisted rows mirrored from the chat-messages endpoint
  //     (only present when `gameCode` is set), and
  //   - ephemeral system captions (slash-command results, errors, /help
  //     output) that live entirely in the panel and are never POSTed.
  // The home-page right-rail with no gameCode also uses this list for
  // local-only user echoes.
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [pending, setPending] = useState(false);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  // Persistence layer for in-game chat. Polls and exposes a `send` that
  // stores first then returns the persisted row.
  const { messages: persistedMessages, send: sendPersisted } = useChatMessages({
    token: gameCode ? authToken : null,
    code: gameCode,
    apiBase,
  });
  // Mirror polled persisted rows into the unified list, deduping by id.
  // Ephemeral system messages are kept in place around them.
  useEffect(() => {
    if (!gameCode) return;
    setMessages((prev) => {
      const have = new Set(prev.map((m) => m.id));
      const fresh = persistedMessages
        .filter((p) => !have.has(p.id))
        .map<ChatMessage>((p) => ({
          id: p.id,
          speaker: p.speaker_username,
          me: p.speaker_is_me,
          body: p.message,
          at: p.created_at,
        }));
      if (fresh.length === 0) return prev;
      // Stable insert by created_at — persisted rows come in ASC order
      // from the server, but local system captions may have interleaved
      // timestamps in between (e.g. a /help typed while a peer message
      // was in flight). A merge-sort once per arrival is cheap.
      const merged = [...prev, ...fresh].sort(
        (a, b) => new Date(a.at).getTime() - new Date(b.at).getTime(),
      );
      return merged;
    });
  }, [persistedMessages, gameCode]);

  // Always scroll the chat to the bottom on new message — matches the
  // dominant chat-app convention (latest content visible by default).
  useEffect(() => {
    const node = messagesRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [messages]);

  function pushMessage(m: Omit<ChatMessage, "id" | "at">): string {
    const id = crypto.randomUUID();
    setMessages((prev) => [
      ...prev,
      { ...m, id, at: new Date().toISOString() },
    ]);
    return id;
  }


  // Replace the body of an existing local message in place. Used by the
  // /invite flow to backfill the freshly-allocated room code into the
  // user's echoed "/invite @target" line once the server returns it.
  function updateMessageBody(id: string, body: string) {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, body } : m)));
  }

  async function dispatchSlash(
    action: SlashAction,
    target: string,
    _message: string | undefined,
    // Optional id of the user's just-echoed local message ("/invite
    // @target ..."). For /invite, we patch this row to include the
    // server-issued code once the request returns, so the user has
    // "/invite @target CODE" visible in their own transcript.
    echoedMessageId?: string,
  ) {
    const spec = SLASH_SPECS[action];
    setPending(true);
    try {
      const payload: Record<string, string> = { target_username: target };
      // Slash commands no longer carry user-typed messages. The recipient
      // gets the invite as a modal dialog only; the code is echoed back
      // into the inviter's transcript by the post-response patch below.
      // `message` is intentionally omitted from the payload regardless
      // of the regex tail.
      const resp = await fetch(`${apiBase}${spec.endpoint}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) {
        // /invite intentionally masks the 403 "cannot_invite_blocker"
        // response: the spec doesn't want the inviter to learn they've
        // been blocked, only that the message couldn't go through. The
        // server still returns 403 with the detail, but we swap to a
        // bland delivery-failure caption here.
        if (action === "invite" && resp.status === 403) {
          pushMessage({
            speaker: "system",
            me: false,
            body: "Sorry, we couldn't deliver your message.",
            system: true,
            systemKind: "error",
          });
          return;
        }
        throw new Error(await formatErrorDetail(resp));
      }
      const body = (await resp.json().catch(() => ({}))) as SlashResponseBody;
      // Backfill the room code into the user's own echoed line. Local
      // echo only — the recipient gets the code via the incoming-
      // invites modal flow, keyed by the same code.
      if (action === "invite" && echoedMessageId && body.invited_code) {
        updateMessageBody(
          echoedMessageId,
          `/invite @${target} ${body.invited_code}`,
        );
      }
      pushMessage({
        speaker: "system",
        me: false,
        body: spec.successCaption(target, body),
        system: true,
        systemKind: "info",
      });
      if (body.game_terminated) onActiveGameTerminated?.();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown error";
      pushMessage({
        speaker: "system",
        me: false,
        body: spec.errorCaption(target, msg),
        system: true,
        systemKind: "error",
      });
    } finally {
      setPending(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setDraft("");

    // /help is local-only — never persisted (it's a UI affordance, not
    // part of the conversation).
    if (HELP_RE.test(text)) {
      pushMessage({ speaker: meUsername, me: true, body: "/help" });
      pushMessage({
        speaker: "system",
        me: false,
        body: HELP_TEXT,
        system: true,
        systemKind: "info",
      });
      return;
    }

    // /who opens the Who's Online modal — a UI affordance, never
    // persisted to the conversation. Same target as the header button.
    if (WHO_RE.test(text)) {
      onShowWhosOnline?.();
      return;
    }

    // "Store first, post-process later":
    //   1. Persist the literal text to /chat/{code}/messages so the
    //      opponent sees it (including literal `/invite @bob` for slash
    //      commands).
    //   2. After the POST succeeds, dispatch any slash-command side
    //      effect. A failed side-effect surfaces as an ephemeral system
    //      caption — the message itself stays in the log.
    //
    // Home-page right-rail has no `gameCode` → step 1 falls back to a
    // local-only echo (no peer, no persistence).
    // Echoed-message id of the literal "/invite @target …" line that the
    // user sees in their own transcript. Only set for the home-page
    // right-rail (no gameCode); for in-game chat the echoed message
    // comes back via the polled persisted stream and we can't patch it
    // locally without re-fetching.
    let echoedMessageId: string | undefined;
    if (gameCode) {
      try {
        await sendPersisted(text);
      } catch (err) {
        pushMessage({
          speaker: "system",
          me: false,
          body: `Could not send: ${err instanceof Error ? err.message : "unknown error"}`,
          system: true,
          systemKind: "error",
        });
        return;
      }
    } else {
      echoedMessageId = pushMessage({
        speaker: meUsername,
        me: true,
        body: text,
      });
    }

    for (const action of Object.keys(SLASH_RE) as SlashAction[]) {
      const m = text.match(SLASH_RE[action]);
      if (!m) continue;
      // m[2] is only captured by the /invite regex (optional trailing
      // freeform message). The other slash regexes have no second
      // capture group, so it's `undefined` and dispatchSlash ignores it.
      void dispatchSlash(action, m[1], m[2], echoedMessageId);
      return;
    }
  }

  // Header label: yellow @username, or a friendlier placeholder when nobody
  // is on the other end yet.
  const peerLabel = useMemo(() => {
    if (peerUsername) return `@${peerUsername}`;
    return "No conversation";
  }, [peerUsername]);

  // Tailwind classes per variant. Kept inline (vs CVA / className helper)
  // because there are only two variants and the diff between them is small
  // enough that a single colour palette per role is the clearest read.
  const styles = isLight
    ? {
        // In-game palette per design feedback: dark outer shell + header
        // + input row (so the chat reads as part of the dark game panel)
        // wrapping a **light-grey transcript** in the middle. Signature
        // amber/yellow is reserved for the speaker chips and the header
        // name. Messages are blue (own) and white (peer) so they pop off
        // the grey transcript without competing with the yellow accent.
        shell: "bg-neutral-900 border-neutral-700 shadow-md shadow-black/30",
        header: "bg-neutral-950 border-b border-neutral-800",
        headerEyebrow: "text-neutral-400",
        headerName: peerUsername ? "text-amber-400" : "text-neutral-500",
        // Scrollable transcript region — medium-grey (#777777) per the
        // design feedback. Darker than the original light-grey so the
        // amber speaker chips and the blue own-bubbles stay readable
        // against it; peer bubbles switch from white to a near-white
        // so they still have enough contrast.
        messagesBg: "bg-[#777777]",
        messages: "scrollbar-thin scrollbar-thumb-neutral-500",
        emptyState: "text-neutral-200",
        emptyAccent: "text-amber-300",
        inputRow: "bg-neutral-950 border-t border-neutral-800",
        input:
          "bg-neutral-800 border border-neutral-700 text-neutral-100 placeholder:text-neutral-500 " +
          "focus:outline-none focus:border-amber-500/70 focus:ring-1 focus:ring-amber-500/40",
        button:
          "bg-amber-500 text-neutral-900 hover:bg-amber-400 " +
          "disabled:cursor-not-allowed disabled:opacity-50 " +
          "focus:outline-none focus:ring-2 focus:ring-amber-300/50",
      }
    : {
        shell:
          "bg-neutral-900/70 border-neutral-700/80 shadow-inner shadow-black/30",
        header: "bg-neutral-950 border-b border-neutral-800",
        headerEyebrow: "text-neutral-500",
        headerName: peerUsername ? "text-amber-300" : "text-neutral-500",
        messagesBg: "",
        messages: "scrollbar-thin scrollbar-thumb-neutral-700",
        emptyState: "text-neutral-500",
        emptyAccent: "text-amber-300/90",
        inputRow: "bg-neutral-900 border-t border-neutral-800",
        input:
          "bg-neutral-800 border border-neutral-700 text-neutral-100 placeholder:text-neutral-500 " +
          "focus:outline-none focus:border-amber-500/70 focus:ring-1 focus:ring-amber-500/40",
        button:
          "bg-amber-600 text-neutral-900 hover:bg-amber-500 " +
          "disabled:cursor-not-allowed disabled:opacity-50 " +
          "focus:outline-none focus:ring-2 focus:ring-amber-300/50",
      };

  return (
    // Fixed-height column when used as the right-rail card; stretch-to-fill
    // when it replaces the entire left column during an in-game session.
    <div
      className={[
        "flex flex-col rounded-xl border overflow-hidden",
        sizeClass,
        styles.shell,
      ].join(" ")}
    >
      {/* Header.
          Three columns: peer info (left) — "Who's Online?" trigger (centre) —
          presence dot (right). The centre button is the same `/who` that the
          user could type into the input below; we surface it as a one-click
          affordance per the in-game UX feedback. */}
      <header
        className={[
          "flex items-center justify-between gap-3 px-4 py-2.5",
          styles.header,
        ].join(" ")}
      >
        <div className="flex flex-col min-w-0">
          <span
            className={[
              "text-[12px] uppercase tracking-[0.18em] font-semibold",
              styles.headerEyebrow,
            ].join(" ")}
          >
            Chat with
          </span>
          <span
            className={[
              "truncate font-heading text-[19px] font-semibold",
              styles.headerName,
            ].join(" ")}
          >
            {peerLabel}
          </span>
        </div>
        <button
          type="button"
          onClick={() => onShowWhosOnline?.()}
          aria-label="Show currently online players"
          className={[
            "rounded-md px-2.5 py-1 text-[12px] font-semibold font-heading",
            "transition-colors disabled:cursor-not-allowed disabled:opacity-50",
            isLight
              ? "bg-neutral-800 text-amber-300 hover:bg-neutral-700"
              : "bg-neutral-800 text-amber-300 hover:bg-neutral-700",
            "focus:outline-none focus:ring-2 focus:ring-amber-400/50",
          ].join(" ")}
        >
          Who's Online?
        </button>
        <PresenceDot connected={!!peerUsername} />
      </header>

      {/* Messages — scrolls. The light-grey background here is the
          "actual scrollable chat" the design feedback asked for; the
          dark shell + header + input row frame it. */}
      <div
        ref={messagesRef}
        className={[
          "flex-1 min-h-0 overflow-y-auto px-3 py-3 space-y-3",
          styles.messagesBg,
          styles.messages,
        ].join(" ")}
      >
        {messages.length === 0 && (
          <p
            className={["text-center text-[15px] mt-4", styles.emptyState].join(
              " ",
            )}
          >
            No messages yet. Say hi, type{" "}
            <code className={["font-mono", styles.emptyAccent].join(" ")}>
              /invite @username
            </code>{" "}
            to start a multiplayer game, or{" "}
            <code className={["font-mono", styles.emptyAccent].join(" ")}>
              /help
            </code>{" "}
            for the command list.
          </p>
        )}
        {messages.map((m) => (
          <Message key={m.id} m={m} variant={variant} />
        ))}
      </div>

      {/* Input row. */}
      <form
        onSubmit={handleSubmit}
        className={[
          "flex items-stretch gap-2 px-3 py-2.5",
          styles.inputRow,
        ].join(" ")}
      >
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={
            peerUsername
              ? `Message @${peerUsername} or /invite @username…`
              : "/invite @username to start a game"
          }
          disabled={pending}
          aria-label="Chat message"
          className={[
            "flex-1 min-w-0 rounded-lg px-3 py-2 text-[17px] disabled:opacity-60",
            styles.input,
          ].join(" ")}
        />
        <button
          type="submit"
          disabled={pending || draft.trim().length === 0}
          className={[
            "rounded-lg px-4 py-2 text-[17px] font-semibold font-heading transition-colors",
            styles.button,
          ].join(" ")}
        >
          Send
        </button>
      </form>
    </div>
  );
}

function Message({
  m,
  variant,
}: {
  m: ChatMessage;
  variant: "dark" | "light";
}) {
  const isLight = variant === "light";
  if (m.system) {
    // Multi-line system output (e.g. /help) is rendered in a monospaced
    // block so the column-aligned command list stays legible. Single-line
    // captions get the centred caption styling used elsewhere.
    const isMultiline = m.body.includes("\n");
    const bgBlock = isLight
      ? "bg-white border border-neutral-300"
      : "bg-neutral-800/60 border border-neutral-700/60";
    const errColor = isLight ? "text-red-700" : "text-red-400";
    const infoColor = isLight ? "text-blue-700" : "text-sky-300";
    return (
      <pre
        className={[
          "whitespace-pre-wrap text-[15px] px-3 py-2 rounded-md mx-2",
          isMultiline
            ? `font-mono text-left ${bgBlock}`
            : "text-center font-sans bg-transparent border-0",
          m.systemKind === "error" ? errColor : infoColor,
        ].join(" ")}
      >
        {m.body}
      </pre>
    );
  }
  // Convention follows iMessage / WhatsApp / Slack / Discord / Telegram:
  // the active user's bubbles sit on the RIGHT (white-on-blue), peer
  // bubbles on the LEFT. The asymmetric corner radius ("tail" pointing
  // toward the speaker's side) reinforces the side mapping at a glance.
  //
  // Speaker name is rendered as a small dark chip with amber text per
  // the in-game design feedback — even when the transcript background
  // is light grey, the username reads against a dark band in the
  // signature colour.
  const isMe = m.me;
  const speakerChip = isLight
    ? "bg-neutral-900 text-amber-400"
    : "bg-neutral-800 text-amber-300";
  const meBubble = isLight
    ? "rounded-tr-sm bg-blue-600 text-white"
    : "rounded-tr-sm bg-blue-600 text-white";
  const peerBubble = isLight
    ? "rounded-tl-sm bg-white text-neutral-900 border border-neutral-300"
    : "rounded-tl-sm bg-neutral-800 text-neutral-100 border border-neutral-700/60";
  const shadow = isLight
    ? "shadow-sm shadow-black/30"
    : "shadow-sm shadow-black/40";
  // Chat message text uses Barlow Condensed (loaded from Google Fonts in
  // index.html). The Tailwind arbitrary family `font-['Barlow_Condensed']`
  // emits `font-family: Barlow Condensed`; the condensed face keeps the
  // bubbles compact while staying comfortably readable.
  const bubbleText =
    "font-['Barlow_Condensed'] font-semibold text-[15px] leading-snug";
  return (
    <div
      className={[
        "flex flex-col max-w-[88%]",
        isMe ? "items-end ml-auto" : "items-start mr-auto",
      ].join(" ")}
    >
      <span
        className={[
          "inline-block rounded-full px-2 py-0.5 mb-1",
          "text-[13px] font-semibold uppercase tracking-[0.16em] font-heading",
          speakerChip,
          isMe ? "mr-1" : "ml-1",
        ].join(" ")}
      >
        @{m.speaker}
      </span>
      <div
        className={[
          "rounded-2xl px-4 py-2",
          bubbleText,
          shadow,
          isMe ? meBubble : peerBubble,
        ].join(" ")}
      >
        {m.body}
      </div>
    </div>
  );
}

function PresenceDot({ connected }: { connected: boolean }) {
  return (
    <span
      title={connected ? "Online" : "No conversation"}
      className={[
        "h-2.5 w-2.5 rounded-full",
        connected
          ? "bg-emerald-400 shadow-[0_0_6px_2px_rgba(74,222,128,0.45)]"
          : "bg-neutral-700",
      ].join(" ")}
    />
  );
}
