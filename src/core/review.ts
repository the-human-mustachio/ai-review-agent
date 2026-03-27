import { reviewSchema, summarySchema } from './schemas.js';
import type { Review } from '../types.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OpenCodeClient = any;
type LogFn = (...args: unknown[]) => void;

const DEFAULT_REVIEW: Review = {
  approve: false,
  summary: 'Failed to parse AI review output.',
  issues: [],
  recommendation: 'Review manually.',
};

export async function runReview(
  client: OpenCodeClient,
  prompt: string,
  id: string | number,
  { log = console.log }: { log?: LogFn } = {},
): Promise<Review> {
  const result = await promptWithSchema(client, {
    prompt,
    schema: reviewSchema,
    log,
    label: `review-${id}`,
  });
  return result || DEFAULT_REVIEW;
}

export async function runAgenticOpencode(
  client: OpenCodeClient,
  prompt: string,
  id: string | number,
  { log = console.log }: { log?: LogFn } = {},
): Promise<Review> {
  const result = await promptWithSchema(client, {
    prompt,
    agent: 'orchestrator',
    schema: reviewSchema,
    log,
    label: `orchestrator-${id}`,
  });
  return result || DEFAULT_REVIEW;
}

export async function runSummary(
  client: OpenCodeClient,
  prompt: string,
  id: string | number,
  { log = console.log }: { log?: LogFn } = {},
): Promise<string> {
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

interface PromptOptions {
  prompt: string;
  agent?: string;
  schema: Record<string, unknown>;
  log: LogFn;
  label: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function promptWithSchema(client: OpenCodeClient, { prompt, agent, schema, log, label }: PromptOptions): Promise<any> {
  try {
    const session = await client.session.create({ body: { title: label } });
    const sessionId = session.data.id;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: any = {
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
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log(`OpenCode SDK error (${label}): ${message}`);
    return null;
  }
}
