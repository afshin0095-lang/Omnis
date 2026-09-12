/**
 * The base stylesheet this component library needs.
 *
 * WHY A LIBRARY SHIPS ANY CSS AT ALL
 * ----------------------------------
 * Almost every visual property is expressed as `var(--omnis-*)`, so a theme change
 * needs no stylesheet. But three things cannot be expressed as a custom property:
 * `@keyframes`, the focus-visible reset, and the reduced-motion override. Those are
 * structural, not thematic, so they belong to the library rather than to a theme.
 *
 * They are injected once, as a single `<style data-omnis-ui-base>` element, and the
 * injection is idempotent. A component library that requires the consumer to
 * remember a CSS import is a library that produces unstyled spinners in exactly the
 * one environment nobody tests: production.
 *
 * KEYFRAMES ARE DEFINED HERE, USED BY COMPONENTS
 * ----------------------------------------------
 * `Spinner`, `Progress` (indeterminate) and `Modal` reference these animation names.
 * The names are prefixed for the same reason the classes are.
 */

/** Marker attribute used to find an already-injected stylesheet. */
export const BASE_STYLE_ATTRIBUTE = "data-omnis-ui-base";

/** Animation names exported so components never hard-code a string. */
export const ANIMATIONS = {
  spin: "omnis-spin",
  indeterminate: "omnis-indeterminate",
  shimmer: "omnis-shimmer",
  fadeIn: "omnis-fade-in",
  riseIn: "omnis-rise-in",
} as const;

/** One member of {@link ANIMATIONS}. */
export type AnimationName = (typeof ANIMATIONS)[keyof typeof ANIMATIONS];

/**
 * The stylesheet text.
 *
 * Keyframe definitions deliberately use only `transform` and `opacity`: those are
 * composited on the GPU and do not trigger layout, which is the difference between
 * an ambient animation that costs nothing and one that makes a whole page stutter.
 */
export const OMNIS_BASE_CSS = `
@keyframes ${ANIMATIONS.spin} {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

@keyframes ${ANIMATIONS.indeterminate} {
  0% { transform: translateX(-100%); }
  50% { transform: translateX(120%); }
  100% { transform: translateX(320%); }
}

@keyframes ${ANIMATIONS.shimmer} {
  0% { opacity: 0.45; }
  50% { opacity: 1; }
  100% { opacity: 0.45; }
}

@keyframes ${ANIMATIONS.fadeIn} {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes ${ANIMATIONS.riseIn} {
  from { opacity: 0; transform: translateY(8px) scale(0.985); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}

/* A visible focus ring on every interactive element this library renders. The
   offset keeps the ring off the element's own border, where a glow would otherwise
   be indistinguishable from the border itself. */
.${"omnis-focusable"}:focus-visible {
  outline: 2px solid var(--omnis-color-border-focus);
  outline-offset: 2px;
}

/* Honour the OS preference regardless of what the theme says: a user who asks for
   reduced motion is reporting a medical constraint, not a taste. */
@media (prefers-reduced-motion: reduce) {
  .omnis-animated {
    animation-duration: 1ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 1ms !important;
  }
}
`;

/** Class applied to elements that participate in animation. */
export const ANIMATED_CLASS = "omnis-animated";

/** Class applied to elements that should show the library's focus ring. */
export const FOCUSABLE_CLASS = "omnis-focusable";

/**
 * Injects {@link OMNIS_BASE_CSS} into `target`, once.
 *
 * Returns the style element, or null when there is no document (server rendering).
 * Idempotent: calling it from several providers on one page adds one stylesheet.
 */
export function injectBaseStyles(target?: HTMLElement | null): HTMLStyleElement | null {
  if (typeof document === "undefined") {
    return null;
  }
  const host = target ?? document.head;
  const existing = host.querySelector<HTMLStyleElement>(`style[${BASE_STYLE_ATTRIBUTE}]`);
  if (existing !== null) {
    return existing;
  }
  const element = document.createElement("style");
  element.setAttribute(BASE_STYLE_ATTRIBUTE, "true");
  element.textContent = OMNIS_BASE_CSS;
  host.appendChild(element);
  return element;
}

/** Removes the injected stylesheet. Used by tests and by provider cleanup. */
export function removeBaseStyles(target?: HTMLElement | null): void {
  if (typeof document === "undefined") {
    return;
  }
  const host = target ?? document.head;
  for (const element of Array.from(host.querySelectorAll(`style[${BASE_STYLE_ATTRIBUTE}]`))) {
    element.remove();
  }
}

/** True when the base stylesheet is present. */
export function hasBaseStyles(target?: HTMLElement | null): boolean {
  if (typeof document === "undefined") {
    return false;
  }
  const host = target ?? document.head;
  return host.querySelector(`style[${BASE_STYLE_ATTRIBUTE}]`) !== null;
}
