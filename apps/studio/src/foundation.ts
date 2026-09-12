/**
 * What Sprint 0 actually shipped.
 *
 * This list is displayed on the Studio's welcome surface, so it has to be true.
 * `src/__tests__/foundation.test.ts` reads the workspace and asserts that these names
 * match the packages that exist — which turns "the caption went stale" from a thing
 * someone eventually notices into a failing test.
 *
 * It lists the shared packages, not the bounded contexts: the services named in the
 * target architecture are declared in the event registry and the domain docs, but
 * they are not implemented yet, and presenting them as running would be a claim the
 * repository cannot support.
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
