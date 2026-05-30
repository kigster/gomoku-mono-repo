import ModalShell from "./ModalShell";

interface AboutModalProps {
  onClose: () => void;
}

export default function AboutModal({ onClose }: AboutModalProps) {
  return (
    <ModalShell
      title={
        <>
          About the <span className="text-amber-400">Author</span>
        </>
      }
      onClose={onClose}
      widthClassName="max-w-5xl"
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
      <p className="text-lg">
        <span className="font-heading font-bold text-amber-400">Gomoku</span> is
        a networked five-in-a-row game with a C-powered AI backend and a React
        frontend, running on Google Cloud infrastructure.
      </p>

      <section>
        <h3 className="mb-2 font-bold text-white">History</h3>
        <p>
          Konstantin Gredeskoul started writing this game around{" "}
          <strong>2010</strong>. The original engine was based on a carefully
          tuned evaluation function before minimax and deeper search machinery
          were added later.
        </p>
        <p className="mt-2">
          Over time the engine grew into a stronger opponent with minimax,
          alpha-beta pruning, iterative deepening, transposition caching, and
          threat-sequence detection.
        </p>
      </section>

      <section>
        <h3 className="mb-2 font-bold text-white">Technology</h3>
        <ul className="ml-2 list-inside list-disc space-y-1">
          <li>
            Game engine: <strong>ANSI C</strong> with an HTTP server layer
          </li>
          <li>
            Frontend: <strong>React + TypeScript + Vite + TailwindCSS</strong>
          </li>
          <li>
            Infrastructure: <strong>Google Cloud Run</strong> with Docker
            containers
          </li>
        </ul>
      </section>

      <section>
        <h3 className="mb-2 font-bold text-white">Links</h3>
        <div className="flex flex-wrap gap-4">
          <a
            href="https://kig.re/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-amber-400 underline underline-offset-2 transition-colors hover:text-amber-300"
          >
            kig.re
          </a>
          <a
            href="https://reinvent.one"
            target="_blank"
            rel="noopener noreferrer"
            className="text-amber-400 underline underline-offset-2 transition-colors hover:text-amber-300"
          >
            reinvent.one
          </a>
          <a
            href="https://github.com/kigster/gomoku-ansi-c"
            target="_blank"
            rel="noopener noreferrer"
            className="text-amber-400 underline underline-offset-2 transition-colors hover:text-amber-300"
          >
            GitHub
          </a>
        </div>
      </section>

      <footer className="border-t border-neutral-700 pt-3 text-sm text-neutral-400">
        &copy; 2026{" "}
        <a
          href="https://kig.re/"
          target="_blank"
          rel="noopener noreferrer"
          className="text-neutral-300 transition-colors hover:text-amber-400"
        >
          Konstantin Gredeskoul
        </a>
        . Co-authored by <span className="text-neutral-300">Claude AI</span>.
      </footer>
    </ModalShell>
  );
}
