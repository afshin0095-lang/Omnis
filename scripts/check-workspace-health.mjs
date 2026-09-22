#!/usr/bin/env node
/**
 * OMNIS workspace health check.
 *
 * WHY THIS EXISTS
 * ---------------
 * The Sprint 0 audit found problems that no compiler catches: two TypeScript
 * majors installed side by side, packages that depended on each other in a cycle,
 * source files that were empty, documents referenced from code that did not exist,
 * and eight platform packages with no tests at all. Every one of them was invisible
 * to `tsc` and to `eslint`, and every one of them cost real time.
 *
 * This script turns those classes of problem into a gate. It is deliberately
 * structural rather than stylistic: it checks what the workspace *is*, not how the
 * code is formatted (Prettier and ESLint already own that).
 *
 * WHAT IT CHECKS
 * --------------
 *  1. Manifest hygiene — every member declares the fields and scripts the workspace
 *     relies on, and nothing is published by accident.
 *  2. Version discipline — shared dependencies come from the pnpm catalog, internal
 *     ones from `workspace:*`, so a version can never be bumped in one place only.
 *  3. TypeScript configuration — every member extends the shared base; libraries
 *     separate "check" from "emit".
 *  4. Dependency layering — dependencies point strictly downward and there are no
 *     cycles. Technology ownership (Zod, React) is confined to the packages that
 *     are allowed to know about it.
 *  4c. Event registrations — every declared `ai.*` event type has a definition, and no
 *     definition points at a type nobody declared.
 *  5. Substance — no empty files, no placeholder markers, no `any`, no suppression
 *     comments, and every package with source has tests.
 *  6. Documentation integrity — every `docs/**` reference resolves, and every
 *     document listed in the map exists.
 *  7. Repository hygiene — build output and editor state are not tracked.
 *
 * Exit code is 0 when the workspace is healthy and 1 otherwise, with one line per
 * finding so a failure can be fixed without re-running anything.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Relative path from the repository root, for stable output. */
const rel = (absolute) => path.relative(REPO_ROOT, absolute).split(path.sep).join("/");

/**
 * The dependency layers, lowest first.
 *
 * A member may depend only on members in a strictly lower layer. This is the rule
 * that keeps `@omnis/types` reusable by everything, keeps presentation out of the
 * platform, and makes a cycle structurally impossible rather than merely unlikely.
 */
const LAYERS = [
  { layer: 0, name: "primitives", members: ["@omnis/types", "@omnis/theme"] },
  { layer: 1, name: "errors", members: ["@omnis/errors"] },
  {
    layer: 2,
    name: "shared vocabulary",
    members: ["@omnis/validation", "@omnis/ai-core-types"],
  },
  { layer: 3, name: "contracts", members: ["@omnis/contracts", "@omnis/config"] },
  {
    layer: 4,
    name: "platform",
    members: ["@omnis/logging", "@omnis/telemetry", "@omnis/events", "@omnis/execution-context"],
  },
  {
    layer: 5,
    name: "registries and governance",
    members: [
      "@omnis/model-registry",
      "@omnis/provider-registry",
      "@omnis/policy-engine",
      "@omnis/budget-engine",
      "@omnis/ai-evaluation",
    ],
  },
  { layer: 6, name: "presentation", members: ["@omnis/ui"] },
  {
    layer: 7,
    name: "execution",
    members: ["@omnis/tool-runtime", "@omnis/execution-kernel", "@omnis/model-orchestrator"],
  },
  { layer: 8, name: "agents", members: ["@omnis/agent-runtime"] },
  { layer: 9, name: "composition", members: ["@omnis/ai-core-runtime"] },
  { layer: 10, name: "apps", members: ["studio"] },
];

/**
 * The highest layer, which is the application layer.
 *
 * Computed rather than written as a constant, so adding a layer cannot silently
 * turn the "nothing may depend on an app" rule into a rule about some other layer.
 */
const MAX_LAYER = LAYERS.reduce((highest, entry) => Math.max(highest, entry.layer), 0);

/**
 * The AI Core: every package whose job is to decide, govern and record AI work.
 *
 * Named as a set because three rules apply to all of them and to none of the rest:
 * they are headless, they are provider-independent, and they may not reach sideways
 * into a runtime that is supposed to call them.
 */
