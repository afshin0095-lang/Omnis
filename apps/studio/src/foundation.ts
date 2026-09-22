/**
 * What the workspace actually ships, in two groups.
 *
 * Both lists are displayed on the Studio's welcome surface, so both have to be true.
 * `src/__tests__/foundation.test.ts` reads the workspace and asserts that the two groups
 * together account for every package that exists, and that nothing is described that
 * does not — which turns "the caption went stale" from a thing someone eventually
 * notices into a failing test.
 *
 * The split is architectural rather than cosmetic. The foundation is what every bounded
 * context is allowed to build on: identifiers, errors, validation, contracts, events,
 * configuration, logging, telemetry, theme and interface primitives. The AI Core is the
 * first bounded context built on it, and it is listed separately because a reader who
 * cannot tell the shared base from one domain will eventually import the domain from
 * somewhere that should only ever see the base.
 *
 * What is still absent is deliberate: the remaining services named in the target
 * architecture are declared in the event registry and the domain docs, but they are not
 * implemented, and presenting them as running would be a claim the repository cannot
 * support.
 */

/** Shared foundation packages delivered in Sprint 0, in dependency order. */
export const FOUNDATION_PACKAGES = [
  "@omnis/types",
  "@omnis/errors",
  "@omnis/validation",
  "@omnis/contracts",
  "@omnis/events",
  "@omnis/config",
  "@omnis/logging",
  "@omnis/telemetry",
  "@omnis/theme",
  "@omnis/ui",
] as const;

/** One member of {@link FOUNDATION_PACKAGES}. */
export type FoundationPackage = (typeof FOUNDATION_PACKAGES)[number];

/** A one-line description of each package, for the inspector surface. */
export const FOUNDATION_DESCRIPTIONS: Readonly<Record<FoundationPackage, string>> = {
  "@omnis/types": "Branded identifiers, primitives and the shared vocabulary.",
  "@omnis/errors": "The OmnisError hierarchy, with redaction at construction.",
  "@omnis/validation": "Zod schemas, exposed as the only validation entry point.",
  "@omnis/contracts": "Event envelopes, commands, approvals and actor context.",
  "@omnis/events": "The event registry and an in-memory bus.",
  "@omnis/config": "Typed, environment-sensitive configuration and secrets.",
  "@omnis/logging": "Structured logging behind a provider-independent interface.",
  "@omnis/telemetry": "Metric and tracing contracts, with validating no-ops.",
  "@omnis/theme": "Design tokens and themes, as pure serializable data.",
  "@omnis/ui": "Accessible React primitives and the theme provider.",
};

/** AI Core packages delivered in Sprint 1, in dependency order. */
export const AI_CORE_PACKAGES = [
  "@omnis/ai-core-types",
  "@omnis/execution-context",
  "@omnis/model-registry",
  "@omnis/provider-registry",
  "@omnis/policy-engine",
  "@omnis/budget-engine",
  "@omnis/tool-runtime",
  "@omnis/execution-kernel",
  "@omnis/model-orchestrator",
  "@omnis/ai-evaluation",
  "@omnis/agent-runtime",
  "@omnis/ai-core-runtime",
] as const;

/** One member of {@link AI_CORE_PACKAGES}. */
export type AiCorePackage = (typeof AI_CORE_PACKAGES)[number];

/** A one-line description of each AI Core package, for the inspector surface. */
export const AI_CORE_DESCRIPTIONS: Readonly<Record<AiCorePackage, string>> = {
  "@omnis/ai-core-types":
    "The AI Core's vocabulary: models, providers, agents, tools, policies and budgets.",
  "@omnis/execution-context":
    "Cancellation, deadlines and child scopes, carried through every execution.",
  "@omnis/model-registry": "Immutable model descriptors, resolved by id, slug or capability.",
  "@omnis/provider-registry":
    "Provider adapters, lifecycle states and the scoring that orders candidates.",
  "@omnis/policy-engine":
    "Deterministic policy decisions, where a denial outranks every allowance.",
  "@omnis/budget-engine": "Integer micro-USD budgets, reserved before work and settled after it.",
  "@omnis/tool-runtime":
    "Tool calls behind permission and policy checks, with timeouts and audit rows.",
  "@omnis/execution-kernel":
    "Sequential steps with dependencies, hooks, cancellation and deadlines.",
  "@omnis/model-orchestrator":
    "The model call pipeline: selection, retries, fallbacks and settlement.",
  "@omnis/ai-evaluation":
    "Rule-based evaluation of executions, with no model judging another model.",
  "@omnis/agent-runtime":
    "The agent state machine and its plans, never calling a provider directly.",
  "@omnis/ai-core-runtime":
    "The composition: one runtime wiring registries, governance and execution.",
};
