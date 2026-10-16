import { describe, expect, test } from "bun:test";
import { compileGlob } from "../src/core/glob";
import { computeVisibility, exactPathRule, extensionKey, parseRules, presetRules, type VisibilityInput } from "../src/core/rules";

describe("compileGlob", () => {
  const cases: [pattern: string, path: string, expected: boolean][] = [
    // No slash: matches a single segment anywhere (the user's `.spec.` case).
    ["*.spec.*", "src/app/user.spec.ts", true],
    ["*.spec.*", "user.spec.tsx", true],
    ["*.spec.*", "src/spec/user.ts", false],
    ["*.spec.*", "src/user.specs.ts", false],
    // A segment pattern that names a directory hides everything below it.
    ["__tests__", "src/__tests__/a/b.ts", true],
    ["node_modules", "node_modules_backup/x.js", false],
    // Trailing slash: directories only.
    ["docs/", "docs/intro.md", true],
    ["docs/", "src/docs/intro.md", true],
    ["docs/", "docs", false],
    // Slash anywhere else anchors at the repository root.
    ["src/gen/**", "src/gen/a/b.ts", true],
    ["src/gen/**", "lib/src/gen/a.ts", false],
    ["/README.md", "README.md", true],
    ["/README.md", "docs/README.md", false],
    ["src/*.ts", "src/a.ts", true],
    ["src/*.ts", "src/a/b.ts", false],
    ["**/fixtures/*.json", "fixtures/a.json", true],
    ["**/fixtures/*.json", "a/b/fixtures/c.json", true],
    // Classes, braces, escapes.
    ["*.{js,ts}", "a/b.ts", true],
    ["*.{js,ts}", "a/b.tsx", false],
    ["file[0-9].txt", "file7.txt", true],
    ["file[!0-9].txt", "file7.txt", false],
    ["\\*literal", "*literal", true],
    ["\\*literal", "xliteral", false],
    // Regex metacharacters in paths are literal.
    ["a+b(1).ts", "x/a+b(1).ts", true],
  ];
  for (const [pattern, path, expected] of cases) {
    test(`${pattern} ${expected ? "matches" : "does not match"} ${path}`, () => {
      expect(compileGlob(pattern).test(path)).toBe(expected);
    });
  }

  test("rejects an unclosed brace", () => {
    expect(() => compileGlob("*.{js,ts")).toThrow(SyntaxError);
  });
});

describe("parseRules", () => {
  test("skips comments and blank lines, reports invalid lines with their line number", () => {
    const { rules, errors } = parseRules("# tests\n\n*.spec.*\nre:([\n!keep.spec.ts", "repo:a/b");
    expect(rules.map((r) => r.line)).toEqual(["*.spec.*", "!keep.spec.ts"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ lineNumber: 4, line: "re:([" });
  });

  test("re: rules test the full path", () => {
    const [rule] = parseRules("re:^api/.*\\.json$", "global").rules;
    expect(rule!.matcher.test("api/v1/x.json")).toBe(true);
    expect(rule!.matcher.test("src/api/x.json")).toBe(false);
  });
});

describe("exactPathRule", () => {
  test.each(["src/app/[id]/page.tsx", "!important.ts", "#notes.md", "a/{x,y}.ts", "a\\b*.ts"])("matches only %s", (path) => {
    const { rules, errors } = parseRules(exactPathRule(path), "repo");
    expect(errors).toEqual([]);
    expect(rules[0]!.negate).toBe(false);
    expect(rules[0]!.matcher.test(path)).toBe(true);
    expect(rules[0]!.matcher.test(`nested/${path}`)).toBe(false);
    expect(rules[0]!.matcher.test("src/app/i/page.tsx")).toBe(false);
  });
});

describe("extensionKey", () => {
  test.each([
    ["src/user.spec.ts", ".spec.ts"],
    ["a/b/index.ts", ".ts"],
    ["types.d.ts", ".d.ts"],
    ["Makefile", "(none)"],
    [".eslintrc", ".eslintrc"],
    [".github/workflows/ci.yml", ".yml"],
    ["archive.tar.gz", ".tar.gz"],
    ["packages/shared/forks/ReactFeatureFlags.native-fb.js", ".js"],
    ["Button.Stories.tsx", ".stories.tsx"],
  ])("%s → %s", (path, key) => {
    expect(extensionKey(path)).toBe(key);
  });
});

describe("computeVisibility", () => {
  const paths = ["src/app.ts", "src/app.spec.ts", "src/critical.spec.ts", "yarn.lock", "README.md"];
  const base: VisibilityInput = {
    paths,
    rules: [],
    hiddenExtensions: new Set(),
    acceptedSuggestions: new Map(),
    overrides: new Map(),
    query: "",
  };
  const hiddenOf = (input: Partial<VisibilityInput>) =>
    [...computeVisibility({ ...base, ...input })].filter(([, d]) => d.hidden).map(([p]) => p);

  test("hides nothing without filters", () => {
    expect(hiddenOf({})).toEqual([]);
  });

  test("a later negated rule re-shows a file (last match wins)", () => {
    const rules = parseRules("*.spec.*\n!critical.spec.ts", "repo").rules;
    expect(hiddenOf({ rules })).toEqual(["src/app.spec.ts"]);
  });

  test("a later hiding rule overrides an earlier negation", () => {
    const rules = parseRules("!critical.spec.ts\n*.spec.*", "repo").rules;
    expect(hiddenOf({ rules })).toEqual(["src/app.spec.ts", "src/critical.spec.ts"]);
  });

  test("presets hide their groups and record the preset as the reason", () => {
    const decisions = computeVisibility({ ...base, rules: presetRules(["Lockfiles", "Docs"]) });
    expect(decisions.get("yarn.lock")).toEqual({ hidden: true, reason: { kind: "rule", rule: "yarn.lock", origin: "preset:Lockfiles" } });
    expect(decisions.get("README.md")?.hidden).toBe(true);
    expect(decisions.get("src/app.ts")?.hidden).toBe(false);
  });

  test("hidden extension chips use compound extensions", () => {
    expect(hiddenOf({ hiddenExtensions: new Set([".spec.ts"]) })).toEqual(["src/app.spec.ts", "src/critical.spec.ts"]);
  });

  test("search keeps only matching files; a leading ! keeps only non-matching files", () => {
    expect(hiddenOf({ query: "SPEC" })).toEqual(["src/app.ts", "yarn.lock", "README.md"]);
    expect(hiddenOf({ query: "!*.spec.*" })).toEqual(["src/app.spec.ts", "src/critical.spec.ts"]);
  });

  test("an unfinished regex in search hides nothing instead of throwing", () => {
    expect(hiddenOf({ query: "re:(" })).toEqual([]);
  });

  test("accepted Jev suggestions hide files with the suggestion as reason", () => {
    const decisions = computeVisibility({ ...base, acceptedSuggestions: new Map([["yarn.lock", "lockfile (99%)"]]) });
    expect(decisions.get("yarn.lock")).toEqual({ hidden: true, reason: { kind: "suggestion", detail: "lockfile (99%)" } });
  });

  test("manual overrides beat rules in both directions", () => {
    const rules = parseRules("*.spec.*", "repo").rules;
    const overrides = new Map([
      ["src/app.spec.ts", false],
      ["src/app.ts", true],
    ]);
    expect(hiddenOf({ rules, overrides })).toEqual(["src/app.ts", "src/critical.spec.ts"]);
  });
});
