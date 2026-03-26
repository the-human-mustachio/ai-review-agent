import { tool } from "@opencode-ai/plugin"

export default tool({
  description:
    "Submit the PR summary. You MUST call this tool to submit your summary — do not output markdown as text.",
  args: {
    overview: tool.schema
      .string()
      .describe("1-3 sentences describing what this PR does and why"),
    changes: tool.schema
      .string()
      .describe(
        "Markdown file-by-file walkthrough grouped by area. For each file, one sentence on what changed."
      ),
    riskAreas: tool.schema
      .string()
      .describe(
        "Markdown bullet list of 1-3 areas reviewers should pay closest attention to"
      ),
  },
  async execute(args) {
    return JSON.stringify(args)
  },
})
