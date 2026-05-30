# Gomoku ANSI C - Technical Overview

> [!IMPORTANT]
> This document is meant for developers who want to understand the code organization, structure, and key aspects of the minimax algorithm.

## Table of Contents

- [Gomoku ANSI C - Technical Overview](#gomoku-ansi-c---technical-overview)
  - [Table of Contents](#table-of-contents)
  - [Architecture Overview](#architecture-overview)
    - [Module Organization](#module-organization)
  - [Core Modules](#core-modules)
    - [main.c - Game Orchestration](#mainc---game-orchestration)
    - [`gomoku.c/h` - Game Rules and Evaluation](#gomokuch---game-rules-and-evaluation)
    - [`board.c/h` - Board Management](#boardch---board-management)
    - [`game.c/h` - Game State Management](#gamech---game-state-management)
    - [`ai.c/h` - AI Search Engine](#aich---ai-search-engine)
    - [ui.c/h - Terminal Interface](#uich---terminal-interface)
    - [cli.c/h - Command-Line Interface](#clich---command-line-interface)
  - [Game State Flow](#game-state-flow)
  - [AI Architecture Details](#ai-architecture-details)
    - [Search Strategy](#search-strategy)
    - [Evaluation Function](#evaluation-function)
    - [Performance Characteristics](#performance-characteristics)
  - [Testing Infrastructure](#testing-infrastructure)
    - [Test Suite: 24 Comprehensive Tests](#test-suite-24-comprehensive-tests)
    - [Running Tests](#running-tests)
  - [Build System](#build-system)
    - [Make Build (Traditional)](#make-build-traditional)
    - [CMake Build (Modern)](#cmake-build-modern)
  - [Key Design Decisions](#key-design-decisions)
    - [1. Unified Move Generation](#1-unified-move-generation)
    - [2. Simplified Threat Evaluation](#2-simplified-threat-evaluation)
    - [3. Transposition Table Without Clearing](#3-transposition-table-without-clearing)
    - [4. Modular Architecture](#4-modular-architecture)
    - [5. Dynamic Player Type System](#5-dynamic-player-type-system)
  - [Performance Optimization Techniques](#performance-optimization-techniques)
    - [Memory Efficiency](#memory-efficiency)
    - [CPU Efficiency](#cpu-efficiency)
    - [Search Efficiency](#search-efficiency)
  - [Extension Points](#extension-points)
    - [New Game Rules](#new-game-rules)
    - [Advanced AI](#advanced-ai)
    - [UI Enhancements](#ui-enhancements)
    - [Network Play](#network-play)
    - [Save/Load System](#saveload-system)
  - [Code Quality](#code-quality)
    - [Metrics](#metrics)
    - [Standards](#standards)
    - [Recent Improvements](#recent-improvements)
  - [Development Workflow](#development-workflow)
    - [Quick Start](#quick-start)
    - [Common Development Tasks](#common-development-tasks)
  - [Future Directions](#future-directions)
    - [Short Term](#short-term)
    - [Medium Term](#medium-term)
    - [Long Term](#long-term)
  - [References](#references)
    - [Gomoku Game](#gomoku-game)
    - [AI Algorithms](#ai-algorithms)
    - [Implementation Resources](#implementation-resources)

## Architecture Overview

The codebase follows a clean modular design with clear separation of concerns. Each module handles a specific aspect of the game, making the code maintainable and easy to understand.

### Module Organization

> [!NOTE]
> This excludes the network/httpd part of this project. You can find the documentation about that in [this document](httpd.md).

```
gomoku-c/src/
├── main.c     - Entry point and main game loop orchestration
├── gomoku.c/h - Core game rules, pattern recognition, evaluation
├── board.c/h  - Board state management and memory allocation
├── game.c/h   - Game state, history, timers, optimization caches
├── ai.c/h     - AI search engine (minimax, move generation)
├── ui.c/h     - Terminal UI rendering and keyboard input
├── cli.c/h    - Command-line argument parsing
└── ansi.h     - ANSI terminal escape sequences and colors
```

## Core Modules

### main.c - Game Orchestration

**105 lines** - Simple, focused entry point

- Parses command-line arguments via CLI module
- Initializes game state with configuration
- Runs main game loop handling player turns
- Delegates to UI for display and AI for moves
- Clean shutdown and resource cleanup

**Key Design**: Minimal logic, maximum delegation. Acts as a thin coordinator.

### `gomoku.c/h` - Game Rules and Evaluation

**Core game logic and pattern recognition**

**Evaluation System**:

- Threat-based pattern matching for tactical analysis
- Graduated threat levels: Five (100K), Straight Four (50K), Three (1K), etc.
- Pattern cost matrix for evaluating board positions
- Incremental and full board evaluation modes

**Win Detection**:

- Efficient four-direction scanning (horizontal, vertical, two diagonals)
- Exactly five-in-a-row win condition
- Cached winner system for performance

**Pattern Recognition**:

- Matrix-based threat detection (THREAT_FIVE through THREAT_TWO)
- Combination threat analysis (three-and-four, three-and-three)
- Blocked pattern identification

### `board.c/h` - Board Management

**Memory and coordinate utilities**

- Dynamic board allocation for 15x15 or 19x19 sizes
- Safe memory management with proper cleanup
- Coordinate conversion utilities (row/col to cell index)
- Unicode rendering support for X and O symbols
- Board validation and bounds checking

### `game.c/h` - Game State Management

**Central hub connecting all game components**

**Core Data Structure**: `game_state_t`

- Board reference and game configuration
- Move history with timing and evaluation data
- Current game state (running, won, draw)
- Optimization caches (interesting moves, winner cache)
- Transposition table and Zobrist hashing
- Killer move heuristics
- AI status messages and search metadata

**Optimization Systems**:

- **Transposition Table**: 100K entries for position caching
- **Zobrist Hashing**: Incremental hash updates for fast lookups
- **Winner Cache**: Avoids redundant win detection
- **Interesting Moves Cache**: Tracks tactically relevant positions
- **Killer Moves**: History heuristic for move ordering

**Undo System**:

- Full move history with timestamps
- Cache rebuild on undo to maintain consistency
- Single-move undo for Human vs Human
- Two-move undo for games with AI

### `ai.c/h` - AI Search Engine

**Sophisticated minimax-based AI with modern optimizations**s

**Move Generation** (Refactored in PR #27):

- Unified direct board scanning approach
- Candidate generation within radius 2 of occupied cells
- Empty board special case (plays center)
- Integrated priority calculation during generation
- Eliminates dual-path complexity

**Move Prioritization**:

- Winning moves: 2 billion priority (searched first)
- Blocking opponent wins: 1.5 billion priority
- Killer moves: +1 million bonus
- Threat-based scoring: 10-12x multiplier
- Center bias for opening play

**Search Algorithm**:

- Minimax with alpha-beta pruning
- Iterative deepening for time management
- Configurable search depth (1-8 typical)
- Timeout support with graceful degradation
- Transposition table integration

**Search Optimizations**:

- Move ordering for better pruning
- Killer move heuristics
- Transposition table cutoffs
- Early termination for forced wins
- Incremental hash updates

**Key Improvements** (PR #27):

- Removed dual-path move generation complexity
- Simplified threat evaluation (no open-end tracking)
- Fixed transposition table flag logic
- Removed problematic root alpha narrowing
- Better hash consistency

### ui.c/h - Terminal Interface

**ANSI terminal-based user interaction**

**Display Components**:

- Unicode board rendering with colored pieces (X=red, O=blue)
- Move history sidebar with timing information
- Status messages and AI thinking indicators
- Optional welcome screen
- Progress dots during AI search

**Input Handling**:

- Raw terminal mode for immediate key response
- Arrow key navigation for move selection
- Action keys: Enter (confirm), U (undo), Q (quit)
- Input validation and error feedback

**Terminal Management**:

- ANSI color escape sequences
- Cursor positioning and screen clearing
- Raw mode enable/disable with proper restoration
- Non-blocking input for responsive UI

### cli.c/h - Command-Line Interface

**Flexible configuration system**

**Supported Options**:

```bash
--board 15|19        # Board size (default: 15)
--depth N            # AI search depth (default: 4)
--depth N:M          # Asymmetric depths (X plays N, O — M)
--radius R           # How far from occupied cells to look
--timeout N          # Search timeout in seconds
--player-x human|ai  # Player X type (default: human)
--player-o human|ai  # Player O type (default: ai)
--undo               # Enable undo functionality
--skip-welcome       # Skip welcome screen
--help               # Show usage information
```

**Game Modes**:

1. **Human vs AI** (default): Interactive play against computer
1. **Human vs Human**: Two-player local game
1. **AI vs AI**: Self-play mode for testing and analysis

**Asymmetric AI**:

- Configure different search depths per AI player
- Enables testing AI strength imbalances
- Format: `--depth 2:6` (X plays at depth 2, O at depth 6)

## Game State Flow

```
CLI Parse → Init Game → Main Loop → Cleanup
              ↓            ↓
         game_state_t   Determine Player Type
              ↓            ↓
         Init Caches   Human Input or AI Search
              ↓            ↓
         Init Board    Make Move → Update State
                          ↓
                     Check Win/Draw → Continue or End
```

## AI Architecture Details

### Search Strategy

The AI uses a carefully tuned minimax search with several layers of optimization:

1. **Iterative Deepening**: Searches progressively deeper, stopping on timeout
1. **Move Generation**: Scans board directly, generates candidates within radius 2
1. **Move Ordering**: Sorts moves by priority (wins first, then threats, then heuristics)
1. **Alpha-Beta Pruning**: Eliminates provably inferior branches
1. **Transposition Table**: Avoids re-searching identical positions
1. **Killer Moves**: Prioritizes moves that caused cutoffs at same depth

### Evaluation Function

Position scoring combines multiple factors:

- **Threat Recognition**: Pattern matching for tactical features

  - Five-in-a-row: 100,000 (winning position)
  - Straight four: 50,000 (critical threat)
  - Open three: 1,000 (strong attack)
  - Lower threats: Progressively smaller scores

- **Pattern Combinations**: Bonus for multiple threats

  - Three-and-four: 5,000
  - Three-and-three: 5,000
  - Multiple threats amplify position strength

- **Positional Factors**:

  - Center control bias
  - Stone connectivity
  - Space control

### Performance Characteristics

**Typical Performance** (15x15 board, depth 4):

- Opening moves: 1-2 seconds
- Mid-game: 2-5 seconds
- End-game: \<1 second (fewer candidates)

**Search Statistics**:

- Nodes evaluated: 10K-100K depending on position
- Branching factor: ~40 average (reduced by radius constraint)
- Transposition hits: 20-40% of probes
- Alpha-beta cutoffs: 60-80% of branches

## Testing Infrastructure

### Test Suite: 24 Comprehensive Tests

The test suite uses Google Test (C++) to validate all components:

**Board & Utilities** (4 tests):

- Board creation and memory management
- Coordinate utility functions
- Move validation logic
- Game state initialization

**Win Detection** (5 tests):

- Horizontal win patterns
- Vertical win patterns
- Diagonal win patterns
- Anti-diagonal win patterns
- No-winner scenarios

**Evaluation & AI** (6 tests):

- Position evaluation correctness
- Evaluation with winning positions
- AI move selection quality
- Minimax algorithm correctness
- Minimax with different board sizes
- Minimax with winning sequences

**Game Mechanics** (5 tests):

- Game logic functions
- Undo functionality
- Other player determination
- Multi-direction threat detection
- Blocked pattern recognition

**Integration Tests** (4 tests):

- Corner cases and edge conditions
- Self-play quality assessment
- AI vs AI game completion
- Asymmetric depth configuration

### Running Tests

```bash
# Setup (first time only)
make -C gomoku-c googletest

# Run all tests
make -C gomoku-c test

# Alternative: CMake build
make -C gomoku-c cmake-test
```

**Test Coverage**: Core game logic, AI algorithms, edge cases, and integration scenarios.

## Build System

### Make Build (Traditional)

```bash
make -C gomoku-c all       # Build game executable
make -C gomoku-c test      # Build and run tests
make -C gomoku-c clean     # Remove build artifacts
make -C gomoku-c rebuild   # Clean + build
```

**Compiler Flags**:

- Optimized build: `-O3`
- Warnings: `-Wall -Wextra -Wimplicit-function-declaration`
- Test build: `-O2` (faster compilation)

### CMake Build (Modern)

```bash
make -C gomoku-c cmake-build  # Build with CMake
make -C gomoku-c cmake-test   # Test with CMake
make -C gomoku-c cmake-clean  # Clean CMake build
```

**Features**:

- Out-of-source builds in `build/` directory
- Automatic Google Test discovery
- Cross-platform support

## Key Design Decisions

### 1. Unified Move Generation

**Rationale**: Eliminated dual-path complexity (optimized vs dynamic) that caused maintenance burden and potential bugs. Single direct board scanning approach is simpler and more maintainable.

**Benefits**:

- Single source of truth
- No cache synchronization issues
- Naturally adapts to board changes
- Easier to understand and debug

### 2. Simplified Threat Evaluation

**Rationale**: Removed complex open-end tracking that added code complexity without proportional benefit. Simple consecutive-count scoring is sufficient for move ordering.

**Trade-off**: Slightly less precise tactical evaluation, but much simpler code. The minimax search compensates by evaluating actual positions.

### 3. Transposition Table Without Clearing

**Rationale**: Keeping entries across moves improves hit rate. Depth-based replacement ensures fresh entries replace stale ones naturally.

**Impact**: Better search efficiency without the overhead of clearing 100K entries between moves.

### 4. Modular Architecture

**Rationale**: Clean separation allows independent testing and development. Each module has a single, well-defined responsibility.

**Benefit**: New features (like game modes) can be added without touching AI code. Bug fixes are isolated to specific modules.

### 5. Dynamic Player Type System

**Rationale**: Enables three game modes with minimal code duplication. Runtime player type determination keeps code flexible.

**Implementation**: Player type arrays indexed by player constant. Game loop queries type before each turn.

## Performance Optimization Techniques

### Memory Efficiency

- Stack-based move arrays (no heap allocation in search)
- Compact data structures (bit flags, unsigned char for small values)
- Reusable buffers (candidate maps, move lists)

### CPU Efficiency

- Early loop exits on bounds/empty checks
- Candidate map for O(1) duplicate detection
- Incremental hash updates (O(1) vs O(board_size²))
- Sorted move lists for faster cutoffs

### Search Efficiency

- Radius constraint (radius 2) limits branching factor
- Killer move heuristics improve move ordering
- Transposition table avoids redundant search
- Iterative deepening finds good moves early

## Extension Points

The modular design provides clear extension points for new features:

### New Game Rules

**Module**: `gomoku.c/h`

- Modify win detection for variants (exactly 5, overline, renju)
- Adjust pattern recognition for different rule sets
- Update evaluation weights for game balance

### Advanced AI

**Module**: `ai.c/h`

- Implement null-move pruning
- Add parallel search (multi-threading)
- Implement opening book or endgame tables
- Add Monte Carlo Tree Search (MCTS) option

### UI Enhancements

**Module**: `ui.c/h`

- Add graphical UI via ncurses
- Implement replay mode
- Add move annotations
- Support themes and customization

### Network Play

**New Modules**: `network.c/h`, `protocol.c/h`

- Implement client-server architecture
- Add network protocol for move exchange
- Support online matchmaking
- Enable spectator mode

### Save/Load System

**New Module**: `persistence.c/h`

- Serialize game state to file
- Support PGN or custom format
- Enable game resume
- Store move analysis

## Code Quality

### Metrics

- **Total Lines**: ~3,500 (excluding tests and generated code)
- **Average Function Length**: 20-30 lines
- **Cyclomatic Complexity**: Generally low (\<10 per function)
- **Module Cohesion**: High (each module has clear purpose)
- **Coupling**: Low (modules interact through well-defined interfaces)

### Standards

- **C Standard**: ANSI C (C89/C90 compatible)
- **Naming Convention**: snake_case for functions/variables
- **Constant Naming**: ALL_CAPS with prefixes
- **Documentation**: Function comments with parameter descriptions
- **Error Handling**: Return codes (RT_SUCCESS/RT_FAILURE)

### Recent Improvements

- **PR #27**: Refactored AI move generation (~300 lines removed)
- **PR #28**: Added three game modes with player configuration
- Transposition table fixes (hash indexing, flag logic)
- Minimax bug fixes (root alpha narrowing removed)
- Cache consistency improvements (rebuild on undo)

## Development Workflow

### Quick Start

```bash
# Clone and build
git clone https://github.com/kigster/gomoku-ansi-c
cd gomoku-ansi-c
make -C gomoku-c all    # or: just build

# Run game
bin/gomoku

# Run tests
gomoku-c/tests/tests-setup  # First time only
make -C gomoku-c test
```

### Common Development Tasks

**Adding a New Feature**:

1. Identify affected modules
1. Update data structures if needed
1. Implement feature in module
1. Add tests in `gomoku-c/tests/gomoku_test.cpp`
1. Update documentation

**Debugging AI Issues**:

1. Enable verbose output (add debug prints in `ai.c`)
1. Run AI vs AI mode to reproduce
1. Check move generation, evaluation, and search
1. Verify transposition table behavior
1. Test with lower depths for faster iteration

**Performance Profiling**:

1. Build with profiling flags (`-pg`)
1. Run representative game
1. Analyze with `gprof`
1. Focus on hot paths (move generation, evaluation)
1. Optimize with measurements

## Future Directions

### Short Term

- Network play support
- Save/load functionality
- Opening book for improved AI
- Enhanced UI with move history navigation

### Medium Term

- Web-based UI (WASM compilation)
- Mobile app version
- AI training mode with difficulty adjustment
- Tournament mode with multiple AI variants

### Long Term

- Neural network-based AI option
- Cloud-based game analysis
- Professional tournament features
- Educational mode with move explanations

## References

### Gomoku Game

- Standard Gomoku rules (five-in-a-row)
- Board sizes: 15x15 (standard), 19x19 (advanced)
- Win condition: Exactly five consecutive stones

### AI Algorithms

- Minimax algorithm with alpha-beta pruning
- Transposition tables and Zobrist hashing
- Killer move heuristic
- Iterative deepening

### Implementation Resources

- ANSI C standard library
- POSIX terminal control
- Google Test framework
- CMake and Make build systems

<br />

| | |
| ------------------ | --------------------------------------------------------------- |
| **Project Status** | Production Ready |
| **License** | MIT |
| **Repository**: | <https://github.com/kigster/gomoku-ansi-c> |
| **Author** | © 2010-2026 [Konstantin Gredeskoul](https://github.com/kigster) |