const AI_CORE_PACKAGES = [
  "@omnis/ai-core-types",
  "@omnis/execution-context",
  "@omnis/model-registry",
  "@omnis/provider-registry",
  "@omnis/policy-engine",
  "@omnis/budget-engine",
  "@omnis/ai-evaluation",
  "@omnis/tool-runtime",
  "@omnis/execution-kernel",
  "@omnis/model-orchestrator",
  "@omnis/agent-runtime",
  "@omnis/ai-core-runtime",
];

/**
 * Dependencies no member may declare, and no source file may import.
 *
 * Sprint 1 is deliberately provider-independent: the AI Core decides *which* model
 * to call and *whether* it may be called, and a vendor SDK is what actually calls
 * one. Admitting a SDK here would put a vendor's types into the platform's
 * vocabulary, its retry policy into the orchestrator's, and its outage into the
 * platform's own failure classes. When a provider adapter package exists, it will
 * own these dependencies and nothing else may import it except through the
 * `ProviderAdapter` interface.
 */
const FORBIDDEN_DEPENDENCIES = {
  openai: "a vendor SDK; the AI Core is provider-independent (ADR-0005)",
  "@anthropic-ai/sdk": "a vendor SDK; the AI Core is provider-independent (ADR-0005)",
  "@google/generative-ai": "a vendor SDK; the AI Core is provider-independent (ADR-0005)",
  "@google/genai": "a vendor SDK; the AI Core is provider-independent (ADR-0005)",
  "@aws-sdk/client-bedrock-runtime": "a vendor SDK; the AI Core is provider-independent (ADR-0005)",
  "cohere-ai": "a vendor SDK; the AI Core is provider-independent (ADR-0005)",
  mistralai: "a vendor SDK; the AI Core is provider-independent (ADR-0005)",
  "@mistralai/mistralai": "a vendor SDK; the AI Core is provider-independent (ADR-0005)",
  ai: "an agent framework; OMNIS composes its own (ADR-0005)",
  "@ai-sdk/openai": "a vendor SDK; the AI Core is provider-independent (ADR-0005)",
  langchain: "an agent framework; OMNIS composes its own (ADR-0005)",
  "@langchain/core": "an agent framework; OMNIS composes its own (ADR-0005)",
  "@langchain/openai": "an agent framework and a vendor SDK (ADR-0005)",
  llamaindex: "an agent framework; OMNIS composes its own (ADR-0005)",
};

/**
 * Packages the AI Core may not import, because it is headless.
 *
 * Every one of these packages exists to render something in a browser. The AI Core
 * runs where the work runs, which is usually nowhere near a document object, and a
 * rendering dependency would make it untestable outside one.
 */
const PRESENTATION_PACKAGES = ["react", "react-dom", "framer-motion", "zustand", "lucide-react"];

/**
 * Internal imports that layering permits but the architecture forbids.
 *
 * Layering says "downward only"; it cannot say "these two siblings must not know
 * each other". Each entry is an invariant the Sprint 1 design rests on, and each one
 * has been broken by an innocent-looking import at least once in design review.
 */
const DENIED_INTERNAL_IMPORTS = [
  {
    from: "@omnis/events",
    deny: ["@omnis/ai-core-types"],
    reason:
      "an event contract must be describable without one domain: the bus carries platform events, and coupling it to the AI Core would make every consumer of every event depend on it",
  },
  {
    from: "@omnis/ai-core-types",
    deny: ["@omnis/contracts", "@omnis/events", "@omnis/telemetry", "@omnis/validation"],
    reason:
      "the AI Core's vocabulary is the lowest thing in it: a type that needed a schema library or an event bus could not be reused by either",
  },
  {
    from: "@omnis/execution-context",
    deny: ["@omnis/telemetry"],
    reason:
      "a context reports the identifiers of the span it is inside; it does not create spans. Importing the tracer would make every context a telemetry client",
  },
  {
    from: "@omnis/tool-runtime",
    deny: ["@omnis/execution-kernel", "@omnis/model-orchestrator", "@omnis/agent-runtime"],
    reason:
      "a tool is gated by permission and policy, not by whatever scheduled it: the kernel calls tools, and a tool runtime that knew the kernel could call back into it",
  },
  {
    from: "@omnis/model-orchestrator",
    deny: ["@omnis/execution-kernel", "@omnis/tool-runtime", "@omnis/agent-runtime"],
    reason:
      "the orchestrator selects, gates and calls models. It does not schedule steps, invoke tools or run agents, and importing them would make a model call able to start one",
  },
  {
    from: "@omnis/execution-kernel",
    deny: ["@omnis/model-orchestrator", "@omnis/tool-runtime", "@omnis/agent-runtime"],
    reason:
      "the kernel runs the step executors it is handed. Naming a runtime would make the scheduler know about the things it schedules, and there would be no way to run a step the platform has not heard of",
  },
  {
    from: "@omnis/agent-runtime",
    deny: ["@omnis/model-orchestrator", "@omnis/tool-runtime"],
    reason:
      "an agent pipeline goes through the kernel, which is given the executors. An agent runtime that called a provider or a tool itself would bypass the policy and budget gates that are the point of the pipeline",
  },
  {
    from: "@omnis/policy-engine",
    deny: ["@omnis/budget-engine", "@omnis/tool-runtime", "@omnis/model-orchestrator"],
    reason:
      "a policy decides whether work may happen; it does not reserve money for it or perform it. A policy engine that could charge a budget would be able to spend on a denial",
  },
  {
    from: "@omnis/budget-engine",
    deny: ["@omnis/policy-engine", "@omnis/tool-runtime", "@omnis/model-orchestrator"],
    reason:
      "a budget accounts for work already decided on. It must not consult policy or invoke anything, or a reservation could become an execution",
  },
  {
    from: "@omnis/ai-evaluation",
    deny: ["@omnis/model-orchestrator", "@omnis/agent-runtime", "@omnis/tool-runtime"],
    reason:
      "evaluation is deterministic rules over recorded output. An evaluator that could call a model would be an LLM-as-judge, which Sprint 1 excludes on purpose",
  },
];

