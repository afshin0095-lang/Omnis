/**
 * The boundaries the AI Core is built on, asserted against the repository itself.
 *
 * `scripts/check-workspace-health.mjs` is the gate that fails a commit; this suite is
 * the same set of invariants expressed as tests, which means they can be read,
 * reasoned about and extended without learning a second tool. It also asserts things
 * the script deliberately does not: that edges which *must* exist do (an agent runtime
 * that stopped depending on the kernel would be a silently ungoverned pipeline), and
 * that a manifest declares no dependency its source never imports.
 *
 * Nothing here imports another package's internals. The graph is read from files.
 */

import { describe, expect, it } from "vitest";
import {
  AI_CORE_PACKAGE_NAMES,
  importedPackages,
  importsOf,
  isFixtureFile,
  packageOf,
  readWorkspace,
  REPO_ROOT,
} from "../support/workspaceGraph.js";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const workspace = readWorkspace();
/** One pass over the tree: what each member's source actually reaches for. */
const imported = importedPackages(workspace);

/** The packages a member's source actually reaches for. */
function importsOfMember(name: string): ReadonlySet<string> {
  const packages = imported.get(name);
  if (packages === undefined) {
    throw new Error(`"${name}" is not a workspace member`);
  }
  return packages;
}

/** The member with this name, or a failure that says the repository changed. */
function member(name: string): (typeof workspace.members)[number] {
  const found = workspace.byName.get(name);
  if (found === undefined) {
    throw new Error(`"${name}" is not a workspace member`);
  }
  return found;
}

/** Vendor SDKs and agent frameworks: what "provider-independent" excludes. */
const FORBIDDEN_PACKAGES: readonly string[] = Object.freeze([
  "openai",
  "@anthropic-ai/sdk",
  "@google/generative-ai",
  "@google/genai",
  "@aws-sdk/client-bedrock-runtime",
  "cohere-ai",
  "mistralai",
  "@mistralai/mistralai",
  "ai",
  "@ai-sdk/openai",
  "langchain",
  "@langchain/core",
  "@langchain/openai",
  "llamaindex",
]);

/** Rendering packages, which a headless core may not reach for. */
const PRESENTATION_PACKAGES: readonly string[] = Object.freeze([
  "react",
  "react-dom",
  "framer-motion",
  "zustand",
  "lucide-react",
]);

describe("the AI Core exists as twelve packages, and only as twelve packages", () => {
  it("has every package the architecture names", () => {
    const present = workspace.members.map((entry) => entry.name);
    for (const name of AI_CORE_PACKAGE_NAMES) {
      expect(present, `${name} is missing from the workspace`).toContain(name);
    }
  });

  it("gives each one a description, an ESM manifest and a built entry point", () => {
    for (const name of AI_CORE_PACKAGE_NAMES) {
      const entry = member(name);
      expect(entry.manifest.private, `${name} must be private`).toBe(true);
      expect(entry.manifest.type, `${name} must be ESM`).toBe("module");
      expect(
        (entry.manifest.description ?? "").trim().length,
        `${name} must describe itself`,
      ).toBeGreaterThan(0);
      expect(entry.manifest.main, `${name} must be consumed through dist`).toBe("./dist/index.js");
      expect(entry.manifest.types, `${name} must publish its types from dist`).toBe(
        "./dist/index.d.ts",
      );
      expect(
        existsSync(path.join(entry.directory, "src", "index.ts")),
        `${name} needs a single entry point`,
      ).toBe(true);
    }
  });

  it("keeps the composition root the only package that wires everything together", () => {
    const composition = member("@omnis/ai-core-runtime");
    for (const name of AI_CORE_PACKAGE_NAMES) {
      if (name !== composition.name) {
        expect(composition.internal, `the composition must wire ${name}`).toContain(name);
      }
    }
    // A second composition root would be a second place where the gates are ordered, and
    // the two would drift. Nothing else may depend on most of the core.
    for (const entry of workspace.aiCore) {
      if (entry.name === composition.name) {
        continue;
      }
      const wired = entry.internal.filter((dependency) =>
        AI_CORE_PACKAGE_NAMES.includes(dependency),
      );
      expect(
        wired.length,
        `${entry.name} is becoming a second composition root: ${wired.join(", ")}`,
      ).toBeLessThanOrEqual(6);
    }
  });
});

