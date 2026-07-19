<p align="center">
  <img src="resources/icon.png" alt="Sully logo" width="128" />
</p>

<h1 align="center">Sully</h1>

<p align="center">AI dev workflow orchestrator</p>

## Table of Contents

- [What is Sully?](#what-is-sully)
- [How it works](#how-it-works)
- [Features](#features)
- [Integrations](#integrations)
- [Getting Started](#getting-started)
- [License](#license)

## What is Sully?

Sully is a macOS desktop app (Electron) that turns your Linear board into an AI development pipeline. It watches your tickets and, as cards move through columns, automatically spawns headless Claude Code (or Codex) sessions to plan, implement, open PRs for, and review each ticket. Every ticket runs in its own git worktree, and results flow back to Linear and GitHub.

## How it works

1. A ticket enters a column you've mapped to a phase (planning, in progress, in review, etc.).
2. Sully creates a dedicated git worktree and branch for the ticket.
3. A headless agent session runs the phase: writing a plan, implementing the change, creating the PR, or reviewing it.
4. Plans land in `.sully/plan.md` for your review. Agents can ask blocking questions, and you reply through the in-app ticket chat.
5. As the ticket moves through the board, Sully advances it through coding, PR creation, and review, posting progress back to Linear and GitHub along the way.

## Features

- **Linear-driven orchestration**: column-to-phase mapping drives the entire workflow, with per-ticket opt-in via labels
- **Git worktree isolation**: each ticket gets its own worktree and branch
- **Plan review and ticket chat**: review agent plans and answer agent questions without leaving the app
- **Automated PR creation and review**: creates PRs and watches for PRs where you're a requested reviewer, spawning review sessions automatically
- **CI auto-fix**: reads failing GitHub Actions logs and PR review comments, then reprompts the agent to fix them
- **Production error investigation**: pulls errors from PostHog error tracking and spawns investigation sessions
- **Embedded terminals and browser**: split and dockable terminals, a browser panel, and a dev server runner
- **One-click deploys**: run your own release commands per repo
- **Usage and cost tracking**: per-session budgets and a live usage bar
- **Doctor diagnostics**: checks that your CLIs, tokens, and MCP servers are healthy

## Integrations

| Tool | Used for |
| --- | --- |
| **Linear** | The primary driver. Polls tickets by column, moves states, and reads/posts comments via the GraphQL API |
| **GitHub** (`gh` CLI) | Creates PRs, checks CI status, fetches failing Actions logs, and reads/posts PR review comments |
| **Claude Code** (`claude` CLI) | The main AI agent for planning, coding, PR creation, review, and error investigation |
| **OpenAI Codex** (`codex` CLI) | Optional alternative agent, configurable per phase |
| **MCP servers** | Per-phase server selection from `~/.claude.json`, with OAuth re-login support |
| **Figma** | Injects a Figma token into sessions so agents can read design comments |
| **PostHog** | Queries error tracking to feed production error investigation sessions |
| **Git** | Worktrees, branch sync, and mapping repos to local paths |
| **CI providers** | GitHub Actions log fetching, plus CircleCI and Vercel status via the PR check rollup |

## Getting Started

### Prerequisites

- macOS
- Node.js 20+
- [Claude Code](https://claude.com/claude-code) (`claude`) installed and authenticated
- [GitHub CLI](https://cli.github.com) (`gh`) installed and authenticated
- `git` with your repos cloned locally
- A Linear account with an API key
- Optional: `codex` CLI, a Figma personal access token, a PostHog personal API key

### Run the app

```bash
npm install
npm run dev
```

To build a packaged macOS app instead:

```bash
npm run build:mac
```

### First-time setup

1. Launch the app and complete onboarding: enter your Linear API key, and optionally GitHub, Figma, and PostHog credentials. Secrets are encrypted with the macOS Keychain.
2. In Settings, map your Linear board columns to workflow phases (planning, in progress, in review, etc.).
3. Point Sully at your repos and configure per-phase models, permission modes, and budgets.
4. Optionally set a required label so only opted-in tickets are picked up.
5. Move a ticket into a mapped column and watch Sully take it from plan to PR.

Run the built-in doctor from the app if anything looks off; it checks your CLIs, tokens, and MCP servers.

## License

Sully is open source under the [MIT License](LICENSE).
