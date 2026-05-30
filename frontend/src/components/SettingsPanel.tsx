import type { GameSettings, DisplayMode, PlayerSide } from "../types";
import { TIMEOUT_OPTIONS } from "../constants";

interface SettingsPanelProps {
  settings: GameSettings;
  onChange: (settings: GameSettings) => void;
  disabled: boolean;
}

export default function SettingsPanel({
  settings,
  onChange,
  disabled,
}: SettingsPanelProps) {
  const update = (patch: Partial<GameSettings>) =>
    onChange({ ...settings, ...patch });
  const isStones = settings.displayMode === "stones";

  const labelCls = "text-neutral-400 text-sm shrink-0";
  const valueBadge =
    "font-mono text-amber-300 text-xs bg-neutral-900/70 px-2 py-0.5 rounded-md border border-neutral-700/50";

  return (
    <div className="glass-card rounded-xl p-5">
      <h3 className="font-heading text-lg font-bold text-amber-400 mb-5">
        Settings
      </h3>

      <div className="space-y-5">
        {/* AI Search Depth */}
        <div>
          <div className="flex justify-between items-center mb-2">
            <label className={labelCls}>AI Depth</label>
            <span className={valueBadge}>{settings.aiDepth}</span>
          </div>
          <input
            type="range"
            min={2}
            max={7}
            value={settings.aiDepth}
            onChange={(e) => update({ aiDepth: Number(e.target.value) })}
            disabled={disabled}
          />
          <div className="flex justify-between mt-1">
            <span className="text-neutral-700 text-[10px]">Fast</span>
            <span className="text-neutral-700 text-[10px]">Deep</span>
          </div>
        </div>

        {/* AI Search Radius */}
        <div>
          <div className="flex justify-between items-center mb-2">
            <label className={labelCls}>AI Radius</label>
            <span className={valueBadge}>{settings.aiRadius}</span>
          </div>
          <input
            type="range"
            min={1}
            max={4}
            value={settings.aiRadius}
            onChange={(e) => update({ aiRadius: Number(e.target.value) })}
            disabled={disabled}
          />
          <div className="flex justify-between mt-1">
            <span className="text-neutral-700 text-[10px]">Narrow</span>
            <span className="text-neutral-700 text-[10px]">Wide</span>
          </div>
        </div>

        <div className="border-t border-neutral-700/40" />

        {/* AI Timeout */}
        <div className="flex items-center justify-between gap-4">
          <label className={labelCls}>AI Timeout</label>
          <select
            value={settings.aiTimeout}
            onChange={(e) => update({ aiTimeout: e.target.value })}
            disabled={disabled}
            className="bg-neutral-900/70 border border-neutral-700/60 rounded-lg px-3 py-1.5
                       text-sm text-neutral-200 focus:outline-none focus:border-amber-500
                       disabled:opacity-35 disabled:cursor-not-allowed min-w-[100px]"
          >
            {TIMEOUT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        <div className="border-t border-neutral-700/40" />

        {/* Display Mode — segmented control */}
        <div>
          <label className={`${labelCls} block mb-2`}>Display</label>
          <div className="flex rounded-lg border border-neutral-700/60 bg-neutral-900/50 p-0.5 gap-0.5">
            {(
              [
                ["stones", "Stones"],
                ["xo", "X & O"],
              ] as [DisplayMode, string][]
            ).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                onClick={() => !disabled && update({ displayMode: mode })}
                disabled={disabled}
                className={`flex-1 py-1.5 text-xs font-semibold rounded-md transition-all
                  ${
                    settings.displayMode === mode
                      ? "bg-amber-600 text-white shadow-sm"
                      : "text-neutral-500 hover:text-neutral-300"
                  }
                  ${disabled ? "opacity-35 cursor-not-allowed" : "cursor-pointer"}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Allow Undo — toggle switch */}
        <div className="flex items-center justify-between gap-4">
          <label htmlFor="undo-toggle" className={`${labelCls} cursor-pointer`}>
            Allow Undo
          </label>
          <button
            id="undo-toggle"
            type="button"
            role="switch"
            aria-checked={settings.undoEnabled}
            onClick={() =>
              !disabled && update({ undoEnabled: !settings.undoEnabled })
            }
            disabled={disabled}
            className={`relative inline-flex h-5 w-10 shrink-0 rounded-full transition-colors duration-200
                        focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-500
                        ${settings.undoEnabled ? "bg-amber-600" : "bg-neutral-700"}
                        ${disabled ? "opacity-35 cursor-not-allowed" : "cursor-pointer"}`}
          >
            <span
              className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-sm
                             ring-0 transition-transform duration-200 mt-0.5
                             ${settings.undoEnabled ? "translate-x-5" : "translate-x-0.5"}`}
            />
          </button>
        </div>

        <div className="border-t border-neutral-700/40" />

        {/* Your Side */}
        <div>
          <div className="flex justify-between items-center mb-2">
            <label className={labelCls}>Your Side</label>
            <span className="text-neutral-600 text-[10px] uppercase tracking-wide">
              {settings.playerSide === "X" ? "Goes first" : "Goes second"}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {(["X", "O"] as PlayerSide[]).map((side) => {
              const label = isStones
                ? side === "X"
                  ? "⬛ Black"
                  : "⬜ White"
                : side === "X"
                  ? "✕ First"
                  : "○ Second";
              const active = settings.playerSide === side;
              return (
                <button
                  key={side}
                  onClick={() => !disabled && update({ playerSide: side })}
                  disabled={disabled}
                  className={`py-2.5 px-3 rounded-lg text-sm font-semibold transition-all
                    ${
                      active
                        ? "bg-amber-600 text-white ring-1 ring-amber-500/50 shadow-md shadow-amber-900/30"
                        : "bg-neutral-900/60 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 border border-neutral-700/50"
                    }
                    ${disabled ? "opacity-35 cursor-not-allowed" : "cursor-pointer"}`}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
