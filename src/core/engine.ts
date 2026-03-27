import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { createOpencode } from '@opencode-ai/sdk';
import { loadPrompt, renderPrompt } from './prompt.js';
import { DEFAULT_PROMPT, AGENTIC_KICKOFF_PROMPT, SUMMARY_PROMPT } from './prompts.js';
import { runReview, runAgenticOpencode, runSummary } from './review.js';
import type { Review, Issue, ReviewOptions, FileDiff, HunkContext, Chunk, InlineComment } from '../types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type LogFn = (...args: unknown[]) => void;

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

const AGENT_FILES = ['orchestrator.md', 'security.md', 'architecture.md', 'testing.md', 'performance.md'];

export async function runFullReview(opts: ReviewOptions): Promise<Review> {
  const {
    baseBranch,
    prTitle,
    prAuthor,
    prBody = '',
    prNumber,
    mode = 'quick',
    summary: shouldGenerateSummary = true,
    promptPath,
    rulesPath,
    excludePatterns = '',
    maxDiffSize = 100000,
    opencodeConfig,
    apiKey,
    provider,
    model: modelId,
    log = console.log,
  } = opts;

  // Build model string for OpenCode config (format: "provider/model")
  const modelString = provider && modelId ? `${provider}/${modelId}` : undefined;
  if (modelString) {
    log(`Using model: ${modelString}`);
  }

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

  // Context + file diffs
  const fileDiffs = splitDiffByFile(fullDiff);
  const context = gatherHunkContext(fileDiffs);

  // Sanitize PR metadata
  const safePrTitle = sanitize(prTitle);
  const safePrAuthor = sanitize(prAuthor);
  const safePrBody = sanitize(prBody);

  // Provision opencode files (agents, config) before starting SDK server
  provisionOpenCodeFiles(log, mode);

  // Start OpenCode SDK server
  log('Starting OpenCode SDK...');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const opencodeOpts: any = { timeout: 10000, port: 0 };
  if (modelString) {
    opencodeOpts.config = { model: modelString };
  }
  const { client, server } = await createOpencode(opencodeOpts);

  try {
    // Generate PR summary
    let prSummary = '';
    if (shouldGenerateSummary) {
      prSummary = await generateSummary({ client, fileDiffs, fullDiff, safePrTitle, safePrAuthor, safePrBody, prNumber, log });
    }

    const shared = { client, fileDiffs, fullDiff, context, rules, safePrTitle, safePrAuthor, safePrBody, prNumber, log };

    let review: Review;
    if (mode === 'agentic') {
      log('Running in agentic mode (multi-agent review)...');
      review = await runAgenticReview({ ...shared, promptPath });
    } else {
      log('Running in quick mode (single-pass review)...');
      review = await runQuickReview({ ...shared, promptPath, maxDiffSize });
    }

    review.prSummary = prSummary;
    return review;
  } finally {
    server.close();
  }
}

// ─── Quick Mode ──────────────────────────────────────────────────────────────

interface ReviewParams {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any;
  fileDiffs: FileDiff[];
  fullDiff: string;
  context: HunkContext[];
  rules: string;
  safePrTitle: string;
  safePrAuthor: string;
  safePrBody: string;
  prNumber: string | number;
  promptPath?: string;
  maxDiffSize?: number;
  log: LogFn;
}

async function runQuickReview({ client, fileDiffs, context, rules, safePrTitle, safePrAuthor, safePrBody, prNumber, promptPath, maxDiffSize = 100000, log }: ReviewParams): Promise<Review> {
  const chunks = buildChunks(fileDiffs, maxDiffSize);
  log(`Split into ${chunks.length} chunk(s) for review.`);

  const template = promptPath ? loadPrompt(promptPath) : DEFAULT_PROMPT;

  const chunkResults = await Promise.all(chunks.map(async (chunk, i) => {
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

    return runReview(client, prompt, `${prNumber}-${i}`, { log });
  }));

  return mergeResults(chunkResults);
}

// ─── Agentic Mode ────────────────────────────────────────────────────────────

