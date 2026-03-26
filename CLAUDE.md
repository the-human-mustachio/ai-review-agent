# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

AI-powered PR code review agent that works as a CLI tool, npm package, or GitHub Action. It diffs against a base branch and reviews code using OpenCode (an AI CLI tool), then posts inline comments + a summary review to GitHub or Bitbucket. Supports two modes: **quick** (single-pass per chunk) and **agentic** (orchestrator + specialized sub-agents).

## Commands

- **Build** (for GitHub Actions distribution): `npm run build` — uses `@vercel/ncc` to bundle `src/index.js` into `dist/`
- **Run locally**: `npm run dev -- <flags>` or `node bin/cli.js <flags>` (e.g. `--output-only --base-branch main --rules ./standards/`)
- **Run agentic mode**: `node bin/cli.js --output-only --base-branch main --mode agentic`
- **No test suite exists yet.**

## Architecture

The codebase has four layers:

1. **Entry points** — `src/index.js` (GitHub Actions, reads `action.yml` inputs) and `bin/cli.js` (CLI, parses `--flags`). Both call `runFullReview()` with a `mode` option.

2. **Core** (`src/core/`):
   - `engine.js` — main pipeline with mode routing. Shared logic: git diff, file filtering, hunk context gathering, rules loading, sanitization, markdown formatting. Branches into `runQuickReview()` or `runAgenticReview()` based on `mode`.
   - `prompt.js` — loads prompt templates and renders `{{VARIABLE}}` placeholders.
   - `review.js` — `runReview()` for quick mode, `runAgenticOpencode()` for agentic mode. Both call `opencode run` via `execFileSync` and parse streaming JSON output. Includes truncated-JSON repair logic.

3. **Platforms** (`src/platforms/`):
   - `github.js` — reads PR metadata from `GITHUB_EVENT_PATH`, posts reviews via Octokit, dismisses stale bot reviews.
   - `bitbucket.js` — fetches PR metadata from BB API, posts individual inline comments, sets build status, manages approve/unapprove.
   - Each platform exports `detect()`, `getPrMetadata()`, `postReview()`.

4. **Agents** (`.opencode/agent/`):
   - `orchestrator.md` — primary agent that analyzes PRs and delegates to sub-agents via opencode's `task` tool.
   - `security.md`, `architecture.md`, `testing.md`, `performance.md` — specialized sub-agents, each with focused review criteria and access to file-reading tools.
   - Agent files are provisioned to the working directory at runtime if not present (for npm/GitHub Action usage).

## Key Design Decisions

- **Two review modes**: Quick mode (default) does fast single-pass chunk reviews. Agentic mode uses an orchestrator that dynamically selects which sub-agents to spawn based on the PR diff content.
- **OpenCode as the AI backend**: Reviews are executed by shelling out to the `opencode` CLI (`opencode-ai` npm package). Agentic mode uses `opencode run --agent orchestrator --format json`. The version is pinnable via `--opencode-version` (default: 1.3.2).
- **Agent provisioning**: `.opencode/agent/*.md` files ship with the npm package and are copied to the working directory's `.opencode/agent/` before invoking opencode in agentic mode, so they work when installed via npx or as a GitHub Action.
- **Prompt injection mitigation**: PR metadata (title, author, body) is wrapped in `---BEGIN_USER_INPUT---`/`---END_USER_INPUT---` delimiters.
- **Hunk-aware context**: The engine reads ±20 lines around each diff hunk for richer context.
- **Chunking** (quick mode only): Large diffs are split into chunks (default 100k chars) and reviewed in parallel, then merged with deduplication.
- **Same output format**: Both modes produce `{ approve, summary, issues, recommendation }` — platform adapters work identically regardless of mode.

## Prompt Templates

- `prompts/default.txt` — quick mode template. Placeholders: `PR_TITLE`, `PR_AUTHOR`, `PR_BODY`, `RULES`, `CONTEXT`, `DIFF`.
- `prompts/agentic-kickoff.txt` — agentic mode template. Same placeholders plus `FILE_LIST` (changed files with line counts). Does NOT tell the model to avoid tools.
