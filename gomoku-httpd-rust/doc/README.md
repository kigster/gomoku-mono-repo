# Research Papers on Gomoku AI

This document summarizes the key concepts and optimizations described in the research papers located in this directory. These papers provide the theoretical foundation for many of the advanced AI techniques used in this Gomoku project.

______________________________________________________________________

## 1. "Go-Moku and Threat-Space Search" (1994, Allis, van den Herik, Huntjens)

> [!TIP]
> [Source Article as a PDF](1994--allis-gomoku-and-threat-space-search.pdf)

### Primary Context

This seminal paper asserts that Go-Moku is a theoretical win for the first player (Black). It introduces two new search techniques, **Threat-Space Search** and **Proof-Number Search (PNS)**, which are used by their program, VICTORIA, to prove the win. The paper's main focus is explaining Threat-Space Search and its advantages over conventional alpha-beta search.

### Key Concepts & Optimizations

**Threat-Space Search:** This is the most critical concept and is a major departure from a standard minimax search. Instead of exploring all possible moves, this technique focuses only on moves that create a **threat**.

- **Threat Definition**: A move that forces an immediate response. Examples include:

  - **Four**: A line of four stones, which threatens to become a five on the next turn. The opponent *must* block it.
  - **Three**: A line of three stones, which threatens to become a *straight four* (an unblockable line of four) on the next turn. This also forces a response.
  - **Double Threat**: A move that creates two or more threats simultaneously, which is usually a winning move as the opponent can only block one.

- **How it Works**: The search algorithm operates in a "threat space" rather than the "game space". It builds a sequence of threats, assuming the opponent's only moves are the ones that parry the immediate threat. The goal is to find a sequence of forcing moves that inevitably leads to a double threat.

- **Advantages**:

  - **Massively Reduced Search Space**: It prunes away almost all moves that don't create or respond to a threat, dramatically reducing the branching factor. It mirrors how human experts think, by focusing only on the critical, forcing lines of play.
  - **Deep Searches**: Because the branching factor is so low, threat-space search can find winning lines that are 20-30+ ply (moves) deep, far beyond what a conventional alpha-beta search could manage.

**Proof-Number Search (PNS):** This technique is used in combination with Threat-Space Search. When Threat-Space Search fails to find a winning line, PNS is used to try and prove whether a position is a win, loss, or draw. It's particularly effective in positions with a large branching factor where threat-based analysis isn't sufficient.

______________________________________________________________________

## 2. "AI Agent for Playing Gomoku" (2000s, Stanford University Poster)

> [!TIP]
> [Source Article as a PDF](2000--stanford--ai-agent-for-playing-gomoku.pdf)

### Primary Context

This is a poster from a student project at Stanford that compares the performance of a **Minimax algorithm with alpha-beta pruning** against a **Monte Carlo Tree Search (MCTS)** for playing Gomoku.

### Key Concepts & Optimizations

**Heuristic Evaluation Function:** The minimax algorithm's performance is heavily dependent on its evaluation function. The one described here is based on recognizing and weighting different threat patterns, similar to the ideas in the Allis paper. The score is a weighted sum of patterns like:

- **`N_four`**: Number of fours for the agent vs. the opponent.
- **`N_open_three`**: Number of open threes (a three with empty spaces on both ends, making it very dangerous).
- **`N_half_three`**: Number of less potent threats.

**Minimax with Search Space Reduction:** The poster notes that the branching factor is too high for a deep search. They suggest a common optimization:

- **Beam Search**: At any given position, only consider the 'k' best moves as determined by the heuristic evaluation function, instead of all possible moves. This drastically cuts down the branching factor, allowing for a deeper search at the risk of missing a good move that initially looked poor.

**Monte Carlo Tree Search (MCTS):** This is presented as an alternative to minimax.

- **How it Works**: MCTS builds a search tree by running many random "playouts" (simulations) to the end of the game. It uses the results of these simulations to estimate which moves are most promising, gradually focusing the search on better parts of the game tree.
- **Heuristic Roll-out Policy**: Instead of purely random simulations, they suggest incorporating the same domain knowledge (threat patterns) from the minimax evaluation function to guide the simulations. This makes the playouts "smarter" and allows the MCTS to converge on a good move with fewer simulations.

______________________________________________________________________

## 3. "Solving Renju" (2001, Wágner, Virág)

> [!TIP]
> [Source Article as a PDF](2001--solving-renju-by-wagner-et-al.pdf)

### Primary Context

This paper claims to have solved **Free Renju**, a professional variant of Gomoku. Like the Allis paper, it confirms that the first player has a forced win. Renju has more complex rules than standard Gomoku (e.g., Black is forbidden from making double-threes, double-fours, or overlines), which makes the search more complicated.

### Key Concepts & Optimizations

**Iterative Deepening Threat-Sequence Search:** The core of their solver is a **threat-sequence search**, building directly on the concepts from Allis (1994). Their program works by:

1. Generating a winning tree for Black based on threat sequences.
1. Storing this tree in a database.
1. Using an iterative-deepening approach, where they search for threat sequences up to a certain depth (e.g., 17 plies).

**Human-Expert-Guided Search:** A key part of their process involved leveraging human expertise to manage the enormous search space.

- **Positional Moves**: Human experts provided thousands of "positional moves" (yobi moves) that, while not immediate threats, create a strong positional advantage.
- **Opening Book**: The program used an opening book to handle the initial moves of the game, relying on pre-analyzed lines.
- **Database Generation**: The process took thousands of CPU hours. A "checking" program was written to play backwards through the generated game tree to find any holes or missing variations in the proof, which were then corrected in subsequent runs.

This approach demonstrates that even with powerful search algorithms, solving a complex game like Renju required a hybrid approach combining algorithmic search with a large, curated database of expert knowledge.
