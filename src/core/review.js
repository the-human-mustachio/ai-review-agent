const { execFileSync } = require('child_process');

const DEFAULT_REVIEW = {
  approve: false,
  summary: 'Failed to parse AI review output.',
  issues: [],
  recommendation: 'Review manually.',
};

/**
 * Run OpenCode in quick mode (no agent) and return the parsed review JSON.
 */
function runReview(prompt, id, { log = console.log } = {}) {
  try {
    let stderr = '';
    let stdout;
    try {
      stdout = execFileSync(
        'opencode',
        ['run', '--format', 'json', prompt],
        { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }
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
  } finally {}
}

/**
 * Parse OpenCode JSON output to extract the review object.
 */
function parseReviewOutput(output, { log = console.log } = {}) {
  const lines = output.split('\n').filter(Boolean);
  const textParts = [];
  const eventTypes = new Set();

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.type) eventTypes.add(parsed.type);
      if (parsed.type === 'text' && parsed.part?.text) {
        textParts.push(parsed.part.text);
      }
    } catch {
      // Not valid JSON line, skip
    }
  }

  log(`OpenCode event types: ${[...eventTypes].join(', ')} (${lines.length} lines, ${textParts.length} text parts)`);
  if (textParts.length === 0) {
    log(`Raw output lines:\n${lines.map((l, i) => `  [${i}] ${l.slice(0, 300)}`).join('\n')}`);
  }

  // Try combining all text parts first — agentic mode often splits the response across events
  if (textParts.length > 1) {
    const combined = textParts.join('');
    const review = tryParseReview(combined);
    if (review) return review;
  }

  // Search backwards — the final text part is most likely to contain the review JSON
  for (let i = textParts.length - 1; i >= 0; i--) {
    const review = tryParseReview(textParts[i]);
    if (review) return review;
  }

  log('Warning: Could not extract review JSON from OpenCode output');
  log(`Raw text parts (${textParts.length}): ${JSON.stringify(textParts.map(t => t.slice(0, 200)))}`);
  return DEFAULT_REVIEW;
}

function tryParseReview(text) {
  // Strip markdown code fences if present
  let trimmed = text.trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) {
    trimmed = fenceMatch[1].trim();
  }

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

/**
 * Run OpenCode with the orchestrator agent for agentic review mode.
 */
function runAgenticOpencode(prompt, id, { log = console.log } = {}) {
  try {
    let stderr = '';
    let stdout;
    try {
      stdout = execFileSync(
        'opencode',
        ['run', '--agent', 'orchestrator', '--format', 'json', prompt],
        { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }
      );
    } catch (execErr) {
      stderr = execErr.stderr || '';
      stdout = execErr.stdout || '';
      log(`OpenCode orchestrator stderr: ${stderr}`);
      if (!stdout) {
        log(`OpenCode orchestrator exited with code ${execErr.status}, no stdout`);
        return DEFAULT_REVIEW;
      }
    }

    log(`OpenCode orchestrator stdout (first 500 chars): ${stdout.slice(0, 500)}`);
    return parseReviewOutput(stdout, { log });
  } finally {}
}

module.exports = { runReview, runAgenticOpencode, parseReviewOutput };
