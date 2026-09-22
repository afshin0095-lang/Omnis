/**
 * The workspace's dependency graph, read from the repository rather than declared.
 *
 * An architecture test that asserts a graph somebody typed into the test proves
 * nothing about the code. These helpers read the manifests and the import statements
 * that are actually there, so a suite that says "the kernel does not import the
 * orchestrator" fails the moment somebody adds the import — including in a file the
 * author of the rule had never seen.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The repository root, resolved from this module's own location. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** A relative path from the repository root, with forward slashes. */
export function relative(absolute: string): string {
  return path.relative(REPO_ROOT, absolute).split(path.sep).join("/");
}

/** Directories that are never source. */
const IGNORED = new Set(["node_modules", "dist", "build", "coverage", ".turbo", ".git", ".cache"]);

/** Extensions that count as source. */
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);

/** One workspace member. */
export interface WorkspaceMember {
  readonly name: string;
  /** Absolute directory. */
  readonly directory: string;
  /** Relative directory, for stable messages. */
  readonly location: string;
  readonly manifest: {
    readonly name?: string;
    readonly dependencies?: Record<string, string>;
    readonly devDependencies?: Record<string, string>;
    readonly peerDependencies?: Record<string, string>;
    readonly optionalDependencies?: Record<string, string>;
    readonly scripts?: Record<string, string>;
    readonly type?: string;
    readonly private?: boolean;
    readonly main?: string;
    readonly types?: string;
    readonly exports?: Record<string, unknown>;
    readonly files?: string[];
    readonly description?: string;
    readonly license?: string;
  };
  /** Every dependency declared in any field. */
  readonly declared: readonly string[];
  /** Declared dependencies that are workspace members. */
  readonly internal: readonly string[];
  /** Source files, relative to the repository root. */
  readonly files: readonly string[];
}

/** Walks a tree, yielding files whose extension is accepted. */
function* walk(directory: string, accepted: Set<string>): Generator<string> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED.has(entry.name)) {
        yield* walk(absolute, accepted);
      }
      continue;
    }
    if (accepted.has(path.extname(entry.name))) {
      yield absolute;
    }
  }
}

/** Reads every workspace member: `packages/*`, `apps/*` and `tests`. */
export function workspaceMembers(): readonly WorkspaceMember[] {
  const directories: string[] = [];
  for (const group of ["packages", "apps"]) {
    const groupPath = path.join(REPO_ROOT, group);
    if (!existsSync(groupPath)) {
      continue;
    }
    for (const entry of readdirSync(groupPath, { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(path.join(groupPath, entry.name, "package.json"))) {
        directories.push(path.join(groupPath, entry.name));
      }
    }
  }
  const suite = path.join(REPO_ROOT, "tests");
  if (existsSync(path.join(suite, "package.json"))) {
    directories.push(suite);
  }

  return directories.sort().map((directory) => {
    const manifest = JSON.parse(
      readFileSync(path.join(directory, "package.json"), "utf8"),
    ) as WorkspaceMember["manifest"];
    const declared = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
    ];
    return {
      name: manifest.name ?? relative(directory),
      directory,
      location: relative(directory),
      manifest,
      declared,
      // Filled in below, once every member is known.
      internal: [],
      files: [...walk(directory, SOURCE_EXTENSIONS)].map(relative).sort(),
    };
  });
}

/** The workspace, with internal dependencies resolved against the member list. */
export interface Workspace {
  readonly members: readonly WorkspaceMember[];
  /** Member by package name. */
  readonly byName: ReadonlyMap<string, WorkspaceMember>;
  /** The AI Core packages that exist, by name. */
  readonly aiCore: readonly WorkspaceMember[];
}

/** The AI Core, as a list of package names. */
export const AI_CORE_PACKAGE_NAMES: readonly string[] = Object.freeze([
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
]);

/** Reads the workspace and resolves internal dependency edges. */
export function readWorkspace(): Workspace {
  const members = workspaceMembers();
  const names = new Set(members.map((member) => member.name));
  const resolved = members.map((member) => ({
    ...member,
    internal: member.declared.filter((dependency) => names.has(dependency)),
  }));
  return {
    members: resolved,
    byName: new Map(resolved.map((member) => [member.name, member])),
    aiCore: resolved.filter((member) => AI_CORE_PACKAGE_NAMES.includes(member.name)),
  };
}

/** Every module specifier a source file mentions, static or dynamic. */
const IMPORT_PATTERN = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["']([^"']+)["']/g;

/** The specifiers one file imports, with comments removed first. */
export function importsOf(file: string): readonly string[] {
  const absolute = path.isAbsolute(file) ? file : path.join(REPO_ROOT, file);
  const source = readFileSync(absolute, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
  return [...source.matchAll(IMPORT_PATTERN)].map((match) => match[1] as string);
}

/** The bare package name behind a specifier, or `null` for a relative one. */
export function packageOf(specifier: string): string | null {
  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    return null;
  }
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? null);
}

/** True for a file that exists to support tests rather than to ship. */
export function isFixtureFile(file: string): boolean {
  return /\.test\.[cm]?[jt]sx?$/.test(file) || /(^|\/)testSupport\.[cm]?[jt]sx?$/.test(file);
}

/** Every member's imported packages, keyed by member name. */
export function importedPackages(workspace: Workspace): ReadonlyMap<string, ReadonlySet<string>> {
  const result = new Map<string, ReadonlySet<string>>();
  for (const member of workspace.members) {
    const packages = new Set<string>();
    for (const file of member.files) {
      for (const specifier of importsOf(file)) {
        const dependency = packageOf(specifier);
        if (dependency !== null) {
          packages.add(dependency);
        }
      }
    }
    result.set(member.name, packages);
  }
  return result;
}
