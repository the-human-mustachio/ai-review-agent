const { formatComment, formatInlineIssuesAsList, buildInlineComments } = require('../core/engine');

/**
 * Detect GitHub environment and extract PR metadata.
 */
function detect() {
  return !!process.env.GITHUB_ACTIONS;
}

async function getPrMetadata() {
  // In GitHub Actions, the event payload is in a file
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) throw new Error('GITHUB_EVENT_PATH not set');

  const fs = require('fs');
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

/**
 * Post review results to GitHub PR.
 */
async function postReview(review, { prNumber, token, postReview: shouldPost = true, log = console.log }) {
  const { Octokit } = require('@octokit/rest');
  const octokit = new Octokit({ auth: token });

  const [owner, repo] = process.env.GITHUB_REPOSITORY.split('/');

  // Dismiss stale reviews
  log('Dismissing stale reviews...');
  await dismissStaleReviews(octokit, owner, repo, prNumber, log);

  if (!shouldPost) {
    // Just post a comment
    await octokit.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body: formatComment(review),
    });
    return;
  }

  // Get head SHA
  const { data: pr } = await octokit.pulls.get({ owner, repo, pull_number: prNumber });
  const commitId = pr.head.sha;

  const inlineComments = buildInlineComments(review.issues);
  const summaryBody = formatComment(review);
  const event = review.approve ? 'APPROVE' : 'REQUEST_CHANGES';

  try {
    await octokit.pulls.createReview({
      owner,
      repo,
      pull_number: prNumber,
      commit_id: commitId,
      event,
      body: summaryBody,
      comments: inlineComments,
    });
    log(`Posted review with ${inlineComments.length} inline comment(s).`);
  } catch (error) {
    log(`Warning: Failed to post inline comments: ${error.message}`);
    log('Falling back to summary-only review...');

    await octokit.pulls.createReview({
      owner,
      repo,
      pull_number: prNumber,
      commit_id: commitId,
      event,
      body: summaryBody + formatInlineIssuesAsList(review.issues),
    });
  }
}

async function dismissStaleReviews(octokit, owner, repo, prNumber, log) {
  try {
    const { data: reviews } = await octokit.pulls.listReviews({
      owner,
      repo,
      pull_number: prNumber,
    });

    const botReviews = reviews.filter(
      (r) =>
        r.user?.login === 'github-actions[bot]' &&
        (r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED')
    );

    for (const review of botReviews) {
      try {
        await octokit.pulls.dismissReview({
          owner,
          repo,
          pull_number: prNumber,
          review_id: review.id,
          message: 'Superseded by new AI review.',
        });
        log(`Dismissed stale review #${review.id}.`);
      } catch (err) {
        log(`Warning: Could not dismiss review #${review.id}: ${err.message}`);
      }
    }
  } catch (err) {
    log(`Warning: Could not list reviews for dismissal: ${err.message}`);
  }
}

module.exports = { detect, getPrMetadata, postReview };
