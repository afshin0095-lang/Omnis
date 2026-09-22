/**
 * Shared constants and hard limits for the AI Core.
 *
 * WHY limits live in one module
 * -----------------------------
 * Every limit in the AI Core is a resource-exhaustion guard: an unbounded plan,
 * an unbounded retry loop, an unbounded message array or an unbounded metadata
 * object is how a runaway agent turns into an unbounded bill or a hung kernel.
 * Declaring them once means (a) the kernel, the orchestrator and the runtimes
 * enforce the *same* number, and (b) a test can assert the number instead of
 * restating it.
 *
 * All of these are values, not configuration: changing one is a contract change
 * and must go through an ADR, because downstream behavior (retry counts, plan
 * size, fallback depth) is specified against them.
 */

import type { JsonObject } from "@omnis/types";

/**
 * Contract version of the AI Core surface.
 *
 * Independent of {@link CONTRACT_VERSION} in `@omnis/contracts` on purpose: the
 * envelope vocabulary and the AI execution vocabulary evolve at different rates,
 * and a model-descriptor change must not silently claim a new event contract.
 */
export const AI_CORE_CONTRACT_VERSION = "1.0.0";

/**
 * Micro-USD per USD.
 *
 * Money in the AI Core is always an integer number of micro-USD. Floating point
 * money accumulates rounding error across reservations and commits, and a budget
 * that drifts by fractions of a cent per call eventually reports a false
 * "exhausted" — or worse, a false "available". Integer minor units make the
 * ledger exact and make equality checks meaningful.
 */
export const MICRO_USD_PER_USD = 1_000_000;

/** Prefix for every AI Core telemetry attribute, e.g. `omnis.ai.execution.id`. */
export const AI_TELEMETRY_PREFIX = "omnis.ai";

/** Default wall-clock budget for one execution when the caller sets none. */
export const DEFAULT_EXECUTION_TIMEOUT_MS = 30_000;

/** Default wall-clock budget for one model invocation. */
export const DEFAULT_MODEL_TIMEOUT_MS = 20_000;

/** Default wall-clock budget for one tool invocation. */
export const DEFAULT_TOOL_TIMEOUT_MS = 10_000;

/** Upper bound on the number of steps in a single execution plan. */
export const MAX_PLAN_STEPS = 64;

/** Upper bound on the number of dependencies one step may declare. */
export const MAX_STEP_DEPENDENCIES = 8;

/**
 * Upper bound on retry attempts for one step.
 *
 * Three attempts (the original plus two retries) is the point past which a retry
 * loop stops being recovery and starts being denial: a provider that failed three
 * times within one deadline is not coming back inside that deadline.
 */
export const MAX_RETRY_ATTEMPTS = 3;

/** Upper bound on how many fallback candidates the orchestrator may consider. */
export const MAX_FALLBACK_CANDIDATES = 5;

/** Upper bound on messages in one model request. */
export const MAX_REQUEST_MESSAGES = 256;

/** Upper bound on content parts in one message. */
export const MAX_CONTENT_PARTS = 32;

/** Upper bound on tool calls a single model response may request. */
export const MAX_TOOL_CALLS_PER_RESPONSE = 8;

/** Upper bound on entries in one metadata bag. */
export const MAX_METADATA_ENTRIES = 64;

/** Upper bound on nesting depth accepted by the JSON-safety assertion. */
export const MAX_JSON_SAFE_DEPTH = 32;

/** Upper bound on tool descriptors attached to one model request. */
export const MAX_REQUEST_TOOLS = 32;

/** Upper bound on rules in one policy set. */
export const MAX_POLICY_RULES = 64;

/** Upper bound on limits in one budget. */
export const MAX_BUDGET_LIMITS = 16;

/** Upper bound on evaluation rules applied to one execution. */
export const MAX_EVALUATION_RULES = 32;

/**
 * The metadata shape every AI Core record carries.
 *
 * Typed as a readonly {@link JsonObject} so records can be serialized into events
 * and telemetry without a conversion step — and so the JSON-safety assertion is a
 * real invariant rather than a hope.
 */
export type AiCoreMetadata = Readonly<JsonObject>;

/** An empty metadata bag, reused instead of allocating a new object per record. */
export const EMPTY_METADATA: AiCoreMetadata = Object.freeze({});
