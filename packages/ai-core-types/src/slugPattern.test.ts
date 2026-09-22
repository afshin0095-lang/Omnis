import { describe, expect, it } from "vitest";
import { isAiCoreSlug, SLUG_CONTRACT, SLUG_PATTERN } from "./slugPattern.js";

describe("SLUG_PATTERN", () => {
  it("accepts url-safe lowercase slugs", () => {
    for (const slug of ["ab", "a1", "gpt-4o", "claude.v3", "local_ollama", "x".repeat(64)]) {
      expect(isAiCoreSlug(slug), slug).toBe(true);
    }
  });

  it("rejects slugs that would need escaping or hide a duplicate", () => {
    for (const slug of [
      "",
      "a",
      "Bad",
      "UPPER",
      "with space",
      "-lead",
      ".lead",
      "trail-",
      "trail_",
      "trail.",
      "x".repeat(65),
      "slüg",
      "a/b",
    ]) {
      expect(isAiCoreSlug(slug), slug).toBe(false);
    }
  });

  it("is stateless: the same value gives the same answer every time", () => {
    // A regex with the sticky or global flag would carry lastIndex between calls, which
    // turns slug validation into a function of call history.
    expect(SLUG_PATTERN.flags).not.toContain("g");
    expect(SLUG_PATTERN.flags).not.toContain("y");
    expect(isAiCoreSlug("openai")).toBe(true);
    expect(isAiCoreSlug("openai")).toBe(true);
  });

  it("documents the contract it enforces", () => {
    expect(SLUG_CONTRACT).toContain("2-64");
    expect(SLUG_CONTRACT).toContain("ending");
  });
});
