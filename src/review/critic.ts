import { z } from "zod";
import { callTool } from "../llm/anthropic.js";
import { config } from "../config.js";
import type { RawFinding } from "./types.js";

const scoreSchema = z.object({
  scores: z.array(
    z.object({
      index: z.number().int(),
      keep: z.boolean(),
      confidence: z.number().min(0).max(1),
    }),
  ),
});

const TOOL_SCHEMA = {
  type: "object",
  properties: {
    scores: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "number", description: "The finding's index from the input list." },
          keep: { type: "boolean", description: "true if a senior engineer would flag this in review." },
          confidence: { type: "number", description: "0..1 confidence that this is a real, worth-posting issue." },
        },
        required: ["index", "keep", "confidence"],
      },
    },
  },
  required: ["scores"],
};

const SYSTEM = `You are a strict senior engineer triaging code-review comments. For each finding, decide whether it is worth posting. KEEP: real bugs, security issues, broken contracts, data loss, clear logic errors. DROP: subjective style, naming preferences, speculative concerns, anything a linter already catches, and false positives. Be harsh — the goal is a small number of high-value comments.`;

/** Returns the findings with keep/confidence populated by the critic. */
export async function runCritic(findings: RawFinding[]): Promise<RawFinding[]> {
  if (findings.length === 0) return [];

  const list = findings
    .map(
      (f, i) =>
        `[${i}] (${f.severity}/${f.category}) ${f.file}:${f.startLine} — ${f.explanation}`,
    )
    .join("\n");

  let scores: z.infer<typeof scoreSchema>["scores"];
  try {
    const raw = await callTool<unknown>({
      model: config.CRITIC_MODEL,
      maxTokens: 2000,
      system: SYSTEM,
      user: `Score these ${findings.length} findings:\n\n${list}`,
      toolName: "submit_scores",
      toolDescription: "Submit a keep/confidence score for every finding by index.",
      schema: TOOL_SCHEMA,
    });
    scores = scoreSchema.parse(raw).scores;
  } catch {
    // On critic failure, fall back to conservative defaults (keep, mid confidence).
    return findings.map((f) => ({ ...f, keep: true, confidence: 0.75 }));
  }

  const byIndex = new Map(scores.map((s) => [s.index, s]));
  return findings.map((f, i) => {
    const s = byIndex.get(i);
    return { ...f, keep: s?.keep ?? true, confidence: s?.confidence ?? 0.75 };
  });
}
