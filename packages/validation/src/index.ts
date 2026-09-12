/**
 * `@omnis/validation` — the single runtime validation layer for OMNIS.
 *
 * WHY ONE TECHNOLOGY
 * ------------------
 * Every externally meaningful OMNIS contract is validated at runtime: event
 * payloads from third-party webhooks, commands from the API, configuration from
 * the environment, responses from model providers. TypeScript types are erased at
 * runtime and cannot do this job.
 *
 * Running two schema libraries across the monorepo means two error shapes, two
 * coercion behaviours and two sets of subtle differences in how `undefined`,
 * `null` and unknown keys are handled — a permanent source of integration bugs.
 * Zod is the single sanctioned choice.
 *
 * WHY THIS PACKAGE IS THE ONLY ONE THAT IMPORTS ZOD
 * -------------------------------------------------
 * `z` is re-exported here so that every other package and service writes
 * `import { z } from "@omnis/validation"` instead of `from "zod"`. That makes the
 * "one validation technology" rule mechanically enforceable: the architecture
 * tests reject a direct `zod` import from anywhere except this package, so the
 * vendor is contained behind exactly one module boundary and can be upgraded —
 * or replaced — by changing one package.
 *
 * WHY A WRAPPER AROUND `parse`
 * ----------------------------
 * Raw `schema.parse()` throws a vendor error. Letting that escape would couple
 * every caller to the vendor and would produce an error that OMNIS retry
 * policies, HTTP adapters and log redaction do not understand. This module
 * converts failures into {@link ValidationError} carrying normalised
 * {@link ValidationIssue} records, so the rest of the platform only ever sees
 * OMNIS types.
 *
 * INVARIANT
 * ---------
 * A value that has passed a schema parse is trusted for its *shape*, never for
 * its *meaning*. Authorization, policy evaluation and domain invariants are
 * checked separately, after validation.
 */

import { ValidationError, type ValidationIssue } from "@omnis/errors";
import type { ParseResult } from "@omnis/types";
import { parseFailure, parseSuccess } from "@omnis/types";
import { summariseIssues, toValidationIssues } from "./issues.js";
import { contractLabel, type OmnisSchema, type SchemaDescriptor } from "./schema.js";

// The sanctioned entry point to the validation vendor. Import `z` from here,
// never from "zod", outside this package.
export { z } from "zod";

export { summariseIssues, toValidationIssues } from "./issues.js";
// Re-exported so a consumer can name the type that `toValidationIssues` returns
// without taking a second dependency on `@omnis/errors`. The type is defined there
// because the error hierarchy owns it; this is a naming convenience, not a second
// source of truth.
export type { ValidationIssue } from "@omnis/errors";
export {
  contractLabel,
  describeSchema,
  type OmnisSchema,
  type SafeParseFailure,
  type SafeParseResult,
  type SafeParseSuccess,
  type SchemaDescriptor,
  type SchemaOutput,
} from "./schema.js";
export {
  attributesSchema,
  causationIdSchema,
  commandNameSchema,
  emailAddressSchema,
  environmentSchema,
  eventTypeSchema,
  identifierSchema,
  identifierSchemas,
  isoDateTimeSchema,
  jsonObjectSchema,
  jsonValueSchema,
  languageTagSchema,
  logFormatSchema,
  logLevelSchema,
  nonEmptyStringSchema,
  percentageSchema,
  ratioSchema,
  semVerSchema,
  serviceNameSchema,
  socialPlatformSchema,
  trimmedStringSchema,
  uriSchema,
  utcTimestampSchema,
} from "./primitives.js";

/**
 * Validates without throwing.
 *
 * Preferred at boundaries that handle untrusted input in bulk — comment
 * ingestion, webhook receivers, event consumers — where one malformed record
 * must not abort the whole batch.
 */
export function tryValidate<TOutput>(
  schema: OmnisSchema<TOutput>,
  input: unknown,
): ParseResult<TOutput> {
  const result = schema.safeParse(input);
  if (result.success) {
    return parseSuccess(result.data);
  }
  return parseFailure(summariseIssues(toValidationIssues(result.error)));
}

/**
 * Validates, throwing {@link ValidationError} on failure.
 *
 * Preferred where invalid input means the caller has already broken a contract —
 * command handlers, configuration loading, internal service calls.
 */
export function validate<TOutput>(
  schema: OmnisSchema<TOutput>,
  input: unknown,
  contractId = "schema",
): TOutput {
  const result = schema.safeParse(input);
  if (result.success) {
    return result.data;
  }

  const issues: ValidationIssue[] = toValidationIssues(result.error);
  throw new ValidationError(`${contractId} validation failed: ${summariseIssues(issues)}`, {
    issues,
    retryable: false,
  });
}

/** Validates against a {@link SchemaDescriptor}, naming the contract in the error. */
export function validateContract<TOutput>(
  descriptor: SchemaDescriptor<TOutput>,
  input: unknown,
): TOutput {
  return validate(descriptor.schema, input, contractLabel(descriptor));
}

/** Non-throwing variant of {@link validateContract}. */
export function tryValidateContract<TOutput>(
  descriptor: SchemaDescriptor<TOutput>,
  input: unknown,
): ParseResult<TOutput> {
  return tryValidate(descriptor.schema, input);
}

/**
 * Type-guard form of validation, for `filter` and narrowing chains.
 *
 * Note that a guard discards the failure reason, so it belongs in filtering code
 * and not at a trust boundary where the reason must be reported.
 */
export function isValid<TOutput>(schema: OmnisSchema<TOutput>, input: unknown): input is TOutput {
  return schema.safeParse(input).success;
}
