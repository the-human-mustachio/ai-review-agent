const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const DEFAULT_REVIEW = {
  approve: false,
  summary: 'Failed to parse AI review output.',
  issues: [],
  recommendation: 'Review manually.',
};

/**
 * Run OpenCode and return the parsed review JSON.
 * Writes prompt to a temp file and pipes via stdin to avoid CLI arg size limits.
 */
function runReview(prompt, id, { log = console.log } = {}) {
  const tmpFile = path.join(os.tmpdir(), `ai-review-prompt-${id}.txt`);
  fs.writeFileSync(tmpFile, prompt, 'utf-8');

  try {
    let stderr = '';
    let stdout;
    try {
      stdout = execSync(
        `opencode run --format json --title "PR Review #${id}" "$(cat "${tmpFile}")"`,
        { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], shell: '/bin/bash' }
      );
    } catch (execErr) {
      stderr = execErr.stderr || '';
      stdout = execErr.stdout || '';
      log(`OpenCode stderr: ${stderr}`);
      if (!stdout) {
        log(`OpenCode exited with code ${execErr.status}, no stdout`);
        return DEFAULT_REVIEW;
      }
    }

    log(`OpenCode stdout (first 500 chars): ${stdout.slice(0, 500)}`);
    return parseReviewOutput(stdout, { log });
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

/**
 * Parse OpenCode JSON output to extract the review object.
 */
function parseReviewOutput(output, { log = console.log } = {}) {
  const lines = output.split('\n').filter(Boolean);
  const textParts = [];

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.type === 'text' && parsed.part?.text) {
        textParts.push(parsed.part.text);
      }
    } catch {
      // Not valid JSON line, skip
    }
  }

  for (const text of textParts) {
    const review = tryParseReview(text);
    if (review) return review;
  }

  if (textParts.length > 1) {
    const combined = textParts.join('');
    const review = tryParseReview(combined);
    if (review) return review;
  }

  log('Warning: Could not extract review JSON from OpenCode output');
  log(`Raw text parts: ${JSON.stringify(textParts)}`);
  return DEFAULT_REVIEW;
}

function tryParseReview(text) {
  const trimmed = text.trim();

  try {
    const obj = JSON.parse(trimmed);
    if (isValidReview(obj)) return obj;
  } catch {}

  const start = trimmed.indexOf('{');
  if (start === -1) return null;

  const jsonStr = trimmed.slice(start);

  try {
    const obj = JSON.parse(jsonStr);
    if (isValidReview(obj)) return obj;
  } catch {}

  const repaired = repairTruncatedJson(jsonStr);
  if (repaired) {
    try {
      const obj = JSON.parse(repaired);
      if (isValidReview(obj)) return obj;
    } catch {}
  }

  return null;
}

function repairTruncatedJson(json) {
  let inString = false;
  let escaped = false;
  const stack = [];

  for (let i = 0; i < json.length; i++) {
    const ch = json[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\' && inString) { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') stack.pop();
  }

  if (stack.length === 0) return null;

  let repaired = json;
  if (inString) repaired += '"';
  while (stack.length > 0) repaired += stack.pop();

  return repaired;
}

function isValidReview(obj) {
  return (
    obj &&
    typeof obj === 'object' &&
    typeof obj.approve === 'boolean' &&
    typeof obj.summary === 'string'
  );
}

module.exports = { runReview, parseReviewOutput };