describe("dependencies point downward, and the graph has no cycles", () => {
  /** The layer table, lowest first. A member may depend only on strictly lower layers. */
  const LAYERS: readonly (readonly string[])[] = Object.freeze([
    Object.freeze(["@omnis/types", "@omnis/theme"]),
    Object.freeze(["@omnis/errors"]),
    Object.freeze(["@omnis/validation", "@omnis/ai-core-types"]),
    Object.freeze(["@omnis/contracts", "@omnis/config"]),
    Object.freeze([
      "@omnis/logging",
      "@omnis/telemetry",
      "@omnis/events",
      "@omnis/execution-context",
    ]),
    Object.freeze([
      "@omnis/model-registry",
      "@omnis/provider-registry",
      "@omnis/policy-engine",
      "@omnis/budget-engine",
      "@omnis/ai-evaluation",
    ]),
    Object.freeze(["@omnis/ui"]),
    Object.freeze(["@omnis/tool-runtime", "@omnis/execution-kernel", "@omnis/model-orchestrator"]),
    Object.freeze(["@omnis/agent-runtime"]),
    Object.freeze(["@omnis/ai-core-runtime"]),
    Object.freeze(["studio"]),
  ]);

  const layerOf = new Map<string, number>();
  LAYERS.forEach((members, layer) => {
    for (const name of members) {
      layerOf.set(name, layer);
    }
  });

  it("assigns every member to exactly one layer", () => {
    for (const entry of workspace.members) {
      if (entry.location === "tests") {
        // The suite may depend on anything: it is the top of the graph by definition.
        continue;
      }
      expect(layerOf.has(entry.name), `${entry.name} is not in the layer table`).toBe(true);
    }
    expect(layerOf.size).toBe(
      workspace.members.filter((entry) => entry.location !== "tests").length,
    );
  });

  it("never lets a member depend on its own layer or above", () => {
    const violations: string[] = [];
    for (const entry of workspace.members) {
      const from = layerOf.get(entry.name);
      if (from === undefined) {
        continue;
      }
      for (const dependency of entry.internal) {
        const to = layerOf.get(dependency);
        if (to !== undefined && to >= from) {
          violations.push(`${entry.name} (layer ${from}) -> ${dependency} (layer ${to})`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("has no cycle, reachable from any member", () => {
    const cycles: string[] = [];
    for (const start of workspace.members) {
      const seen = new Set<string>();
      const stack: [string, string[]][] = [[start.name, [start.name]]];
      while (stack.length > 0) {
        const [node, trail] = stack.pop() ?? [start.name, [start.name]];
        for (const next of workspace.byName.get(node)?.internal ?? []) {
          if (next === start.name) {
            cycles.push([...trail, next].join(" -> "));
            continue;
          }
          if (!seen.has(next)) {
            seen.add(next);
            stack.push([next, [...trail, next]]);
          }
        }
      }
    }
    expect(cycles).toEqual([]);
  });

  it("lets nothing depend on the application or on the test suite", () => {
    for (const entry of workspace.members) {
      expect(entry.internal, `${entry.name} must not depend on the app`).not.toContain("studio");
      expect(entry.internal, `${entry.name} must not depend on the suite`).not.toContain(
        "@omnis/platform-tests",
      );
    }
  });
});

describe("the gates are where the architecture says they are", () => {
  /** Edges that must be absent, each with the invariant it protects. */
  const DENIED: readonly {
    readonly from: string;
    readonly deny: readonly string[];
    readonly because: string;
  }[] = Object.freeze([
    {
      from: "@omnis/events",
      deny: ["@omnis/ai-core-types"],
      because: "an event contract must be describable without one domain",
    },
    {
      from: "@omnis/ai-core-types",
      deny: ["@omnis/contracts", "@omnis/events", "@omnis/telemetry", "@omnis/validation"],
      because: "the vocabulary is the lowest thing in the core, so it can depend on nothing in it",
    },
    {
      from: "@omnis/execution-context",
      deny: ["@omnis/telemetry"],
      because: "a context reports the span it is inside; it does not create spans",
    },
    {
      from: "@omnis/tool-runtime",
      deny: ["@omnis/execution-kernel", "@omnis/model-orchestrator", "@omnis/agent-runtime"],
      because:
        "the kernel calls tools; a tool runtime that knew the kernel could call back into it",
    },
    {
      from: "@omnis/model-orchestrator",
      deny: ["@omnis/execution-kernel", "@omnis/tool-runtime", "@omnis/agent-runtime"],
      because: "a model call must not be able to start a step, a tool or an agent",
    },
    {
      from: "@omnis/execution-kernel",
      deny: ["@omnis/model-orchestrator", "@omnis/tool-runtime", "@omnis/agent-runtime"],
      because:
        "the kernel runs the executors it is handed, so it can run work it has never heard of",
    },
    {
      from: "@omnis/agent-runtime",
      deny: ["@omnis/model-orchestrator", "@omnis/tool-runtime"],
      because:
        "an agent pipeline goes through the kernel; calling a provider directly would skip policy and budget",
    },
    {
      from: "@omnis/policy-engine",
      deny: ["@omnis/budget-engine", "@omnis/tool-runtime", "@omnis/model-orchestrator"],
      because: "a policy decides whether work may happen; it must not be able to spend or perform",
    },
    {
      from: "@omnis/budget-engine",
      deny: ["@omnis/policy-engine", "@omnis/tool-runtime", "@omnis/model-orchestrator"],
      because: "a budget accounts for decided work; a reservation must not become an execution",
    },
    {
      from: "@omnis/ai-evaluation",
      deny: ["@omnis/model-orchestrator", "@omnis/agent-runtime", "@omnis/tool-runtime"],
      because:
        "evaluation is deterministic rules; an evaluator that could call a model would be an LLM-as-judge",
    },
  ]);

  it("keeps every forbidden edge absent, in manifests and in source", () => {
    for (const rule of DENIED) {
      const entry = member(rule.from);
      for (const denied of rule.deny) {
        expect(
          entry.internal,
          `${rule.from} must not declare ${denied}: ${rule.because}`,
        ).not.toContain(denied);
        expect(
          importsOfMember(rule.from).has(denied),
          `${rule.from} must not import ${denied}: ${rule.because}`,
        ).toBe(false);
      }
    }
  });

  it("keeps the edges the pipeline depends on present", () => {
    // An agent pipeline is only governed if it actually goes through the kernel, and the
    // kernel is only a scheduler if the composition hands it the executors. Both edges are
    // load-bearing: removing either would still compile.
    expect(member("@omnis/agent-runtime").internal).toContain("@omnis/execution-kernel");
    expect(member("@omnis/model-orchestrator").internal).toContain("@omnis/model-registry");
    expect(member("@omnis/model-orchestrator").internal).toContain("@omnis/provider-registry");
    expect(member("@omnis/model-orchestrator").internal).toContain("@omnis/policy-engine");
    expect(member("@omnis/model-orchestrator").internal).toContain("@omnis/budget-engine");
    expect(member("@omnis/tool-runtime").internal).toContain("@omnis/policy-engine");
    expect(member("@omnis/execution-kernel").internal).toContain("@omnis/policy-engine");
    expect(member("@omnis/execution-kernel").internal).toContain("@omnis/budget-engine");
  });

  it("reports through spans and events, never through a logger", () => {
    // A logger is a second, ungoverned channel: it has no trace identity, no redaction
    // contract of its own and no subscriber that can be turned off. The AI Core reports
    // through telemetry and the event bus, and both are already gated.
    for (const entry of workspace.aiCore) {
      expect(
        importsOfMember(entry.name).has("@omnis/logging"),
        `${entry.name} must not log directly`,
      ).toBe(false);
    }
  });
});

describe("provider independence", () => {
  it("declares no vendor SDK and no agent framework anywhere in the workspace", () => {
    for (const entry of workspace.members) {
      for (const forbidden of FORBIDDEN_PACKAGES) {
        expect(entry.declared, `${entry.name} must not depend on ${forbidden}`).not.toContain(
          forbidden,
        );
      }
    }
  });

  it("imports no vendor SDK from any source file", () => {
    const violations: string[] = [];
    for (const entry of workspace.members) {
      for (const file of entry.files) {
        for (const specifier of importsOf(file)) {
          const dependency = packageOf(specifier);
          if (dependency !== null && FORBIDDEN_PACKAGES.includes(dependency)) {
            violations.push(`${file} imports ${specifier}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("reaches a provider only through the adapter interface the core defines", () => {
    // The one place a provider is invoked is the adapter's `invoke`, and the only package
    // that declares the interface is the vocabulary package. If a second package grew its
    // own notion of calling a provider, selection and fallback would stop applying to it.
    const adapterOwners = workspace.members.filter((entry) =>
      entry.files.some(
        (file) =>
          !isFixtureFile(file) &&
          /interface ProviderAdapter\b/.test(readFileSync(path.join(REPO_ROOT, file), "utf8")),
      ),
    );
    expect(adapterOwners.map((entry) => entry.name)).toEqual(["@omnis/ai-core-types"]);
  });
});

describe("the core is headless", () => {
  it("imports no rendering package", () => {
    for (const entry of workspace.aiCore) {
      for (const presentation of PRESENTATION_PACKAGES) {
        expect(
          importsOfMember(entry.name).has(presentation),
          `${entry.name} must stay headless`,
        ).toBe(false);
      }
    }
  });

  it("keeps rendering in the presentation layer and the app", () => {
    const owners = workspace.members
      .filter((entry) => importsOfMember(entry.name).has("react"))
      .map((entry) => entry.name);
    expect(new Set(owners)).toEqual(new Set(["@omnis/ui", "studio"]));
  });
});

describe("manifests describe the source", () => {
  it("declares every internal package its source imports", () => {
    const violations: string[] = [];
    for (const entry of workspace.members) {
      for (const dependency of importsOfMember(entry.name)) {
        if (
          dependency.startsWith("@omnis/") &&
          !entry.declared.includes(dependency) &&
          dependency !== entry.name
        ) {
          violations.push(`${entry.name} imports ${dependency} without declaring it`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("declares no internal package its source never imports", () => {
    const violations: string[] = [];
    for (const entry of workspace.members) {
      for (const dependency of entry.internal) {
        if (!importsOfMember(entry.name).has(dependency)) {
          violations.push(`${entry.name} declares ${dependency} but never imports it`);
        }
      }
    }
    // A phantom dependency is how a layer violation arrives later: the edge is already
    // permitted, so the import that uses it looks harmless.
    expect(violations).toEqual([]);
  });

  it("imports no package through its source directory", () => {
    const violations: string[] = [];
    for (const entry of workspace.members) {
      for (const file of entry.files) {
        for (const specifier of importsOf(file)) {
          if (
            /@omnis\/[^/]+\/(src|dist)\//.test(specifier) ||
            /\.\.\/\.\.\/[^/]+\/src\//.test(specifier)
          ) {
            violations.push(`${file} imports ${specifier}`);
          }
        }
      }
    }
    // A deep import bypasses the entry point, so it keeps working after the package's
    // public surface changes and stops working when its file layout does.
    expect(violations).toEqual([]);
  });
});

describe("production code does not lean on fixtures", () => {
  it("imports no test support module and no test file", () => {
    const violations: string[] = [];
    for (const entry of workspace.members) {
      if (entry.location === "tests") {
        continue;
      }
      for (const file of entry.files) {
        if (isFixtureFile(file)) {
          continue;
        }
        for (const specifier of importsOf(file)) {
          if (packageOf(specifier) === null && /(testSupport|\.test)(\.js)?$/.test(specifier)) {
            violations.push(`${file} imports ${specifier}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("ships no fixture in its build", () => {
    // `testSupport` is a development surface: if a package emitted it, a consumer could
    // import it, and the fixtures would become an API nobody intended to maintain.
    for (const entry of workspace.aiCore) {
      const build = path.join(entry.directory, "tsconfig.build.json");
      if (!existsSync(build)) {
        continue;
      }
      const text = readFileSync(build, "utf8");
      const hasFixtures = entry.files.some((file) => isFixtureFile(file));
      if (hasFixtures) {
        expect(text, `${entry.name} must exclude its fixtures from the build`).toMatch(
          /test\.ts|testSupport/,
        );
      }
    }
  });
});

describe("every AI Core package is tested", () => {
  it("has at least one test file next to its source", () => {
    for (const entry of workspace.aiCore) {
      const tests = entry.files.filter((file) => file.endsWith(".test.ts"));
      expect(tests.length, `${entry.name} has no tests`).toBeGreaterThan(0);
    }
  });

  it("tests the composition from outside itself", () => {
    // The suite in this directory is the only place where the packages are exercised
    // together through their published surfaces. Without it, "the platform works" would
    // mean "twelve packages each work in isolation".
    const suites =
      workspace.byName
        .get("@omnis/platform-tests")
        ?.files.filter((file) => file.endsWith(".test.ts")) ?? [];
    expect(suites.length).toBeGreaterThanOrEqual(5);
    expect(suites.some((file) => file.startsWith("tests/integration/"))).toBe(true);
    expect(suites.some((file) => file.startsWith("tests/contract/"))).toBe(true);
  });
});
