/**
 * Commands, command results and the human-approval gate.
 *
 * COMMANDS VS EVENTS
 * ------------------
 * An event states that something happened; it cannot be refused, only ignored. A
 * command asks for something to happen; it can be rejected, queued, rate-limited
 * or held for a human signature. Modelling both as "messages" would erase that
 * difference and make it impossible to express an approval gate at all.
 *
 * Commands are therefore point-to-point (one producer, one handler) and carry the
 * full {@link ExecutionContext}. Events are broadcast and carry a flattened
 * projection of it.
 *
 * THE APPROVAL GATE
 * -----------------
 * OMNIS is designed to operate autonomously, and most operations should. But
 * high-impact operations — publishing to a real audience, changing platform
 * account settings, spending money, altering a character's identity, sending
 * external communication — must be able to require a human signature.
 *
 * ```text
 * Agent request -> Policy evaluation -> Approval required?
 *                                          |          |
 *                                         no         yes
 *                                          |          |
 *                                       Execute   ApprovalRequest
 *                                                     |
 *                                            Human decision
 *                                                |        |
 *                                             approve    deny
 *                                                |        |
 *                                             Execute   Rejected
 * ```
 *
 * `CommandResult` encodes that gate as a first-class outcome: `"rejected"` with a
 * non-null `approval` means "not refused forever, awaiting a decision", which is
 * categorically different from `"failed"`. Conflating them would make a pending
 * approval look like an error and get retried or alerted on.
 */

import type { SerializedOmnisError } from "@omnis/errors";
import { ERROR_CODE_VALUES } from "@omnis/errors";
import type {
  ApprovalId,
  CommandId,
  CommandName,
  EventId,
  JsonObject,
  SemVer,
  TrimmedString,
  UtcTimestamp,
} from "@omnis/types";
import { createApprovalId, createCommandId, nowIso } from "@omnis/types";
import {
  commandNameSchema,
  identifierSchemas,
  isoDateTimeSchema,
  jsonObjectSchema,
  semVerSchema,
  trimmedStringSchema,
  validate,
  z,
} from "@omnis/validation";
import type { ActorContext, ExecutionContext, ServiceName } from "./context.js";
import { actorContextSchema, executionContextSchema, serviceNameSchema } from "./context.js";
import { CONTRACT_VERSION, formatContractId } from "./version.js";

/** Stable contract identifiers. */
export const COMMAND_CONTRACT_ID = "Command";
export const COMMAND_RESULT_CONTRACT_ID = "CommandResult";
export const APPROVAL_REQUEST_CONTRACT_ID = "ApprovalRequest";

// --- Serialized errors -----------------------------------------------------

/**
 * One level of a serialized error's cause chain.
 *
 * Deliberately non-recursive: a cause is validated either as a bare
 * `{ name?, message }` or as a full OMNIS error *without its own nested cause*.
 * Recursion here would require a mutually-recursive schema pair whose types
 * cannot be inferred without an explicit annotation, and an explicit
 * `z.ZodType<T>` annotation is not satisfiable by `z.object` because Zod's input
 * parameter is contravariant and an object schema's input is narrower than
 * `unknown`.
 *
 * The one-level bound is a real, documented limitation rather than an accident:
 * deeper chains still serialize and travel correctly, they are simply validated
 * as JSON rather than field-by-field past the first cause.
 */
const errorCauseSchema = z.union([
  z.object({
    name: z.string(),
    code: z.enum(ERROR_CODE_VALUES),
    message: z.string(),
    metadata: jsonObjectSchema,
    retryable: z.boolean(),
    retryAfterMs: z.number().int().nonnegative().optional(),
    occurredAt: isoDateTimeSchema,
    stack: z.string().optional(),
  }),
  z.object({ message: z.string(), name: z.string().optional() }),
]);

