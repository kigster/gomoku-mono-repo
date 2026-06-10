---
name: workflow-auditor
description: Behavioral auditing skill for Claude Code that audits SwiftUI user flows for dead ends, broken promises, and UX friction. Verifies whether your app actually works from the user's perspective, not just whether the code compiles.
source: community
date_added: '2026-04-08'
author: terry-nyberg
repo: https://github.com/Terryc21/workflow-audit
tags:
- swiftui
- audit
- ux
- behavioral-testing
- claude-code
tools:
- claude-code
---

# Workflow Auditor

## Overview

A button exists. Does anyone find it? A sheet opens. Can the user get back out? A feature is promoted on the dashboard. Does tapping it actually go anywhere?

Workflow Audit is a behavioral auditing skill for Claude Code that audits SwiftUI user flows for dead ends, broken promises, and UX friction. It doesn't check whether your code compiles or follows conventions. It checks whether your app actually works from the user's perspective.

## How It Works

The audit runs in 5 layers, each building on the last:

- **Discovery**: finds all UI entry points (sheets, navigation links, cards, context menus)
- **Flow Tracing**: follows critical user paths from entry to completion
- **Issue Detection**: 20 categories including dead ends, buried buttons, dismiss traps, stale context, loading traps, notification fragility, and more
- **Semantic Evaluation**: assesses discoverability, efficiency, feedback, and recovery from the user's point of view
- **Data Wiring**: verifies features use real data, not mock or hardcoded values, and checks platform parity

Like Radar Suite, Workflow Audit is behavioral, not grep-based. Pattern-based auditors verify that your code is correct. Workflow Audit verifies that your user's journey is complete. A view can pass every lint check and still strand the user on a screen with no way out.

## Commands

- `/workflow-audit` — full 5-layer audit
- `/workflow-audit layer3` — issue detection only
- `/workflow-audit trace "A → B → C"` — trace a specific user flow
- `/workflow-audit fix` — generate fixes for found issues
- `/workflow-audit diff` — compare against previous audit

Findings are rated by urgency, risk, ROI, blast radius, and fix effort. After the audit, run `/plan` to turn findings into a phased fix plan.

## Install

```bash
git clone https://github.com/Terryc21/workflow-audit.git
cp -r workflow-audit ~/.claude/skills/
```

## Author

Built by [Terry Nyberg](https://github.com/Terryc21) — [stuffolio.app](https://stuffolio.app)
