#!/usr/bin/env node
/**
 * OMNIS secret scanner.
 *
 * WHY THIS EXISTS
 * ---------------
 * OMNIS holds platform credentials (YouTube, Instagram), model-provider keys and
 * tenant data. A single committed key is not recoverable by deleting it: it stays in
 * history, in forks and in every clone. The platform already refuses to *log* a
 * secret — `@omnis/errors` redacts before serialization and `@omnis/logging`
 * redacts on emit — so the remaining hole is the repository itself. This script
 * closes it and runs in `pnpm verify` and in CI on every push.
 *
 * WHAT IT DOES
 * ------------
 * Scans every file git tracks (plus untracked-but-not-ignored files, so a new
 * mistake is caught before it is committed) for credential-shaped material, and
 * fails with the file and line — never with the secret itself, which is masked in
 * the report so that reading the output cannot become the leak.
 *
 * DELIBERATE FAKES
 * ----------------
 * The redaction tests must contain credential-shaped strings to prove redaction
 * works; a scanner that cannot express that would either be bypassed or ignored.
 * Such a line carries an explicit, auditable marker:
 *
 *     const FAKE = "sk-proj-..."; // omnis-secret-scan:allow fake key for redaction test
 *
 * The marker suppresses findings on that line only, and the reason is printed in the
 * report so a reviewer can see every suppression at a glance. A marker without a
 * reason is itself a finding.
 *
 * Suppression is per line because a formatter is free to move a trailing comment onto a
 * different line than the one it annotated — which silently re-enables the finding.
 * Prefer a named fixture constant that carries the marker over an inline literal, so the
 * secret and its justification cannot be separated by reformatting.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Inline suppression marker, with a mandatory reason. */
const ALLOW_MARKER = "omnis-secret-scan:allow";

/**
 * Credential shapes worth failing a build over.
 *
 * Each pattern is anchored so that ordinary prose cannot match it: a document about
 * "task-relevant" behaviour must not be reported as an OpenAI key. Precision matters
 * more than recall here, because a scanner that cries wolf gets disabled — and a
 * disabled scanner is worse than no scanner.
 */
const PATTERNS = [
  {
    id: "aws-access-key-id",
    description: "AWS access key ID",
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  },
  {
    id: "github-token",
    description: "GitHub personal access token",
    pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  },
  {
    id: "github-fine-grained-token",
    description: "GitHub fine-grained personal access token",
    pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  },
  {
    id: "slack-token",
    description: "Slack token",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  },
  {
    id: "anthropic-key",
    description: "Anthropic API key",
    pattern: /(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    id: "openai-key",
    description: "OpenAI-style API key",
    pattern: /(?<![A-Za-z0-9_-])sk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    id: "google-api-key",
    description: "Google API key",
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },
  {
    id: "private-key-block",
    description: "PEM private key block",
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/g,
  },
  {
    id: "jwt",
    description: "JSON Web Token",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
  {
    id: "credential-assignment",
    description: "secret-looking assignment",
    pattern:
      /(?:api[_-]?key|apikey|secret|password|passwd|pwd|access[_-]?key|private[_-]?key|auth[_-]?token|client[_-]?secret)(?:["']?\s*[:=]\s*)["'][^"'$\{][^"']{11,}["']/gi,
  },
  {
    id: "connection-string",
    description: "database or broker URL with embedded credentials",
    pattern:
      /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|rediss|amqps?):\/\/[^:/@\s]+:[^@\s]{6,}@/gi,
  },
  {
    id: "bearer-literal",
    description: "hard-coded bearer token",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g,
  },
];

/** Files whose content is not text we can reason about, or which are noise. */
const SKIPPED_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".mp4",
  ".mov",
  ".pdf",
  ".zip",
]);

/** Paths that are third-party or generated and therefore not ours to police. */
const SKIPPED_PATHS = [
  /(^|\/)node_modules\//,
  /(^|\/)dist\//,
  /(^|\/)\.turbo\//,
  /pnpm-lock\.yaml$/,
];

/** Keeps the first and last few characters so a finding is identifiable but useless. */
function mask(secret) {
  if (secret.length <= 8) {
    return "*".repeat(secret.length);
  }
  return `${secret.slice(0, 4)}${"*".repeat(Math.min(secret.length - 8, 24))}${secret.slice(-4)}`;
}

/** Lists the files to scan: tracked, plus untracked and not ignored. */
function filesToScan() {
  try {
    const output = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    return output.split("\n").filter((line) => line.length > 0);
  } catch {
    process.stderr.write(
      "secret scan: git is unavailable, so the tracked-file list could not be read\n",
    );
    process.exit(1);
  }
}

const findings = [];
const suppressions = [];
let scannedFiles = 0;
let skippedBinary = 0;

for (const relative of filesToScan()) {
  if (SKIPPED_PATHS.some((pattern) => pattern.test(relative))) {
    continue;
  }
  if (SKIPPED_EXTENSIONS.has(path.extname(relative).toLowerCase())) {
    skippedBinary += 1;
    continue;
  }
  const absolute = path.join(REPO_ROOT, relative);
  let stat;
  try {
    stat = statSync(absolute);
  } catch {
    continue; // Deleted in the working tree but still indexed; nothing to scan.
  }
  if (!stat.isFile() || stat.size === 0) {
    continue;
  }

  let text;
  try {
    text = readFileSync(absolute, "utf8");
  } catch {
    skippedBinary += 1;
    continue;
  }
  if (text.includes("\u0000")) {
    skippedBinary += 1;
    continue;
  }
  scannedFiles += 1;

  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const lineNumber = index + 1;
    const allowAt = line.indexOf(ALLOW_MARKER);
    const allowed = allowAt !== -1;
    const reason = allowed
      ? line
          .slice(allowAt + ALLOW_MARKER.length)
          .replace(/^[:\s-]+/, "")
          .trim()
      : "";

    for (const { id, description, pattern } of PATTERNS) {
      pattern.lastIndex = 0;
      for (const match of line.matchAll(pattern)) {
        const secret = match[0];
        // A suppression only covers the material before the marker on that line.
        if (allowed && match.index < allowAt) {
          if (reason.length === 0) {
            findings.push({
              file: relative,
              line: lineNumber,
              id,
              detail: `${ALLOW_MARKER} was used without a reason`,
            });
          } else {
            suppressions.push({ file: relative, line: lineNumber, id, reason });
          }
          continue;
        }
        findings.push({
          file: relative,
          line: lineNumber,
          id,
          detail: `${description} (${mask(secret)})`,
        });
      }
    }
  }
}

if (findings.length === 0) {
  process.stdout.write(
    `secret scan: OK (${scannedFiles} files scanned, ${skippedBinary} binary skipped, ` +
      `${suppressions.length} documented test fixture(s) allowed)\n`,
  );
  for (const { file, line, id, reason } of suppressions) {
    process.stdout.write(`  allowed ${file}:${line} [${id}] — ${reason}\n`);
  }
  process.exit(0);
}

process.stdout.write(`secret scan: ${findings.length} finding(s)\n\n`);
for (const { file, line, id, detail } of findings) {
  process.stdout.write(`  ${file}:${line} [${id}] ${detail}\n`);
}
process.stdout.write(
  "\nIf this is a deliberate fake used by a test, mark the line with " +
    `"// ${ALLOW_MARKER} <reason>" — the marker is reported on every run so it stays auditable.\n` +
    "If it is a real credential, treat it as compromised: rotate it, then remove it.\n\n",
);
process.exit(1);
