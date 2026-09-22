/**
 * Test-only support for this package's suites.
 *
 * The secret-shaped fixture is assembled at runtime rather than written as a literal:
 * the repository is pushed to GitHub, whose push protection rejects files containing
 * credential-shaped strings even inside tests. Building the value from parts keeps the
 * fixture honest — it still matches the redactor's patterns — without putting a
 * credential-shaped literal into the repository.
 *
 * Excluded from the published build by `tsconfig.build.json`, which ships `src` minus
 * `*.test.ts` and this module.
 */

import { MAX_METADATA_ENTRIES as ENTRIES } from "@omnis/ai-core-types";

/** Re-exported so a test does not have to import the constant from two places. */
export const MAX_METADATA_ENTRIES = ENTRIES;

/** Secret-shaped fixtures, assembled at runtime. */
export const REDACTED_MARKER = {
  /** A Google-API-key-shaped value: the prefix plus 35 characters. */
  fixture: `AIza${"A".repeat(35)}`,
} as const;