/** Schema for the serialized form of an `OmnisError`. */
export const serializedErrorSchema = z.object({
  name: z.string(),
  code: z.enum(ERROR_CODE_VALUES),
  message: z.string(),
  metadata: jsonObjectSchema,
  retryable: z.boolean(),
  retryAfterMs: z.number().int().nonnegative().optional(),
  occurredAt: isoDateTimeSchema,
  stack: z.string().optional(),
  cause: errorCauseSchema.optional(),
});

/** Validates an unknown value as a {@link SerializedOmnisError}. */
export function parseSerializedError(input: unknown): SerializedOmnisError {
  return validate(serializedErrorSchema, input, "SerializedOmnisError");
}

// --- Risk and approval -----------------------------------------------------

/** How consequential an action is, and therefore how much scrutiny it needs. */
export const RISK_LEVELS = ["low", "medium", "high", "critical"] as const;

/** One member of {@link RISK_LEVELS}. */
export type RiskLevel = (typeof RISK_LEVELS)[number];

/**
 * A request for a human decision on an autonomous action.
 *
 * Carries enough context for a person to decide without going hunting: what
 * policy raised it, why, how risky it is, who asked, and when the request stops
 * being valid. An approval that never expires is an approval that can be granted
 * long after the circumstances that justified it have changed.
 */
export type ApprovalRequest = {
  readonly id: ApprovalId;
  /** The policy that raised this gate. */
  readonly policyId: TrimmedString;
  /** Human-readable justification, written for the approver. */
  readonly reason: TrimmedString;
  readonly risk: RiskLevel;
  /** Who asked. Usually an agent, possibly acting on a user's behalf. */
  readonly requestedBy: ActorContext;
  readonly requestedAt: UtcTimestamp;
  /** `null` means the request does not expire, which policies should avoid. */
  readonly expiresAt: UtcTimestamp | null;
};

/** Schema for {@link ApprovalRequest}. */
export const approvalRequestSchema = z.object({
  id: identifierSchemas.approval,
  policyId: trimmedStringSchema,
  reason: trimmedStringSchema,
  risk: z.enum(RISK_LEVELS),
  requestedBy: actorContextSchema,
  requestedAt: isoDateTimeSchema,
  expiresAt: isoDateTimeSchema.nullable().default(null),
});

/** Validates an unknown value as an {@link ApprovalRequest}. */
export function parseApprovalRequest(input: unknown): ApprovalRequest {
  return validate(
    approvalRequestSchema,
    input,
    formatContractId(APPROVAL_REQUEST_CONTRACT_ID, CONTRACT_VERSION),
  );
}

/** Mints a new approval request. */
export function createApprovalRequest(
  input: Omit<ApprovalRequest, "id" | "requestedAt"> & { readonly requestedAt?: UtcTimestamp },
): ApprovalRequest {
  return { ...input, id: createApprovalId(), requestedAt: input.requestedAt ?? nowIso() };
}

// --- Commands --------------------------------------------------------------

/** A request to perform a state-changing operation. */
export type Command<TPayload extends JsonObject = JsonObject> = {
  readonly id: CommandId;
  /** Imperative dotted name, e.g. `content.production.start`. */
  readonly name: CommandName;
  readonly version: SemVer;
  readonly issuedAt: UtcTimestamp;
  /** The service that issued the command. */
  readonly source: ServiceName;
  readonly context: ExecutionContext;
  readonly payload: TPayload;
};

/** Schema for a {@link Command} carrying an arbitrary JSON payload. */
export const commandSchema = z.object({
  id: identifierSchemas.command,
  name: commandNameSchema,
  version: semVerSchema,
  issuedAt: isoDateTimeSchema,
  source: serviceNameSchema,
  context: executionContextSchema,
  payload: jsonObjectSchema,
});

/** Validates an unknown value as a {@link Command}. */
export function parseCommand(input: unknown): Command {
  return validate(commandSchema, input, formatContractId(COMMAND_CONTRACT_ID, CONTRACT_VERSION));
}

