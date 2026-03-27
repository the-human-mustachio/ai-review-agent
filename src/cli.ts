#!/usr/bin/env node

import { runFullReview, shouldFailForThreshold, countBySeverity } from './core/engine.js';
import * as githubPlatform from './platforms/github.js';
import * as bitbucketPlatform from './platforms/bitbucket.js';
import type { Platform } from './types.js';

const PLATFORMS: Record<string, Platform> = {
  github: githubPlatform,
  bitbucket: bitbucketPlatform,
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printUsage();
    process.exit(0);
  }

  const log = console.log;

  // Detect or use specified platform
  let platformName = args.platform;
  if (!platformName && !args['output-only']) {
    for (const [name, platform] of Object.entries(PLATFORMS)) {
      if (platform.detect()) {
        platformName = name;
        log(`Auto-detected platform: ${name}`);
        break;
      }
    }
  }

  // Get PR metadata — from platform or CLI args
  let prMeta;
  if (platformName && !args['output-only']) {
    const platform = PLATFORMS[platformName];
    if (!platform) {
      console.error(`Unknown platform: ${platformName}. Supported: ${Object.keys(PLATFORMS).join(', ')}`);
      process.exit(1);
    }
    const token = args.token || process.env.GH_TOKEN || process.env.GITHUB_TOKEN || process.env.BB_TOKEN || process.env.BITBUCKET_TOKEN;
    prMeta = await platform.getPrMetadata(token);
  } else {
    prMeta = {
      prNumber: args['pr-number'] || '0',
      prTitle: args['pr-title'] || '',
      prAuthor: args['pr-author'] || '',
      prBody: args['pr-body'] || '',
      baseBranch: args['base-branch'] || 'main',
    };
  }

  // Run the review
  const review = await runFullReview({
    baseBranch: prMeta.baseBranch,
    prTitle: prMeta.prTitle,
    prAuthor: prMeta.prAuthor,
    prBody: prMeta.prBody,
    prNumber: prMeta.prNumber,
    mode: (args.mode as 'quick' | 'agentic') || 'quick',
    summary: args.summary !== 'false',
    promptPath: args.prompt || undefined,
    rulesPath: args.rules || undefined,
    excludePatterns: args.exclude || '',
    maxDiffSize: parseInt(args['max-diff-size'] || '100000', 10),
    opencodeConfig: args['opencode-config'] || undefined,
    apiKey: args['api-key'] || undefined,
    log,
  });

  // Output JSON if requested
  if (args['output-only']) {
    console.log(JSON.stringify(review, null, 2));
    process.exit(review.approve ? 0 : 1);
  }

  // Post to platform
  const token = args.token || process.env.GH_TOKEN || process.env.GITHUB_TOKEN || process.env.BB_TOKEN || process.env.BITBUCKET_TOKEN;
  if (!token) {
    console.error('Error: No token provided. Use --token or set GH_TOKEN / BB_TOKEN env var.');
    process.exit(1);
  }

  const platform = PLATFORMS[platformName!];
  await platform.postReview(review, {
    prNumber: prMeta.prNumber,
    token,
    postReview: args['post-review'] !== 'false',
    log,
  });

  // Check threshold
  const threshold = args['severity-threshold'] || 'blocking';
  const fail = shouldFailForThreshold(review, threshold);
  if (fail) {
    console.error(fail);
    process.exit(1);
  }

  const blockingCount = countBySeverity(review.issues, 'blocking');
  log(`Review complete. Approved: ${review.approve}. Issues: ${review.issues.length} (${blockingCount} blocking).`);
}

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        args[key] = 'true';
      } else {
        args[key] = next;
        i++;
      }
    }
  }
  return args;
}

function printUsage(): void {
  console.log(`
ai-review-agent - AI-powered code review for pull requests

USAGE:
  ai-review-agent [options]

PLATFORMS:
  --platform <name>       Platform to use: github, bitbucket (auto-detected if omitted)
  --token <token>         API token for posting reviews (or set GH_TOKEN / BB_TOKEN env var)

PR METADATA (auto-detected in CI, required for --output-only):
  --pr-number <n>         PR number
  --pr-title <title>      PR title
  --pr-author <author>    PR author
  --pr-body <body>        PR description
  --base-branch <branch>  Base branch (default: main)

REVIEW OPTIONS:
  --mode <mode>           Review mode: quick (single-pass) or agentic (multi-agent). Default: quick
  --summary <bool>        Generate PR summary (default: true)
  --prompt <path>         Path to custom prompt template
  --rules <path>          Path to rules file or directory
  --exclude <patterns>    Comma-separated glob patterns to exclude
  --max-diff-size <n>     Max diff size in chars (default: 100000)
  --severity-threshold <s> Fail threshold: blocking, warning, info (default: blocking)
  --opencode-config <path> Path to OpenCode config file
  --api-key <key>         API key for AI provider
  --post-review <bool>    Post approve/request-changes review (default: true)

OUTPUT:
  --output-only           Print JSON review to stdout and exit (no platform posting)
  --help                  Show this help
`);
}

main().catch((err: Error) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
