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
  const stdout = execOpenCode(['run', '--format', 'json', prompt], { log, label: 'review' });
  if (!stdout) return DEFAULT_REVIEW;
  return parseReviewOutput(stdout, { log });
}

/**
 * Run OpenCode with the orchestrator agent for agentic review mode.
 */
function runAgenticOpencode(prompt, id, { log = console.log } = {}) {
  const stdout = execOpenCode(['run', '--agent', 'orchestrator', '--format', 'json', prompt], { log, label: 'orchestrator' });
  if (!stdout) return DEFAULT_REVIEW;
  return parseReviewOutput(stdout, { log });
}

/**
 * Run OpenCode to generate a PR summary.
 */
function runSummary(prompt, id, { log = console.log } = {}) {
  const stdout = execOpenCode(['run', '--format', 'json', prompt], { log, label: 'summary' });
  if (!stdout) return '';
  return parseSummaryOutput(stdout);
}

// ─── OpenCode Execution ─────────────────────────────────────────────────────

function execOpenCode(args, { log, label }) {
  try {
    return execFileSync('opencode', args, {
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (execErr) {
    const stderr = execErr.stderr || '';
    const stdout = execErr.stdout || '';
    if (stderr) log(`OpenCode ${label} stderr: ${stderr}`);
    if (!stdout) {
      log(`OpenCode ${label} exited with code ${execErr.status}, no stdout`);
      return null;
    }
    return stdout;
  }
}

// ─── Output Parsing ─────────────────────────────────────────────────────────

/**
 * Parse OpenCode streaming JSON output into structured parts.
 */
function parseOpenCodeOutput(output) {
  const lines = output.split('\n').filter(Boolean);
  const toolCalls = [];
  const textParts = [];
  const eventTypes = new Set();

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.type) eventTypes.add(parsed.type);
      if (parsed.type === 'tool_use' && parsed.part) {
        toolCalls.push({
          tool: parsed.part.tool,
          state: parsed.part.state,
        });
      }
      if (parsed.type === 'text' && parsed.part?.text) {
        textParts.push(parsed.part.text);
      }
    } catch {
      // Not valid JSON line, skip
    }
  }

  return { toolCalls, textParts, eventTypes, lines };
}

/**
 * Extract review from submit-review tool call.
 */
function parseReviewOutput(output, { log = console.log } = {}) {
  const { toolCalls, eventTypes, lines } = parseOpenCodeOutput(output);

  log(`OpenCode event types: ${[...eventTypes].join(', ')} (${lines.length} lines, ${toolCalls.length} tool calls)`);
  if (toolCalls.length > 0) {
    log(`Tool calls: ${toolCalls.map(c => c.tool).join(', ')}`);
  }

  for (const call of toolCalls) {
    if (call.tool === 'submit-review' && call.state?.input) {
      const input = call.state.input;
      if (isValidReview(input)) {
        log('Parsed review from submit-review tool call.');
        return input;
      }
    }
  }

  log('Warning: No submit-review tool call found in OpenCode output.');
  log(`Raw output lines:\n${lines.map((l, i) => `  [${i}] ${l.slice(0, 300)}`).join('\n')}`);
  return DEFAULT_REVIEW;
}

/**
 * Extract PR summary from submit-summary tool call.
 */
function parseSummaryOutput(output) {
  const { toolCalls, textParts } = parseOpenCodeOutput(output);

  for (const call of toolCalls) {
    if (call.tool === 'submit-summary' && call.state?.input) {
      const input = call.state.input;
      if (input.overview) {
        return `### Overview\n${input.overview}\n\n### Changes\n${input.changes}\n\n### Risk Areas\n${input.riskAreas}`;
      }
    }
  }

  // Fallback: plain text (in case tool wasn't called)
  return textParts.join('').trim();
}

function isValidReview(obj) {
  return (
    obj &&
    typeof obj === 'object' &&
    typeof obj.approve === 'boolean' &&
    typeof obj.summary === 'string'
  );
}

module.exports = { runReview, runAgenticOpencode, runSummary, parseReviewOutput };
