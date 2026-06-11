# Plan — 0.3.1 CMake build system

## Steps

1. **Author `CMakeLists.txt`** for the engine and the test target, declaring
   sources, include dirs, and the GoogleTest dependency.
2. **Wire tests** through CTest so `cmake --build` + `ctest` runs the suite.
3. **Update CI** to drive the build via CMake.
4. **Refresh the help screen** text.
5. Bump `GAME_VERSION` to `0.3.1`, tag, merge via PR #5.

## Testing strategy

- A clean-checkout configure + build + `ctest` run on the CI platforms.
- Confirm the test binary builds on the first attempt (a pain point later fixed
  in 0.3.2).

## Deviations from the code

Keeping both the Makefile and CMake during the transition invites drift between
two build descriptions. The cleaner path is to make CMake authoritative and
reduce any remaining Makefile to a thin convenience wrapper that calls CMake, so
there is a single source of build truth.
