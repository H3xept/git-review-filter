import { compileGlob, type GlobMatcher } from "./glob";

/**
 * Rules use .gitignore-style lines:
 *   *.spec.*          hide matching files
 *   !important.spec.ts  show again (last matching line wins)
 *   re:^src/gen/      regular expression tested against the full path
 *   # comment
 */
export interface Rule {
  readonly line: string;
  /** Where the rule came from, e.g. `preset:Tests`, `global`, `repo:owner/name`. */
  readonly origin: string;
  readonly negate: boolean;
  readonly matcher: GlobMatcher;
}

export interface RuleError {
  readonly origin: string;
  readonly lineNumber: number;
  readonly line: string;
  readonly message: string;
}

export function parseRules(text: string, origin: string): { rules: Rule[]; errors: RuleError[] } {
  const rules: Rule[] = [];
  const errors: RuleError[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    const negate = line.startsWith("!");
    const body = negate ? line.slice(1) : line;
    try {
      rules.push({ line, origin, negate, matcher: compileMatcher(body) });
    } catch (e) {
      errors.push({ origin, lineNumber: index + 1, line, message: (e as Error).message });
    }
  });
  return { rules, errors };
}

function compileMatcher(body: string, nocase = false): GlobMatcher {
  if (body.startsWith("re:")) {
    const re = new RegExp(body.slice(3), nocase ? "i" : "");
    return { source: body, test: (path) => re.test(path) };
  }
  return compileGlob(body, { nocase });
}

export const PRESETS = {
  Tests: ["*.spec.*", "*.test.*", "*_test.go", "test_*.py", "__tests__/", "__snapshots__/", "*.snap"],
  Lockfiles: [
    "package-lock.json",
    "npm-shrinkwrap.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "bun.lock",
    "bun.lockb",
    "Cargo.lock",
    "go.sum",
    "poetry.lock",
    "uv.lock",
    "Pipfile.lock",
    "Gemfile.lock",
    "composer.lock",
    "Podfile.lock",
  ],
  Generated: ["*.min.js", "*.min.css", "*.map", "*.generated.*", "*.g.dart", "*.pb.go", "*_pb2.py", "dist/", "vendor/"],
  Docs: ["*.md", "*.mdx", "*.rst", "docs/", "LICENSE*", "CHANGELOG*"],
} as const satisfies Record<string, readonly string[]>;

export type PresetName = keyof typeof PRESETS;
export const PRESET_NAMES = Object.keys(PRESETS) as PresetName[];

export function presetRules(names: Iterable<PresetName>): Rule[] {
  const out: Rule[] = [];
  for (const name of names) out.push(...parseRules(PRESETS[name].join("\n"), `preset:${name}`).rules);
  return out;
}

/** A rule line that matches exactly one repository path, escaping glob syntax (`src/[id]/page.tsx`). */
export function exactPathRule(path: string): string {
  return "/" + path.replace(/[\\*?[\]{}]/g, "\\$&");
}

/**
 * Second-to-last name parts that mark a file kind (`user.spec.ts`, `types.d.ts`). Other middle parts,
 * such as build variants in `Flags.native-fb.js`, would split one file type into many chips.
 */
const KIND_QUALIFIERS = new Set(["spec", "test", "e2e", "cy", "bench", "d", "min", "stories", "story", "module", "config", "generated", "g", "pb", "snap", "mock", "fixture", "tar"]);

/** `foo.spec.ts` → `.spec.ts`, `Flags.native-fb.js` → `.js`, `Makefile` → `(none)`, `.eslintrc` → `.eslintrc`. */
export function extensionKey(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const parts = base.replace(/^\.+/, "").split(".");
  if (parts.length <= 1) return base.startsWith(".") ? base : "(none)";
  const last = parts[parts.length - 1]!;
  const qualifier = parts.length >= 3 ? parts[parts.length - 2]!.toLowerCase() : null;
  return qualifier !== null && KIND_QUALIFIERS.has(qualifier) ? `.${qualifier}.${last}` : `.${last}`;
}

export type HideReason =
  | { kind: "rule"; rule: string; origin: string }
  | { kind: "extension"; extension: string }
  | { kind: "suggestion"; detail: string }
  | { kind: "search" }
  | { kind: "manual" };

export interface Decision {
  readonly hidden: boolean;
  /** Set when hidden. */
  readonly reason?: HideReason;
}

/** Search box query: substring (case-insensitive), glob when it has glob characters, `re:` regex; a leading `!` excludes matches. */
export function compileQuery(query: string): ((path: string) => boolean) | null {
  const q = query.trim();
  if (q === "") return null;
  const negate = q.startsWith("!");
  const body = negate ? q.slice(1) : q;
  if (body === "") return null;
  let test: (path: string) => boolean;
  if (body.startsWith("re:") || /[*?[{]/.test(body)) {
    test = compileMatcher(body, true).test;
  } else {
    const needle = body.toLowerCase();
    test = (path) => path.toLowerCase().includes(needle);
  }
  return negate ? (p) => !test(p) : test;
}

export interface VisibilityInput {
  readonly paths: readonly string[];
  /** Ordered rules; the last matching rule decides. */
  readonly rules: readonly Rule[];
  readonly hiddenExtensions: ReadonlySet<string>;
  /** Files hidden because the user accepted a Jev suggestion; value is the reason text. */
  readonly acceptedSuggestions: ReadonlyMap<string, string>;
  /** Per-file manual override: true = force hidden, false = force shown. Wins over every other filter. */
  readonly overrides: ReadonlyMap<string, boolean>;
  readonly query: string;
}

export function computeVisibility(input: VisibilityInput): Map<string, Decision> {
  const out = new Map<string, Decision>();
  // Invalid search queries (e.g. an unfinished regex) leave search inactive instead of throwing on every keystroke.
  let matchesQuery: ((path: string) => boolean) | null = null;
  try {
    matchesQuery = compileQuery(input.query);
  } catch {
    matchesQuery = null;
  }

  for (const path of input.paths) {
    const override = input.overrides.get(path);
    if (override !== undefined) {
      out.set(path, override ? { hidden: true, reason: { kind: "manual" } } : { hidden: false });
      continue;
    }
    out.set(path, decide(path, input, matchesQuery));
  }
  return out;
}

function decide(path: string, input: VisibilityInput, matchesQuery: ((path: string) => boolean) | null): Decision {
  let ruleHit: Rule | undefined;
  for (const rule of input.rules) {
    if (rule.matcher.test(path)) ruleHit = rule;
  }
  if (ruleHit && !ruleHit.negate) {
    return { hidden: true, reason: { kind: "rule", rule: ruleHit.line, origin: ruleHit.origin } };
  }
  const ext = extensionKey(path);
  if (input.hiddenExtensions.has(ext)) return { hidden: true, reason: { kind: "extension", extension: ext } };
  const suggestion = input.acceptedSuggestions.get(path);
  if (suggestion !== undefined) return { hidden: true, reason: { kind: "suggestion", detail: suggestion } };
  if (matchesQuery && !matchesQuery(path)) return { hidden: true, reason: { kind: "search" } };
  return { hidden: false };
}

export function describeReason(reason: HideReason): string {
  switch (reason.kind) {
    case "rule":
      return `${reason.origin}: ${reason.rule}`;
    case "extension":
      return `extension ${reason.extension}`;
    case "suggestion":
      return `Jev: ${reason.detail}`;
    case "search":
      return "search";
    case "manual":
      return "hidden manually";
  }
}