/** Everything a caller must supply to mint a command. */
export type NewCommand<TPayload extends JsonObject = JsonObject> = {
  readonly name: CommandName;
  readonly payload: TPayload;
  readonly source: ServiceName;
  readonly context: ExecutionContext;
  readonly version?: SemVer;
  readonly issuedAt?: UtcTimestamp;
};

/**
 * Mints a well-formed {@link Command}.
 *
 * `id` and `issuedAt` are generated here rather than at call sites so that a
 * command can never exist without an identity — which is what makes idempotent
 * handling and end-to-end tracing possible.
 */
export function createCommand<TPayload extends JsonObject = JsonObject>(
  input: NewCommand<TPayload>,
): Command<TPayload> {
  return {
    id: createCommandId(),
    name: input.name,
    version: input.version ?? CONTRACT_VERSION,
    issuedAt: input.issuedAt ?? nowIso(),
    source: input.source,
    context: input.context,
    payload: input.payload,
  };
}

// --- Results ---------------------------------------------------------------

/** The three possible outcomes of handling a command. */
export const COMMAND_RESULT_STATUSES = ["succeeded", "failed", "rejected"] as const;

/** One member of {@link COMMAND_RESULT_STATUSES}. */
export type CommandResultStatus = (typeof COMMAND_RESULT_STATUSES)[number];

/**
 * The outcome of handling a {@link Command}.
 *
 * A discriminated union on `status` so a caller cannot read `data` from a failed
 * result or ignore an approval that is waiting.
 */
export type CommandResult<TData extends JsonObject = JsonObject> =
  | {
      readonly status: "succeeded";
      readonly commandId: CommandId;
      readonly completedAt: UtcTimestamp;
      /** The handler's output. `{}` when the command is write-only. */
      readonly data: TData;
      /**
       * Events emitted as a consequence of this command.
       *
       * Returned to the caller so the whole unit of work can be committed or
       * dispatched atomically, rather than each event being published from deep
       * inside a handler where a partial failure would leave the system
       * inconsistent.
       */
      readonly emittedEventIds: readonly EventId[];
    }
  | {
      /** The handler ran and failed. Retriability is on `error.retryable`. */
      readonly status: "failed";
      readonly commandId: CommandId;
      readonly completedAt: UtcTimestamp;
      readonly error: SerializedOmnisError;
    }
  | {
      /**
       * The handler did not run: a policy gate stopped it.
       *
       * `approval` non-null means the action may proceed once a human decides.
       * `approval` null means the policy refused outright with no appeal path.
       */
      readonly status: "rejected";
      readonly commandId: CommandId;
      readonly completedAt: UtcTimestamp;
      readonly error: SerializedOmnisError;
      readonly approval: ApprovalRequest | null;
    };

/** Schema for a {@link CommandResult} carrying an arbitrary JSON payload. */
export const commandResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("succeeded"),
    commandId: identifierSchemas.command,
    completedAt: isoDateTimeSchema,
    data: jsonObjectSchema,
    emittedEventIds: z.array(identifierSchemas.event).default([]),
  }),
  z.object({
    status: z.literal("failed"),
    commandId: identifierSchemas.command,
    completedAt: isoDateTimeSchema,
    error: serializedErrorSchema,
  }),
  z.object({
    status: z.literal("rejected"),
    commandId: identifierSchemas.command,
    completedAt: isoDateTimeSchema,
    error: serializedErrorSchema,
    approval: approvalRequestSchema.nullable().default(null),
  }),
]);

/** Validates an unknown value as a {@link CommandResult}. */
export function parseCommandResult(input: unknown): CommandResult {
  return validate(
    commandResultSchema,
    input,
    formatContractId(COMMAND_RESULT_CONTRACT_ID, CONTRACT_VERSION),
  );
}

/** True when the result is waiting on a human decision. */
export function isAwaitingApproval(result: CommandResult): boolean {
  return result.status === "rejected" && result.approval !== null;
}
