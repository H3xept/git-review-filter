import type { FileChange } from "./diff";

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-latest";
/** Bump whenever QUESTIONS or buildState change, so cached answers from an older rubric are not reused. */
export const RUBRIC_VERSION = 1;

export const ROLES = {
  application_logic: "Source code that runs in the product or library",
  tests: "Test files, test helpers, or test snapshots",
  fixtures_or_examples: "Example apps, demo code, storybook stories, or test fixtures",
  documentation: "README, changelog, or other prose documentation",
  configuration_or_build: "Build, CI, tooling, editor, or package manifest configuration",
  dependency_lockfile: "Dependency lock files such as yarn.lock, package-lock.json, or Cargo.lock",
  generated_or_vendored: "Machine-generated, minified, or third-party vendored code",
  assets: "Images, fonts, icons, or other binary or media assets",
  styles: "CSS or other stylesheets",
} as const;
export type Role = keyof typeof ROLES;

export const ATTENTION_LEVELS = [
  "None: the change is a dependency lockfile, generated or minified output, vendored third-party code, or binary content that reviewers do not read line by line",
  "Low: a trivial or mechanical edit such as formatting, renaming, comment or typo fixes, version bumps, or simple test data, where a quick skim is enough",
  "Medium: an ordinary change to code, tests, docs, or configuration that is worth reading once",
  "High: a change to logic, security, permissions, data handling, or a public API that needs careful line-by-line review",
] as const;

export const QUESTIONS = {
  role: {
    type: "choice",
    instructions: "What kind of file is `file.path` in this repository?",
    criteria: ROLES,
  },
  mechanical: {
    type: "noul",
    instructions:
      "Every change in `file.diff_excerpt` is mechanical: formatting, whitespace, import reordering, renaming, or version bumps, with no change to behavior.",
  },
  attention: {
    type: "score",
    instructions: "How much careful human review attention does the change to `file.path` shown in `file.diff_excerpt` need?",
    criteria: ATTENTION_LEVELS,
  },
} as const;

export interface JevState {
  pull_request: { title: string };
  file: {
    path: string;
    previous_path?: string;
    change_type: FileChange["status"];
    lines_added: number;
    lines_removed: number;
    diff_excerpt: string;
    diff_excerpt_truncated: boolean;
  };
}

export function buildState(prTitle: string, file: FileChange): JevState {
  return {
    pull_request: { title: prTitle },
    file: {
      path: file.path,
      ...(file.oldPath !== undefined ? { previous_path: file.oldPath } : {}),
      change_type: file.status,
      lines_added: file.additions,
      lines_removed: file.deletions,
      diff_excerpt: file.excerpt,
      diff_excerpt_truncated: file.truncated,
    },
  };
}

export interface JevAnswers {
  role: { type: "choice"; choice: Role; confidence: number; probabilities: Record<Role, number> };
  mechanical: { type: "noul"; noul: number };
  attention: { type: "score"; score: number; confidence: number; probabilities: Record<string, number> };
}

/** Narrows an API response body to the answers this rubric expects; throws on anything else. */
export function readAnswers(body: unknown): { answers: JevAnswers; model: string } {
  const b = body as { model?: unknown; answers?: Partial<Record<keyof JevAnswers, { type?: string }>> } | null;
  const a = b?.answers;
  if (typeof b?.model !== "string" || a?.role?.type !== "choice" || a.mechanical?.type !== "noul" || a.attention?.type !== "score") {
    throw new Error(`Unexpected Jev response: ${JSON.stringify(body).slice(0, 200)}`);
  }
  return { answers: a as unknown as JevAnswers, model: b.model };
}

export interface SuggestionSettings {
  /** Files with `attention.score` below this are suggested (0 = none … 3 = high). */
  attentionThreshold: number;
  /** Extra roles the user treats as low interest (e.g. tests, documentation). */
  lowInterestRoles: readonly Role[];
}

export const DEFAULT_SUGGESTION_SETTINGS: SuggestionSettings = { attentionThreshold: 0.75, lowInterestRoles: [] };

/** Roles that are low interest regardless of user settings. */
const ALWAYS_LOW: readonly Role[] = ["dependency_lockfile", "generated_or_vendored", "assets"];
const ROLE_MIN_PROBABILITY = 0.8;
const MECHANICAL_MIN = 0.9;
/** A file whose attention score reaches this is never suggested, whatever its role. */
const ATTENTION_CEILING = 1.5;

export interface Classification {
  readonly low: boolean;
  readonly reason: string;
  readonly attention: number;
  readonly role: Role;
  readonly roleProbability: number;
}

/**
 * Combines the three answers in code (System One composite pattern). Suggestions are conservative:
 * a file needs a low attention score, or a confident low-interest role / mechanical change while
 * its attention stays below ATTENTION_CEILING.
 */
export function classify(answers: JevAnswers, settings: SuggestionSettings): Classification {
  const attention = answers.attention.score;
  const role = answers.role.choice;
  const roleProbability = answers.role.probabilities[role] ?? 0;
  const base = { attention, role, roleProbability };
  const label = ROLE_LABELS[role];

  if (attention < settings.attentionThreshold) {
    return { ...base, low: true, reason: `${label}; review attention ${attention.toFixed(1)}/3` };
  }
  if (attention < ATTENTION_CEILING) {
    const lowRoles = new Set<Role>([...ALWAYS_LOW, ...settings.lowInterestRoles]);
    if (lowRoles.has(role) && roleProbability >= ROLE_MIN_PROBABILITY) {
      return { ...base, low: true, reason: `${label} (${Math.round(roleProbability * 100)}%)` };
    }
    if (answers.mechanical.noul >= MECHANICAL_MIN) {
      return { ...base, low: true, reason: `mechanical change (${Math.round(answers.mechanical.noul * 100)}%)` };
    }
  }
  return { ...base, low: false, reason: `${label}; review attention ${attention.toFixed(1)}/3` };
}

export const ROLE_LABELS: Record<Role, string> = {
  application_logic: "application logic",
  tests: "tests",
  fixtures_or_examples: "fixtures/examples",
  documentation: "documentation",
  configuration_or_build: "config/build",
  dependency_lockfile: "lockfile",
  generated_or_vendored: "generated/vendored",
  assets: "asset",
  styles: "styles",
};
