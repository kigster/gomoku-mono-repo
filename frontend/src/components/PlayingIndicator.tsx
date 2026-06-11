// A tiny animated tic-tac-toe board used in the Who's Online table to
// mark a user who is currently in a game ("playing"). Implemented as an
// inline SVG with SMIL animation rather than an animated GIF so it stays
// crisp at every size (70px on desktop, 25px on phones) and needs no
// asset pipeline — the marks pop in one at a time on a looping ~5s
// timeline, then clear and replay.
//
// Colours are fixed (not `currentColor`) so the indicator reads on every
// row background the table uses — green (friend), dark-red (blocked), and
// neutral alike.

interface PlayingIndicatorProps {
  // Sizing is driven by `className` (Tailwind h-/w-, which override the
  // SVG width/height below). The attributes are only a fallback for a
  // caller that supplies no sizing class.
  className?: string;
}

// Cell centres on a 90×90 viewBox (three 30px cells: centres 15/45/75).
// Each entry is a move in play order; `kind` picks the glyph. The order
// deliberately mixes X and O across the board so the loop reads as a
// real game unfolding.
const MOVES: Array<{ kind: "x" | "o"; cx: number; cy: number }> = [
  { kind: "x", cx: 45, cy: 45 },
  { kind: "o", cx: 15, cy: 15 },
  { kind: "x", cx: 75, cy: 75 },
  { kind: "o", cx: 75, cy: 15 },
  { kind: "x", cx: 15, cy: 75 },
];

const CYCLE = "5s";
const X_COLOR = "#f59e0b"; // amber
const O_COLOR = "#38bdf8"; // sky

export default function PlayingIndicator({
  className = "",
}: PlayingIndicatorProps) {
  return (
    <svg
      width={70}
      height={70}
      viewBox="0 0 90 90"
      className={className}
      role="img"
      aria-label="In a game"
    >
      <title>In a game</title>
      {/* Grid: two vertical + two horizontal lines at the thirds. */}
      <g stroke="rgba(255,255,255,0.55)" strokeWidth={3} strokeLinecap="round">
        <line x1={30} y1={6} x2={30} y2={84} />
        <line x1={60} y1={6} x2={60} y2={84} />
        <line x1={6} y1={30} x2={84} y2={30} />
        <line x1={6} y1={60} x2={84} y2={60} />
      </g>

      {MOVES.map((mv, i) => {
        // Each mark appears at its slot in the timeline and holds until
        // the cycle resets. Equal slices across the 5 moves, all cleared
        // near the end (0.9) before the loop restarts.
        const appearAt = (0.12 + i * 0.15).toFixed(2);
        const anim = (
          <animate
            attributeName="opacity"
            values="0;0;1;1;0"
            keyTimes={`0;${appearAt};${appearAt};0.9;1`}
            dur={CYCLE}
            repeatCount="indefinite"
          />
        );
        if (mv.kind === "o") {
          return (
            <circle
              key={i}
              cx={mv.cx}
              cy={mv.cy}
              r={9}
              fill="none"
              stroke={O_COLOR}
              strokeWidth={4}
              opacity={0}
            >
              {anim}
            </circle>
          );
        }
        return (
          <g
            key={i}
            stroke={X_COLOR}
            strokeWidth={4}
            strokeLinecap="round"
            opacity={0}
          >
            <line x1={mv.cx - 8} y1={mv.cy - 8} x2={mv.cx + 8} y2={mv.cy + 8} />
            <line x1={mv.cx + 8} y1={mv.cy - 8} x2={mv.cx - 8} y2={mv.cy + 8} />
            {anim}
          </g>
        );
      })}
    </svg>
  );
}
