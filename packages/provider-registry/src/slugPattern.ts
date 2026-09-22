/**
 * Provider slugs use the AI Core slug pattern.
 *
 * Re-exported here so this package's validation module has a single local import to point
 * at, and so the pattern itself lives in `@omnis/ai-core-types` where the model registry
 * can share it. See {@link SLUG_PATTERN} for the shape and the reasoning behind it.
 */

export { SLUG_CONTRACT, SLUG_PATTERN } from "@omnis/ai-core-types";
