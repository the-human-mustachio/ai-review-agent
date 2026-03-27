import fs from 'fs';
import { Octokit } from '@octokit/rest';
import { formatComment, formatInlineIssuesAsList, buildInlineComments } from '../core/engine.js';
import type { PrMetadata, Review, PostReviewOptions } from '../types.js';

type LogFn = (...args: unknown[]) => void;

export function detect(): boolean {
  return !!process.env.GITHUB_ACTIONS;
}

export async function getPrMetadata(): Promise<PrMetadata> {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) throw new Error('GITHUB_EVENT_PATH not set');

  const event = JSON.parse(fs.readFileSync(eventPath, 'utf-8'));
  const pr = event.pull_request;
  if (!pr) throw new Error('No pull_request in event payload');

  return {
    prNumber: pr.number,
    prTitle: pr.title,
    prAuthor: pr.user.login,
    prBody: pr.body || '',
    baseBranch: pr.base.ref,
  };
}

export async function postReview(
  review: Review,
  { prNumber, token, postReview: shouldPost = true, log = console.log }: PostReviewOptions,
): Promise<void> {
  const octokit = new Octokit({ auth: token });

  const [owner, repo] = (process.env.GITHUB_REPOSITORY || '').split('/');

  // Dismiss stale reviews
  log('Dismissing stale reviews...');
  await dismissStaleReviews(octokit, owner, repo, prNumber, log);

  if (!shouldPost) {
    await octokit.issues.createComment({
      owner,
      repo,
      issue_number: Number(prNumber),
      body: formatComment(review),
    });
    return;
  }

  // Get head SHA
  const { data: pr } = await octokit.pulls.get({ owner, repo, pull_number: Number(prNumber) });
  const commitId = pr.head.sha;

  const inlineComments = buildInlineComments(review.issues);
  const summaryBody = formatComment(review);
  const event = review.approve ? 'APPROVE' as const : 'REQUEST_CHANGES' as const;

  try {
    await octokit.pulls.createReview({
      owner,
      repo,
      pull_number: Number(prNumber),
      commit_id: commitId,
      event,
      body: summaryBody,
      comments: inlineComments,
    });
    log(`Posted review with ${inlineComments.length} inline comment(s).`);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log(`Warning: Failed to post inline comments: ${message}`);
    log('Falling back to summary-only review...');

    await octokit.pulls.createReview({
      owner,
      repo,
      pull_number: Number(prNumber),
      commit_id: commitId,
      event,
      body: summaryBody + formatInlineIssuesAsList(review.issues),
    });
  }
}

async function dismissStaleReviews(
  octokit: InstanceType<typeof Octokit>,
  owner: string,
  repo: string,
  prNumber: string | number,
  log: LogFn,
): Promise<void> {
  try {
    const { data: reviews } = await octokit.pulls.listReviews({
      owner,
      repo,
      pull_number: Number(prNumber),
    });

    const botReviews = reviews.filter(
      (r) =>
        r.user?.login === 'github-actions[bot]' &&
        (r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED'),
    );

    for (const review of botReviews) {
      try {
        await octokit.pulls.dismissReview({
          owner,
          repo,
          pull_number: Number(prNumber),
          review_id: review.id,
          message: 'Superseded by new AI review.',
        });
        log(`Dismissed stale review #${review.id}.`);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        log(`Warning: Could not dismiss review #${review.id}: ${message}`);
      }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log(`Warning: Could not list reviews for dismissal: ${message}`);
  }
}
