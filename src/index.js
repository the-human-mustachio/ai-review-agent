/**
 * GitHub Actions entry point.
 * Thin wrapper that maps action.yml inputs to the CLI engine.
 */
const core = require('@actions/core');
const { runFullReview, shouldFailForThreshold, countBySeverity } = require('./core/engine');
const githubPlatform = require('./platforms/github');

async function run() {
  try {
    const apiKey = core.getInput('api-key');
    if (apiKey) {
      core.setSecret(apiKey);
    }

    const prMeta = await githubPlatform.getPrMetadata();

    const review = await runFullReview({
      baseBranch: prMeta.baseBranch,
      prTitle: prMeta.prTitle,
      prAuthor: prMeta.prAuthor,
      prBody: prMeta.prBody,
      prNumber: prMeta.prNumber,
      mode: core.getInput('mode') || 'quick',
      summary: core.getInput('summary') !== 'false',
      promptPath: core.getInput('prompt') || undefined,
      rulesPath: core.getInput('rules') || undefined,
      excludePatterns: core.getInput('exclude-patterns'),
      maxDiffSize: parseInt(core.getInput('max-diff-size') || '100000', 10),
      opencodeVersion: core.getInput('opencode-version') || undefined,
      opencodeConfig: core.getInput('opencode-config') || undefined,
      apiKey: apiKey || undefined,
      log: core.info,
    });

    // Set outputs
    core.setOutput('approved', String(review.approve));
    core.setOutput('summary', review.summary);
    core.setOutput('issues-count', String(review.issues.length));
    core.setOutput('blocking-count', String(countBySeverity(review.issues, 'blocking')));
    core.setOutput('pr-summary', review.prSummary || '');

    // Post review
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (!token) {
      core.setFailed('GITHUB_TOKEN or GH_TOKEN is required to post reviews.');
      return;
    }

    await githubPlatform.postReview(review, {
      prNumber: prMeta.prNumber,
      token,
      postReview: core.getInput('post-review') !== 'false',
      log: core.info,
    });

    // Threshold check
    const threshold = core.getInput('severity-threshold') || 'blocking';
    const fail = shouldFailForThreshold(review, threshold);
    if (fail) {
      core.setFailed(fail);
    } else {
      core.info('AI review completed successfully.');
    }
  } catch (error) {
    core.setFailed(`AI review failed: ${error.message}`);
  }
}

run();
