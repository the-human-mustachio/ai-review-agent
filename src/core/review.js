const { reviewSchema, summarySchema } = require('./schemas');

const DEFAULT_REVIEW = {
  approve: false,
  summary: 'Failed to parse AI review output.',
  issues: [],
  recommendation: 'Review manually.',
};

/**
 * Run OpenCode in quick mode (no agent) and return the parsed review JSON.
 */
async function runReview(client, prompt, id, { log = console.log } = {}) {
  const result = await promptWithSchema(client, {
    prompt,
    schema: reviewSchema,
    log,
    label: `review-${id}`,
  });
  return result || DEFAULT_REVIEW;
}

/**
 * Run OpenCode with the orchestrator agent for agentic review mode.
 */
async function runAgenticOpencode(client, prompt, id, { log = console.log } = {}) {
  const result = await promptWithSchema(client, {
    prompt,
    agent: 'orchestrator',
    schema: reviewSchema,
    log,
    label: `orchestrator-${id}`,
  });
  return result || DEFAULT_REVIEW;
}

/**
 * Run OpenCode to generate a PR summary.
 */
async function runSummary(client, prompt, id, { log = console.log } = {}) {
  const result = await promptWithSchema(client, {
    prompt,
    schema: summarySchema,
    log,
    label: `summary-${id}`,
  });
  if (!result || !result.overview) return '';
  return `### Overview\n${result.overview}\n\n### Changes\n${result.changes}\n\n### Risk Areas\n${result.riskAreas}`;
}

// ─── SDK Interaction ────────────────────────────────────────────────────────

async function promptWithSchema(client, { prompt, agent, schema, log, label }) {
  try {
    const session = await client.session.create({ body: { title: label } });
    const sessionId = session.data.id;

    const body = {
      parts: [{ type: 'text', text: prompt }],
      format: { type: 'json_schema', schema },
    };
    if (agent) body.agent = agent;

    log(`Sending prompt to OpenCode (${label})...`);
    const result = await client.session.prompt({
      path: { id: sessionId },
      body,
    });

    const output = result?.data?.info?.structured;
    if (!output) {
      log(`Warning: No structured output returned for ${label}`);
      return null;
    }

    log(`Received structured output for ${label}.`);
    return output;
  } catch (err) {
    log(`OpenCode SDK error (${label}): ${err.message}`);
    return null;
  }
}

module.exports = { runReview, runAgenticOpencode, runSummary };
