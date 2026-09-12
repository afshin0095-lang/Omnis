/**
 * Spacing scale.
 *
 * A 4px base with a deliberate set of steps rather than every integer, because a
 * scale that permits anything gets used for anything and stops producing visual
 * rhythm. Keys are the step number, so `spacing[4]` is 16px — the mapping is
 * readable at a call site without opening this file.
 */

import type { SpacingTokens } from "../themes/types.js";

/** Base unit. Every step is a multiple of it. */
export const SPACING_BASE_PX = 4;

export const SPACING: SpacingTokens = {
  0: "0",
  1: "0.25rem",
  2: "0.5rem",
  3: "0.75rem",
  4: "1rem",
  5: "1.25rem",
  6: "1.5rem",
  8: "2rem",
  10: "2.5rem",
  12: "3rem",
  16: "4rem",
};
