/**
 * The welcome surface lists the packages the workspace ships, so the list has to be true.
 *
 * This test reads the workspace and compares. Without it the caption goes stale the
 * first time a package is added or renamed, and a stale caption on the product's own
 * front door is worse than no caption.
 *
 * It also holds the two groups apart. The foundation is what any bounded context may
 * build on; the AI Core is one context. A package that appears in the wrong group is a
 * claim about the architecture, not a caption mistake, so it is asserted here.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AI_CORE_DESCRIPTIONS,
  AI_CORE_PACKAGES,
  FOUNDATION_DESCRIPTIONS,
  FOUNDATION_PACKAGES,
} from "../foundation";

/**
 * Absolute path to the repository's packages directory.
 *
 * Resolved from the working directory, which Vitest sets to the workspace member.
 * `import.meta.url` is not used because vite-node does not give it a `file:` scheme,
 * which `fileURLToPath` requires.
 */
const PACKAGES_DIR = resolve(process.cwd(), "../../packages");

/** The package name declared by each directory under `packages/`. */
function workspacePackageNames(): string[] {
  return readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const manifest = join(PACKAGES_DIR, entry.name, "package.json");
      const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string };
      expect(parsed.name, manifest).toBeTruthy();
      return parsed.name as string;
    })
    .sort();
}

/** Every package the caption names, in either group. */
const CAPTIONED: readonly string[] = [...FOUNDATION_PACKAGES, ...AI_CORE_PACKAGES];

describe("the package caption", () => {
  it("lists exactly the packages the workspace contains", () => {
    expect([...CAPTIONED].sort()).toEqual(workspacePackageNames());
  });

  it("keeps the shared foundation and the AI Core in separate groups", () => {
    const foundation = new Set<string>(FOUNDATION_PACKAGES);
    for (const name of AI_CORE_PACKAGES) {
      // A package in both groups would be presented as shared and as one domain at the
      // same time, which is exactly the confusion the grouping exists to prevent.
      expect(foundation.has(name), name).toBe(false);
    }
  });

  it("has no duplicates", () => {
    expect(new Set(CAPTIONED).size).toBe(CAPTIONED.length);
  });

  it("describes every package it names", () => {
    const descriptions: Readonly<Record<string, string>> = {
      ...FOUNDATION_DESCRIPTIONS,
      ...AI_CORE_DESCRIPTIONS,
    };
    for (const name of CAPTIONED) {
      const description = descriptions[name];
      expect(description, name).toBeTruthy();
      // A description that is a restatement of the name tells the reader nothing.
      expect(description?.length ?? 0, name).toBeGreaterThan(24);
      expect(description?.endsWith(".") ?? false, name).toBe(true);
    }
  });

  it("describes nothing that does not exist", () => {
    const known = new Set<string>(CAPTIONED);
    for (const name of [
      ...Object.keys(FOUNDATION_DESCRIPTIONS),
      ...Object.keys(AI_CORE_DESCRIPTIONS),
    ]) {
      expect(known.has(name), name).toBe(true);
    }
  });

  it("is ordered by dependency, not alphabetically", () => {
    // `types` has no dependencies and `ui` sits at the top of the frontend chain;
    // an alphabetical list would hide the layering this caption is meant to show.
    expect(FOUNDATION_PACKAGES[0]).toBe("@omnis/types");
    expect(FOUNDATION_PACKAGES[FOUNDATION_PACKAGES.length - 1]).toBe("@omnis/ui");
    expect(FOUNDATION_PACKAGES.indexOf("@omnis/errors")).toBeLessThan(
      FOUNDATION_PACKAGES.indexOf("@omnis/validation"),
    );
    expect(FOUNDATION_PACKAGES.indexOf("@omnis/theme")).toBeLessThan(
      FOUNDATION_PACKAGES.indexOf("@omnis/ui"),
    );
  });

  it("orders the AI Core by dependency as well", () => {
    // Vocabulary first, composition last: a reader scanning the caption sees the layering
    // the AI Core is built in, which is the part of the architecture worth showing.
    expect(AI_CORE_PACKAGES[0]).toBe("@omnis/ai-core-types");
    expect(AI_CORE_PACKAGES[AI_CORE_PACKAGES.length - 1]).toBe("@omnis/ai-core-runtime");
    expect(AI_CORE_PACKAGES.indexOf("@omnis/policy-engine")).toBeLessThan(
      AI_CORE_PACKAGES.indexOf("@omnis/tool-runtime"),
    );
    expect(AI_CORE_PACKAGES.indexOf("@omnis/execution-kernel")).toBeLessThan(
      AI_CORE_PACKAGES.indexOf("@omnis/agent-runtime"),
    );
  });
});
