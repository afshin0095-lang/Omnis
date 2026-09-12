/**
 * Layer ordering scale.
 *
 * THE PROBLEM THIS SOLVES
 * -----------------------
 * Stacking is the one visual property that cannot be fixed locally. A tooltip that
 * disappears behind a modal can only be corrected by raising the tooltip, which
 * then breaks the toast that must appear above the tooltip, which breaks the
 * dropdown that must appear above the toast. Every local fix is a global regression
 * waiting to happen.
 *
 * So the order is decided once, here, and components take a named layer instead of
 * a number. Asking "should this sit above a modal?" becomes a question with a
 * documented answer rather than a guess that happens to work on one screen.
 *
 * Layers are spaced by 10 so an unforeseen layer can be inserted between two
 * existing ones without renumbering everything above it — renumbering is what
 * causes the regressions this scale exists to prevent.
 */

import type { ZIndexTokens } from "../themes/types.js";

/** The single shared layer scale. Identical across themes: order is not a skin. */
export const Z_INDEX: ZIndexTokens = {
  /** Default document flow. */
  base: 0,
  /** Ordinary page content above the animated background. */
  content: 10,
  /** Cards and panels that lift within content. */
  raised: 20,
  /** Menus and select popovers anchored to a control. */
  dropdown: 30,
  /** Headers and toolbars that stay visible while scrolling. */
  sticky: 40,
  /** The dimmed backdrop behind a modal. */
  overlay: 50,
  /** Modal and dialog surfaces. */
  modal: 60,
  /** Detached popovers that must escape a modal's clipping context. */
  popover: 70,
  /** Notifications: transient, must be seen over anything the user is doing. */
  toast: 80,
  /** Tooltips describe whatever is under the pointer, so they sit above toasts. */
  tooltip: 90,
  /** Reserved ceiling. Nothing may exceed this. */
  max: 100,
};

/**
 * Type guard asserting a value is a known layer index.
 *
 * Exported so a component that receives a numeric `zIndex` prop can validate it
 * against the scale rather than accepting an arbitrary number and reintroducing
 * the exact problem the scale exists to prevent.
 */
export function isKnownZIndex(value: number): boolean {
  return Object.values(Z_INDEX).includes(value);
}
