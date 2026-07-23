export type Severity = "low" | "medium" | "high" | "critical";
export type Category =
  | "bug"
  | "security"
  | "perf"
  | "logic"
  | "style"
  | "rule";

export interface RawFinding {
  file: string;
  startLine: number;
  endLine: number;
  severity: Severity;
  category: Category;
  explanation: string;
  suggestedCode?: string | null;
  source: "ai" | "rule";
  // populated by the critic
  keep?: boolean;
  confidence?: number;
  ruleName?: string;
}

export interface InlineComment {
  path: string;
  startLine: number;
  endLine: number;
  multiLine: boolean;
  body: string;
  severity: Severity;
  confidence: number;
}

export interface ReviewResult {
  summary: string;
  inline: InlineComment[];
  demoted: RawFinding[]; // couldn't anchor; rolled into the summary
}

export const SEVERITY_RANK: Record<Severity, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};
