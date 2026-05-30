import { useState, useEffect } from "react";
import { trackEntered, trackAbandoned } from "../analytics";

interface NameModalProps {
  onSubmit: (name: string) => void;
  currentName?: string;
  onClose?: () => void;
}

export default function NameModal({
  onSubmit,
  currentName,
  onClose,
}: NameModalProps) {
  const [name, setName] = useState(currentName ?? "");
  const isRename = !!currentName;

  useEffect(() => {
    if (!isRename) {
      const handler = () => trackAbandoned();
      window.addEventListener("beforeunload", handler);
      return () => window.removeEventListener("beforeunload", handler);
    }
  }, [isRename]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (name.trim()) {
      if (!isRename) trackEntered(name.trim());
      onSubmit(name.trim());
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <form
        onSubmit={handleSubmit}
        className="bg-neutral-800 rounded-2xl shadow-2xl p-8 max-w-md w-full mx-4 relative"
      >
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
        <h2 className="text-2xl font-bold mb-2 text-center text-white">
          {isRename ? (
            <>
              Rename <span className="font-heading text-amber-400">Player</span>
            </>
          ) : (
            <>
              Welcome to{" "}
              <span className="font-heading text-amber-400">Gomoku</span>
            </>
          )}
        </h2>
        <p
          className="text-neutral-400 text-center mb-6"
          style={{ fontSize: "14pt" }}
        >
          {isRename ? (
            "Enter your new player name below."
          ) : (
            <>
              What should we call you?
              <br />
              <span className="text-neutral-500">
                (just so we can address you properly &mdash; saved locally in
                your browser)
              </span>
            </>
          )}
        </p>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Your name"
          autoFocus
          className="w-full px-4 py-3 rounded-lg bg-neutral-700 border border-neutral-600
                     text-neutral-100 placeholder-neutral-500 focus:outline-none
                     focus:border-amber-500 focus:ring-1 focus:ring-amber-500 mb-4"
        />
        <div className="flex gap-3">
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-3 rounded-lg font-semibold text-lg
                         bg-neutral-700 hover:bg-neutral-600 text-neutral-300
                         transition-colors"
            >
              Cancel
            </button>
          )}
          <button
            type="submit"
            disabled={!name.trim() || (isRename && name.trim() === currentName)}
            className="flex-1 py-3 rounded-lg font-semibold text-lg
                       bg-amber-600 hover:bg-amber-500 disabled:bg-neutral-600
                       disabled:text-neutral-400 transition-colors"
          >
            {isRename ? "Save" : "Continue"}
          </button>
        </div>
      </form>
    </div>
  );
}
