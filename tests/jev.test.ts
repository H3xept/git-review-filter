import { describe, expect, test } from "bun:test";
import { classify, readAnswers, ROLES, type JevAnswers, type Role, type SuggestionSettings } from "../src/core/jev";

function answers(role: Role, roleP: number, attention: number, mechanical = 0): JevAnswers {
  const probabilities = Object.fromEntries(Object.keys(ROLES).map((r) => [r, r === role ? roleP : (1 - roleP) / 8])) as Record<Role, number>;
  return {
    role: { type: "choice", choice: role, confidence: roleP, probabilities },
    mechanical: { type: "noul", noul: mechanical },
    attention: { type: "score", score: attention, confidence: 0.9, probabilities: {} },
  };
}

const defaults: SuggestionSettings = { attentionThreshold: 0.75, lowInterestRoles: [] };

describe("classify", () => {
  test("suggests files below the attention threshold", () => {
    expect(classify(answers("application_logic", 0.9, 0.5), defaults).low).toBe(true);
    expect(classify(answers("application_logic", 0.9, 0.8), defaults).low).toBe(false);
  });

  test("lockfiles, generated code and assets are suggested when confident and attention is below 1.5", () => {
    expect(classify(answers("dependency_lockfile", 0.95, 1.2), defaults)).toMatchObject({ low: true, reason: "lockfile (95%)" });
    expect(classify(answers("dependency_lockfile", 0.6, 1.2), defaults).low).toBe(false);
  });

  test("never suggests a file whose attention reaches 1.5, whatever its role", () => {
    expect(classify(answers("generated_or_vendored", 1, 1.5), defaults).low).toBe(false);
    expect(classify(answers("tests", 1, 2.1), { ...defaults, lowInterestRoles: ["tests"] }).low).toBe(false);
  });

  test("user-selected roles only count when the user selected them", () => {
    expect(classify(answers("tests", 0.9, 1.2), defaults).low).toBe(false);
    expect(classify(answers("tests", 0.9, 1.2), { ...defaults, lowInterestRoles: ["tests"] }).low).toBe(true);
  });

  test("confident mechanical changes are suggested", () => {
    expect(classify(answers("application_logic", 1, 1.1, 0.95), defaults)).toMatchObject({ low: true, reason: "mechanical change (95%)" });
    expect(classify(answers("application_logic", 1, 1.1, 0.6), defaults).low).toBe(false);
  });
});

describe("readAnswers", () => {
  test("accepts a response with all three answers", () => {
    const body = { model: "jev-1.13.0", answers: answers("tests", 1, 1) };
    expect(readAnswers(body).model).toBe("jev-1.13.0");
  });

  test("rejects a response missing an answer", () => {
    expect(() => readAnswers({ model: "jev-1.13.0", answers: { role: { type: "choice" } } })).toThrow(/Unexpected Jev response/);
  });
});
