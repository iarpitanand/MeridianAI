import micromatch from "micromatch";
import type { ProbotOctokit } from "probot";
import { buildContextPack } from "./context.js";
import { runReviewer } from "./reviewer.js";
import { runCritic } from "./critic.js";
import { runRules } from "./rules.js";
import { llmEnabled } from "../llm/anthropic.js";
import { anchorFinding, canSuggest } from "./anchor.js";
import { fileByPath, type DiffFile } from "./diff.js";
import { DEPTH_PRESET, type MeridianConfig } from "./meridianConfig.js";
import {
  SEVERITY_RANK,
  type InlineComment,
  type RawFinding,
  type ReviewResult,
  type Severity,
} from "./types.js";

const SEV_EMOJI: Record<Severity, string> = {
  low: "🔵",
  medium: "🟡",
  high: "🟠",
  critical: "🔴",
};

export async function runPipeline(params: {
  octokit: InstanceType<typeof ProbotOctokit>;
  repoId: number;
  owner: string;
  repo: string;
  headSha: string;
  prTitle: string;
  prBody: string;
  diff: string;
  files: DiffFile[];
  config: MeridianConfig;
  configWarning?: string;
}): Promise<ReviewResult> {
  const { files, config } = params;

  // Rules run in parallel with the LLM and never go through the critic.
  const ruleFindings = runRules(files, config.rules);

  let summary = "";
  let aiFindings: RawFinding[] = [];

  if (llmEnabled()) {
    const pack = await buildContextPack(params);
    const reviewed = await runReviewer(pack);
    summary = reviewed.summary;
    aiFindings = await runCritic(reviewed.findings);
  } else {
    summary = fallbackSummary(params.diff);
  }

  // ---- Mechanical filter ----
  const kept: RawFinding[] = [];
  const demoted: RawFinding[] = [];
  const strictPreset = DEPTH_PRESET.strict;

  for (const f of aiFindings) {
    if (f.keep === false) continue;
    // Findings in a `focus` path always get the "strict" thresholds, regardless
    // of the repo's configured depth — that's the point of marking a path focus.
    const inFocus = config.focus.length > 0 && micromatch.isMatch(f.file, config.focus);
    const minConfidence = inFocus ? strictPreset.minConfidence! : config.minConfidence;
    const minSeverity = inFocus ? strictPreset.minSeverity! : config.minSeverity;
    if ((f.confidence ?? 0) < minConfidence) continue;
    if (SEVERITY_RANK[f.severity] < SEVERITY_RANK[minSeverity]) continue;
    if (config.categories[f.category] === false) continue;
    kept.push(f);
  }
  kept.push(...ruleFindings); // always kept

  // Anchor + build inline comments; demote what can't anchor.
  const anchored: InlineComment[] = [];
  for (const f of kept) {
    const file = fileByPath(files, f.file);
    if (!file) {
      demoted.push(f);
      continue;
    }
    const a = anchorFinding(file, f.startLine, f.endLine);
    if (!a.ok || a.startLine === undefined || a.endLine === undefined) {
      demoted.push(f);
      continue;
    }
    anchored.push({
      path: f.file,
      startLine: a.startLine,
      endLine: a.endLine,
      multiLine: a.multiLine,
      severity: f.severity,
      confidence: f.confidence ?? 1,
      body: formatBody(f, file, a.startLine, a.endLine),
    });
  }

  // Dedupe near-identical comments (same file, within 1 line).
  const deduped = dedupe(anchored);

  // Sort by severity × confidence, cap at maxComments.
  deduped.sort(
    (x, y) =>
      SEVERITY_RANK[y.severity] * y.confidence -
      SEVERITY_RANK[x.severity] * x.confidence,
  );
  const inline = deduped.slice(0, config.maxComments);
  const overflow = deduped.slice(config.maxComments);

  return {
    summary: composeSummary(summary, demoted, overflow, params.configWarning),
    inline,
    demoted,
  };
}

function formatBody(
  f: RawFinding,
  file: DiffFile,
  startLine: number,
  endLine: number,
): string {
  const badge =
    f.source === "rule"
      ? `📋 team rule: ${f.ruleName}`
      : `🤖 ${f.category}`;
  const lines = [`${SEV_EMOJI[f.severity]} **${f.explanation}**`, "", `_${badge}_`];

  if (f.suggestedCode && canSuggest(file, startLine, endLine)) {
    lines.push("", "```suggestion", f.suggestedCode, "```");
  }
  return lines.join("\n");
}

function dedupe(comments: InlineComment[]): InlineComment[] {
  const seen = new Map<string, InlineComment>();
  for (const c of comments) {
    const key = `${c.path}:${Math.round(c.startLine)}`;
    const existing = seen.get(key);
    if (
      !existing ||
      SEVERITY_RANK[c.severity] * c.confidence >
        SEVERITY_RANK[existing.severity] * existing.confidence
    ) {
      seen.set(key, c);
    }
  }
  return [...seen.values()];
}

function composeSummary(
  reviewSummary: string,
  demoted: RawFinding[],
  overflow: InlineComment[],
  warning?: string,
): string {
  const parts: string[] = [];
  if (warning) parts.push(`> ⚠️ ${warning}`);
  parts.push("### MeridianAI review");
  parts.push(reviewSummary || "_No blocking issues found._");

  const extras = demoted.length + overflow.length;
  if (extras > 0) {
    const items = [
      ...demoted.map((d) => `- ${d.file}: ${d.explanation}`),
      ...overflow.map((o) => `- ${o.path}:${o.startLine}`),
    ].slice(0, 15);
    parts.push(
      `<details><summary>${extras} more minor item(s)</summary>\n\n${items.join("\n")}\n</details>`,
    );
  }
  return parts.join("\n\n");
}

function fallbackSummary(diff: string): string {
  const files = (diff.match(/^diff --git /gm) ?? []).length;
  let add = 0;
  let del = 0;
  for (const l of diff.split("\n")) {
    if (l.startsWith("+") && !l.startsWith("+++")) add++;
    else if (l.startsWith("-") && !l.startsWith("---")) del++;
  }
  return `_LLM review disabled (no ANTHROPIC_API_KEY). Change size: ${files} file(s), +${add} / −${del}._`;
}
