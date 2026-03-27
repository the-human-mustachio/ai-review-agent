# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

AI-powered PR code review agent that works as a CLI tool and npm package. It diffs against a base branch and reviews code using the OpenCode SDK (`@opencode-ai/sdk`), then posts inline comments + a summary review to GitHub or Bitbucket. Supports two modes: **quick** (single-pass per chunk) and **agentic** (orchestrator + specialized sub-agents).

## Commands

- **Build**: `bun run build` — uses `bun build` to bundle `src/cli.ts` into `dist/cli.js`
- **Type check**: `bun run typecheck` — runs `tsc --noEmit`
- **Run locally**: `bun run dev -- <flags>` or `node dist/cli.js <flags>` (e.g. `--output-only --base-branch main --rules ./standards/`)
- **Run agentic mode**: `node dist/cli.js --output-only --base-branch main --mode agentic`
- **No test suite exists yet.**

## Tech Stack

- **Language**: TypeScript (ESM)
- **Runtime**: Node.js (built output), Bun (development/build)
- **Build**: `bun build` bundles all TS into a single `dist/cli.js` targeting Node.js
- **Package distribution**: Published to npm, users run via `npx @_mustachio/ai-review-agent`

## Architecture

The codebase has four layers:

1. **Entry point** — `src/cli.ts` (CLI, parses `--flags`). Calls `runFullReview()` with a `mode` option.

2. **Core** (`src/core/`):
   - `engine.ts` — main pipeline with mode routing. Shared logic: git diff, file filtering, hunk context gathering, rules loading, sanitization, markdown formatting. Starts the OpenCode SDK server, runs reviews, then shuts it down.
   - `prompt.ts` — loads prompt templates and renders `{{VARIABLE}}` placeholders.
   - `review.ts` — `runReview()` for quick mode, `runAgenticOpencode()` for agentic mode. Uses the SDK's `client.session.prompt()` with JSON schema structured output.
   - `schemas.ts` — JSON schemas for review and summary structured output.
   - `types.ts` — shared TypeScript interfaces (Review, Issue, PrMetadata, etc.).

3. **Platforms** (`src/platforms/`):
   - `github.ts` — reads PR metadata from `GITHUB_EVENT_PATH`, posts reviews via Octokit, dismisses stale bot reviews.
   - `bitbucket.ts` — fetches PR metadata from BB API, posts individual inline comments, sets build status, manages approve/unapprove.
   - Each platform exports `detect()`, `getPrMetadata()`, `postReview()`.

4. **Agents** (`.opencode/agent/`):
   - `orchestrator.md` — primary agent that analyzes PRs and delegates to sub-agents via opencode's `task` tool.
   - `security.md`, `architecture.md`, `testing.md`, `performance.md` — specialized sub-agents, each with focused review criteria and access to file-reading tools.
   - Agent files are provisioned to the working directory at runtime if not present (for npm usage).

## Key Design Decisions

- **Two review modes**: Quick mode (default) does fast single-pass chunk reviews. Agentic mode uses an orchestrator that dynamically selects which sub-agents to spawn based on the PR diff content.
- **OpenCode SDK**: Reviews are executed via the `@opencode-ai/sdk` package programmatically. The SDK starts a local server, creates sessions, and uses structured output (JSON schema) to get validated responses — no CLI shelling or stdout parsing needed.
- **Agent provisioning**: `.opencode/agent/*.md` files ship with the npm package and are copied to the working directory's `.opencode/agent/` before starting the SDK server in agentic mode.
- **Prompt injection mitigation**: PR metadata (title, author, body) is wrapped in `---BEGIN_USER_INPUT---`/`---END_USER_INPUT---` delimiters.
- **Hunk-aware context**: The engine reads ±20 lines around each diff hunk for richer context.
- **Chunking** (quick mode only): Large diffs are split into chunks (default 100k chars) and reviewed in parallel, then merged with deduplication.
- **Same output format**: Both modes produce `{ approve, summary, issues, recommendation }` — platform adapters work identically regardless of mode.

## Prompt Templates

Prompt templates are defined inline in `src/core/prompts.ts` (bundled into the output). Users can override with `--prompt <path>` for custom templates.

- `DEFAULT_PROMPT` — quick mode template. Placeholders: `PR_TITLE`, `PR_AUTHOR`, `PR_BODY`, `RULES`, `CONTEXT`, `DIFF`.
- `AGENTIC_KICKOFF_PROMPT` — agentic mode template. Same placeholders plus `FILE_LIST` (changed files with line counts).
- `SUMMARY_PROMPT` — PR summary template. Placeholders: `PR_TITLE`, `PR_AUTHOR`, `PR_BODY`, `FILE_LIST`, `DIFF`.
