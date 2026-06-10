---
name: radar-suite
description: 7 behavioral audit skills that trace data and user flows through Swift/SwiftUI apps to find bugs that pattern-matching tools miss. Catches wrong outcomes, not just wrong code.
source: community
date_added: '2026-04-08'
author: terry-nyberg
repo: https://github.com/Terryc21/radar-suite
tags:
- swift
- swiftui
- audit
- behavioral-testing
- ios
- claude-code
tools:
- claude-code
---

# Radar Suite

## Overview

Every audit tool checks your code. Radar Suite checks what your code does.

7 behavioral audit skills that trace data and user flows through your Swift/SwiftUI app to find bugs that pattern-matching tools miss. Instead of checking code in isolation ("this line looks wrong"), Radar Suite examines how the code actually behaves: following a button tap through views, view models, managers, and persistence to see if the round trip works.

Every skill is behavioral, not structural. It cares about what happens, not what the code looks like.

## Why It Matters

Pattern-based auditors catch wrong code. Radar Suite catches wrong outcomes:

- Data silently lost on export/import
- Screens users can navigate into but not out of
- Deferred deletions that crash 30 days after release
- Arrays quietly reduced to single elements at handoff points

These bugs pass every line-level check because each file looks correct individually.

Radar Suite is **complementary** to grep-based auditors, not a replacement. Pattern matchers verify that each piece is correct. Radar Suite verifies that the pieces work together. You need both.

> Most auditors verify the engine is built to spec. Radar Suite drives the car and discovers the GPS is telling the driver to turn left into a lake.

## What's Included

- **radar-suite**: Unified entry point. Routes to any skill or runs all in sequence.
- **data-model-radar**: Are fields backed up correctly? Does export lose data? Are relationships safe?
- **time-bomb-radar**: Will your app crash 30 days after release? Finds deferred deletions, cache expiry, trial paths, and scheduled side effects that only break on aged data.
- **ui-path-radar**: Can users reach every feature? Are there dead ends or broken links?
- **roundtrip-radar**: Does data survive backup, restore, export, import, create, edit, save? Detects arrays silently losing elements and code paths that read fewer fields than others.
- **ui-enhancer-radar**: Visual quality. Spacing, empty states, contrast, and accessibility.
- **capstone-radar**: Overall A-F grade and ship/no-ship recommendation. Aggregates findings from all other skills.

Skills run in sequence, each passing findings to the next. Works on any Swift/SwiftUI project (iOS, macOS, iPadOS, tvOS, visionOS).

## Install

```bash
git clone https://github.com/Terryc21/radar-suite.git
cp -r radar-suite ~/.claude/skills/
```

## Author

Built by [Terry Nyberg](https://github.com/Terryc21) — [stuffolio.app](https://stuffolio.app)
