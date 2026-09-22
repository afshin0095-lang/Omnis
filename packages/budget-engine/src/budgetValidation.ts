/**
 * Validation schemas for budgets, reservations and ledger snapshots.
 *
 * Money is the one place where a permissive parser is actively dangerous: a limit that
 * arrives as `1.5` (USD? micro-USD? a typo?) must be rejected at registration rather than
 * interpreted at spend time. Every amount here is a non-negative finite integer, and the
 * schemas are also the published contracts, so what the ledger stores and what the events
 * promise are one definition.
 */

import {
  AI_CORE_CONTRACT_VERSION,
  BUDGET_DIMENSIONS,
  BUDGET_STATUSES,
  BUDGET_WINDOWS,
  MAX_BUDGET_LIMITS,
  RESERVATION_STATES,
} from "@omnis/ai-core-types";
import type {
  Budget,
  BudgetDimension,
  BudgetHold,
  BudgetStatus,
  BudgetWindow,
  ExecutionId,
  ReservationState,
} from "@omnis/ai-core-types";
import {
  describeSchema,
  identifierSchemas,
  jsonObjectSchema,
  nonEmptyStringSchema,
  z,
} from "@omnis/validation";

/** Maximum length of an idempotency key. */
export const MAX_RESERVATION_KEY_LENGTH = 191;

/** Schema for a non-negative integer amount: tokens, requests, milliseconds, micro-USD. */
export const integerAmountSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** Schema for one budget dimension. */
export const budgetDimensionSchema = z.enum(BUDGET_DIMENSIONS);

/** Schema for one budget window. */
export const budgetWindowSchema = z.enum(BUDGET_WINDOWS);

/** Schema for one budget status. */
export const budgetStatusSchema = z.enum(BUDGET_STATUSES);

/** Schema for one reservation state. */
export const reservationStateSchema = z.enum(RESERVATION_STATES);

/** Schema for a single limit. */
export const budgetLimitSchema = z.object({
  dimension: budgetDimensionSchema,
  window: budgetWindowSchema,
  limit: integerAmountSchema,
  enforcement: z.enum(["hard", "soft"]),
});

/**
 * Schema for a limit as supplied at registration.
 *
 * `enforcement` is optional on the way in and always present on the stored limit, defaulting to
 * hard: an operator who forgets to say how a limit is enforced gets the behaviour that cannot
 * silently overspend.
 */
export const budgetLimitInputSchema = budgetLimitSchema
  .omit({ enforcement: true })
  .extend({ enforcement: z.enum(["hard", "soft"]).optional() });

/** Schema for a stored budget. */
export const budgetSchema = z.object({
  id: identifierSchemas.budget,
  name: nonEmptyStringSchema,
  description: z.string().max(1024),
  status: budgetStatusSchema,
  limits: z.array(budgetLimitSchema).max(MAX_BUDGET_LIMITS),
  tenantId: identifierSchemas.tenant.nullable(),
  policyId: identifierSchemas.policy.nullable(),
  metadata: jsonObjectSchema,
  createdAt: z.string().datetime(),
  version: z.number().int().min(1),
});

/** A budget as supplied at registration. */
export const budgetInputSchema = z.object({
  id: identifierSchemas.budget.optional(),
  name: nonEmptyStringSchema,
  description: z.string().max(1024).optional(),
  status: budgetStatusSchema.optional(),
  limits: z.array(budgetLimitInputSchema).max(MAX_BUDGET_LIMITS),
  tenantId: identifierSchemas.tenant.nullish(),
  policyId: identifierSchemas.policy.nullish(),
  metadata: jsonObjectSchema.optional(),
  createdAt: z.string().datetime().optional(),
});

/** Schema for one hold. */
export const budgetHoldSchema = z.object({
  dimension: budgetDimensionSchema,
  amount: integerAmountSchema,
});

/** Schema for an idempotency key: opaque, bounded, never empty. */
export const reservationKeySchema = z.string().min(1).max(MAX_RESERVATION_KEY_LENGTH);

/** Schema for a reservation request. */
export const reserveRequestSchema = z.object({
  budgetId: identifierSchemas.budget,
  executionId: identifierSchemas.execution,
  key: reservationKeySchema,
  holds: z.array(budgetHoldSchema).min(1).max(MAX_BUDGET_LIMITS),
  sessionId: z.string().min(1).max(191).nullish(),
});

/** Schema for a stored reservation. */
export const budgetReservationSchema = z.object({
  id: identifierSchemas.reservation,
  budgetId: identifierSchemas.budget,
  executionId: identifierSchemas.execution,
  key: reservationKeySchema,
  holds: z.array(budgetHoldSchema),
  state: reservationStateSchema,
  committed: z.array(budgetHoldSchema),
  createdAt: z.string().datetime(),
  committedAt: z.string().datetime().nullable(),
  releasedAt: z.string().datetime().nullable(),
});

/** Schema for a ledger snapshot. */
export const budgetUsageSchema = z.object({
  budgetId: identifierSchemas.budget,
  committed: z.array(budgetHoldSchema),
  reserved: z.array(budgetHoldSchema),
  window: budgetWindowSchema,
  windowStartedAt: z.string().datetime(),
  observedAt: z.string().datetime(),
});

/** Schema for a pre-work check result. */
export const budgetCheckResultSchema = z.object({
  allowed: z.boolean(),
  blockingDimension: budgetDimensionSchema.nullable(),
  requested: integerAmountSchema,
  available: integerAmountSchema,
  reason: z.string().nullish(),
  softLimitExceeded: z.boolean(),
});

/** The budget contract. */
export const BUDGET_CONTRACT = describeSchema("Budget", budgetSchema, AI_CORE_CONTRACT_VERSION);

/** The reservation contract. */
export const BUDGET_RESERVATION_CONTRACT = describeSchema(
  "BudgetReservation",
  budgetReservationSchema,
  AI_CORE_CONTRACT_VERSION,
);

/** The ledger snapshot contract. */
export const BUDGET_USAGE_CONTRACT = describeSchema(
  "BudgetUsage",
  budgetUsageSchema,
  AI_CORE_CONTRACT_VERSION,
);

/** The check result contract. */
export const BUDGET_CHECK_CONTRACT = describeSchema(
  "BudgetCheckResult",
  budgetCheckResultSchema,
  AI_CORE_CONTRACT_VERSION,
);

/** A budget as supplied at registration. */
export interface BudgetInput {
  readonly id?: Budget["id"];
  readonly name: string;
  readonly description?: string;
  readonly status?: BudgetStatus;
  readonly limits: readonly BudgetLimitInput[];
  readonly tenantId?: Budget["tenantId"];
  readonly policyId?: Budget["policyId"];
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly createdAt?: string;
}

/** A limit as supplied at registration. `enforcement` defaults to hard. */
export interface BudgetLimitInput {
  readonly dimension: BudgetDimension;
  readonly window: BudgetWindow;
  readonly limit: number;
  readonly enforcement?: "hard" | "soft";
}

/** A reservation request. */
export interface ReserveRequest {
  readonly budgetId: Budget["id"];
  readonly executionId: ExecutionId;
  readonly key: string;
  readonly holds: readonly BudgetHold[];
  /** Session bucket for `session`-windowed limits. Falls back to the execution. */
  readonly sessionId?: string | null;
}

/** True when the value names a budget dimension. */
export function isBudgetDimensionValue(value: string): value is BudgetDimension {
  return budgetDimensionSchema.safeParse(value).success;
}

/** True when the value names a reservation state. */
export function isReservationStateValue(value: string): value is ReservationState {
  return reservationStateSchema.safeParse(value).success;
}
