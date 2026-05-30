import type { ReactNode } from "react";
import ModalShell from "./ModalShell";

interface RulesModalProps {
  onClose: () => void;
}

export default function RulesModal({ onClose }: RulesModalProps) {
  return (
    <ModalShell
      title={
        <>
          Gomoku <span className="text-amber-400">Rules</span>
        </>
      }
      onClose={onClose}
      widthClassName="max-w-5xl"
      bodyClassName="space-y-6 text-neutral-300 rules-content"
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
      <Section title="What is Gomoku?">
        <p>
          Gomoku (also known as <em>Five in a Row</em>, <em>Go-Moku</em>, or{" "}
          <em>Gobang</em>) is an abstract strategy board game traditionally
          played with black and white stones on a Go board. The standard board
          is 15&times;15, though 19&times;19 is also common. Players alternate
          placing stones on empty intersections, and the first to form an
          unbroken line of <strong>five stones</strong> horizontally,
          vertically, or diagonally wins.
        </p>
      </Section>

      <Section title="Basic Rules">
        <ol className="list-decimal space-y-2">
          <li>
            <strong>Black plays first.</strong> Players alternate turns, placing
            one stone per turn.
          </li>
          <li>
            Stones are placed on <strong>intersections</strong> of the grid
            lines, not inside squares.
          </li>
          <li>
            Once placed, stones are <strong>never moved or removed</strong>.
          </li>
          <li>
            The first player to get <strong>exactly five in a row</strong> wins.
          </li>
          <li>
            If the board fills up with no five-in-a-row, the game is a{" "}
            <strong>draw</strong>.
          </li>
        </ol>
      </Section>

      <Section title="Game Variants">
        <h4 className="mb-1 mt-2 font-semibold text-amber-400">
          Standard Gomoku
        </h4>
        <p>
          A line of <em>exactly</em> five wins. An overline of six or more
          stones does <em>not</em> count as a win &mdash; if you fill a gap and
          end up with six in a row, the game continues.{" "}
          <strong>This is what we play by default in this app</strong>, for both
          human and AI sides.
        </p>

        <h4 className="mb-1 mt-4 font-semibold text-amber-400">
          Freestyle Gomoku
        </h4>
        <p>
          The simplest variant. Five <em>or more</em> stones in a row wins. No
          restrictions on opening moves. We do not play this variant here
          &mdash; the engine treats overlines as sterile rather than winning.
        </p>

        <h4 className="mb-1 mt-4 font-semibold text-amber-400">Renju</h4>
        <p>
          A tournament variant designed to offset Black&rsquo;s first-move
          advantage. Black is subject to three additional restrictions:
        </p>
        <ul className="mt-1 list-disc space-y-1">
          <li>
            <strong>Double-three:</strong> Black cannot place a stone that
            creates two open rows of three.
          </li>
          <li>
            <strong>Double-four:</strong> Black cannot create two rows of four
            at the same time.
          </li>
          <li>
            <strong>Overline:</strong> A line of six or more does not count as a
            win for Black.
          </li>
        </ul>
        <p className="mt-1">
          White has no such restrictions and can win with an overline. Renju
          rules are <em>not</em> enforced by this app.
        </p>

        <h4 className="mb-1 mt-4 font-semibold text-amber-400">
          Swap / Swap2 Opening
        </h4>
        <p>
          To further balance the game, some tournaments use opening rules where
          the first player places one or more stones and the opponent can choose
          to swap colors. Not implemented here.
        </p>
      </Section>

      <Section title="The First-Mover Advantage">
        <p>
          In unrestricted Gomoku on a 15&times;15 board, Black has a proven
          winning strategy. This is why tournament rules like Renju and swap
          openings exist, and why choosing White can be a fun handicap if you
          want more of a challenge.
        </p>
      </Section>

      <Section title="Strategy Tips">
        <h4 className="mb-2 font-semibold text-amber-400">Build Threats</h4>
        <p>
          The key to winning Gomoku is creating <strong>threats</strong>:
          positions that force your opponent to respond defensively.
        </p>
        <ul className="mt-2 list-disc space-y-1">
          <li>
            <strong>Open Four</strong> (<code>_XXXX_</code>): four in a row with
            both ends empty. Unstoppable.
          </li>
          <li>
            <strong>Closed Four</strong> (<code>OXXXX_</code>): four in a row
            with one end blocked. Forces an immediate answer.
          </li>
          <li>
            <strong>Broken Four</strong> (<code>XX_XX</code> or{" "}
            <code>X_XXX</code>): four stones with one gap. Filling the gap makes
            five &mdash; must block, just like a closed four.
          </li>
          <li>
            <strong>Open Three</strong> (<code>_XXX_</code>): three in a row
            with both ends open. Often the start of a winning sequence &mdash;
            either extension creates an open four.
          </li>
          <li>
            <strong>Broken Three</strong> (<code>_XX_X_</code>) with both ends
            open: looks innocent, but filling the gap creates an open four.
            Treat it as seriously as an open three.
          </li>
        </ul>

        <h4 className="mb-2 mt-4 font-semibold text-amber-400">
          Threat Sequences
        </h4>
        <p>
          Strong play revolves around chaining forcing moves until you reach an
          unavoidable win, such as a double-four or four-three fork.
        </p>

        <h4 className="mb-2 mt-4 font-semibold text-amber-400">General Tips</h4>
        <ul className="list-disc space-y-1">
          <li>
            Play near the <strong>center</strong> early to maximize options.
          </li>
          <li>
            Always check for an opponent <strong>four</strong> or{" "}
            <strong>open three</strong> before attacking.
          </li>
          <li>
            Create <strong>double threats</strong> whenever possible.
          </li>
          <li>
            Keep your stones <strong>connected</strong>; scattered stones are
            inefficient.
          </li>
        </ul>
      </Section>
    </ModalShell>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-lg font-bold text-white">{title}</h3>
      {children}
    </section>
  );
}
