import ModalShell from "./ModalShell";

interface DifficultySettingsModalProps {
  onClose: () => void;
}

export default function DifficultySettingsModal({
  onClose,
}: DifficultySettingsModalProps) {
  return (
    <ModalShell
      title={
        <>
          Difficulty <span className="text-amber-400">Settings</span>
        </>
      }
      onClose={onClose}
      widthClassName="max-w-3xl"
      bodyClassName="space-y-5 text-neutral-300"
      footer={
        <button
          onClick={onClose}
          className="w-full rounded-xl bg-green-600 py-3 text-lg font-bold font-heading
                     shadow-lg shadow-green-900/30 transition-all cursor-pointer
                     hover:bg-green-500 active:bg-green-700"
        >
          Close
        </button>
      }
    >
      <p className="text-lg text-neutral-200">
        This game exposes a couple of settings for you to control your AI
        opponent.
      </p>
      <div className="rounded-2xl border border-amber-500/20 bg-amber-500/8 p-5">
        <p className="font-semibold text-amber-300">AI Difficulty Settings</p>
        <p className="mt-2">The following elements are in your control:</p>
        <ul className="list-disc ml-4 mt-2 space-y-3">
          <li>
            <strong>AI Depth</strong> (range{" "}
            <span className="font-mono">2–7</span>, default{" "}
            <span className="font-mono">5</span>) — imagine playing chess in
            your head: "if I go here, then my opponent will probably go there,
            then I'll go here…" Each one of those steps is called a <em>ply</em>
            . AI Depth is just how many plies the AI looks ahead before it picks
            a move. Depth 2 means it only thinks "my move, your move." Depth 5
            means it thinks five moves into the future. Higher depth = stronger
            play, but also more thinking time (each extra ply roughly multiplies
            the work).
            <div className="mt-2 rounded-lg border border-amber-500/15 bg-neutral-950/40 p-3 text-sm">
              <strong className="text-amber-200">
                Why odd vs. even depth matters:
              </strong>{" "}
              this is a real quirk of the minimax algorithm called the{" "}
              <em>odd–even effect</em>. At an <strong>odd</strong> depth (3, 5,
              7) the search ends right after the AI makes a move — so the AI
              sees its own attack land but doesn't see your reply to it. That
              makes attacks look extra shiny, so the AI plays more aggressively
              (it favors <em>the attacker</em>). At an <strong>even</strong>{" "}
              depth (2, 4, 6) the search ends with <em>your</em> reply, meaning
              the AI always checks whether you can shut down its threats. That
              makes it more cautious and defensive (it favors{" "}
              <em>the defender</em>). So if you want a hyper-aggressive
              opponent, pick 5 or 7. If you want a careful, hard-to-beat wall,
              pick 4 or 6.
            </div>
          </li>
          <li>
            <strong>AI Radius</strong> (range{" "}
            <span className="font-mono">1–4</span>, default{" "}
            <span className="font-mono">2</span>) — the board has 361
            intersections (19×19), and checking every empty one every turn would
            take forever. So the AI only looks at empty spots that are within{" "}
            <em>Radius</em> squares of a stone that's already on the board.
            Radius 1 = only the squares right next to existing stones (super
            fast, but the AI misses long-range traps). Radius 2 (the default) is
            the sweet spot — it sees most useful moves without slowing down.
            Radius 3 or 4 lets the AI consider sneakier, farther-away moves, but
            the search gets dramatically slower because there are way more
            squares to think about.
          </li>
          <li>
            <strong>AI Timeout</strong> — how long the AI is allowed to think
            before it has to commit. If you set it to 30 seconds and the AI is
            still searching when the timer hits zero, it stops and plays the
            best move it found so far. Use this only if the AI is taking forever
            and you'd rather move along :)
          </li>
          <li>
            <strong>Who moves first.</strong> Gomoku has a strong first-mover
            advantage, so if you want extra hard mode, play as the second player
            (white / O).
          </li>
          <li>
            Finally, you can choose whether to play with black-and-white stones
            or X's and O's — purely a visual preference.
          </li>
        </ul>
        <p className="mt-4 text-sm text-neutral-400">
          <strong className="text-amber-300">Quick recipe:</strong> for a
          balanced game, depth <span className="font-mono">5</span> + radius{" "}
          <span className="font-mono">2</span> is the default and plays well.
          For a brutal attacker, try depth <span className="font-mono">7</span>{" "}
          + radius <span className="font-mono">2</span>. For a stubborn defender
          that's hard to beat, try depth <span className="font-mono">6</span> +
          radius <span className="font-mono">3</span> (and bring a snack — it'll
          think for a while).
        </p>
        <p className="font-semibold text-amber-300 mt-4">Leaderboard Scoring</p>
        <p className="mt-2">
          Anytime you win, your score is automatically computed and saved in the
          database. The top 100 global players who have the highest score on at
          least one game are shown on the leaderboard.
        </p>
        <p className="mt-2">
          Therefore it would probably be a good idea to explain how the score is
          computed.
        </p>
        <ul className="list-disc ml-4 mt-2 space-y-1">
          <li>
            The score rewards the games that you win quickly, and penalizes the
            games that you lose slowly.
          </li>
          <li>
            The score rewards when you win against more difficult AI settings
            (such as higher depth and radius)
          </li>
          <li>
            Finally, if you play the second turn player (white stone or a O) you
            get an additional bump in the final score because of the well known
            first-mover advantage.
          </li>
        </ul>
        <p className="mt-2">
          NOTE: Lost games count as zero points and have no affect.
        </p>
        <p className="mt-2">
          If you have any suggestions on how to improve the scoring system,
          please reach out to us at kig AT kig.re.
        </p>
      </div>
    </ModalShell>
  );
}