/** External packages only one member is allowed to depend on. */
const TECHNOLOGY_OWNERS = {
  zod: ["@omnis/validation"],
  react: ["@omnis/ui", "studio"],
  "react-dom": ["@omnis/ui", "studio"],
  "framer-motion": ["studio"],
  vite: ["studio"],
};

/** Scripts every workspace member must provide. */
const REQUIRED_SCRIPTS = ["build", "typecheck", "lint", "test", "clean"];

/** Directories that are never source. */
const IGNORED_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".turbo",
  ".git",
  ".cache",
  "public",
]);

/** Extensions scanned for substance and forbidden patterns. */
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);

/** Documentation extensions scanned for references and emptiness. */
const DOC_EXTENSIONS = new Set([".md", ".markdown"]);

/** A finding: where, and what is wrong. */
const findings = [];

/** Records a finding. */
function fail(file, message) {
  findings.push({ file, message });
}

/** Reads a UTF-8 file, or null when absent. */
function read(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** Reads and parses JSON with comment tolerance for tsconfig files. */
function readJson(file) {
  const text = read(file);
  if (text === null) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    // tsconfig files legitimately contain comments and trailing commas.
    try {
      return JSON.parse(
        text
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/(^|[^:"'\\])\/\/.*$/gm, "$1")
          .replace(/,(\s*[}\]])/g, "$1"),
      );
    } catch {
      fail(rel(file), "is not valid JSON");
      return null;
    }
  }
}

/**
 * Lists immediate subdirectories that contain a package.json.
 *
 * `tests` is a member too. It is the one place where cross-package invariants are
 * tested, so it is checked like any other member — with the difference that it emits
 * nothing, belongs to no layer, and nothing may depend on it.
 */
function workspaceMembers() {
  const members = [];
  for (const group of ["packages", "apps"]) {
    const groupPath = path.join(REPO_ROOT, group);
    if (!existsSync(groupPath)) {
      continue;
    }
    for (const entry of readdirSync(groupPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const directory = path.join(groupPath, entry.name);
      if (existsSync(path.join(directory, "package.json"))) {
        members.push(directory);
      }
    }
  }
  // `tests` is a single member rather than a group of them.
  const suite = path.join(REPO_ROOT, "tests");
  if (existsSync(path.join(suite, "package.json"))) {
    members.push(suite);
  }
  return members.sort();
}

/** Walks a tree, yielding files whose extension is accepted. */
function* walk(directory, accepted) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name)) {
        yield* walk(absolute, accepted);
      }
      continue;
    }
    if (accepted.has(path.extname(entry.name))) {
      yield absolute;
    }
  }
}

/** Strips comments so that prose cannot be mistaken for code. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

/**
 * Blanks the contents of string literals, keeping the quotes and the line count.
 *
 * Used for the marker scan, which is the mirror image of the code scan: a marker is
 * deferred work, and deferred work is written in comments, never in data. A test for
 * a rule that forbids the substring "todo" has to contain that substring, and failing
 * it would teach people to weaken the rule instead of writing the test.
 */
function blankStringLiterals(source) {
  return source.replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/gs, (match) => match[0] + match[0]);
}

