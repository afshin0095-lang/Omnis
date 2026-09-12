/**
 * Theme utilities: composition and typed token access.
 *
 * These two capabilities are what make a theme *runtime* data rather than a
 * compile-time constant: `mergeTheme` lets a partial override produce a complete
 * theme, and `resolveToken` lets code reach a token by a name the compiler checks.
 */

export {
  brandTheme,
  composeTheme,
  mergeTheme,
  withAlpha,
  withReducedMotion,
} from "./mergeTheme.js";
export type { DeepPartialTheme, ThemeOverrides } from "./mergeTheme.js";
export { hasToken, resolveToken, resolveTokenOr } from "./resolveToken.js";
export type { TokenPath, TokenValue } from "./resolveToken.js";
