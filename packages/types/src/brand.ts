/**
 * Nominal (branded) typing primitives.
 *
 * WHY
 * ---
 * OMNIS passes many identifier-shaped strings between domains: tenant IDs,
 * character IDs, correlation IDs, execution IDs. A bare `string` allows a
 * `CharacterId` to be handed to a function expecting a `TenantId` and the
 * compiler stays silent. Branding makes that a compile error at zero runtime
 * cost — the brand exists only in the type system and is fully erased from the
 * emitted JavaScript.
 *
 * INVARIANTS
 * ----------
 * - A branded value is structurally identical to its base at runtime.
 * - Branding is created in exactly one place per family (the `parse*` /
 *   `create*` factories). Application code must never cast to a branded type
 *   directly; that defeats the guarantee.
 * - Brands are erased, so they never leak into serialized output, logs or
 *   network payloads.
 */

/**
 * The unique symbol used as the brand key.
 *
 * A `unique symbol` (rather than a string-literal key) makes the brand
 * unforgeable: no object literal can accidentally satisfy it, because the
 * symbol is never exported as a value and exists only as a type.
 */
export declare const BRAND: unique symbol;

/** The type of the unforgeable brand key. */
export type BrandKey = typeof BRAND;

/**
 * `TBase` tagged with the nominal label `TBrand`.
 *
 * @example
 * ```ts
 * type TenantId = Branded<string, "TenantId">;
 * ```
 */
export type Branded<TBase, TBrand extends string> = TBase & {
  readonly [BRAND]: TBrand;
};

/** Recovers the underlying runtime type of a branded value. */
export type Unbranded<T> = T extends Branded<infer TBase, string> ? TBase : T;

/** Extracts the nominal label of a branded value. */
export type BrandLabel<T> = T extends Branded<unknown, infer TBrand> ? TBrand : never;

/**
 * Narrows an unknown value to a branded type *without* validating it.
 *
 * This is deliberately not exported from the package root. Validation factories
 * (`parseIdentifier`, `parseNonEmptyString`, ...) are the only sanctioned way to
 * mint a branded value; a public unchecked cast would let callers bypass
 * validation and silently reintroduce the `string`-soup problem branding exists
 * to prevent.
 *
 * @internal
 */
export function unsafeBrand<TBranded>(value: unknown): TBranded {
  return value as TBranded;
}
