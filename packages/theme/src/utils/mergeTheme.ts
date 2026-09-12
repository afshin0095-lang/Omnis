/**
 * Runtime theme composition.
 *
 * WHY MERGING IS A REQUIREMENT, NOT A CONVENIENCE
 * -----------------------------------------------
 * §34 asks for themes that are runtime-configurable and for future user-
 * customisable themes. Both mean the same thing mechanically: take a shipped theme
 * and apply a small set of overrides on top of it. Without composition, every
 * tenant variation has to be a complete hand-written theme object — around two
 * hundred values — which guarantees that a tenant theme silently misses whatever
 * tokens were added after it was written.
 *
 * Merging keeps a partial override permanently correct: new tokens inherit the base
 * theme's value automatically.
 *
 * WHAT IS DELIBERATELY NOT MERGED
 * --------------------------------
 * Arrays are replaced, never concatenated or merged element-wise. `colors.aurora` is
 * a fixed-length tuple whose meaning depends on position; merging it by index would
 * let a tenant override one gradient stop and end up with a ramp nobody designed.
 * Replacing the whole tuple is the only interpretation that stays predictable.
 */

import { REDUCED_MOTION } from "../tokens/motion.js";
import type { MotionTokens, Theme } from "../themes/types.js";

/** A partial, arbitrarily nested override of a theme. */
export type DeepPartialTheme<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { readonly [K in keyof T]?: DeepPartialTheme<T[K]> }
    : T;

/** A partial theme: any subset of tokens may be overridden. */
export type ThemeOverrides = DeepPartialTheme<Theme>;

/** True for plain objects, which are the only values merged recursively. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

/** Recursively applies `overrides` onto `base`, returning a new value. */
function mergeDeep<Base>(base: Base, overrides: unknown): Base {
  if (overrides === undefined) {
    return base;
  }
  if (!isPlainObject(base) || !isPlainObject(overrides)) {
    // Scalars and arrays replace wholesale. See the module comment on arrays.
    return overrides as Base;
  }

  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      // An explicitly-undefined override means "leave the base value alone".
      // Deleting instead would let a partial override remove a required token and
      // produce a theme with a hole in it.
      continue;
    }
    const existing: unknown = merged[key];
    merged[key] = isPlainObject(existing) ? mergeDeep(existing, value) : value;
  }
  return merged as Base;
}

/**
 * Composes a new theme from a base and a partial override.
 *
 * Neither input is mutated, so a base theme can serve any number of derived themes
 * concurrently — which is the situation once several tenants are active at once.
 */
export function mergeTheme(base: Theme, overrides: ThemeOverrides): Theme {
  return mergeDeep(base, overrides);
}

/**
 * Composes several overrides onto a base, left to right.
 *
 * The order is the precedence: a later source wins. That makes the intended
 * layering expressible directly — shipped theme, then tenant brand, then the
 * individual user's preference.
 */
export function composeTheme(base: Theme, ...overrides: readonly ThemeOverrides[]): Theme {
  return overrides.reduce<Theme>((theme, override) => mergeDeep(theme, override), base);
}

/**
 * Builds a tenant-branded variant of a theme.
 *
 * A focused helper rather than asking every caller to know which tokens carry a
 * brand: the accent colour and its emission are the two that visibly change an
 * identity, and deriving the glow from the accent keeps them consistent instead of
 * letting a caller set a blue accent with a green glow.
 */
export function brandTheme(
  base: Theme,
  brand: { readonly primary: string; readonly glow?: string },
): Theme {
  return mergeTheme(base, {
    id: `${base.id}-branded`,
    colors: {
      primary: brand.primary,
      primaryGlow: brand.glow ?? withAlpha(brand.primary, 0.35),
      borderFocus: brand.glow ?? withAlpha(brand.primary, 0.55),
    },
  });
}

/**
 * Best-effort alpha application to a colour literal.
 *
 * Handles `#rgb`, `#rrggbb` and passes anything else through unchanged inside a
 * `color-mix()` expression, which modern browsers evaluate for us. Returning the
 * input untouched on an unrecognised format is the safe failure: a slightly wrong
 * glow is a cosmetic issue, a malformed colour value is a dropped declaration.
 */
export function withAlpha(color: string, alpha: number): string {
  const clamped = Math.min(1, Math.max(0, alpha));
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (hex === null || hex[1] === undefined) {
    return `color-mix(in srgb, ${color} ${Math.round(clamped * 100)}%, transparent)`;
  }
  const digits =
    hex[1].length === 3
      ? hex[1]
          .split("")
          .map((digit) => `${digit}${digit}`)
          .join("")
      : hex[1];
  const value = Number.parseInt(digits, 16);
  if (!Number.isFinite(value)) {
    return `color-mix(in srgb, ${color} ${Math.round(clamped * 100)}%, transparent)`;
  }
  const r = (value >> 16) & 0xff;
  const g = (value >> 8) & 0xff;
  const b = value & 0xff;
  return `rgba(${r}, ${g}, ${b}, ${clamped})`;
}

/**
 * Reduces a theme's motion for visitors who asked for it.
 *
 * Exposed as a utility as well as being applied by the theme provider, because a
 * server-rendered page needs the same adjustment before hydration or it will paint
 * one frame of full animation and then snap — which is precisely the jolt the
 * preference exists to avoid.
 */
export function withReducedMotion(theme: Theme, motion: MotionTokens = REDUCED_MOTION): Theme {
  return mergeTheme(theme, { motion });
}
