#!/usr/bin/env node
// Cross-platform clean task for OMNIS workspace members.
//
// Every package/app declares `"clean": "node ../../scripts/clean-package.mjs"`.
// A single shared implementation is used instead of `rm -rf` so the task behaves
// identically on Windows, macOS, Linux and in CI.
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const DIRECTORIES = ["dist", "build", "coverage", ".turbo", ".vite", "node_modules/.tmp"];

const cwd = process.cwd();
const removed = [];

for (const directory of DIRECTORIES) {
  const path = join(cwd, directory);
  if (existsSync(path)) {
    rmSync(path, { recursive: true, force: true });
    removed.push(directory);
  }
}

for (const entry of readdirSync(cwd)) {
  if (entry.endsWith(".tsbuildinfo")) {
    rmSync(join(cwd, entry), { force: true });
    removed.push(entry);
  }
}

if (process.env["OMNIS_CLEAN_VERBOSE"] === "true") {
  console.log(`cleaned ${cwd} (${removed.length}: ${removed.join(", ") || "nothing"})`);
}
