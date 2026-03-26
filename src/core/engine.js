const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { loadPrompt, renderPrompt } = require('./prompt');
const { runReview } = require('./review');

const CONTEXT_LINES_AROUND_HUNK = 20;
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.webp', '.bmp',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.zip', '.gz', '.tar', '.rar', '.7z',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx',
  '.exe', '.dll', '.so', '.dylib', '.o',
  '.mp3', '.mp4', '.wav', '.avi', '.mov',
  '.pyc', '.class', '.wasm',
]);

const DEFAULT_EXCLUDES = [
  'packages/ai-review-action/**',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  '**/dist/**',
  '**/*.min.js',
  '**/*.min.css',
  '**/*.map',
  '**/*.snap',
];

const DEFAULT_OPENCODE_VERSION = '1.3.2';

/**
 * Run the full review pipeline. Platform-agnostic.
 *
 * @param {object} opts
 * @param {string} opts.baseBranch - Base branch to diff against
 * @param {string} opts.prTitle
 * @param {string} opts.prAuthor
 * @param {string} opts.prBody
 * @param {number|string} opts.prNumber
 * @param {string} [opts.promptPath] - Custom prompt template path
 * @param {string} [opts.rulesPath] - Path to rules file or directory
 * @param {string} [opts.excludePatterns] - Comma-separated exclude globs
 * @param {number} [opts.maxDiffSize=100000]
 * @param {string} [opts.opencodeVersion]
 * @param {string} [opts.opencodeConfig] - Path to OpenCode config
 * @param {string} [opts.apiKey] - API key to set in env
 * @param {function} [opts.log] - Logging function
 * @returns {Promise<object>} Review result: { approve, summary, issues, recommendation }
 */
