# @_mustachio/ai-review-agent

AI-powered pull request code review agent. Works as a CLI tool or npm library. Supports GitHub and Bitbucket.

## Features

- **Two review modes** — fast single-pass (quick) or multi-agent deep review (agentic)
- **Agentic review** — orchestrator dynamically spawns specialized sub-agents (security, architecture, testing, performance) based on what changed
- **Inline comments** on specific lines of the PR diff
- **Hunk-aware context** — reads code surrounding changed lines, not just the diff
- **Diff chunking** — splits large PRs into parallel review chunks (quick mode)
- **Custom rules** — point at a file or directory of coding standards (SOLID, CLEAN, etc.)
- **Configurable prompt** — bring your own review prompt template
- **Multi-platform** — GitHub Actions and Bitbucket Pipelines
- **JSON output** — use `--output-only` for scripting and custom integrations
- **Prompt injection mitigation** — PR metadata wrapped in delimiters
- **Stale review cleanup** — dismisses/deletes previous AI reviews on new commits
- **Binary file detection** — skips images, compiled files, etc.

## Quick Start

### npx (any CI or local)

```bash
# Quick mode (default) — fast single-pass review
npx @_mustachio/ai-review-agent \
  --platform github \
  --token $GH_TOKEN \
  --rules ./docs/standards/

# Agentic mode — multi-agent deep review
npx @_mustachio/ai-review-agent \
  --platform github \
  --token $GH_TOKEN \
  --mode agentic \
  --rules ./docs/standards/
```

### GitHub Actions

```yaml
name: AI Code Review

on:
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write
      contents: read
    env:
      GH_TOKEN: ${{ github.token }}

    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: actions/setup-node@v4
        with:
          node-version: '24'

      - run: npx @_mustachio/ai-review-agent --mode agentic --rules docs/standards/standards.md --severity-threshold blocking
```

### Bitbucket Pipelines

```yaml
pipelines:
  pull-requests:
    '**':
      - step:
          name: AI Code Review
          script:
            - npx @_mustachio/ai-review-agent --rules ./docs/standards/ --severity-threshold blocking
          # BB_TOKEN must be set as a secured repository variable
          # with pullrequest:write and repository:write scopes
```

### Local / JSON Output

```bash
# Just get the review as JSON (no comments posted)
npx @_mustachio/ai-review-agent \
  --output-only \
  --base-branch main \
  --rules ./standards/

# Agentic mode locally
npx @_mustachio/ai-review-agent \
  --output-only \
  --base-branch main \
  --mode agentic \
  --rules ./standards/
```

## Review Modes

### Quick Mode (default)

Fast, single-pass review. The diff is split into chunks and each chunk is reviewed in a single LLM call. Best for small-to-medium PRs or when speed matters.

```bash
--mode quick
```

### Agentic Mode

An orchestrator agent analyzes the PR and dynamically spawns specialized sub-agents based on what changed. Sub-agents can use tools to read files, search the codebase, and explore beyond the diff context.

```bash
--mode agentic
```

**Specialized sub-agents:**

| Agent | Triggers On | Focus |
|-------|------------|-------|
| Security | Auth, crypto, secrets, deps, user input, network I/O | Injection, XSS, CSRF, leaked credentials, OWASP |
| Architecture | New files, moved files, import changes, 3+ directories | Separation of concerns, patterns, API design |
| Testing | Source changes without test updates, test modifications | Coverage, edge cases, test quality, broken tests |
| Performance | DB queries, loops, I/O, caching, algorithm changes | N+1 queries, blocking I/O, memory leaks, complexity |

The orchestrator decides which agents are relevant — not all agents run on every PR. A docs-only change may skip all sub-agents, while a new API endpoint might trigger security + architecture + testing.

## CLI Options

```
PLATFORMS:
  --platform <name>         github, bitbucket (auto-detected if omitted)
  --token <token>           API token (or set GH_TOKEN / BB_TOKEN env var)

PR METADATA (auto-detected in CI):
  --pr-number <n>           PR number
  --pr-title <title>        PR title
  --pr-author <author>      PR author
  --pr-body <body>          PR description
  --base-branch <branch>    Base branch (default: main)

REVIEW OPTIONS:
  --mode <mode>             Review mode: quick (single-pass) or agentic (multi-agent). Default: quick
  --provider <name>         AI provider (e.g. amazon-bedrock, anthropic, openai)
  --model <id>              Model ID (e.g. anthropic.claude-sonnet-4-20250514-v1:0)
  --prompt <path>           Custom prompt template
  --rules <path>            Rules file or directory
  --exclude <patterns>      Comma-separated exclude globs
  --max-diff-size <n>       Max diff chars per chunk (default: 100000)
  --severity-threshold <s>  Fail threshold: blocking, warning, info
  --opencode-config <path>  OpenCode config file
  --api-key <key>           AI provider API key
  --post-review <bool>      Post approve/request-changes (default: true)

OUTPUT:
  --output-only             Print JSON to stdout, exit 0 (approved) or 1 (rejected)
  --help                    Show help
```

