# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

AI-powered PR code review agent that works as a CLI tool, npm package, or GitHub Action. It diffs against a base branch, splits large diffs into chunks, sends each chunk through OpenCode (an AI CLI tool) with a review prompt, and posts inline comments + a summary review to GitHub or Bitbucket.

## Commands

- **Build** (for GitHub Actions distribution): `npm run build` — uses `@vercel/ncc` to bundle `src/index.js` into `dist/`
- **Run locally**: `npm run dev -- <flags>` or `node bin/cli.js <flags>` (e.g. `--output-only --base-branch main --rules ./standards/`)
- **No test suite exists yet.**

## Architecture

The codebase has three layers:

1. **Entry points** — `src/index.js` (GitHub Actions, reads `action.yml` inputs) and `bin/cli.js` (CLI, parses `--flags`). Both call into the core engine.

2. **Core** (`src/core/`):
   - `engine.js` — orchestrates the full review pipeline: git diff → filter files → split by file → gather hunk context → chunk diffs → run parallel reviews → merge & deduplicate results. Also contains markdown formatting helpers (`formatComment`, `buildInlineComments`). This is the main module (`package.json` main field).
   - `prompt.js` — loads prompt template (default: `prompts/default.txt`) and renders `{{VARIABLE}}` placeholders.
   - `review.js` — executes `opencode run --format json` via child_process, parses the streaming JSON output, includes truncated-JSON repair logic.

3. **Platforms** (`src/platforms/`):
   - `github.js` — reads PR metadata from `GITHUB_EVENT_PATH`, posts reviews via Octokit, dismisses stale bot reviews.
   - `bitbucket.js` — fetches PR metadata from BB API (env vars don't include title/author), posts individual inline comments, sets build status, manages approve/unapprove.
   - Each platform exports `detect()`, `getPrMetadata()`, `postReview()`.

## Key Design Decisions

- **OpenCode as the AI backend**: Reviews are executed by shelling out to the `opencode` CLI (`opencode-ai` npm package), not by calling an LLM API directly. The version is pinnable via `--opencode-version` (default in `engine.js`).
- **Prompt injection mitigation**: PR metadata (title, author, body) is wrapped in `---BEGIN_USER_INPUT---`/`---END_USER_INPUT---` delimiters before being injected into the prompt.
- **Hunk-aware context**: For each changed file, the engine reads the full file and extracts lines surrounding each diff hunk (±20 lines), providing the AI with more context than the raw diff alone.
- **Chunking**: Large diffs are split into chunks (default 100k chars) and reviewed in parallel via `Promise.all`, then merged with deduplication.
- **Graceful inline comment fallback**: On GitHub, if posting inline comments fails (e.g. line not in diff), it falls back to a summary-only review with issues listed as markdown.

## Prompt Template

`prompts/default.txt` uses `{{MUSTACHE}}` placeholders: `PR_TITLE`, `PR_AUTHOR`, `PR_BODY`, `RULES`, `CONTEXT`, `DIFF`. The AI is instructed to return only raw JSON matching a specific schema (approve, summary, issues, recommendation).