async function runFullReview(opts) {
  const {
    baseBranch,
    prTitle,
    prAuthor,
    prBody = '',
    prNumber,
    promptPath,
    rulesPath,
    excludePatterns = '',
    maxDiffSize = 100000,
    opencodeVersion = DEFAULT_OPENCODE_VERSION,
    opencodeConfig,
    apiKey,
    log = console.log,
  } = opts;

  // Set env vars
  if (apiKey) process.env.ANTHROPIC_API_KEY = apiKey;
  if (opencodeConfig) process.env.OPENCODE_CONFIG = opencodeConfig;

  // Load rules
  const rules = rulesPath ? loadRules(rulesPath, log) : '';
  if (rules) log(`Loaded review rules (${rules.length} chars).`);

  // Get changed files
  log('Fetching changed files...');
  const nameOnly = exec(`git diff --name-only origin/${baseBranch}...HEAD`);
  const allFiles = nameOnly.split('\n').filter(Boolean);
  const { included, excluded } = filterFiles(allFiles, excludePatterns);

  if (included.length === 0) {
    log('No reviewable files changed. Skipping review.');
    return { approve: true, summary: 'No reviewable files changed.', issues: [], recommendation: '' };
  }

  if (excluded.length > 0) log(`Excluded ${excluded.length} file(s).`);

  // Get diff
  log(`Reviewing ${included.length} file(s)...`);
  const fullDiff = exec(`git diff origin/${baseBranch}...HEAD -- ${included.map(f => `"${f}"`).join(' ')}`);

  if (!fullDiff.trim()) {
    log('No diff found. Skipping review.');
    return { approve: true, summary: 'No diff found.', issues: [], recommendation: '' };
  }

  // Context + chunks
  const fileDiffs = splitDiffByFile(fullDiff);
  const context = gatherHunkContext(fileDiffs);
  const chunks = buildChunks(fileDiffs, maxDiffSize);
  log(`Split into ${chunks.length} chunk(s) for review.`);

  // Install OpenCode
  log(`Installing OpenCode v${opencodeVersion}...`);
  exec(`npm install -g opencode-ai@${opencodeVersion}`);

  // Sanitize
  const safePrTitle = sanitize(prTitle);
  const safePrAuthor = sanitize(prAuthor);
  const safePrBody = sanitize(prBody);

  // Review chunks in parallel
  const template = loadPrompt(promptPath);

  const chunkResults = await Promise.all(chunks.map((chunk, i) => {
    const chunkLabel = chunks.length > 1 ? ` (chunk ${i + 1}/${chunks.length})` : '';
    log(`Running AI review${chunkLabel}...`);

    const contextSection = context.length > 0
      ? `File context (surrounding code for reference):\n${context.filter(c => chunk.files.includes(c.file)).map(c => `--- ${c.file} ---\n${c.content}`).join('\n\n')}`
      : '';

    const rulesSection = rules
      ? `Review rules and standards (apply these when evaluating the code):\n${rules}`
      : '';

    const prompt = renderPrompt(template, {
      PR_TITLE: safePrTitle,
      PR_AUTHOR: safePrAuthor,
      PR_BODY: safePrBody,
      RULES: rulesSection,
      CONTEXT: contextSection,
      DIFF: chunk.diff,
    });

    return runReview(prompt, `${prNumber}-${i}`, { log });
  }));

  // Merge
  let shouldApprove = true;
  const allIssues = [];
  const allSummaries = [];
  const allRecommendations = [];

  for (const review of chunkResults) {
    if (review.issues) allIssues.push(...review.issues);
    if (review.summary) allSummaries.push(review.summary);
    if (review.recommendation) allRecommendations.push(review.recommendation);
    if (!review.approve) shouldApprove = false;
  }

  return {
    approve: shouldApprove,
    summary: allSummaries.join(' '),
    issues: deduplicateIssues(allIssues),
    recommendation: allRecommendations.join(' '),
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function exec(cmd) {
  return execSync(cmd, { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 });
}

function sanitize(text) {
  if (!text) return '';
  const cleaned = text.replace(/---END_USER_INPUT---/gi, '');
  return `---BEGIN_USER_INPUT---\n${cleaned}\n---END_USER_INPUT---`;
}

function deduplicateIssues(issues) {
  const seen = new Set();
  const unique = [];
  for (const issue of issues) {
    const key = issue.file && issue.line
      ? `${issue.file}:${issue.line}:${issue.severity}`
      : `${issue.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(issue);
    }
  }
  return unique;
}

function shouldFailForThreshold(review, threshold) {
  if (!review.approve && (!review.issues || review.issues.length === 0)) {
    return 'Review did not approve but found no issues — possible parse failure.';
  }
  const issues = review.issues || [];
  const severities = ['info', 'warning', 'blocking'];
  const thresholdIndex = severities.indexOf(threshold);
  if (thresholdIndex === -1) return null;
  const failingSeverities = severities.slice(thresholdIndex);
  const failingIssues = issues.filter((i) => failingSeverities.includes(i.severity));
  if (failingIssues.length > 0) {
    return `Review found ${failingIssues.length} issue(s) at or above '${threshold}' severity.`;
  }
  return null;
}

function countBySeverity(issues, severity) {
  return (issues || []).filter((i) => i.severity === severity).length;
}

// ─── Hunk-Aware Context ─────────────────────────────────────────────────────

function gatherHunkContext(fileDiffs) {
  const context = [];
  for (const { file, diff } of fileDiffs) {
    if (isBinaryFile(file)) continue;
    if (!fs.existsSync(file)) continue;

    let lines;
    try {
      const content = fs.readFileSync(file, 'utf-8');
      if (content.includes('\0')) continue;
      lines = content.split('\n');
    } catch { continue; }

    const hunkRanges = [];
    const hunkRegex = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm;
    let match;
    while ((match = hunkRegex.exec(diff)) !== null) {
      const start = parseInt(match[1], 10);
      const len = match[2] !== undefined ? parseInt(match[2], 10) : 1;
      hunkRanges.push({ start, end: start + len - 1 });
    }
    if (hunkRanges.length === 0) continue;

    const padded = hunkRanges.map(r => ({
      start: Math.max(1, r.start - CONTEXT_LINES_AROUND_HUNK),
      end: Math.min(lines.length, r.end + CONTEXT_LINES_AROUND_HUNK),
    }));
    const merged = mergeRanges(padded);
    const snippets = merged.map(r => {
      const snippet = lines.slice(r.start - 1, r.end);
      return `Lines ${r.start}-${r.end}:\n${snippet.join('\n')}`;
    });
    context.push({ file, content: snippets.join('\n\n') });
  }
  return context;
}

function mergeRanges(ranges) {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    if (sorted[i].start <= last.end + 1) {
      last.end = Math.max(last.end, sorted[i].end);
    } else {
      merged.push(sorted[i]);
    }
  }
  return merged;
}

function isBinaryFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

// ─── Diff & Filtering ───────────────────────────────────────────────────────

function splitDiffByFile(fullDiff) {
  const parts = fullDiff.split(/(?=^diff --git )/m).filter(Boolean);
  return parts.map((diff) => {
    const match = diff.match(/^diff --git a\/(.+?) b\/(.+)/);
    const file = match ? match[2] : 'unknown';
    return { file, diff };
  });
}

function buildChunks(fileDiffs, maxSize) {
  const chunks = [];
  let current = { files: [], diffs: [], size: 0 };
  for (const { file, diff } of fileDiffs) {
    if (current.size + diff.length > maxSize && current.diffs.length > 0) {
      chunks.push({ files: current.files, diff: current.diffs.join('\n') });
      current = { files: [], diffs: [], size: 0 };
    }
    current.files.push(file);
    current.diffs.push(diff);
    current.size += diff.length;
  }
  if (current.diffs.length > 0) {
    chunks.push({ files: current.files, diff: current.diffs.join('\n') });
  }
  return chunks;
}

function filterFiles(files, extraPatterns) {
  const patterns = [...DEFAULT_EXCLUDES];
  if (extraPatterns) {
    patterns.push(...extraPatterns.split(',').map((p) => p.trim()).filter(Boolean));
  }
  const included = [];
  const excluded = [];
  for (const file of files) {
    if (matchesAny(file, patterns)) {
      excluded.push(file);
    } else {
      included.push(file);
    }
  }
  return { included, excluded };
}

function matchesAny(file, patterns) {
  for (const pattern of patterns) {
    if (pattern.startsWith('**/')) {
      const suffix = pattern.slice(3);
      if (suffix.startsWith('*.')) {
        if (file.endsWith(suffix.slice(1))) return true;
      } else if (suffix.endsWith('/**')) {
        const dir = suffix.slice(0, -3);
        if (file.includes(`/${dir}/`) || file.startsWith(`${dir}/`)) return true;
      } else {
        if (file.includes(suffix) || file.endsWith(suffix)) return true;
      }
    } else if (pattern.endsWith('/**')) {
      const prefix = pattern.slice(0, -3);
      if (file.startsWith(prefix + '/') || file === prefix) return true;
    } else if (pattern.startsWith('*.')) {
      if (file.endsWith(pattern.slice(1))) return true;
    } else {
      if (file === pattern || file.endsWith('/' + pattern)) return true;
    }
  }
  return false;
}

// ─── Rules Loading ──────────────────────────────────────────────────────────

function loadRules(rulesPath, log = console.log) {
  if (!fs.existsSync(rulesPath)) {
    log(`Warning: Rules path not found: ${rulesPath}`);
    return '';
  }
  const stat = fs.statSync(rulesPath);
  if (stat.isFile()) return fs.readFileSync(rulesPath, 'utf-8');
  if (stat.isDirectory()) {
    const files = fs.readdirSync(rulesPath).filter((f) => !f.startsWith('.')).sort();
    const parts = [];
    for (const file of files) {
      const filePath = path.join(rulesPath, file);
      if (fs.statSync(filePath).isFile()) {
        parts.push(`### ${file}\n\n${fs.readFileSync(filePath, 'utf-8')}`);
      }
    }
    return parts.join('\n\n');
  }
  return '';
}