async function runAgenticReview({ client, fileDiffs, fullDiff, context, rules, safePrTitle, safePrAuthor, safePrBody, prNumber, promptPath, log }: ReviewParams): Promise<Review> {
  const template = promptPath ? loadPrompt(promptPath) : AGENTIC_KICKOFF_PROMPT;

  const fileList = buildFileList(fileDiffs);

  const contextSection = context.length > 0
    ? `File context (surrounding code for reference):\n${context.map(c => `--- ${c.file} ---\n${c.content}`).join('\n\n')}`
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
    DIFF: fullDiff,
    FILE_LIST: fileList,
  });

  log('Running orchestrator agent...');
  const review = await runAgenticOpencode(client, prompt, prNumber, { log });

  return {
    approve: review.approve,
    summary: review.summary,
    issues: deduplicateIssues(review.issues || []),
    recommendation: review.recommendation || '',
  };
}

// ─── PR Summary ──────────────────────────────────────────────────────────────

interface SummaryParams {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any;
  fileDiffs: FileDiff[];
  fullDiff: string;
  safePrTitle: string;
  safePrAuthor: string;
  safePrBody: string;
  prNumber: string | number;
  log: LogFn;
}

async function generateSummary({ client, fileDiffs, fullDiff, safePrTitle, safePrAuthor, safePrBody, prNumber, log }: SummaryParams): Promise<string> {
  log('Generating PR summary...');
  const template = SUMMARY_PROMPT;
  const fileList = buildFileList(fileDiffs);

  const prompt = renderPrompt(template, {
    PR_TITLE: safePrTitle,
    PR_AUTHOR: safePrAuthor,
    PR_BODY: safePrBody,
    FILE_LIST: fileList,
    DIFF: fullDiff,
  });

  return runSummary(client, prompt, `summary-${prNumber}`, { log });
}

function buildFileList(fileDiffs: FileDiff[]): string {
  return fileDiffs.map(({ file, diff }) => {
    const added = (diff.match(/^\+[^+]/gm) || []).length;
    const removed = (diff.match(/^-[^-]/gm) || []).length;
    return `- ${file} (+${added}/-${removed})`;
  }).join('\n');
}

function provisionOpenCodeFiles(log: LogFn, mode: string): void {
  // In bundle: __dirname is <package>/dist/, so '..' reaches package root.
  // In source: __dirname is <package>/src/core/, so '../..' reaches package root.
  // Use a heuristic: check if .opencode exists at '..' first, then '../..'.
  let packageDir = path.join(__dirname, '..');
  if (!fs.existsSync(path.join(packageDir, '.opencode'))) {
    packageDir = path.join(__dirname, '..', '..');
  }
  const targetOpencode = path.join(process.cwd(), '.opencode');
  const targetAgentDir = path.join(targetOpencode, 'agent');
  const sourceAgentDir = path.join(packageDir, '.opencode', 'agent');

  // Provision agent .md files (only needed for agentic mode)
  if (mode === 'agentic' && !fs.existsSync(path.join(targetAgentDir, 'orchestrator.md'))) {
    log('Provisioning agent files...');
    fs.mkdirSync(targetAgentDir, { recursive: true });

    for (const file of AGENT_FILES) {
      const target = path.join(targetAgentDir, file);
      if (!fs.existsSync(target)) {
        const source = path.join(sourceAgentDir, file);
        if (fs.existsSync(source)) {
          fs.copyFileSync(source, target);
        }
      }
    }
  }

  // Ensure opencode config allows task tool (only for agentic mode)
  const targetConfig = path.join(targetOpencode, 'opencode.json');
  if (mode === 'agentic' && fs.existsSync(targetConfig)) {
    try {
      const existing = JSON.parse(fs.readFileSync(targetConfig, 'utf-8'));
      if (existing.permission && existing.permission.task !== 'allow') {
        log('Overriding task permission to "allow" for agentic mode...');
        existing.permission.task = 'allow';
        fs.writeFileSync(targetConfig, JSON.stringify(existing, null, 2), 'utf-8');
      }
    } catch { /* ignore parse errors */ }
  } else if (mode === 'agentic' && !fs.existsSync(targetConfig)) {
    const sourceConfig = path.join(packageDir, '.opencode', 'opencode.json');
    if (fs.existsSync(sourceConfig)) {
      log('Provisioning default opencode config...');
      fs.copyFileSync(sourceConfig, targetConfig);
    }
  }
}

// ─── Result Merging ──────────────────────────────────────────────────────────

