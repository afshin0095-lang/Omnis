/**
 * `@omnis/contracts` — the cross-domain contract foundation for OMNIS.
 *
 * This package defines *what* crosses a boundary: event envelopes, commands,
 * results, execution context and the approval gate. It deliberately contains no
 * domain behaviour, no transport, no storage and no provider knowledge.
 *
 * Dependencies: `@omnis/types` (primitives), `@omnis/errors` (serialized error
 * shape), `@omnis/validation` (runtime schemas). It must never depend on a
 * service, an app, or a specific event type — those live in `@omnis/events` and
 * in the owning domains.
 */

export {
  ACTOR_KINDS,
  actorContextSchema,
  executionContextSchema,
  isAutonomousActor,
  isHumanActor,
  isProductionContext,
  parseActorContext,
  parseExecutionContext,
  parseTenantContext,
  serviceActor,
  serviceNameSchema,
  SYSTEM_ACTOR,
  tenantContextSchema,
} from "./context.js";
export type {
  ActorContext,
  ActorKind,
  ExecutionContext,
  ServiceName,
  TenantContext,
} from "./context.js";

export {
  assertInterpretableVersion,
  createCausedEvent,
  createEvent,
  EVENT_ENVELOPE_CONTRACT_ID,
  EVENT_SCOPES,
  eventEnvelopeSchema,
  parseEventEnvelope,
} from "./envelope.js";
export type { EventEnvelope, EventScope, NewEvent } from "./envelope.js";

export {
  APPROVAL_REQUEST_CONTRACT_ID,
  approvalRequestSchema,
  COMMAND_CONTRACT_ID,
  COMMAND_RESULT_CONTRACT_ID,
  COMMAND_RESULT_STATUSES,
  commandResultSchema,
  commandSchema,
  createApprovalRequest,
  createCommand,
  isAwaitingApproval,
  parseApprovalRequest,
  parseCommand,
  parseCommandResult,
  parseSerializedError,
  RISK_LEVELS,
  serializedErrorSchema,
} from "./command.js";
export type {
  ApprovalRequest,
  Command,
  CommandResult,
  CommandResultStatus,
  NewCommand,
  RiskLevel,
} from "./command.js";

export {
  isDomainEvent,
  isEventScope,
  isIntegrationEvent,
  promoteToIntegrationEvent,
  toDomainEvent,
} from "./events.js";
export type { DomainEvent, IntegrationEvent } from "./events.js";

export {
  classifyVersionChange,
  CONTRACT_CHANGE_KINDS,
  CONTRACT_VERSION,
  formatContractId,
  isBackwardsCompatible,
  nextVersion,
} from "./version.js";
export type { ContractChangeKind } from "./version.js";
