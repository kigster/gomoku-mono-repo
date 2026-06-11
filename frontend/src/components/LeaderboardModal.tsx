import { useState, useEffect } from "react";
import ModalShell from "./ModalShell";
import crownIcon from "../../assets/images/crown-transparent.png";

interface LeaderboardEntry {
  username: string;
  elo_rating: number;
  elo_games_count: number;
  score: number;
  rating: number;
  depth: number;
  radius: number;
  total_moves: number;
  human_time_s: number;
  geo_country: string | null;
  geo_city: string | null;
  played_at: string;
}

interface LeaderboardModalProps {
  apiBase: string;
  onClose: () => void;
}

export default function LeaderboardModal({
  apiBase,
  onClose,
}: LeaderboardModalProps) {
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch(`${apiBase}/leaderboard?limit=100`)
      .then((r) => {
        if (!r.ok) throw new Error("Failed to load leaderboard");
        return r.json();
      })
      .then((data) => setEntries(data.entries))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [apiBase]);

  return (
    <ModalShell
      title={
        <>
          Worldwide <span className="text-amber-400">Leaderboard</span>
        </>
      }
      onClose={onClose}
      widthClassName="max-w-4xl"
      bodyClassName="space-y-4"
    >
      <p className="text-center text-sm text-neutral-500">
        Top 100 players worldwide
      </p>
      <p className="text-center text-xs italic text-neutral-500">
        Ranked by Gomocup-style Elo (BayesElo with eloAdvantage=0,
        eloDraw=0.01). NOTE: Only games of humans vs AI are counted.
      </p>

      {loading && (
        <p className="py-8 text-center text-neutral-400">Loading...</p>
      )}

      {error && <p className="py-8 text-center text-red-400">{error}</p>}

      {!loading && !error && entries.length === 0 && (
        <p className="py-8 text-center text-neutral-400">
          No scores yet. Be the first to win a game.
        </p>
      )}

      {!loading && !error && entries.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-neutral-800">
              <tr className="border-b border-neutral-700 text-neutral-400">
                <th className="w-10 px-2 py-2 text-left">#</th>
                <th className="px-2 py-2 text-left">Player</th>
                <th className="px-2 py-2 text-right">Elo</th>
                <th className="hidden px-2 py-2 text-right sm:table-cell">
                  Games
                </th>
                <th className="hidden px-2 py-2 text-right sm:table-cell">
                  Best Score
                </th>
                <th className="hidden px-2 py-2 text-center md:table-cell">
                  Best Depth
                </th>
                <th className="hidden px-2 py-2 text-right md:table-cell">
                  Time
                </th>
                <th className="hidden px-2 py-2 text-left lg:table-cell">
                  Location
                </th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry, i) => (
                <tr
                  key={`${entry.username}-${i}`}
                  className={`border-b border-neutral-700/50 transition-colors hover:bg-neutral-700/30 ${
                    i === 0
                      ? "font-semibold text-amber-400"
                      : i < 3
                        ? "text-amber-200"
                        : "text-neutral-300"
                  }`}
                >
                  <td className="px-2 py-2">{i + 1}</td>
                  <td className="px-2 py-2 font-medium">
                    <span className="inline-flex items-center gap-2">
                      <span>{entry.username}</span>
                      {i === 0 && (
                        <img
                          src={crownIcon}
                          alt="Champion"
                          title="Current champion"
                          className="h-[25px] w-[25px] shrink-0 sm:h-[70px] sm:w-[70px]"
                        />
                      )}
                    </span>
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums font-semibold">
                    {entry.elo_rating}
                  </td>
                  <td className="hidden px-2 py-2 text-right tabular-nums sm:table-cell">
                    {entry.elo_games_count}
                  </td>
                  <td className="hidden px-2 py-2 text-right tabular-nums sm:table-cell text-neutral-400">
                    {entry.score.toLocaleString()}
                  </td>
                  <td className="hidden px-2 py-2 text-center md:table-cell text-neutral-400">
                    d{entry.depth}/r{entry.radius}
                  </td>
                  <td className="hidden px-2 py-2 text-right tabular-nums md:table-cell text-neutral-400">
                    {entry.human_time_s}s
                  </td>
                  <td className="hidden px-2 py-2 text-neutral-500 lg:table-cell">
                    {[entry.geo_city, entry.geo_country]
                      .filter(Boolean)
                      .join(", ") || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </ModalShell>
  );
}
