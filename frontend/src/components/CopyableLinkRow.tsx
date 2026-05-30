import { useState } from "react";

interface Props {
  /** URL to display + copy. */
  url: string;
  className?: string;
}

/**
 * Single-line, non-wrapping URL display with a copy button. Used by the
 * multiplayer invite flow so the host can share a link without wrap noise.
 */
export default function CopyableLinkRow({ url, className = "" }: Props) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className={`flex items-stretch gap-2 ${className}`}>
      <input
        readOnly
        value={url}
        aria-label="Invitation link"
        className="min-w-0 flex-1 truncate rounded-md border border-neutral-600 bg-neutral-900 px-3 py-2 font-mono text-sm text-neutral-100 focus:outline-none focus:ring-2 focus:ring-amber-500/50"
        onFocus={(e) => e.currentTarget.select()}
      />
      <button
        type="button"
        onClick={handleCopy}
        aria-label={copied ? "Link copied" : "Copy link"}
        title={copied ? "Copied!" : "Copy link"}
        className="inline-flex items-center justify-center rounded-md border border-neutral-600 bg-neutral-700 px-3 py-2 text-sm font-medium text-neutral-100 transition hover:bg-neutral-600 active:bg-neutral-700 focus:outline-none focus:ring-2 focus:ring-amber-500/50"
      >
        {copied ? (
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
        ) : (
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        )}
      </button>
    </div>
  );
}
