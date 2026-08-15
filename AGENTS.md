# OMNIS — AI Development Contract

## Purpose

OMNIS is an intelligent, autonomous, continuously learning operating system for digital media creation, management, publishing, audience intelligence, growth, and revenue, with a primary focus on YouTube and Instagram.

OMNIS also creates and manages persistent Digital Humans that act as virtual influencers with identity, personality, memory, knowledge, skills, habits, emotions, relationships, appearance continuity, goals, experience, and measurable growth.

## Source of Truth

Before changing architecture or behavior, read:

1. `docs/README.md`
2. `docs/SUMMARY.md`
3. `docs/ARCHITECTURE.md`
4. `docs/SYSTEM_SPEC.md`
5. `docs/AI_BUILD_GUIDE.md`
6. relevant domain specifications under `docs/domains/`
7. relevant ADRs under `docs/adr/`
8. relevant contracts under `docs/contracts/`

Code must implement the documented contracts. If code and specification disagree, do not silently choose one: document the discrepancy and resolve it through an ADR.

## Architectural Rules

- Preserve domain boundaries.
- Prefer explicit contracts over implicit coupling.
- New capabilities must normally be introduced as a module, agent, plugin, workflow, capability, or integration.
- Do not change core architecture casually.
- Events and APIs are versioned contracts.
- Character state must be persistent and time-aware.
- Character continuity must be deterministic from recorded state and events, not improvised per generation.
- Experience must be observable and able to update skills, knowledge, preferences, strategies, and behavior through controlled learning flows.
- Global learning must be validated before propagation to other characters.
- All autonomous actions must pass through policy and permission controls.
- External providers must be accessed through adapters/model routing, not hard-coded throughout domain logic.
- Secrets never belong in source code, logs, prompts, or client bundles.
- Every important autonomous action must be auditable.
- Tests and documentation are part of the implementation, not optional follow-up work.

## Implementation Sequence

1. Contracts
2. Domain models
3. Core kernel
4. Event infrastructure
5. Agent SDK and orchestration
6. Character runtime
7. Memory and knowledge
8. Workflow engine
9. Media pipeline
10. Social and audience systems
11. Analytics and learning
12. Studio UI
13. Infrastructure and scaling

## Definition of Done

A feature is not complete until:

- specification exists;
- contracts are defined;
- implementation exists;
- unit/integration tests exist;
- failure modes are handled;
- observability exists;
- security/policy behavior is defined;
- documentation is updated;
- CI is green.