// --- 1/2. Manifests and version discipline --------------------------------

const manifests = new Map();

for (const directory of workspaceMembers()) {
  const manifestPath = path.join(directory, "package.json");
  const manifest = readJson(manifestPath);
  if (manifest === null) {
    continue;
  }
  manifests.set(manifest.name, { directory, manifest });

  const where = rel(manifestPath);
  const isApp = directory.includes(`${path.sep}apps${path.sep}`);
  const isTestSuite = rel(directory) === "tests";

  if (typeof manifest.name !== "string" || manifest.name.length === 0) {
    fail(where, "has no package name");
  } else if (!isApp && !manifest.name.startsWith("@omnis/")) {
    fail(where, `library name "${manifest.name}" must be scoped under @omnis/`);
  }
  if (manifest.private !== true) {
    fail(where, "must be private: OMNIS packages are not published to npm");
  }
  if (manifest.type !== "module") {
    fail(where, 'must declare "type": "module" — the workspace is ESM-only');
  }
  if (manifest.license !== "MIT") {
    fail(where, `license must be MIT to match the root manifest, found "${manifest.license}"`);
  }
  if (typeof manifest.description !== "string" || manifest.description.trim().length === 0) {
    fail(where, "must describe itself: the description is the package's one-line contract");
  }

  // A test suite emits nothing, so it is not asked to build. Everything else is.
  const requiredScripts = isTestSuite
    ? REQUIRED_SCRIPTS.filter((script) => script !== "build")
    : REQUIRED_SCRIPTS;
  for (const script of requiredScripts) {
    if (typeof manifest.scripts?.[script] !== "string") {
      fail(where, `is missing the "${script}" script`);
    }
  }

  if (!isApp && !isTestSuite) {
    // A library is consumed through its built output, so the entry points must be
    // declared; an app is consumed by a bundler and needs none of this.
    if (manifest.main !== "./dist/index.js") {
      fail(where, `library "main" must be "./dist/index.js", found "${manifest.main}"`);
    }
    if (manifest.types !== "./dist/index.d.ts") {
      fail(where, `library "types" must be "./dist/index.d.ts", found "${manifest.types}"`);
    }
    if (manifest.exports?.["."]?.default !== "./dist/index.js") {
      fail(where, 'library "exports" must map "." to ./dist/index.js');
    }
    if (!Array.isArray(manifest.files) || !manifest.files.includes("dist")) {
      fail(where, 'library "files" must include "dist"');
    }
  }

  // Version discipline: one source of truth per dependency.
  for (const field of ["dependencies", "devDependencies"]) {
    for (const [dependency, version] of Object.entries(manifest[field] ?? {})) {
      if (dependency.startsWith("@omnis/") || dependency === "studio") {
        if (version !== "workspace:*") {
          fail(where, `${field}.${dependency} must be "workspace:*", found "${version}"`);
        }
      } else if (version !== "catalog:") {
        fail(
          where,
          `${field}.${dependency} must come from the pnpm catalog ("catalog:"), found "${version}"`,
        );
      }
    }
  }
  // A vendor SDK or an agent framework is refused in every dependency field, not
  // just `dependencies`: a devDependency is installed all the same, and one that
  // appears only there is how a forbidden import arrives unnoticed.
  for (const field of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    for (const dependency of Object.keys(manifest[field] ?? {})) {
      const reason = FORBIDDEN_DEPENDENCIES[dependency];
      if (reason !== undefined) {
        fail(where, `must not depend on "${dependency}": ${reason}`);
      }
    }
  }

  // Peer ranges are a published contract, not an installation choice, so they are
  // allowed to state a real range.
  for (const [dependency, version] of Object.entries(manifest.peerDependencies ?? {})) {
    if (typeof version !== "string" || version.length === 0) {
      fail(where, `peerDependencies.${dependency} must declare a range`);
    }
  }
}

// --- 3. TypeScript configuration ------------------------------------------

