/**
 * Type scale.
 *
 * A single scale shared by every theme: changing type sizes is a product decision
 * about density and readability, not a per-skin choice, so it is not part of the
 * light/dark variation.
 *
 * `display` exists separately from `3xl` because the OMNIS welcome surface needs a
 * very large, widely-tracked wordmark, and reusing a body scale step for it would
 * couple the two.
 */

import type { TypographyTokens } from "../themes/types.js";

export const TYPOGRAPHY: TypographyTokens = {
  fontFamily: {
    // System stacks rather than a bundled webfont: no font licence, no
    // third-party request that would leak a Studio visitor's IP, and no
    // layout shift while a font downloads.
    sans: "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
    heading: "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
    mono: "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace",
  },
  fontSize: {
    xs: "0.75rem",
    sm: "0.875rem",
    base: "1rem",
    lg: "1.125rem",
    xl: "1.25rem",
    "2xl": "1.5rem",
    "3xl": "2rem",
    display: "clamp(4rem, 10vw, 7rem)",
  },
  fontWeight: {
    regular: 400,
    medium: 500,
    semibold: 600,
    bold: 700,
  },
  lineHeight: {
    tight: 1.15,
    normal: 1.45,
    relaxed: 1.7,
  },
  letterSpacing: {
    tight: "-0.02em",
    normal: "0",
    wide: "0.15em",
    // The wordmark tracking carried over from the existing Studio stylesheet.
    display: "0.45em",
  },
};
