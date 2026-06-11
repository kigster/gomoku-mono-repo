# Spec — 0.3.1 CMake build system

**Span:** `6180808` → `958fb53` (4 commits, 2025-07-18)
**Version:** `0.2.0` → `0.3.1`

## Theme

Adopt CMake as the project's build system and refresh the help screen.

## What was built

- **CMake build system** ("Version 0.3.1: CMake Build System") — portable,
  generator-based builds that supersede the hand-rolled Makefile flow and
  integrate cleanly with GoogleTest and IDEs.
- **Help-screen update** and a README reference to the introducing PR (#5,
  `kig/cmake`).

## Oracle: version-bump assessment

Labeled `0.3.1` (the project skips a tagged `0.3.0`). Treated as a **minor**-level
change in spirit: CMake is a meaningful infrastructure capability for builders,
though invisible to players and fully backwards-compatible. The jump straight to
`.1` is a numbering choice, not a compatibility signal.