for (const { directory } of manifests.values()) {
  const isApp = directory.includes(`${path.sep}apps${path.sep}`);
  const tsconfigPath = path.join(directory, "tsconfig.json");
  const tsconfig = readJson(tsconfigPath);
  if (tsconfig === null) {
    fail(rel(tsconfigPath), "is missing: every member needs its own tsconfig");
    continue;
  }
  const isTestSuite = rel(directory) === "tests";
  // `tests` sits one level below the root, packages two.
  const expectedExtends = isApp
    ? undefined
    : isTestSuite
      ? "../tsconfig.base.json"
      : "../../tsconfig.base.json";
  if (!isApp && tsconfig.extends !== expectedExtends) {
    fail(
      rel(tsconfigPath),
      `must extend "${expectedExtends}" so strictness is shared, found "${tsconfig.extends}"`,
    );
  }
  if (tsconfig.compilerOptions?.noEmit !== true) {
    fail(rel(tsconfigPath), 'must set "noEmit": true — typecheck must not write output');
  }

  // A solution-style tsconfig compiles nothing itself and delegates to project references.
  // A reference to a project that does not exist makes `tsc -b` skip it silently, which is
  // how a package stops being typechecked and nobody notices until it fails at runtime.
  for (const reference of tsconfig.references ?? []) {
    if (reference === null || typeof reference !== "object" || typeof reference.path !== "string") {
      fail(rel(tsconfigPath), `has a project reference with no path: ${JSON.stringify(reference)}`);
      continue;
    }
    // A reference may name a directory (whose tsconfig.json is then used) or a
    // configuration file directly; both are legal and both have to resolve.
    const referenced = path.resolve(directory, reference.path);
    const resolved = reference.path.endsWith(".json")
      ? referenced
      : path.join(referenced, "tsconfig.json");
    if (!existsSync(resolved)) {
      fail(rel(tsconfigPath), `references "${reference.path}", which resolves to nothing`);
    }
  }

  if (!isApp && !isTestSuite) {
    const buildPath = path.join(directory, "tsconfig.build.json");
    const build = readJson(buildPath);
    if (build === null) {
      fail(rel(buildPath), "is missing: a library needs a separate emit configuration");
    } else if (build.compilerOptions?.noEmit !== false) {
      fail(rel(buildPath), 'must set "noEmit": false so the library actually emits');
    }
    if (!existsSync(path.join(directory, "src", "index.ts"))) {
      fail(`${rel(directory)}/src/index.ts`, "is missing: a library needs a single entry point");
    }
  }
}

// --- 4. Dependency layering, cycles and technology ownership ---------------

const layerOf = new Map();
for (const { layer, members } of LAYERS) {
  for (const member of members) {
    layerOf.set(member, layer);
  }
}

const graph = new Map();

const testSuites = new Set(
  [...manifests]
    .filter(([name, { directory }]) => rel(directory) === "tests")
    .map(([name]) => name),
);

for (const [name, { directory, manifest }] of manifests) {
  if (!layerOf.has(name) && !testSuites.has(name)) {
    fail(
      rel(path.join(directory, "package.json")),
      `"${name}" is not assigned to a dependency layer in scripts/check-workspace-health.mjs`,
    );
  }
  const internal = Object.keys(manifest.dependencies ?? {}).filter((dependency) =>
    manifests.has(dependency),
  );
  graph.set(name, internal);

  // A test suite is the top of the graph in every sense: it may depend on anything,
  // and nothing may depend on it, or production code would be built out of fixtures.
  if (testSuites.has(name)) {
    continue;
  }

  for (const dependency of internal) {
    const from = layerOf.get(name);
    const to = layerOf.get(dependency);
    if (from === undefined || to === undefined) {
      continue;
    }
    if (to >= from) {
      fail(
        rel(path.join(directory, "package.json")),
        `"${name}" (layer ${from}) may not depend on "${dependency}" (layer ${to}): ` +
          "dependencies must point strictly downward",
      );
    }
  }

  for (const [technology, owners] of Object.entries(TECHNOLOGY_OWNERS)) {
    const depends = Object.keys(manifest.dependencies ?? {}).includes(technology);
    const develops = Object.keys(manifest.devDependencies ?? {}).includes(technology);
    if ((depends || develops) && !owners.includes(name)) {
      fail(
        rel(path.join(directory, "package.json")),
        `"${name}" must not depend on "${technology}"; it is owned by ${owners.join(", ")}`,
      );
    }
  }
}

// Cycle detection over the internal graph (defence in depth: layering already
// forbids cycles, so reaching this branch means the layer table is wrong).
for (const start of graph.keys()) {
  const seen = new Set();
  const stack = [[start, [start]]];
  while (stack.length > 0) {
    const [node, trail] = stack.pop() ?? [start, [start]];
    for (const next of graph.get(node) ?? []) {
      if (next === start) {
        fail(start, `is part of a dependency cycle: ${[...trail, next].join(" -> ")}`);
        continue;
      }
      if (!seen.has(next)) {
        seen.add(next);
        stack.push([next, [...trail, next]]);
      }
    }
  }
}

