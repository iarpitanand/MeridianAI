import type { DiffFile } from "./diff.js";
import type { RawFinding } from "./types.js";
import type { RuleDef } from "./meridianConfig.js";

/**
 * Run deterministic .meridian.yml rules over ADDED lines only.
 * Rule findings bypass the LLM critic entirely — if a rule matches, it fires.
 */
export function runRules(files: DiffFile[], rules: RuleDef[]): RawFinding[] {
  if (rules.length === 0) return [];

  const compiled = rules
    .map((r) => {
      try {
        return { rule: r, re: new RegExp(r.pattern) };
      } catch {
        return null; // skip invalid regex rather than crash the review
      }
    })
    .filter((x): x is { rule: RuleDef; re: RegExp } => x !== null);

  const findings: RawFinding[] = [];
  for (const file of files) {
    for (const added of file.addedLines) {
      for (const { rule, re } of compiled) {
        if (re.test(added.content)) {
          findings.push({
            file: file.path,
            startLine: added.line,
            endLine: added.line,
            severity: rule.severity,
            category: "rule",
            explanation: rule.message,
            source: "rule",
            keep: true,
            confidence: 1,
            ruleName: rule.name,
          });
        }
      }
    }
  }
  return findings;
}
