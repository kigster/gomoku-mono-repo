import { useCallback, useState } from "react";

interface WaitingForOpponentProps {
  code: string;
}

export default function WaitingForOpponent({ code }: WaitingForOpponentProps) {
  const [copied, setCopied] = useState(false);
  const url = `${window.location.origin}/play/${code}`;

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard API not available — fall back to selecting the input.
      const input = document.getElementById(
        "mp-share-url",
      ) as HTMLInputElement | null;
      input?.select();
    }
  }, [url]);

  return (
    <div className="w-full max-w-xl rounded-xl border border-neutral-700 bg-neutral-800/80 shadow-xl shadow-black/30 backdrop-blur-sm">
      <div className="flex flex-col items-center gap-4 p-6 text-center">
        <h2 className="font-heading text-2xl text-amber-400 font-bold">
          Waiting for opponent…
        </h2>
        <p className="text-neutral-300">
          Share this link with your friend so they can join:
        </p>
        <div className="text-4xl font-mono tracking-widest text-amber-300 px-6 py-3 rounded-lg bg-neutral-900/60 border border-neutral-700">
          {code}
        </div>
        <div className="w-full max-w-md flex gap-2">
          <input
            id="mp-share-url"
            readOnly
            value={url}
            className="flex-1 px-3 py-2 rounded-lg bg-neutral-800 border border-neutral-700 text-neutral-200 font-mono text-sm"
            onFocus={(e) => e.currentTarget.select()}
          />
          <button
            onClick={handleCopy}
            className="px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 active:bg-amber-700 text-neutral-900 font-semibold transition-colors"
          >
            {copied ? "Copied!" : "Copy link"}
          </button>
        </div>
        <p className="text-sm text-neutral-500 mt-2">
          The game will start automatically when your opponent joins.
        </p>
      </div>
    </div>
  );
}
