/**
 * Class name composition.
 *
 * A thin wrapper over `clsx` rather than a hand-rolled joiner: the conditional
 * form (`cn(base, { [variantClass]: active })`) is what keeps variant logic
 * readable inside a component, and reimplementing it would be a worse version of
 * something already solved.
 *
 * Everything this package emits is BEM-style and prefixed. The prefix is not
 * decoration — a consuming application also loads its own and third-party
 * stylesheets, and an unprefixed `.button` would be overwritten by whichever
 * arrived last.
 */

import { clsx } from "clsx";
import type { ClassValue } from "clsx";

/** Prefix applied to every class this package emits. */
export const CLASS_PREFIX = "omnis";

/** Joins conditional class values into a single string. */
export function cn(...values: ClassValue[]): string {
  return clsx(values);
}

/**
 * Builds a block class: `blockClass("button")` -> `"omnis-button"`,
 * `blockClass("button", "primary")` -> `"omnis-button--primary"`.
 */
export function blockClass(block: string, modifier?: string): string {
  return modifier === undefined
    ? `${CLASS_PREFIX}-${block}`
    : `${CLASS_PREFIX}-${block}--${modifier}`;
}

/** Builds an element class: `elementClass("button", "icon")` -> `"omnis-button__icon"`. */
export function elementClass(block: string, element: string): string {
  return `${CLASS_PREFIX}-${block}__${element}`;
}

/**
 * Builds the full class list for a component instance.
 *
 * Every component routes through here so that the emitted classes are consistent
 * — block, optional variant modifier, optional size modifier, then whatever the
 * caller passed. Callers' classes come last, which means a consumer can always win
 * a specificity tie without `!important`.
 */
export function componentClass(
  block: string,
  options: {
    readonly variant?: string;
    readonly size?: string;
    readonly className?: ClassValue;
    readonly active?: boolean;
    readonly disabled?: boolean;
  } = {},
): string {
  return cn(
    blockClass(block),
    options.variant === undefined ? undefined : blockClass(block, options.variant),
    options.size === undefined ? undefined : blockClass(block, options.size),
    { [blockClass(block, "active")]: options.active === true },
    { [blockClass(block, "disabled")]: options.disabled === true },
    options.className,
  );
}
