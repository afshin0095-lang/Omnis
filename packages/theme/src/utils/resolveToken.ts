/**
 * Reading a token out of a theme by path.
 *
 * WHY TYPED PATHS
 * ---------------
 * A theme is seven levels deep. `theme.colors.textMuted` is easy to typo and the
 * compiler catches it; `get(theme, "colors.textMutd")` is equally easy to typo and
 * the compiler does not. Since runtime composition means code increasingly reaches
 * for tokens by *name* rather than by property access, the name has to be checked.
 *
 * {@link TokenPath} is derived from the `Theme` type itself, so adding a token adds
 * its path automatically and renaming one breaks every string that referenced it.
 * There is no list of paths to keep in sync, which is the only arrangement that
 * survives a growing design system.
 */

import type { Theme } from "../themes/types.js";

/**
 * Every dotted path through a theme that ends at a value.
 *
 * Arrays are treated as leaves: `colors.aurora` resolves to the tuple rather than
 * to `colors.aurora.0`, because indexing into a colour ramp by number is never what
 * a caller means.
 */
type TokenLeaves<T, Prefix extends string = ""> = T extends readonly unknown[]
  ? Prefix
  : T extends object
    ? {
        [K in keyof T & string]: TokenLeaves<T[K], Prefix extends "" ? K : `${Prefix}.${K}`>;
      }[keyof T & string]
    : Prefix;

/** The union of every valid token path. */
export type TokenPath = TokenLeaves<Theme>;

/** Resolves the type found at a dotted path. */
export type TokenValue<Path extends string> = Path extends `${infer Head}.${infer Rest}`
  ? Head extends keyof Theme
    ? TokenValueAt<Theme[Head], Rest>
    : never
  : Path extends keyof Theme
    ? Theme[Path]
    : never;

/** Internal recursion over an arbitrary subtree. */
type TokenValueAt<T, Path extends string> = Path extends `${infer Head}.${infer Rest}`
  ? Head extends keyof T
    ? TokenValueAt<T[Head], Rest>
    : never
  : Path extends keyof T
    ? T[Path]
    : never;

/**
 * Reads the token at `path`, with the return type inferred from the path.
 *
 * @throws {TypeError} when an intermediate segment is missing at runtime. The path
 *   is checked statically, so this can only happen for a theme object that was
 *   built by hand and is incomplete — which is a bug worth failing loudly on
 *   rather than rendering `undefined` into a stylesheet.
 */
export function resolveToken<Path extends TokenPath>(theme: Theme, path: Path): TokenValue<Path> {
  const segments = path.split(".");
  let current: unknown = theme;
  for (const segment of segments) {
    if (current === null || typeof current !== "object") {
      throw new TypeError(
        `Cannot resolve theme token "${path}": segment "${segment}" was reached on a non-object value.`,
      );
    }
    current = (current as Record<string, unknown>)[segment];
    if (current === undefined) {
      throw new TypeError(`Cannot resolve theme token "${path}": segment "${segment}" is missing.`);
    }
  }
  return current as TokenValue<Path>;
}

/**
 * Reads a token, returning `fallback` instead of throwing when it is absent.
 *
 * For the case where the theme really is user-supplied and may be partial —
 * a partially-customised tenant theme should render with defaults for what the
 * tenant did not override, not fail.
 */
export function resolveTokenOr<Path extends TokenPath>(
  theme: Theme,
  path: Path,
  fallback: TokenValue<Path>,
): TokenValue<Path> {
  try {
    return resolveToken(theme, path);
  } catch {
    return fallback;
  }
}

/** True when `path` names a token that exists on `theme`. */
export function hasToken(theme: Theme, path: string): boolean {
  let current: unknown = theme;
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object") {
      return false;
    }
    current = (current as Record<string, unknown>)[segment];
    if (current === undefined) {
      return false;
    }
  }
  return true;
}