// No package may depend on an application, and none may depend on a test suite.
for (const [name, dependencies] of graph) {
  for (const dependency of dependencies) {
    if (layerOf.get(dependency) === MAX_LAYER) {
      fail(name, `must not depend on the application "${dependency}"`);
    }
    if (testSuites.has(dependency)) {
      fail(name, `must not depend on the test suite "${dependency}"`);
    }
  }
}

// --- 4b. Source import rules ----------------------------------------------

/**
 * What the source is allowed to import, checked in the source.
 *
 * Manifest checks see what a package *declares*; these see what it *reaches for*.
 * The difference matters in exactly the cases that hurt: a vendor SDK imported
 * without being declared, a fixture imported by production code because it was
 * convenient, and a sibling runtime imported because it was there. Each rule below
 * names the invariant it protects, and each is a rule the design documents state in
 * prose — prose that a compiler will not enforce.
 */

/** The bare package name behind an import specifier, or null for a relative one. */
function packageOf(specifier) {
  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    return null;
  }
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/** Every module specifier a source file mentions, static or dynamic. */
const IMPORT_PATTERN = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["']([^"']+)["']/g;

/** Members by directory, longest first so a nested package wins over its parent. */
const membersByDirectory = [...manifests.entries()]
  .map(([name, { directory }]) => ({ name, directory: rel(directory) }))
  .sort((left, right) => right.directory.length - left.directory.length);

/** The member a file belongs to, or null when it belongs to none. */
function ownerOf(relative) {
  for (const member of membersByDirectory) {
    if (relative === member.directory || relative.startsWith(`${member.directory}/`)) {
      return member.name;
    }
  }
  return null;
}

const isFixtureFile = (relative) =>
  /\.test\.[cm]?[jt]sx?$/.test(relative) || /(^|\/)testSupport\.[cm]?[jt]sx?$/.test(relative);

for (const file of walk(REPO_ROOT, SOURCE_EXTENSIONS)) {
  const relative = rel(file);
  if (relative.includes("/dist/") || relative.includes("/node_modules/")) {
    continue;
  }
  const owner = ownerOf(relative);
  const code = stripComments(read(file) ?? "");
  const specifiers = [...code.matchAll(IMPORT_PATTERN)].map((match) => match[1]);
  const inAiCore = owner !== null && AI_CORE_PACKAGES.includes(owner);
  const fixture = isFixtureFile(relative);

  for (const specifier of specifiers) {
    const dependency = packageOf(specifier);

    if (dependency !== null && FORBIDDEN_DEPENDENCIES[dependency] !== undefined) {
      fail(relative, `imports "${specifier}": ${FORBIDDEN_DEPENDENCIES[dependency]}`);
      continue;
    }
    if (inAiCore && dependency !== null && PRESENTATION_PACKAGES.includes(dependency)) {
      fail(
        relative,
        `imports "${specifier}": the AI Core is headless, so it may not depend on a rendering package`,
      );
      continue;
    }
    for (const [technology, owners] of Object.entries(TECHNOLOGY_OWNERS)) {
      if (dependency === technology && owner !== null && !owners.includes(owner)) {
        fail(relative, `imports "${specifier}": "${technology}" is owned by ${owners.join(", ")}`);
      }
    }
    for (const rule of DENIED_INTERNAL_IMPORTS) {
      if (owner === rule.from && dependency !== null && rule.deny.includes(dependency)) {
        fail(relative, `imports "${specifier}": ${rule.reason}`);
      }
    }
  }

  // Production code may not import a fixture. The dependency is invisible in a
  // manifest and compiles happily, and it turns a test helper into an API.
  if (!fixture && owner !== null && !testSuites.has(owner)) {
    for (const specifier of specifiers) {
      if (packageOf(specifier) === null && /testSupport(\.js)?$|\.test(\.js)?$/.test(specifier)) {
        fail(relative, `imports "${specifier}": production code may not depend on a test fixture`);
      }
    }
  }
}

// --- 4c. Required AI event registrations -----------------------------------

/**
 * Every declared `ai.*` event type must have a definition, and every definition must
 * point at a declared type.
 *
 * The events package cannot import the AI Core's types, so nothing at compile time ties a
 * declaration to its definition: a new event type can be declared, subscribed to by a
 * consumer, and never defined, and the bus would refuse every envelope of it at runtime.
 * This is the gate that catches it before a consumer does.
 */
