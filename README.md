# @_mustachio/ai-review-agent

AI-powered pull request code review agent. Works as a CLI tool, npm library, or GitHub Action. Supports GitHub and Bitbucket.

## Features

- **Inline comments** on specific lines of the PR diff
- **Hunk-aware context** — reads code surrounding changed lines, not just the diff
- **Diff chunking** — splits large PRs into parallel review chunks
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
npx @_mustachio/ai-review-agent \
  --platform github \
  --token $GH_TOKEN \
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

      - uses: ./packages/ai-review-agent
        with:
          severity-threshold: 'blocking'
          rules: docs/standards/standards.md
          opencode-config: ${{ github.workspace }}/.github/opencode.json
```

When published, replace `uses: ./packages/ai-review-agent` with:

```yaml
      - uses: the-human-mustachio/ai-review-agent@v1
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
```

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
  --prompt <path>           Custom prompt template
  --rules <path>            Rules file or directory
  --exclude <patterns>      Comma-separated exclude globs
  --max-diff-size <n>       Max diff chars per chunk (default: 100000)
  --severity-threshold <s>  Fail threshold: blocking, warning, info
  --opencode-version <v>    Pinned opencode-ai version (default: 0.2.21)
  --opencode-config <path>  OpenCode config file
  --api-key <key>           AI provider API key
  --post-review <bool>      Post approve/request-changes (default: true)

OUTPUT:
  --output-only             Print JSON to stdout, exit 0 (approved) or 1 (rejected)
  --help                    Show help
```

## GitHub Action Inputs

| Input | Description | Default |
|-------|-------------|---------|
| `api-key` | AI provider API key (optional if set in env) | |
| `severity-threshold` | Fail threshold: `blocking`, `warning`, `info` | `blocking` |
| `prompt` | Path to custom prompt template | built-in |
| `post-review` | Post approve/request-changes review | `true` |
| `max-diff-size` | Max diff size per chunk (chars) | `100000` |
| `exclude-patterns` | Comma-separated exclude globs | |
| `opencode-config` | Path to OpenCode config file | |
| `rules` | Path to rules file or directory | |
| `opencode-version` | Pinned opencode-ai version | `0.2.21` |

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

Each file's content is injected into the review prompt as evaluation criteria.

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

```js
const { runFullReview } = require('@_mustachio/ai-review-agent');

const review = await runFullReview({
  baseBranch: 'main',
  prTitle: 'Add feature X',
  prAuthor: 'dev',
  prBody: 'Description here',
  prNumber: 42,
  rulesPath: './standards.md',
});

console.log(review.approve);  // true/false
console.log(review.issues);   // [{severity, message, file, line}]
```

## License

MIT
