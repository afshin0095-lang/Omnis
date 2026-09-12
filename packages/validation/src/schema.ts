/**
 * Schema description and the vendor-neutral schema shape used across OMNIS.
 *
 * `OmnisSchema` is a *structural* interface rather than an alias for a Zod type.
 * Two reasons:
 *
 * 1. Call sites outside the validation allowlist never have to name a vendor
 *    type, so the vendor can be swapped or upgraded by changing one package.
 * 2. It documents the exact capability OMNIS relies on — "unknown in, TOutput
 *    out, never throws" — instead of inheriting an entire vendor surface area.
 *
 * Zod schemas satisfy this interface structurally, so they can be passed directly
 * and still be composed with `z.object({...})` inside this package.
 */

/** The success branch of a non-throwing parse. */
export interface SafeParseSuccess<TOutput> {
  readonly success: true;
  readonly data: TOutput;
}

/** The failure branch of a non-throwing parse. */
export interface SafeParseFailure {
  readonly success: false;
  readonly error: unknown;
}

/** Discriminated result of {@link OmnisSchema.safeParse}. */
export type SafeParseResult<TOutput> = SafeParseSuccess<TOutput> | SafeParseFailure;

/**
 * The minimum capability OMNIS requires from a schema.
 *
 * `input` is `unknown` on purpose: everything reaching a validation boundary
 * (an HTTP body, an event payload, an environment variable) is untyped by
 * definition, and a schema that only accepts already-typed input cannot be the
 * thing that establishes the type.
 */
export interface OmnisSchema<TOutput> {
  /** Validates `input`, returning a result instead of throwing. */
  safeParse(input: unknown): SafeParseResult<TOutput>;
}

/** Infers the output type of an {@link OmnisSchema}. */
export type SchemaOutput<TSchema> = TSchema extends OmnisSchema<infer TOutput> ? TOutput : never;

/**
 * A schema bound to a stable contract identity.
 *
 * Every schema that crosses a process or team boundary should be described, so
 * that a failure names the contract that broke (`EventEnvelope@1.0.0`) instead of
 * an anonymous object. See docs/03-contracts/VERSIONING.md.
 */
export interface SchemaDescriptor<TOutput> {
  /** Stable identifier of the contract, e.g. `"EventEnvelope"`. */
  readonly contractId: string;
  /** The schema version the descriptor validates against. */
  readonly version?: string;
  /** The underlying schema. */
  readonly schema: OmnisSchema<TOutput>;
}

/** Attaches a stable contract identity to a schema. */
export function describeSchema<TOutput>(
  contractId: string,
  schema: OmnisSchema<TOutput>,
  version?: string,
): SchemaDescriptor<TOutput> {
  return { contractId, schema, ...(version === undefined ? {} : { version }) };
}

/** Renders the `contractId[@version]` label used in error messages. */
export function contractLabel(descriptor: SchemaDescriptor<unknown>): string {
  return descriptor.version === undefined
    ? descriptor.contractId
    : `${descriptor.contractId}@${descriptor.version}`;
}
