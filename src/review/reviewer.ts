import { z } from "zod";
import { callTool } from "../llm/anthropic.js";
import { config } from "../config.js";
import type { ContextPack } from "./context.js";
import type { RawFinding, Severity, Category } from "./types.js";

const findingSchema = z.object({
  file: z.string(),
  start_line: z.number().int(),
  end_line: z.number().int(),
  severity: z.enum(["low", "medium", "high", "critical"]),
  category: z.enum(["bug", "security", "perf", "logic", "style"]),
  explanation: z.string(),
  suggested_code: z.string().nullish(),
});
const reviewSchema = z.object({
  summary: z.string(),
  findings: z.array(findingSchema),
});

const TOOL_SCHEMA = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      description:
        "A concise PR walkthrough: what it does, risk areas, what to review first. Markdown.",
    },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          file: { type: "string", description: "Repo-relative path of the changed file." },
          start_line: { type: "number", description: "New-file line number (right side of diff)." },
          end_line: { type: "number", description: "New-file end line (== start_line for single line)." },
          severity: { type: "string", enum: ["low", "medium", "high", "critical"] },
          category: { type: "string", enum: ["bug", "security", "perf", "logic", "style"] },
          explanation: { type: "string", description: "One or two sentences: the issue and why it matters." },
          suggested_code: {
            type: ["string", "null"],
            description:
              "Exact replacement code for the line range if a concrete fix exists, else null. No fences.",
          },
        },
        required: ["file", "start_line", "end_line", "severity", "category", "explanation"],
      },
    },
  },
  required: ["summary", "findings"],
};

const SYSTEM = `You are MeridianAI, a senior code reviewer. You review the DIFF using the whole-repo context provided (changed file contents, callers of changed symbols, and related code). Find real issues: bugs, security problems, broken contracts, data loss, logic errors, and meaningful performance problems. Be thorough here — a later critic pass removes nitpicks. Comment on NEW-file line numbers (the right side of the diff). Provide suggested_code only when you are confident of an exact, minimal replacement for the given line range; otherwise null. Pay special attention to cross-file breakage: if a changed function's callers now break, flag it and name the caller.`;

export interface ReviewerOutput {
  summary: string;
  findings: RawFinding[];
}

export async function runReviewer(pack: ContextPack): Promise<ReviewerOutput> {
  const user = renderPack(pack);
  const raw = await callTool<unknown>({
    model: config.REVIEW_MODEL,
    maxTokens: 8000,
    system: SYSTEM,
    user,
    toolName: "submit_review",
    toolDescription: "Submit the PR summary and the list of findings.",
    schema: TOOL_SCHEMA,
  });

  const parsed = reviewSchema.safeParse(raw);
  if (!parsed.success) {
    return { summary: "", findings: [] };
  }

  return {
    summary: parsed.data.summary,
    findings: parsed.data.findings.map((f) => ({
      file: f.file,
      startLine: f.start_line,
      endLine: f.end_line,
      severity: f.severity as Severity,
      category: f.category as Category,
      explanation: f.explanation,
      suggestedCode: f.suggested_code ?? null,
      source: "ai" as const,
    })),
  };
}

function renderPack(pack: ContextPack): string {
  const parts: string[] = [];
  parts.push(`# Pull request\nTitle: ${pack.prTitle}\n\n${pack.prBody || "(no description)"}`);
  if (pack.conventions) {
    parts.push(`# Team conventions\n${pack.conventions}`);
  }
  parts.push(`# Diff\n\`\`\`diff\n${pack.diff}\n\`\`\``);

  if (pack.changedFileContents.length > 0) {
    parts.push(
      `# Changed files (full content)\n` +
        pack.changedFileContents
          .map((f) => `## ${f.path}\n\`\`\`\n${f.content}\n\`\`\``)
          .join("\n\n"),
    );
  }
  if (pack.callers.length > 0) {
    parts.push(
      `# Callers of changed symbols (blast radius)\n` +
        pack.callers
          .map(
            (c) =>
              `## ${c.symbol} — called at ${c.callerFile}:${c.callerLine}\n\`\`\`\n${c.snippet}\n\`\`\``,
          )
          .join("\n\n"),
    );
  }
  if (pack.semantic.length > 0) {
    parts.push(
      `# Related code (semantic)\n` +
        pack.semantic
          .map((s) => `## ${s.file}${s.symbolName ? ` — ${s.symbolName}` : ""}\n\`\`\`\n${s.snippet}\n\`\`\``)
          .join("\n\n"),
    );
  }
  return parts.join("\n\n");
}
