import {
  useState,
  useCallback,
  type ChangeEvent,
  type CSSProperties,
} from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import {
  oneDark,
  dracula,
  vscDarkPlus,
  nightOwl,
  nord,
  synthwave84,
  atomDark,
  darcula,
  gruvboxDark,
  materialOceanic,
  okaidia,
  solarizedDarkAtom,
} from "react-syntax-highlighter/dist/esm/styles/prism";
import { getLastExchange } from "../api";
import ModalShell from "./ModalShell";

const THEMES: Record<
  string,
  { label: string; style: Record<string, CSSProperties> }
> = {
  oneDark: { label: "One Dark", style: oneDark },
  dracula: { label: "Dracula", style: dracula },
  vscDarkPlus: { label: "VS Code Dark+", style: vscDarkPlus },
  nightOwl: { label: "Night Owl", style: nightOwl },
  nord: { label: "Nord", style: nord },
  synthwave84: { label: "Synthwave 84", style: synthwave84 },
  atomDark: { label: "Atom Dark", style: atomDark },
  darcula: { label: "Darcula", style: darcula },
  gruvboxDark: { label: "Gruvbox Dark", style: gruvboxDark },
  materialOceanic: { label: "Material Oceanic", style: materialOceanic },
  okaidia: { label: "Okaidia", style: okaidia },
  solarizedDarkAtom: { label: "Solarized Dark", style: solarizedDarkAtom },
};

const DEFAULT_THEME = "oneDark";

interface JsonDebugModalProps {
  className?: string;
}

export default function JsonDebugModal({ className }: JsonDebugModalProps) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"request" | "response">("request");
  const [themeKey, setThemeKey] = useState(DEFAULT_THEME);

  const exchange = getLastExchange();

  const handleOpen = useCallback(() => setOpen(true), []);
  const handleClose = useCallback(() => setOpen(false), []);
  const handleThemeChange = useCallback((e: ChangeEvent<HTMLSelectElement>) => {
    setThemeKey(e.target.value);
  }, []);

  const activeTheme = THEMES[themeKey] ?? THEMES.oneDark;
  const lastGamePayload = exchange?.response ?? exchange?.request ?? null;

  const handleDownload = useCallback(() => {
    if (!lastGamePayload) return;
    const blob = new Blob([JSON.stringify(lastGamePayload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `gomoku-game-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [lastGamePayload]);

  return (
    <>
      <button
        onClick={handleOpen}
        title="View this game"
        className={
          className ??
          "cursor-pointer px-2 py-1 text-neutral-400 transition-colors hover:text-neutral-200"
        }
      >
        View This Game
      </button>

      {open && (
        <ModalShell
          title={
            <>
              View <span className="text-amber-400">This Game</span>
            </>
          }
          onClose={handleClose}
          widthClassName="max-w-5xl"
          bodyClassName="space-y-4 p-0 sm:p-0"
          footer={
            <div className="flex gap-3">
              {exchange && (
                <button
                  onClick={handleDownload}
                  className="flex-1 rounded-xl bg-amber-500 py-3 text-lg font-bold font-heading
                             shadow-lg shadow-amber-900/30 transition-all cursor-pointer
                             hover:bg-amber-400 active:bg-amber-600"
                >
                  Download JSON
                </button>
              )}
              <button
                onClick={handleClose}
                className="flex-1 rounded-xl bg-green-600 py-3 text-lg font-bold font-heading
                           shadow-lg shadow-green-900/30 transition-all cursor-pointer
                           hover:bg-green-500 active:bg-green-700"
              >
                Close
              </button>
            </div>
          }
        >
          <div className="space-y-4 px-6 py-6 sm:px-8">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex rounded-xl border border-neutral-700 bg-neutral-900/60 p-1">
                <button
                  onClick={() => setTab("request")}
                  className={`rounded-lg px-4 py-2 text-sm font-semibold transition-colors cursor-pointer ${
                    tab === "request"
                      ? "bg-amber-500 text-neutral-950"
                      : "text-neutral-400 hover:text-neutral-200"
                  }`}
                >
                  Request
                </button>
                <button
                  onClick={() => setTab("response")}
                  className={`rounded-lg px-4 py-2 text-sm font-semibold transition-colors cursor-pointer ${
                    tab === "response"
                      ? "bg-amber-500 text-neutral-950"
                      : "text-neutral-400 hover:text-neutral-200"
                  }`}
                >
                  Response
                </button>
              </div>

              <select
                value={themeKey}
                onChange={handleThemeChange}
                className="cursor-pointer rounded-lg border border-neutral-600 bg-neutral-900 px-3 py-2
                           text-xs text-neutral-300 focus:border-amber-500 focus:outline-none"
              >
                {Object.entries(THEMES).map(([key, { label }]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </div>

            {!exchange ? (
              <div className="py-8 text-center text-neutral-500">
                No API calls have been made yet.
              </div>
            ) : (
              <div className="overflow-hidden rounded-2xl border border-neutral-700 bg-neutral-900">
                {exchange.error && tab === "response" && (
                  <div className="mx-4 mt-3 rounded border border-red-700/50 bg-red-900/30 px-3 py-2 text-sm text-red-400">
                    {exchange.error}
                  </div>
                )}
                <SyntaxHighlighter
                  language="json"
                  style={activeTheme.style}
                  customStyle={{
                    margin: 0,
                    borderRadius: 0,
                    fontSize: "12px",
                    maxHeight: "50vh",
                  }}
                  wrapLongLines
                >
                  {JSON.stringify(
                    tab === "request"
                      ? exchange.request
                      : (exchange.response ?? null),
                    null,
                    2,
                  )}
                </SyntaxHighlighter>
                <div className="border-t border-neutral-700 px-5 py-2">
                  <span className="text-xs text-neutral-500">
                    {new Date(exchange.timestamp).toLocaleTimeString()}
                  </span>
                </div>
              </div>
            )}
          </div>
        </ModalShell>
      )}
    </>
  );
}
