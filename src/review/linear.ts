import { z } from "zod";
import { callTool, llmEnabled } from "../llm/anthropic.js";
import { config } from "../config.js";

// Matches the explicit `id: "HAC-1"` (or 'HAC-1') form asked for in the PR body.
const EXPLICIT_ID_PATTERN = /\bid:\s*["']([A-Za-z][A-Za-z0-9]*-\d+)["']/;
// Fallback: a bare Linear-shaped issue key mentioned anywhere (e.g. "HAC-1").
const BARE_ID_PATTERN = /\b([A-Za-z][A-Za-z0-9]{1,9}-\d+)\b/;

/** Extracts a Linear issue identifier from a PR body, or null if none is present. */
export function extractLinearIssueId(prBody: string): string | null {
  const explicit = prBody.match(EXPLICIT_ID_PATTERN);
  if (explicit) return explicit[1].toUpperCase();
  const bare = prBody.match(BARE_ID_PATTERN);
  return bare ? bare[1].toUpperCase() : null;
}

export function linearEnabled(): boolean {
  return Boolean(config.LINEAR_API_KEY);
}

export interface LinearIssue {
  id: string;
  title: string;
  description: string;
}

/** Fetches an issue's title + description from Linear. Returns null on any
 * failure (missing key, not found, network error) — never throws, since this
 * whole feature must be best-effort and additive. */
export async function fetchLinearIssue(issueId: string): Promise<LinearIssue | null> {
  if (!config.LINEAR_API_KEY) return null;
  try {
    const query = `query Issue {\n  issue(id: "${issueId}") {\n    identifier\n    title\n    description\n  }\n}\n`;
    const res = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: config.LINEAR_API_KEY,
      },
      body: JSON.stringify({ query, operationName: "Issue" }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      data?: { issue?: { identifier: string; title: string; description: string | null } | null };
    };
    const issue = json.data?.issue;
    if (!issue) return null;
    return { id: issue.identifier, title: issue.title, description: issue.description ?? "" };
  } catch {
    return null;
  }
}

const requirementSchema = z.object({
  text: z.string(),
  met: z.boolean(),
  note: z.string(),
});
const checkSchema = z.object({
  passed: z.boolean(),
  requirements: z.array(requirementSchema),
  summary: z.string(),
});

export interface LinearCheckResult {
  passed: boolean;
  requirements: { text: string; met: boolean; note: string }[];
  summary: string;
}

const TOOL_SCHEMA = {
  type: "object",
  properties: {
    passed: {
      type: "boolean",
      description: "true only if every extracted requirement is satisfied by the diff",
    },
    requirements: {
      type: "array",
      description: "the issue description broken into individual checkable requirements",
      items: {
        type: "object",
        properties: {
          text: { type: "string", description: "the requirement, verbatim or lightly paraphrased" },
          met: { type: "boolean" },
          note: { type: "string", description: "one sentence: why met or not, referencing the diff" },
        },
        required: ["text", "met", "note"],
      },
    },
    summary: { type: "string", description: "one or two sentence overall verdict" },
  },
  required: ["passed", "requirements", "summary"],
};

const SYSTEM = `You verify whether a pull request's diff satisfies a linked issue's requirements/acceptance criteria. Break the issue description into individual checkable requirements (bullet points, acceptance criteria, explicit asks). For each, judge strictly whether the diff satisfies it — partial or unclear implementation counts as not met. Base your judgment only on the diff provided.`;

/** Returns null if the LLM is disabled or the model doesn't return a usable result — never throws. */
export async function checkAgainstLinearIssue(
  issue: LinearIssue,
  diff: string,
): Promise<LinearCheckResult | null> {
  if (!llmEnabled()) return null;
  try {
    const user = `# Linear issue: ${issue.id} — ${issue.title}\n\n${issue.description || "(no description)"}\n\n# PR diff\n\`\`\`diff\n${diff}\n\`\`\``;
    const raw = await callTool<unknown>({
      model: config.REVIEW_MODEL,
      maxTokens: 2000,
      system: SYSTEM,
      user,
      toolName: "submit_check",
      toolDescription: "Submit the requirements checklist and verdict.",
      schema: TOOL_SCHEMA,
    });
    const parsed = checkSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function renderLinearComment(issue: LinearIssue, result: LinearCheckResult): string {
  const flag = result.passed ? "🟢 **All requirements met**" : "🔴 **Requirements not fully met**";
  const items = result.requirements
    .map((r) => `- ${r.met ? "✅" : "❌"} ${r.text}\n  <sub>${r.note}</sub>`)
    .join("\n");
  return [
    `### Linear check — ${issue.id}: ${issue.title}`,
    flag,
    "",
    items,
    "",
    result.summary,
  ].join("\n");
}
