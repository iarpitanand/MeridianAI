import { load as loadYaml } from "js-yaml";
import { z } from "zod";
import type { ProbotOctokit } from "probot";

type Octo = InstanceType<typeof ProbotOctokit>;

export interface RuleDef {
  name: string;
  pattern: string; // regex over changed lines
  message: string;
  severity: "low" | "medium" | "high" | "critical";
}

export interface MeridianConfig {
  depth: "chill" | "standard" | "strict";
  maxComments: number;
  minConfidence: number;
  minSeverity: "low" | "medium" | "high" | "critical";
  reviewDrafts: boolean;
  ignore: string[];
  focus: string[];
  instructions: string;
  categories: Record<string, boolean>;
  rules: RuleDef[];
}

export const DEFAULTS: MeridianConfig = {
  depth: "standard",
  maxComments: 10,
  minConfidence: 0.8,
  minSeverity: "low",
  reviewDrafts: false,
  ignore: [],
  focus: [],
  instructions: "",
  categories: { bug: true, security: true, perf: true, logic: true, style: false },
  rules: [],
};

export const DEPTH_PRESET: Record<
  MeridianConfig["depth"],
  Partial<MeridianConfig>
> = {
  chill: { maxComments: 5, minConfidence: 0.9, minSeverity: "high" },
  standard: { maxComments: 10, minConfidence: 0.8, minSeverity: "medium" },
  strict: { maxComments: 20, minConfidence: 0.7, minSeverity: "low" },
};

// .meridian.yml is written snake_case (max_comments, review_drafts); the
// config type is camelCase. Map the wire keys before anything else touches
// the object, or fields with an underscore silently vanish.
const KEY_ALIASES: Record<string, keyof MeridianConfig> = {
  max_comments: "maxComments",
  min_confidence: "minConfidence",
  min_severity: "minSeverity",
  review_drafts: "reviewDrafts",
};

function normalizeKeys(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    out[KEY_ALIASES[k] ?? k] = v;
  }
  return out;
}

const ruleSchema = z.object({
  name: z.string(),
  pattern: z.string(),
  message: z.string(),
  severity: z.enum(["low", "medium", "high", "critical"]),
});

const configSchema = z
  .object({
    depth: z.enum(["chill", "standard", "strict"]).optional(),
    maxComments: z.number().optional(),
    minConfidence: z.number().optional(),
    minSeverity: z.enum(["low", "medium", "high", "critical"]).optional(),
    reviewDrafts: z.boolean().optional(),
    ignore: z.array(z.string()).optional(),
    focus: z.array(z.string()).optional(),
    instructions: z.string().optional(),
    categories: z.record(z.string(), z.boolean()).optional(),
    rules: z.array(ruleSchema).optional(),
  })
  .partial();

/** Fetch and parse .meridian.yml at the PR head; merge over dashboard settings and defaults. */
export async function loadMeridianConfig(
  octokit: Octo,
  owner: string,
  repo: string,
  ref: string,
  dashboardConfig: Partial<MeridianConfig> = {},
): Promise<{ config: MeridianConfig; warning?: string }> {
  const raw = await fetchConfigFile(octokit, owner, repo, ref);
  if (!raw) return { config: mergeConfig({}, dashboardConfig) };

  let yaml: unknown;
  try {
    yaml = loadYaml(raw) ?? {};
  } catch (err) {
    return {
      config: mergeConfig({}, dashboardConfig),
      warning: `Could not parse .meridian.yml (${(err as Error).message}); using defaults.`,
    };
  }

  const normalized = normalizeKeys((yaml as Record<string, unknown>) ?? {});
  const parsed = configSchema.safeParse(normalized);
  if (!parsed.success) {
    return {
      config: mergeConfig({}, dashboardConfig),
      warning: `.meridian.yml has invalid fields (${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}); using defaults.`,
    };
  }

  return { config: mergeConfig(parsed.data, dashboardConfig) };
}

/**
 * Precedence: .meridian.yml > dashboard settings > depth-preset/global defaults.
 * `depth` itself only ever comes from the file or the dashboard (never a bare
 * preset), and expands into maxComments/minConfidence/minSeverity at the
 * "defaults" tier — so an explicit dashboard value for one of those still
 * beats a preset implied by the file's depth, but an explicit file value
 * always wins outright.
 */
function mergeConfig(
  fileConfig: Partial<MeridianConfig>,
  dashboardConfig: Partial<MeridianConfig>,
): MeridianConfig {
  const effectiveDepth = fileConfig.depth ?? dashboardConfig.depth ?? DEFAULTS.depth;
  const preset = DEPTH_PRESET[effectiveDepth] ?? {};

  const base = { ...DEFAULTS, ...preset };
  const merged: MeridianConfig = Object.assign(
    {},
    base,
    stripUndefined(dashboardConfig),
    stripUndefined(fileConfig),
  );

  merged.depth = effectiveDepth;
  merged.categories = {
    ...DEFAULTS.categories,
    ...(dashboardConfig.categories ?? {}),
    ...(fileConfig.categories ?? {}),
  };
  merged.rules = Array.isArray(fileConfig.rules) ? fileConfig.rules : [];
  return merged;
}

async function fetchConfigFile(
  octokit: Octo,
  owner: string,
  repo: string,
  ref: string,
): Promise<string | null> {
  for (const path of [".meridian.yml", ".meridian.yaml", ".github/meridian.yml"]) {
    try {
      const { data } = await octokit.rest.repos.getContent({
        owner,
        repo,
        path,
        ref,
      });
      if (!Array.isArray(data) && data.type === "file" && data.content) {
        return Buffer.from(data.content, "base64").toString("utf8");
      }
    } catch {
      // 404 -> try next path
    }
  }
  return null;
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

export { DEFAULTS as defaultMeridianConfig };