## Providers

By default, the tool uses the OpenCode default provider (Anthropic via `ANTHROPIC_API_KEY`). Use `--provider` and `--model` to specify a different provider.

### Anthropic (default)

No flags needed — set `ANTHROPIC_API_KEY` in your environment.

### AWS Bedrock

Set AWS credentials and region in your environment, then specify the provider and model:

```bash
npx @_mustachio/ai-review-agent \
  --provider amazon-bedrock \
  --model anthropic.claude-sonnet-4-20250514-v1:0 \
  --rules ./docs/standards/
```

**Required environment variables:**
- `AWS_REGION` (e.g. `us-west-2`)
- AWS credentials via one of: `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`, `AWS_PROFILE`, or IAM role (automatic in EC2/ECS/Lambda)

**Anthropic model IDs on Bedrock:**

| Model | Bedrock Model ID |
|-------|-----------------|
| Claude Sonnet 4.6 | `anthropic.claude-sonnet-4-6` |
| Claude Opus 4.6 | `anthropic.claude-opus-4-6-v1` |
| Claude Sonnet 4.5 | `anthropic.claude-sonnet-4-5-20250929-v1:0` |
| Claude Opus 4.5 | `anthropic.claude-opus-4-5-20251101-v1:0` |
| Claude Sonnet 4 | `anthropic.claude-sonnet-4-20250514-v1:0` |
| Claude Opus 4.1 | `anthropic.claude-opus-4-1-20250805-v1:0` |
| Claude Haiku 4.5 | `anthropic.claude-haiku-4-5-20251001-v1:0` |
| Claude 3.5 Haiku | `anthropic.claude-3-5-haiku-20241022-v1:0` |
| Claude 3 Haiku | `anthropic.claude-3-haiku-20240307-v1:0` |

Cross-region variants are also available with `us.` or `eu.` prefixes (e.g. `us.anthropic.claude-sonnet-4-6`, `eu.anthropic.claude-opus-4-6-v1`).

**GitHub Actions example with Bedrock:**

```yaml
- run: npx @_mustachio/ai-review-agent --provider amazon-bedrock --model anthropic.claude-sonnet-4-20250514-v1:0 --rules docs/standards/
  env:
    AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
    AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
    AWS_REGION: us-west-2
```

## Custom Rules

Point `--rules` at a single file or a directory:

```bash
# Single file
--rules docs/standards/standards.md

# Directory (all files concatenated with headers)
--rules .github/review-rules/
```

Example rules directory:

```
.github/review-rules/
  SOLID.md
  CLEAN.md
  security.md
  testing.md
```

Each file's content is injected into the review prompt as evaluation criteria. Rules work in both quick and agentic modes — in agentic mode, the orchestrator passes rules to each sub-agent.

## Output Format

The review JSON (from `--output-only` or the internal pipeline):

```json
{
  "approve": false,
  "summary": "PR introduces a clean architecture violation.",
  "issues": [
    {
      "severity": "blocking",
      "message": "Core imports from infra — violates dependency rule",
      "file": "packages/core/src/organization/organization.usecase.ts",
      "line": 3,
      "endLine": 4
    }
  ],
  "recommendation": "Remove the infra import and use a repository port."
}
```

Both review modes produce the same output format.

## Platform Differences

| Capability | GitHub | Bitbucket |
|---|---|---|
| Inline comments | PR review API | Individual comment API |
| Block merge | `REQUEST_CHANGES` review | Build status `FAILED` |
| Allow merge | `APPROVE` review | Build status `SUCCESSFUL` + approve |
| Stale cleanup | Dismiss previous reviews | Delete previous comments |
| Auth token | Automatic `GITHUB_TOKEN` | Manual `BB_TOKEN` (secured variable) |
| PR metadata | From event payload | Fetched via API |

## Library Usage

```ts
import { runFullReview } from '@_mustachio/ai-review-agent';

// Quick mode (default)
const review = await runFullReview({
  baseBranch: 'main',
  prTitle: 'Add feature X',
  prAuthor: 'dev',
  prBody: 'Description here',
  prNumber: 42,
  rulesPath: './standards.md',
});

// Agentic mode
const deepReview = await runFullReview({
  baseBranch: 'main',
  prTitle: 'Add feature X',
  prAuthor: 'dev',
  prBody: 'Description here',
  prNumber: 42,
  mode: 'agentic',
  rulesPath: './standards.md',
});

console.log(review.approve);  // true/false
console.log(review.issues);   // [{severity, message, file, line}]
```

## License

MIT
