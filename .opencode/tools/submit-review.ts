import { tool } from "@opencode-ai/plugin"

export default tool({
  description:
    "Submit the final code review result. You MUST call this tool to submit your review — do not output JSON as text.",
  args: {
    approve: tool.schema
      .boolean()
      .describe("true only if there are NO blocking issues"),
    summary: tool.schema
      .string()
      .describe("1-3 sentence overview of the PR quality"),
    issues: tool.schema
      .array(
        tool.schema.object({
          severity: tool.schema
            .enum(["blocking", "warning", "info"])
            .describe(
              "blocking = bugs/security/breaking, warning = quality/tests, info = style/nits"
            ),
          message: tool.schema
            .string()
            .describe("Concise description under 120 chars"),
          file: tool.schema
            .string()
            .describe("Exact file path from the diff header"),
          line: tool.schema
            .number()
            .describe("Line number from the diff hunk header (+ side)"),
          endLine: tool.schema
            .number()
            .optional()
            .describe("Optional end line if the issue spans multiple lines"),
        })
      )
      .describe("List of issues found, maximum 20"),
    recommendation: tool.schema
      .string()
      .describe("Brief next steps for the PR author"),
  },
  async execute(args) {
    return JSON.stringify(args)
  },
})
