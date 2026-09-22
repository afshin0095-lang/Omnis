/**
 * The identifier-slug pattern shared by the AI Core registries.
 *
 * Model slugs and provider slugs appear in the same places — configuration files, API
 * paths, event payloads, the Studio UI — and an operator who has learned one shape should
 * not have to learn a second. Declaring the pattern once, in the package both registries
 * already depend on, keeps them from drifting apart, which is how "the model slug is valid
 * but the provider slug is not" bugs are born.
 */

/**
 * Lowercase alphanumeric with `.`, `_` and `-` separators, 2-64 characters, starting and
 * ending with a letter or digit.
 *
 * The character set is deliberately URL-safe and shell-safe: a slug that needed escaping
 * would be a permanent source of mismatch between what an operator typed and what the
 * registry stored. A trailing separator is rejected because `"openai"` and `"openai-"` are
 * the same provider to a human reading a dashboard and two different rows to a registry —
 * that pair is how a duplicate registration survives review.
 */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]{0,62}[a-z0-9]$/;

/** True when `value` is a valid AI Core slug. */
export function isAiCoreSlug(value: string): boolean {
  return SLUG_PATTERN.test(value);
}

/** The human-readable slug contract, reused in validation messages. */
export const SLUG_CONTRACT =
  "must be 2-64 characters of [a-z0-9._-], starting and ending with a letter or digit";
