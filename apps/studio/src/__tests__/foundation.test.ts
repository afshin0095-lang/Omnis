/**
 * The welcome surface lists the foundation packages, so the list has to be true.
 *
 * This test reads the workspace and compares. Without it the caption goes stale the
 * first time a package is added or renamed, and a stale caption on the product's own
 * front door is worse than no caption.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FOUNDATION_DESCRIPTIONS, FOUNDATION_PACKAGES } from "../foundation";

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

describe("the foundation caption", () => {
  it("lists exactly the packages the workspace contains", () => {
    expect([...FOUNDATION_PACKAGES].sort()).toEqual(workspacePackageNames());
  });

  it("has no duplicates", () => {
    expect(new Set(FOUNDATION_PACKAGES).size).toBe(FOUNDATION_PACKAGES.length);
  });

  it("describes every package it names", () => {
    for (const name of FOUNDATION_PACKAGES) {
      const description = FOUNDATION_DESCRIPTIONS[name];
      expect(description, name).toBeTruthy();
      // A description that is a restatement of the name tells the reader nothing.
      expect(description.length, name).toBeGreaterThan(24);
      expect(description.endsWith("."), name).toBe(true);
    }
  });

  it("describes nothing that does not exist", () => {
    const known = new Set<string>(FOUNDATION_PACKAGES);
    for (const name of Object.keys(FOUNDATION_DESCRIPTIONS)) {
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
});
