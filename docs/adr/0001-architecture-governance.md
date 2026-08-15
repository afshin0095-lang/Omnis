# ADR-0001: OMNIS Architecture Governance

- Status: Accepted
- Version: 1.0

## Decision

OMNIS uses a documentation-first, contract-first architecture. The architecture is organized into explicit domains with clear ownership and cross-domain contracts.

The current architecture baseline is stable. New functionality should be introduced as a module, agent, plugin, capability, workflow or integration unless the change genuinely requires a domain boundary change.

## Why

OMNIS is intended to be developed over a long period by humans and multiple AI coding agents. Explicit architecture and contracts reduce context loss, accidental coupling and incompatible implementations.

## Consequences

- Documentation becomes part of the source of truth.
- Architecture changes require ADRs.
- APIs and events are versioned.
- Domain ownership must remain explicit.
- AI agents must inspect specifications before coding.
