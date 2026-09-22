import { describe, expect, it } from "vitest";
import { ValidationError } from "@omnis/errors";
import { createRuleSet, enabledRules, findRule, ruleSetName } from "./ruleSets.js";
import { ruleSpecFor } from "./EvaluationRules.js";
import { AT } from "./testSupport.js";

/** A valid stored set. */
function set() {
  return createRuleSet({
    name: "gate",
    description: "A release gate",
    version: 3,
    rules: [
      ruleSpecFor("completion"),
      ruleSpecFor("latency", { id: "latency-off", enabled: false }),
    ],
    createdAt: AT,
    updatedAt: AT,
  });
}

describe("ruleSetName", () => {
  it("accepts a slug and rejects anything else", () => {
    expect(ruleSetName("release-gate")).toBe("release-gate");
    expect(() => ruleSetName("Release Gate")).toThrow(ValidationError);
    expect(() => ruleSetName("")).toThrow(ValidationError);
  });
});

describe("createRuleSet", () => {
  it("freezes the set, its rules and its rule list", () => {
    const subject = set();
    expect(Object.isFrozen(subject)).toBe(true);
    expect(Object.isFrozen(subject.rules)).toBe(true);
    expect(Object.isFrozen(subject.rules[0])).toBe(true);
    expect(subject.version).toBe(3);
  });

  it("refuses a set that does not satisfy the contract", () => {
    expect(() => createRuleSet({ ...set(), version: 0 })).toThrow(ValidationError);
    expect(() => createRuleSet({ ...set(), name: "Nope" })).toThrow(ValidationError);
    expect(() => createRuleSet({ ...set(), createdAt: "yesterday" })).toThrow(ValidationError);
  });
});

describe("enabledRules and findRule", () => {
  it("filters disabled rules and looks one up by identifier", () => {
    const subject = set();
    expect(enabledRules(subject).map((rule) => rule.id)).toEqual(["completion"]);
    expect(Object.isFrozen(enabledRules(subject))).toBe(true);
    expect(findRule(subject, "latency-off")?.enabled).toBe(false);
    expect(findRule(subject, "missing")).toBeNull();
  });
});