const aiEventTypesPath = path.join(REPO_ROOT, "packages", "events", "src", "ai-event-types.ts");
const aiDefinitionsPath = path.join(REPO_ROOT, "packages", "events", "src", "ai-definitions.ts");
if (!existsSync(aiEventTypesPath) || !existsSync(aiDefinitionsPath)) {
  fail(
    rel(aiEventTypesPath),
    "or its definitions file is missing: the ai.* namespace is part of the event contract",
  );
} else {
  const declaredSource = readFileSync(aiEventTypesPath, "utf8");
  const definedSource = readFileSync(aiDefinitionsPath, "utf8");
  const declared = new Map();
  for (const match of declaredSource.matchAll(
    /^\s+(\w+): parseEventType\("(ai\.[a-z0-9.]+)"\),$/gm,
  )) {
    const [, key, literal] = match;
    if (declared.has(key)) {
      fail(rel(aiEventTypesPath), `declares the event key "${key}" twice`);
    }
    declared.set(key, literal);
  }
  const literals = new Map();
  for (const [key, literal] of declared) {
    if (literals.has(literal)) {
      fail(
        rel(aiEventTypesPath),
        `declares "${literal}" twice (as "${literals.get(literal)}" and "${key}"): one event, one type`,
      );
    }
    literals.set(literal, key);
  }
  const defined = new Set();
  for (const match of definedSource.matchAll(/type:\s*AI_EVENT_TYPES\.(\w+)/g)) {
    defined.add(match[1]);
  }
  for (const key of declared.keys()) {
    if (!defined.has(key)) {
      fail(
        rel(aiDefinitionsPath),
        `defines no event for AI_EVENT_TYPES.${key}: a declared type with no definition cannot be published or validated`,
      );
    }
  }
  for (const key of defined) {
    if (!declared.has(key)) {
      fail(
        rel(aiDefinitionsPath),
        `defines AI_EVENT_TYPES.${key}, which is not declared: a definition nobody declared is unreachable`,
      );
    }
  }
  if (declared.size === 0) {
    fail(rel(aiEventTypesPath), "declares no ai.* event types at all");
  }
}

// --- 5. Substance ---------------------------------------------------------

const MARKER_PATTERN = /\b(?:TODO|FIXME|XXX|HACK)\b/;
const ANY_PATTERNS = [
  { pattern: /:\s*any\b/, label: 'a ": any" annotation' },
  { pattern: /\bas\s+any\b/, label: 'an "as any" cast' },
  { pattern: /<any>/, label: 'an "<any>" type argument' },
  { pattern: /@ts-ignore/, label: "a @ts-ignore suppression" },
  { pattern: /@ts-expect-error/, label: "a @ts-expect-error suppression" },
  { pattern: /eslint-disable/, label: "an eslint-disable suppression" },
];

let sourceFileCount = 0;
const packagesWithTests = new Set();

for (const file of walk(REPO_ROOT, new Set([...SOURCE_EXTENSIONS, ...DOC_EXTENSIONS]))) {
  const relative = rel(file);
  const text = read(file) ?? "";

  if (text.trim().length === 0) {
    fail(relative, "is empty: every committed file must carry meaning");
    continue;
  }
  if (statSync(file).size === 0) {
    fail(relative, "is a zero-byte file");
    continue;
  }

  if (!SOURCE_EXTENSIONS.has(path.extname(file))) {
    continue;
  }
  sourceFileCount += 1;

  const isTest = /\.test\.[cm]?[jt]sx?$/.test(relative);
  if (isTest) {
    const owner = relative.split("/").slice(0, 2).join("/");
    packagesWithTests.add(owner);
  }

  // Placeholder markers are meaningful in comments, so they are searched for with
  // string literals blanked; the code patterns are searched for only after comments
  // are stripped, so that documentation prose cannot be mistaken for a type
  // annotation. Each scan removes exactly the text the other one is about.
  const markers = blankStringLiterals(text);
  if (MARKER_PATTERN.test(markers)) {
    const line = markers.split("\n").findIndex((candidate) => MARKER_PATTERN.test(candidate));
    fail(`${relative}:${line + 1}`, "contains a TODO/FIXME/XXX/HACK marker");
  }

  const code = stripComments(text);
  for (const { pattern, label } of ANY_PATTERNS) {
    if (pattern.test(code)) {
      const line = code.split("\n").findIndex((candidate) => pattern.test(candidate));
      fail(`${relative}:${line + 1}`, `contains ${label}`);
    }
  }
}

for (const { directory } of manifests.values()) {
  const owner = rel(directory);
  if (existsSync(path.join(directory, "src")) && !packagesWithTests.has(owner)) {
    fail(`${owner}/src`, "has no test file: every package with source must be tested");
  }
}

