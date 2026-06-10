---
name: tutorial-creator
description: Generates annotated code reading tutorials from real files in your project. Teaches you using examples from your own codebase, one concept at a time, with vocabulary, comprehension tests, and gap analysis.
source: community
date_added: '2026-04-08'
author: terry-nyberg
repo: https://github.com/Terryc21/code-smarter
tags:
- learning
- tutorial
- documentation
- claude-code
tools:
- claude-code
---

# Tutorial Creator

## Overview

Many developers using AI to build apps are learning the language and frameworks as they go. Most learning resources use generic examples and walk the learner through steps to build a toy app. Tutorial Creator flips that: it teaches you using examples from your own app's codebase, gathered as you develop your app, one concept at a time.

A Claude Code skill that generates annotated code reading tutorials from real files in your project. Point it at a source file and a concept, and it produces a structured lesson with vocabulary, pre/post comprehension tests, common mistakes, and inline annotations on your actual code. Each tutorial builds on the last, tracking vocabulary and concepts across sessions so nothing gets re-explained and nothing gets skipped.

Works with any language: Swift, TypeScript, Python, Rust, or anything else in your project. Auto-detects your stack and calibrates depth to your experience level (beginner, intermediate, advanced).

## What You Get Per Tutorial

- Vocabulary table (new terms only, cumulative across sessions)
- Pre-test (do you already know this?)
- Core pattern explained with simplified examples
- Your real code, annotated line by line
- Common mistakes table
- Post-test (did you learn it?)
- Answer key with full explanations
- Gap analysis (flags prerequisite concepts you haven't covered yet)

## Usage

- Generate a personalized tutorial on any concept using code you already own
- Track learning progress across sessions with scores, vocabulary growth, and mastery checklists
- Identify knowledge gaps automatically and fill them with targeted follow-up lessons
- Calibrate difficulty to your level so explanations grow with you, not past you

If no source file is given, the skill picks one from your project that best demonstrates the topic.

## Install

```bash
git clone https://github.com/Terryc21/code-smarter.git
cp -r code-smarter/skills/tutorial-creator ~/.claude/skills/
```

Or for a specific project:

```bash
cp -r code-smarter/skills/tutorial-creator /path/to/your/project/.claude/skills/
```

On first run, a setup wizard configures your language, experience level, and tutorial output directory.

## Author

Built by [Terry Nyberg](https://github.com/Terryc21) — [stuffolio.app](https://stuffolio.app)