function mergeResults(chunkResults: Review[]): Review {
  let shouldApprove = true;
  const allIssues: Issue[] = [];
  const allSummaries: string[] = [];
  const allRecommendations: string[] = [];

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

function exec(cmd: string): string {
  return execSync(cmd, { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 });
}

function sanitize(text: string): string {
  if (!text) return '';
  const cleaned = text.replace(/---END_USER_INPUT---/gi, '');
  return `---BEGIN_USER_INPUT---\n${cleaned}\n---END_USER_INPUT---`;
}

function deduplicateIssues(issues: Issue[]): Issue[] {
  const seen = new Set<string>();
  const unique: Issue[] = [];
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

export function shouldFailForThreshold(review: Review, threshold: string): string | null {
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

export function countBySeverity(issues: Issue[], severity: string): number {
  return (issues || []).filter((i) => i.severity === severity).length;
}

// ─── Hunk-Aware Context ─────────────────────────────────────────────────────

function gatherHunkContext(fileDiffs: FileDiff[]): HunkContext[] {
  const context: HunkContext[] = [];
  for (const { file, diff } of fileDiffs) {
    if (isBinaryFile(file)) continue;
    if (!fs.existsSync(file)) continue;

    let lines: string[];
    try {
      const content = fs.readFileSync(file, 'utf-8');
      if (content.includes('\0')) continue;
      lines = content.split('\n');
    } catch { continue; }

    const hunkRanges: { start: number; end: number }[] = [];
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

function mergeRanges(ranges: { start: number; end: number }[]): { start: number; end: number }[] {
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

function isBinaryFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

// ─── Diff & Filtering ───────────────────────────────────────────────────────

function splitDiffByFile(fullDiff: string): FileDiff[] {
  const parts = fullDiff.split(/(?=^diff --git )/m).filter(Boolean);
  return parts.map((diff) => {
    const match = diff.match(/^diff --git a\/(.+?) b\/(.+)/);
    const file = match ? match[2] : 'unknown';
    return { file, diff };
  });
}

function buildChunks(fileDiffs: FileDiff[], maxSize: number): Chunk[] {
  const chunks: Chunk[] = [];
  let current = { files: [] as string[], diffs: [] as string[], size: 0 };
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

function filterFiles(files: string[], extraPatterns: string): { included: string[]; excluded: string[] } {
  const patterns = [...DEFAULT_EXCLUDES];
  if (extraPatterns) {
    patterns.push(...extraPatterns.split(',').map((p) => p.trim()).filter(Boolean));
  }
  const included: string[] = [];
  const excluded: string[] = [];
  for (const file of files) {
    if (matchesAny(file, patterns)) {
      excluded.push(file);
    } else {
      included.push(file);
    }
  }
  return { included, excluded };
}

function matchesAny(file: string, patterns: string[]): boolean {
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

function loadRules(rulesPath: string, log: LogFn = console.log): string {
  if (!fs.existsSync(rulesPath)) {
    log(`Warning: Rules path not found: ${rulesPath}`);
    return '';
  }
  const stat = fs.statSync(rulesPath);
  if (stat.isFile()) return fs.readFileSync(rulesPath, 'utf-8');
  if (stat.isDirectory()) {
    const files = fs.readdirSync(rulesPath).filter((f) => !f.startsWith('.')).sort();
    const parts: string[] = [];
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

export const SEVERITY_ICONS: Record<string, string> = { blocking: '🚫', warning: '⚠️', info: '💡' };

export function formatComment(review: Review): string {
  let body = '';

  if (review.prSummary) {
    body += `<details>\n<summary>📋 PR Summary</summary>\n\n${review.prSummary}\n\n</details>\n\n`;
  }

  const verdict = review.approve ? '✅ **Approved**' : '❌ **Changes Requested**';
  body += `## AI Code Review — ${verdict}\n\n${review.summary}`;

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

export function formatInlineIssuesAsList(issues: Issue[]): string {
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

export function buildInlineComments(issues: Issue[]): InlineComment[] {
  const comments: InlineComment[] = [];
  for (const issue of (issues || [])) {
    if (issue.file && issue.line) {
      const icon = SEVERITY_ICONS[issue.severity] || '•';
      const comment: InlineComment = {
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
