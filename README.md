# Sully

A macOS desktop app that drives your dev workflow from Linear. Tickets in a "Planning" column get an AI-drafted implementation plan posted back as a Linear comment; you approve; a headless coding session implements it, opens the PR, and moves the ticket to review. It can also auto-review PRs where you're the requested reviewer or assignee.

Everything runs through the **Claude CLI** (or optionally Codex) as background processes — no model-provider API keys. Every session is visible, streamable, and stoppable in the app.

## Requirements

- macOS (Apple Silicon)
- [Claude Code CLI](https://claude.com/claude-code) installed and logged in (`claude` in your PATH — run it once in a terminal first)
- [gh CLI](https://cli.github.com) installed and authenticated (`gh auth login`)
- `git`
- Optional: `codex` CLI if you want to run a phase with Codex

## Setup

```bash
npm install
npm run dev          # development
npm run build:mac    # package Sully.app (dist/)
```

On first launch the app asks for:

1. **Linear API key** — personal key from linear.app/settings/account/security. Stored encrypted via the macOS Keychain (Electron safeStorage).
2. **GitHub** — nothing to do if `gh` is already authenticated; otherwise paste a token.

Then in **Settings**:

- **Columns** — pick a Linear team and map four workflow states: Planning, Plan ready, In progress, In review.
- **Repositories** — add local repo paths and map each to a Linear team. This tells tickets where to work, and which repos PR auto-review covers.
- **Phases** — per phase (planning / coding / PR review) choose the agent (claude or codex), model, an optional skill/slash command, permission mode, and timeout. Defaults: claude, no skill, CLI default model.

Flip on the **Orchestrator** and/or **Auto reviews** toggles in the sidebar.

By default the orchestrator only picks up tickets carrying the **`sully` label** in Linear (per-ticket opt-in). Change or clear the label under Settings → Tuning.

## How the workflow runs

```
ticket (assigned to you, labeled `sully`) enters Planning column
  → headless planning session in a git worktree for the ticket branch
  → plan posted as a Linear comment, ticket moved to Plan ready
  → you approve (in-app button, or drag the ticket to In progress in Linear)
  → headless coding session implements the plan, pushes, opens the PR
  → ticket moved to In review
```

Details worth knowing:

- **Worktrees**: each ticket works in `<repo-parent>/<repo>-worktrees/<branch>`, using Linear's branch name. `.env` files are symlinked in from the main checkout.
- **Idempotency**: the plan comment carries a hidden HTML marker, so restarts, reinstalls, or cleared state never double-plan or double-post. Coding checks for an existing PR before starting.
- **Editing the plan**: while a ticket sits in Plan ready you can edit the plan directly in the app (Review plan → Edit plan), which updates the Linear comment. Or reply to the plan comment in Linear: a feedback session reads your reply, answers questions in-thread, or revises the plan and replies "Plan updated." Handled replies are tracked with hidden markers, so nothing is answered twice.
- **Re-plan**: drag a ticket from Plan ready back to Planning.
- **Reprompting after coding**: once a ticket is In review you can reprompt the agent from the app (comment icon on the card) or by leaving a regular top-level comment on the ticket in Linear (distinct from plan-thread replies). A session reads the comment against the branch: change requests are implemented, committed, and pushed to the existing PR — the ticket moves back to In progress while it works, then returns to In review; questions are answered without touching code. Either way Sully replies on the ticket when done. Only comments left after the ticket entered review count, and handled ones are marker-tracked so nothing runs twice.
- **Failures**: sessions that fail or time out mark the ticket on the board with a Retry button; the ticket never moves columns on failure.
- **Re-running PR reviews**: any finished review row (done, failed, or stopped) has a re-run button that launches a fresh review of the PR. Only a review posted after the re-run counts as its result, so the old verdict is never mistaken for the new one.
- **Quitting**: closing the window hides it; the app keeps orchestrating from the menu bar. Sessions survive app restarts (reconciled on next launch).

## State & logs

Everything lives in `~/.claude/sully/`: `settings.json`, `state.json`, `pr-reviews.json`, per-session records in `sessions/`, and raw NDJSON logs in `logs/`.
