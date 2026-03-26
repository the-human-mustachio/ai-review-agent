const { formatComment, buildInlineComments } = require('../core/engine');

const BB_API = 'https://api.bitbucket.org/2.0';

/**
 * Detect Bitbucket Pipelines environment.
 */
function detect() {
  return !!process.env.BITBUCKET_BUILD_NUMBER;
}

/**
 * Get PR metadata. Bitbucket Pipelines only provides PR ID, branch, commit,
 * workspace, and repo slug as env vars. Title/author/description must be
 * fetched from the API.
 */
async function getPrMetadata(token) {
  const prId = process.env.BITBUCKET_PR_ID;
  if (!prId) throw new Error('BITBUCKET_PR_ID not set. Is this running on a PR pipeline?');

  const workspace = process.env.BITBUCKET_WORKSPACE;
  const repoSlug = process.env.BITBUCKET_REPO_SLUG;

  if (!workspace || !repoSlug) {
    throw new Error('BITBUCKET_WORKSPACE and BITBUCKET_REPO_SLUG must be set.');
  }

  // Fetch PR details from API since env vars don't include title/author/description
  const prData = await bbFetch(
    `${BB_API}/repositories/${workspace}/${repoSlug}/pullrequests/${prId}`,
    { headers: authHeaders(token) }
  );
  const pr = JSON.parse(prData);

  return {
    prNumber: parseInt(prId, 10),
    prTitle: pr.title || '',
    prAuthor: pr.author?.display_name || pr.author?.nickname || '',
    prBody: pr.description || '',
    baseBranch: pr.destination?.branch?.name || 'main',
    commitHash: process.env.BITBUCKET_COMMIT,
    workspace,
    repoSlug,
  };
}

/**
 * Post review results to Bitbucket PR.
 *
 * Bitbucket doesn't have GitHub's "request changes" concept.
 * Instead we use:
 * - Inline comments for specific issues
 * - Summary comment for the overview
 * - Build status (SUCCESSFUL/FAILED) to block/allow merge
 * - Approve/unapprove as a secondary signal
 */
async function postReview(review, { prNumber, token, postReview: shouldPost = true, log = console.log }) {
  const workspace = process.env.BITBUCKET_WORKSPACE;
  const repoSlug = process.env.BITBUCKET_REPO_SLUG;
  const commitHash = process.env.BITBUCKET_COMMIT;

  if (!workspace || !repoSlug) {
    throw new Error('BITBUCKET_WORKSPACE and BITBUCKET_REPO_SLUG must be set.');
  }

  const baseUrl = `${BB_API}/repositories/${workspace}/${repoSlug}/pullrequests/${prNumber}`;
  const headers = authHeaders(token);

  // Clean up previous AI review comments
  log('Cleaning up previous AI review comments...');
  await deleteStaleComments(baseUrl, headers, log);

  // Post inline comments
  const inlineComments = buildInlineComments(review.issues);
  let inlinePosted = 0;

  for (const comment of inlineComments) {
    try {
      await bbFetch(`${baseUrl}/comments`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: { raw: comment.body, markup: 'markdown' },
          inline: {
            path: comment.path,
            to: comment.line,
            ...(comment.start_line ? { from: comment.start_line } : {}),
          },
        }),
      });
      inlinePosted++;
    } catch (err) {
      log(`Warning: Failed to post inline comment on ${comment.path}:${comment.line}: ${err.message}`);
    }
  }

  log(`Posted ${inlinePosted} inline comment(s).`);

  // Post summary comment
  const summaryBody = formatComment(review);
  await bbFetch(`${baseUrl}/comments`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: { raw: summaryBody, markup: 'markdown' },
    }),
  });

  if (!shouldPost) return;

  // Set build status to block/allow merge (works with branch restrictions on Premium)
  if (commitHash) {
    const statusUrl = `${BB_API}/repositories/${workspace}/${repoSlug}/commit/${commitHash}/statuses/build`;
    try {
      await bbFetch(statusUrl, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          state: review.approve ? 'SUCCESSFUL' : 'FAILED',
          key: 'ai-code-review',
          name: 'AI Code Review',
          description: review.approve
            ? 'AI review passed — no blocking issues found.'
            : `AI review found issues: ${review.summary}`.slice(0, 255),
          url: `https://bitbucket.org/${workspace}/${repoSlug}/pull-requests/${prNumber}`,
        }),
      });
      log(`Set build status: ${review.approve ? 'SUCCESSFUL' : 'FAILED'}`);
    } catch (err) {
      log(`Warning: Could not set build status: ${err.message}`);
    }
  }

  // Approve/unapprove as secondary signal
  if (review.approve) {
    try {
      await bbFetch(`${baseUrl}/approve`, {
        method: 'POST',
        headers,
      });
      log('Approved PR.');
    } catch (err) {
      log(`Warning: Could not approve PR: ${err.message}`);
    }
  } else {
    try {
      await bbFetch(`${baseUrl}/approve`, {
        method: 'DELETE',
        headers,
      });
    } catch {
      // May not have been approved previously — that's fine
    }
    log('PR not approved — issues found.');
  }
}

/**
 * Delete previous AI review comments to prevent accumulation.
 * Identifies bot comments by checking for our signature text.
 */
async function deleteStaleComments(baseUrl, headers, log) {
  try {
    const response = await bbFetch(`${baseUrl}/comments?pagelen=100`, { headers });
    const data = JSON.parse(response);

    for (const comment of (data.values || [])) {
      if (comment.content?.raw?.includes('Generated by AI Code Review')) {
        try {
          await bbFetch(`${baseUrl}/comments/${comment.id}`, {
            method: 'DELETE',
            headers,
          });
          log(`Deleted stale comment #${comment.id}.`);
        } catch (err) {
          log(`Warning: Could not delete comment #${comment.id}: ${err.message}`);
        }
      }
    }
  } catch (err) {
    log(`Warning: Could not list comments for cleanup: ${err.message}`);
  }
}

function authHeaders(token) {
  return { 'Authorization': `Bearer ${token}` };
}

async function bbFetch(url, opts = {}) {
  const response = await fetch(url, opts);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Bitbucket API ${response.status}: ${body}`);
  }
  return response.text();
}

module.exports = { detect, getPrMetadata, postReview };