// --- 6. Documentation integrity -------------------------------------------

const DOC_REFERENCE = /docs\/[A-Za-z0-9_./-]+\.md/g;
const docRoots = [path.join(REPO_ROOT, "docs"), path.join(REPO_ROOT, "scripts")];
for (const directory of ["packages", "apps"]) {
  docRoots.push(path.join(REPO_ROOT, directory));
}

const referenced = new Set();
const reportedReferences = new Set();
const scanned = [
  ...docRoots.flatMap((root) =>
    existsSync(root)
      ? [...walk(root, new Set([...DOC_EXTENSIONS, ...SOURCE_EXTENSIONS, ".mjs"]))]
      : [],
  ),
  ...readdirSync(REPO_ROOT)
    .filter((entry) => DOC_EXTENSIONS.has(path.extname(entry)) || entry === "pnpm-workspace.yaml")
    .map((entry) => path.join(REPO_ROOT, entry)),
];

for (const file of scanned) {
  const relative = rel(file);
  if (relative.includes("/dist/") || relative.includes("/node_modules/")) {
    continue;
  }
  const text = read(file) ?? "";
  for (const match of text.matchAll(DOC_REFERENCE)) {
    const target = match[0];
    referenced.add(target);
    const key = `${relative}::${target}`;
    if (!existsSync(path.join(REPO_ROOT, target)) && !reportedReferences.has(key)) {
      reportedReferences.add(key);
      fail(relative, `references ${target}, which does not exist`);
    }
  }
}

// Every document in the map must exist, and every document must be reachable.
const summaryPath = path.join(REPO_ROOT, "docs", "SUMMARY.md");
const summary = read(summaryPath) ?? "";
const linkedFromSummary = new Set(
  [...summary.matchAll(/\]\(([^)]+\.md)\)/g)].map((match) => `docs/${match[1]}`),
);
for (const file of walk(path.join(REPO_ROOT, "docs"), DOC_EXTENSIONS)) {
  const relative = rel(file);
  if (relative === "docs/SUMMARY.md" || relative === "docs/README.md") {
    continue;
  }
  if (!linkedFromSummary.has(relative) && !referenced.has(relative)) {
    fail(relative, "is not linked from docs/SUMMARY.md or referenced anywhere else");
  }
}
for (const target of linkedFromSummary) {
  if (!existsSync(path.join(REPO_ROOT, target))) {
    fail("docs/SUMMARY.md", `links to ${target}, which does not exist`);
  }
}

// --- 7. Repository hygiene ------------------------------------------------

let tracked = [];
try {
  tracked = execFileSync("git", ["ls-files"], { cwd: REPO_ROOT, encoding: "utf8" })
    .split("\n")
    .filter((line) => line.length > 0);
} catch {
  // Not a git checkout (or git is unavailable): skip rather than fail, because the
  // rest of the report is still actionable.
  tracked = [];
}

for (const file of tracked) {
  if (/(^|\/)(dist|node_modules|\.turbo|coverage)\//.test(file)) {
    fail(file, "is tracked but is build output or editor state");
  }
  if (/\.DS_Store$/.test(file) || /~$/.test(file)) {
    fail(file, "is tracked but is operating-system or editor debris");
  }
}

const rootManifest = readJson(path.join(REPO_ROOT, "package.json"));
if (rootManifest?.packageManager !== undefined) {
  const lockfile = path.join(REPO_ROOT, "pnpm-lock.yaml");
  if (!existsSync(lockfile)) {
    fail("pnpm-lock.yaml", "is missing: pnpm is the only package manager in this workspace");
  }
  for (const forbidden of ["package-lock.json", "yarn.lock", "bun.lockb"]) {
    if (existsSync(path.join(REPO_ROOT, forbidden))) {
      fail(forbidden, "must not exist: this workspace uses pnpm only");
    }
  }
}

// --- Report ---------------------------------------------------------------

const checkedPackages = manifests.size;
if (findings.length === 0) {
  process.stdout.write(
    `workspace health: OK (${checkedPackages} packages, ${sourceFileCount} source files, ` +
      `${referenced.size} documentation references resolved)\n`,
  );
  process.exit(0);
}

process.stdout.write(`workspace health: ${findings.length} problem(s)\n\n`);
for (const { file, message } of findings) {
  process.stdout.write(`  ${file}\n    ${message}\n`);
}
process.stdout.write("\n");
process.exit(1);
