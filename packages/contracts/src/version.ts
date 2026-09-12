/**
 * Contract versioning.
 *
 * WHY
 * ---
 * Events, commands and integration payloads outlive the code that produced them.
 * A character event written to the event store today must still be readable in
 * two years, by a consumer that has been rewritten several times, and possibly by
 * a third-party integration. That is only possible if every contract carries an
 * explicit version and if the rules for changing one are mechanical rather than a
 * matter of opinion.
 *
 * THE RULES
 * ---------
 * - `MAJOR` changes are **breaking**: a consumer written for the previous major
 *   may misinterpret the payload. A major bump requires an ADR, a migration plan
 *   and — for anything already persisted — continued support for the old major.
 * - `MINOR` changes are **additive and backwards compatible**: new optional
 *   fields, new enum members in an open set. A consumer written for the earlier
 *   minor must keep working unchanged.
 * - `PATCH` changes are **non-semantic**: documentation, descriptions, error
 *   message wording. Never the shape.
 *
 * A contract is never edited in place. The previous version stays readable.
 *
 * See docs/03-contracts/VERSIONING.md for the full policy and the deprecation
 * timeline.
 */

import { compareSemVer, parseSemVer, semVerParts, type SemVer } from "@omnis/types";

/**
 * The current version of the OMNIS shared contract set.
 *
 * Every envelope, command and result produced by the platform carries this until
 * an individual contract is versioned independently. Bumping it is an ADR-level
 * decision, not a routine release step.
 */
export const CONTRACT_VERSION: SemVer = parseSemVer("1.0.0");

/** The kind of change being made to a contract. */
export const CONTRACT_CHANGE_KINDS = ["patch", "minor", "major"] as const;

/** One member of {@link CONTRACT_CHANGE_KINDS}. */
export type ContractChangeKind = (typeof CONTRACT_CHANGE_KINDS)[number];

/** Renders the `id@version` label used in logs, errors and registries. */
export function formatContractId(contractId: string, version: SemVer): string {
  return `${contractId}@${version}`;
}

/**
 * True when a consumer written for `previous` can safely read a payload produced
 * at `next` without being redeployed.
 *
 * Compatibility is exactly "same major, not older": within a major, changes are
 * required to be additive, so an older consumer ignores what it does not know.
 * Across a major, no such promise exists.
 */
export function isBackwardsCompatible(previous: SemVer, next: SemVer): boolean {
  const a = semVerParts(previous);
  const b = semVerParts(next);
  if (a.major !== b.major) {
    return false;
  }
  // A pre-release of the same major is not yet a stable contract.
  if (b.prerelease !== null && a.prerelease === null) {
    return false;
  }
  return compareSemVer(next, previous) >= 0;
}

/**
 * Classifies a version transition.
 *
 * Used by tooling and by review checklists to catch a change that was described
 * as additive but actually bumped the major, or — more dangerously — one that
 * altered a shape while claiming to be a patch.
 */
export function classifyVersionChange(previous: SemVer, next: SemVer): ContractChangeKind {
  const a = semVerParts(previous);
  const b = semVerParts(next);
  if (a.major !== b.major) {
    return "major";
  }
  if (a.minor !== b.minor) {
    return "minor";
  }
  return "patch";
}

/**
 * Computes the next version for a given change kind.
 *
 * Centralised so that "bump the minor" means the same thing in every package and
 * cannot be implemented as an off-by-one somewhere.
 */
export function nextVersion(current: SemVer, change: ContractChangeKind): SemVer {
  const { major, minor, patch } = semVerParts(current);
  switch (change) {
    case "major":
      return parseSemVer(`${major + 1}.0.0`);
    case "minor":
      return parseSemVer(`${major}.${minor + 1}.0`);
    case "patch":
      return parseSemVer(`${major}.${minor}.${patch + 1}`);
  }
}
