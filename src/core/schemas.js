const reviewSchema = {
  type: 'object',
  properties: {
    approve: {
      type: 'boolean',
      description: 'true only if there are NO blocking issues',
    },
    summary: {
      type: 'string',
      description: '1-3 sentence overview of the PR quality',
    },
    issues: {
      type: 'array',
      maxItems: 20,
      description: 'List of issues found, maximum 20',
      items: {
        type: 'object',
        properties: {
          severity: {
            type: 'string',
            enum: ['blocking', 'warning', 'info'],
            description: 'blocking = bugs/security/breaking, warning = quality/tests, info = style/nits',
          },
          message: {
            type: 'string',
            description: 'Concise description under 120 chars',
          },
          file: {
            type: 'string',
            description: 'Exact file path from the diff header',
          },
          line: {
            type: 'number',
            description: 'Line number from the diff hunk header (+ side)',
          },
          endLine: {
            type: 'number',
            description: 'Optional end line if the issue spans multiple lines',
          },
        },
        required: ['severity', 'message', 'file', 'line'],
      },
    },
    recommendation: {
      type: 'string',
      description: 'Brief next steps for the PR author',
    },
  },
  required: ['approve', 'summary', 'issues', 'recommendation'],
};

const summarySchema = {
  type: 'object',
  properties: {
    overview: {
      type: 'string',
      description: '1-3 sentences describing what this PR does and why',
    },
    changes: {
      type: 'string',
      description: 'Markdown file-by-file walkthrough grouped by area. For each file, one sentence on what changed.',
    },
    riskAreas: {
      type: 'string',
      description: 'Markdown bullet list of 1-3 areas reviewers should pay closest attention to',
    },
  },
  required: ['overview', 'changes', 'riskAreas'],
};

module.exports = { reviewSchema, summarySchema };