// ─── Markdown Formatting ────────────────────────────────────────────────────

const SEVERITY_ICONS = { blocking: '🚫', warning: '⚠️', info: '💡' };

function formatComment(review) {
  const verdict = review.approve ? '✅ **Approved**' : '❌ **Changes Requested**';
  let body = `## AI Code Review — ${verdict}\n\n${review.summary}`;

  const nonInlineIssues = (review.issues || []).filter((i) => !i.file || !i.line);
  if (nonInlineIssues.length > 0) {
    body += '\n\n### General Issues\n\n| Severity | Details |\n|----------|---------|';
    for (const issue of nonInlineIssues) {
      const icon = SEVERITY_ICONS[issue.severity] || '•';
      body += `\n| ${icon} **${issue.severity}** | ${issue.message} |`;
    }
  }

  if (review.recommendation) {
    body += `\n\n### Recommendation\n\n${review.recommendation}`;
  }

  body += '\n\n---\n*Generated by AI Code Review*';
  return body;
}

function formatInlineIssuesAsList(issues) {
  const inlineIssues = (issues || []).filter((i) => i.file && i.line);
  if (inlineIssues.length === 0) return '';
  let list = '\n\n### Inline Issues\n\n';
  for (const issue of inlineIssues) {
    const icon = SEVERITY_ICONS[issue.severity] || '•';
    const lineRef = issue.endLine ? `L${issue.line}-L${issue.endLine}` : `L${issue.line}`;
    list += `- ${icon} **${issue.severity}** \`${issue.file}:${lineRef}\`: ${issue.message}\n`;
  }
  return list;
}

function buildInlineComments(issues) {
  const comments = [];
  for (const issue of (issues || [])) {
    if (issue.file && issue.line) {
      const icon = SEVERITY_ICONS[issue.severity] || '•';
      const comment = {
        path: issue.file,
        line: issue.line,
        body: `${icon} **${issue.severity}**: ${issue.message}`,
      };
      if (issue.endLine && issue.endLine > issue.line) {
        comment.start_line = issue.line;
        comment.line = issue.endLine;
      }
      comments.push(comment);
    }
  }
  return comments;
}

module.exports = {
  runFullReview,
  shouldFailForThreshold,
  countBySeverity,
  formatComment,
  formatInlineIssuesAsList,
  buildInlineComments,
  SEVERITY_ICONS,
};
