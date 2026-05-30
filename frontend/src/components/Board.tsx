import { useCallback, useMemo } from "react";
import type { CellValue, DisplayMode } from "../types";
import { STAR_POINTS_19, STAR_POINTS_15, BOARD_PX } from "../constants";
import stoneBlack from "../../assets/images/stone-black.png";
import stoneWhite from "../../assets/images/stone-white.png";

interface BoardProps {
  board: CellValue[][];
  boardSize: 15 | 19;
  displayMode: DisplayMode;
  interactive: boolean;
  lastMove: [number, number] | null;
  onCellClick: (row: number, col: number) => void;
}

const PADDING = 24;

export default function Board({
  board,
  boardSize,
  displayMode,
  interactive,
  lastMove,
  onCellClick,
}: BoardProps) {
  const cellSize = (BOARD_PX - 2 * PADDING) / (boardSize - 1);
  const starPoints = boardSize === 19 ? STAR_POINTS_19 : STAR_POINTS_15;

  const handleClick = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      if (!interactive) return;
      const svg = e.currentTarget;
      const rect = svg.getBoundingClientRect();
      const scale = BOARD_PX / rect.width;
      const px = (e.clientX - rect.left) * scale;
      const py = (e.clientY - rect.top) * scale;

      const col = Math.round((px - PADDING) / cellSize);
      const row = Math.round((py - PADDING) / cellSize);
      if (row >= 0 && row < boardSize && col >= 0 && col < boardSize) {
        onCellClick(row, col);
      }
    },
    [interactive, cellSize, boardSize, onCellClick],
  );

  const gridLines = useMemo(() => {
    const lines: React.ReactNode[] = [];
    for (let i = 0; i < boardSize; i++) {
      const pos = PADDING + i * cellSize;
      const edge = i === 0 || i === boardSize - 1;
      lines.push(
        <line
          key={`h${i}`}
          x1={PADDING}
          y1={pos}
          x2={PADDING + (boardSize - 1) * cellSize}
          y2={pos}
          stroke="#5D4037"
          strokeWidth={edge ? 1.5 : 0.8}
        />,
      );
      lines.push(
        <line
          key={`v${i}`}
          x1={pos}
          y1={PADDING}
          x2={pos}
          y2={PADDING + (boardSize - 1) * cellSize}
          stroke="#5D4037"
          strokeWidth={edge ? 1.5 : 0.8}
        />,
      );
    }
    return lines;
  }, [boardSize, cellSize]);

  const starDots = useMemo(() => {
    return starPoints.map(([r, c]) => (
      <circle
        key={`star${r}${c}`}
        cx={PADDING + c * cellSize}
        cy={PADDING + r * cellSize}
        r={3}
        fill="#5D4037"
      />
    ));
  }, [starPoints, cellSize]);

  const pieces = useMemo(() => {
    const nodes: React.ReactNode[] = [];
    const stoneSize = cellSize * 0.9;
    const xoSize = cellSize * 0.7;

    for (let r = 0; r < boardSize; r++) {
      for (let c = 0; c < boardSize; c++) {
        const cell = board[r]?.[c];
        if (cell === "empty") continue;

        const cx = PADDING + c * cellSize;
        const cy = PADDING + r * cellSize;
        const isLast = lastMove && lastMove[0] === r && lastMove[1] === c;

        if (displayMode === "stones") {
          const img = cell === "X" ? stoneBlack : stoneWhite;
          nodes.push(
            <image
              key={`p${r}-${c}`}
              href={img}
              x={cx - stoneSize / 2}
              y={cy - stoneSize / 2}
              width={stoneSize}
              height={stoneSize}
            />,
          );
          if (isLast) {
            nodes.push(
              <circle
                key={`last${r}-${c}`}
                cx={cx}
                cy={cy}
                r={stoneSize * 0.15}
                fill="none"
                stroke={cell === "X" ? "#fff" : "#000"}
                strokeWidth={1.5}
                opacity={0.7}
              />,
            );
          }
        } else {
          nodes.push(
            <text
              key={`p${r}-${c}`}
              x={cx}
              y={cy}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={xoSize}
              fontWeight="bold"
              fill={cell === "X" ? "#1a1a1a" : "#ffffff"}
              stroke={cell === "O" ? "#333" : "none"}
              strokeWidth={cell === "O" ? 0.5 : 0}
            >
              {cell}
            </text>,
          );
          if (isLast) {
            nodes.push(
              <rect
                key={`last${r}-${c}`}
                x={cx - cellSize / 2 + 2}
                y={cy - cellSize / 2 + 2}
                width={cellSize - 4}
                height={cellSize - 4}
                fill="none"
                stroke="#e6a817"
                strokeWidth={2}
                rx={2}
              />,
            );
          }
        }
      }
    }
    return nodes;
  }, [board, boardSize, displayMode, cellSize, lastMove]);

  const hoverArea = useMemo(() => {
    if (!interactive) return null;
    const areas: React.ReactNode[] = [];
    for (let r = 0; r < boardSize; r++) {
      for (let c = 0; c < boardSize; c++) {
        if (board[r]?.[c] !== "empty") continue;
        const cx = PADDING + c * cellSize;
        const cy = PADDING + r * cellSize;
        areas.push(
          <circle
            key={`hover${r}-${c}`}
            cx={cx}
            cy={cy}
            r={cellSize * 0.35}
            fill="transparent"
            className="hover:fill-amber-500/20 cursor-pointer"
          />,
        );
      }
    }
    return areas;
  }, [interactive, board, boardSize, cellSize]);

  return (
    <div
      className="board-wood rounded-xl shadow-2xl p-1 w-[95vw] max-w-[600px] aspect-square
                    transition-transform duration-300 ease-out hover:scale-[1.01] hover:shadow-[0_24px_60px_rgba(0,0,0,0.6)]"
    >
      <svg
        data-testid="board-svg"
        width="100%"
        height="100%"
        viewBox={`0 0 ${BOARD_PX} ${BOARD_PX}`}
        onClick={handleClick}
        className={`block ${interactive ? "cursor-pointer" : "cursor-default"}`}
      >
        {gridLines}
        {starDots}
        {hoverArea}
        {pieces}
      </svg>
    </div>
  );
}
