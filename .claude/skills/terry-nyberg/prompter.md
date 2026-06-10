---
name: prompter
description: Rewrites your Claude Code prompts for clarity before execution. Fixes typos, resolves ambiguous references, and adds specificity — without changing what you're asking for.
source: community
date_added: '2026-04-08'
author: terry-nyberg
repo: https://github.com/Terryc21/code-smarter
tags:
- prompt-engineering
- productivity
- claude-code
tools:
- claude-code
---

# Prompter

## Overview

Vague prompts get vague results. Typos and ambiguous references slow down every AI interaction. Prompter fixes this by rewriting your prompt for clarity before Claude Code acts on it. You see the rewrite, approve or adjust, then it executes.

**Before:** "fix teh thing in that file were the button dont work rite"

**After:** "Fix the broken submit button in LoginView.swift that doesn't trigger the authentication flow on tap"

Same intent. One gets you a fix, the other gets you a conversation about which button in which file.

## What It Does

- Fixes spelling
- Resolves ambiguous references ("that file" becomes the actual file name from context)
- Adds specificity where the intent is clear but the wording is not
- **Never** changes what you're asking for, just how clearly you're asking for it

## Flexible Activation

- Try it once to see what it does
- Set it for the next N prompts with a countdown
- Keep it on for the whole session
- Add it to `CLAUDE.md` so it persists across all future sessions
- Remove it from `CLAUDE.md` when you no longer need it

Skips rewriting automatically for permission responses (yes, no), option selections, and follow-up answers to clarifying questions. If your prompt is already clear, it says so and moves on.

## Use Cases

- Catch typos and vague wording before they waste a round trip
- Turn one-line requests into specific, actionable prompts
- Resolve "that file" and "the thing" into actual file names and components from context
- Try it for one prompt, a set number, or make it permanent in `CLAUDE.md`

## Install

```bash
git clone https://github.com/Terryc21/code-smarter.git
cp -r code-smarter/skills/prompter ~/.claude/skills/
```

Or for a specific project:

```bash
cp -r code-smarter/skills/prompter /path/to/your/project/.claude/skills/
```

Then type `/skill prompter` in Claude Code to activate.

## Author

Built by [Terry Nyberg](https://github.com/Terryc21) — [stuffolio.app](https://stuffolio.app)
