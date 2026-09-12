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
  { layer: 2, name: "validation", members: ["@omnis/validation"] },
  { layer: 3, name: "contracts", members: ["@omnis/contracts"] },
  {
    layer: 4,
    name: "platform",
    members: ["@omnis/config", "@omnis/events", "@omnis/logging", "@omnis/telemetry"],
  },
  { layer: 5, name: "presentation", members: ["@omnis/ui"] },
  { layer: 6, name: "apps", members: ["studio"] },
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

/** Lists immediate subdirectories that contain a package.json. */
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

  for (const script of REQUIRED_SCRIPTS) {
    if (typeof manifest.scripts?.[script] !== "string") {
      fail(where, `is missing the "${script}" script`);
    }
  }

  if (!isApp) {
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
  const expectedExtends = isApp ? undefined : "../../tsconfig.base.json";
  if (!isApp && tsconfig.extends !== expectedExtends) {
    fail(
      rel(tsconfigPath),
      `must extend "${expectedExtends}" so strictness is shared, found "${tsconfig.extends}"`,
    );
  }
  if (tsconfig.compilerOptions?.noEmit !== true) {
    fail(rel(tsconfigPath), 'must set "noEmit": true — typecheck must not write output');
  }

  if (!isApp) {
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

for (const [name, { directory, manifest }] of manifests) {
  if (!layerOf.has(name)) {
    fail(
      rel(path.join(directory, "package.json")),
      `"${name}" is not assigned to a dependency layer in scripts/check-workspace-health.mjs`,
    );
  }
  const internal = Object.keys(manifest.dependencies ?? {}).filter((dependency) =>
    manifests.has(dependency),
  );
  graph.set(name, internal);

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

// No package may depend on an application.
for (const [name, dependencies] of graph) {
  for (const dependency of dependencies) {
    if (layerOf.get(dependency) === LAYERS.length - 1) {
      fail(name, `must not depend on the application "${dependency}"`);
    }
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

  // Placeholder markers are meaningful in comments, so they are searched for in the
  // raw text; the code patterns are searched for only after comments are stripped so
  // that documentation prose cannot be mistaken for a type annotation.
  if (MARKER_PATTERN.test(text)) {
    const line = text.split("\n").findIndex((candidate) => MARKER_PATTERN.test(candidate));
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
