# OMNIS Documentation Map

Every document in the repository, in reading order. A document that is not listed here is
not discoverable, and `pnpm verify:workspace` fails on one that is missing — so this file is
kept in step with the tree by a gate rather than by memory.

**New here?** Read [README.md](README.md), then
[01-architecture/ARCHITECTURE.md](01-architecture/ARCHITECTURE.md), then
[01-architecture/PLATFORM_FOUNDATION.md](01-architecture/PLATFORM_FOUNDATION.md).
**Changing code?** Read [../AGENTS.md](../AGENTS.md) and
[05-implementation/DEVELOPMENT_WORKFLOW.md](05-implementation/DEVELOPMENT_WORKFLOW.md).

## 00 — Foundation

| Document                                 | What it settles                                             |
| ---------------------------------------- | ----------------------------------------------------------- |
| [README.md](README.md)                   | What OMNIS is, and how the documentation is organised       |
| [PROJECT_STATUS.md](PROJECT_STATUS.md)   | The authoritative snapshot of what exists right now         |
| [ROADMAP.md](ROADMAP.md)                 | What is built, what is next, and in what order              |
| [GLOSSARY.md](GLOSSARY.md)               | Canonical terminology — one name per concept                |
| [../README.md](../README.md)             | Repository entry point: quickstart, package map, invariants |
| [../AGENTS.md](../AGENTS.md)             | The development contract for humans and coding agents       |
| [../CHANGELOG.md](../CHANGELOG.md)       | Notable changes, per Sprint                                 |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | Rules, gates and conventions for contributions              |
| [../SECURITY.md](../SECURITY.md)         | Vulnerability reporting and the security boundary summary   |

## 01 — Architecture

| Document                                                                               | What it settles                                                          |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| [01-architecture/ARCHITECTURE.md](01-architecture/ARCHITECTURE.md)                     | Domains, layers, cross-cutting rules, the canonical experience loop      |
| [01-architecture/PLATFORM_FOUNDATION.md](01-architecture/PLATFORM_FOUNDATION.md)       | Packages, dependency layering, module system, strictness, gates          |
| [01-architecture/EVENT_ARCHITECTURE.md](01-architecture/EVENT_ARCHITECTURE.md)         | Event grammar, ownership map, envelope, registry, delivery semantics     |
| [01-architecture/SECURITY_BOUNDARIES.md](01-architecture/SECURITY_BOUNDARIES.md)       | Redaction, personal data, tenancy, approval gates, telemetry cardinality |
| [01-architecture/AI_CORE_ARCHITECTURE.md](01-architecture/AI_CORE_ARCHITECTURE.md)     | Sprint 1 AI Core package map, layers, pipeline, invariants               |
| [01-architecture/AI_CORE_CONTRACTS.md](01-architecture/AI_CORE_CONTRACTS.md)           | Index of AI Core contract documents                                      |
| [01-architecture/AI_CORE_RUNTIME.md](01-architecture/AI_CORE_RUNTIME.md)               | Composition root façade, health, wiring rules                            |
| [01-architecture/AI_AGENT_RUNTIME.md](01-architecture/AI_AGENT_RUNTIME.md)             | Agent lifecycle, planning, events                                        |
| [01-architecture/AI_MODEL_ORCHESTRATION.md](01-architecture/AI_MODEL_ORCHESTRATION.md) | Model call pipeline, fallback, streaming                                 |
| [01-architecture/AI_EXECUTION_KERNEL.md](01-architecture/AI_EXECUTION_KERNEL.md)       | Planned step execution, recording, failures                              |

## 02 — Domain Model

| Document                                                                 | What it settles                                       |
| ------------------------------------------------------------------------ | ----------------------------------------------------- |
| [02-domain-model/DOMAIN_TAXONOMY.md](02-domain-model/DOMAIN_TAXONOMY.md) | The domain map and what each domain owns              |
| [02-domain-model/AGENT_MESH.md](02-domain-model/AGENT_MESH.md)           | Agent mesh model: registry, orchestration, evaluation |

## 03 — Contracts

| Document                                                       | What it settles                                                  |
| -------------------------------------------------------------- | ---------------------------------------------------------------- |
| [03-contracts/IDENTIFIERS.md](03-contracts/IDENTIFIERS.md)     | Identifier format, the twenty kinds, invariants, adding a kind   |
| [03-contracts/VERSIONING.md](03-contracts/VERSIONING.md)       | Compatibility rules, vocabulary governance, deprecation timeline |
| [03-contracts/AI_CORE_TYPES.md](03-contracts/AI_CORE_TYPES.md) | AI vocabulary: models, agents, tools, executions, failures       |
| [03-contracts/AI_EXECUTION.md](03-contracts/AI_EXECUTION.md)   | Execution scopes, kernel, statuses, results                      |
| [03-contracts/AI_MODELS.md](03-contracts/AI_MODELS.md)         | Model references, descriptors, registry                          |
| [03-contracts/AI_PROVIDERS.md](03-contracts/AI_PROVIDERS.md)   | Provider adapters, lifecycle, selection                          |
| [03-contracts/AI_AGENTS.md](03-contracts/AI_AGENTS.md)         | Agent descriptors, state machine, planning                       |
| [03-contracts/AI_TOOLS.md](03-contracts/AI_TOOLS.md)           | Tool descriptors, gated invocation                               |
| [03-contracts/AI_POLICIES.md](03-contracts/AI_POLICIES.md)     | Policy decisions, precedence, fail-closed gate                   |
| [03-contracts/AI_BUDGETS.md](03-contracts/AI_BUDGETS.md)       | Micro-USD budgets, reservations, windows                         |
| [03-contracts/AI_EVALUATION.md](03-contracts/AI_EVALUATION.md) | Deterministic rule-based evaluation                              |

## 04 — Specifications

Domain and subsystem specifications. These describe intended behaviour; where a subsystem is
not yet implemented, [PROJECT_STATUS.md](PROJECT_STATUS.md) says so explicitly.

- [04-specifications/AGENT_REGISTRY_SPEC.md](04-specifications/AGENT_REGISTRY_SPEC.md)
- [04-specifications/AGENT_RUNTIME_AND_MULTI_AGENT_SPEC.md](04-specifications/AGENT_RUNTIME_AND_MULTI_AGENT_SPEC.md)
- [04-specifications/AGENT_RUNTIME_AND_ORCHESTRATION_SPEC.md](04-specifications/AGENT_RUNTIME_AND_ORCHESTRATION_SPEC.md)
- [04-specifications/AGENT_RUNTIME_SPEC.md](04-specifications/AGENT_RUNTIME_SPEC.md)
- [04-specifications/APPEARANCE_CONTINUITY_ENGINE_SPEC.md](04-specifications/APPEARANCE_CONTINUITY_ENGINE_SPEC.md)
- [04-specifications/AUDIENCE_INTELLIGENCE_AND_COMMUNITY_ENGINE_SPEC.md](04-specifications/AUDIENCE_INTELLIGENCE_AND_COMMUNITY_ENGINE_SPEC.md)
- [04-specifications/AUDIENCE_INTELLIGENCE_ENGINE_SPEC.md](04-specifications/AUDIENCE_INTELLIGENCE_ENGINE_SPEC.md)
- [04-specifications/AUDIENCE_INTELLIGENCE_SPEC.md](04-specifications/AUDIENCE_INTELLIGENCE_SPEC.md)
- [04-specifications/CHARACTER_OS_SPEC.md](04-specifications/CHARACTER_OS_SPEC.md)
- [04-specifications/CONTENT_FACTORY_AND_PRODUCTION_ENGINE_SPEC.md](04-specifications/CONTENT_FACTORY_AND_PRODUCTION_ENGINE_SPEC.md)
- [04-specifications/CONTENT_FACTORY_SPEC.md](04-specifications/CONTENT_FACTORY_SPEC.md)
- [04-specifications/CONTENT_RESEARCH_AND_DISCOVERY_ENGINE_SPEC.md](04-specifications/CONTENT_RESEARCH_AND_DISCOVERY_ENGINE_SPEC.md)
- [04-specifications/CONTENT_STRATEGY_AND_EDITORIAL_PLANNING_ENGINE_SPEC.md](04-specifications/CONTENT_STRATEGY_AND_EDITORIAL_PLANNING_ENGINE_SPEC.md)
- [04-specifications/DATA_ARCHITECTURE_SPEC.md](04-specifications/DATA_ARCHITECTURE_SPEC.md)
- [04-specifications/DIGITAL_HUMAN_AND_CHARACTER_GENERATION_ENGINE_SPEC.md](04-specifications/DIGITAL_HUMAN_AND_CHARACTER_GENERATION_ENGINE_SPEC.md)
- [04-specifications/DIGITAL_HUMAN_SIMULATION_ENGINE_SPEC.md](04-specifications/DIGITAL_HUMAN_SIMULATION_ENGINE_SPEC.md)
- [04-specifications/EMOTION_AND_AFFECTIVE_STATE_ENGINE_SPEC.md](04-specifications/EMOTION_AND_AFFECTIVE_STATE_ENGINE_SPEC.md)
- [04-specifications/EVENT_BUS_AND_WORKFLOW_SPEC.md](04-specifications/EVENT_BUS_AND_WORKFLOW_SPEC.md)
- [04-specifications/KNOWLEDGE_AND_EXPERTISE_ENGINE_SPEC.md](04-specifications/KNOWLEDGE_AND_EXPERTISE_ENGINE_SPEC.md)
- [04-specifications/KNOWLEDGE_AND_LEARNING_ENGINE_SPEC.md](04-specifications/KNOWLEDGE_AND_LEARNING_ENGINE_SPEC.md)
- [04-specifications/MEDIA_GENERATION_ENGINE_SPEC.md](04-specifications/MEDIA_GENERATION_ENGINE_SPEC.md)
- [04-specifications/MEMORY_ARCHITECTURE_SPEC.md](04-specifications/MEMORY_ARCHITECTURE_SPEC.md)
- [04-specifications/MEMORY_MESH_SPEC.md](04-specifications/MEMORY_MESH_SPEC.md)
- [04-specifications/MODEL_ORCHESTRATION_AND_AI_AGENT_INFRASTRUCTURE_SPEC.md](04-specifications/MODEL_ORCHESTRATION_AND_AI_AGENT_INFRASTRUCTURE_SPEC.md)
- [04-specifications/OMNIS_ANALYTICS_INTELLIGENCE_AND_GROWTH_ENGINE_SPEC.md](04-specifications/OMNIS_ANALYTICS_INTELLIGENCE_AND_GROWTH_ENGINE_SPEC.md)
- [04-specifications/OMNIS_AUTONOMOUS_CONTENT_OPERATING_SYSTEM_SPEC.md](04-specifications/OMNIS_AUTONOMOUS_CONTENT_OPERATING_SYSTEM_SPEC.md)
- [04-specifications/OMNIS_CONTENT_FACTORY_PIPELINE_AND_PRODUCTION_ENGINE_SPEC.md](04-specifications/OMNIS_CONTENT_FACTORY_PIPELINE_AND_PRODUCTION_ENGINE_SPEC.md)
- [04-specifications/OMNIS_MEMORY_KNOWLEDGE_AND_LEARNING_SYSTEM_SPEC.md](04-specifications/OMNIS_MEMORY_KNOWLEDGE_AND_LEARNING_SYSTEM_SPEC.md)
- [04-specifications/OMNIS_PLATFORM_INTEGRATION_AND_PUBLISHING_ENGINE_SPEC.md](04-specifications/OMNIS_PLATFORM_INTEGRATION_AND_PUBLISHING_ENGINE_SPEC.md)
- [04-specifications/OMNIS_SECURITY_PRIVACY_GOVERNANCE_AND_TRUST_SPEC.md](04-specifications/OMNIS_SECURITY_PRIVACY_GOVERNANCE_AND_TRUST_SPEC.md)
- [04-specifications/ORCHESTRATOR_SPEC.md](04-specifications/ORCHESTRATOR_SPEC.md)
- [04-specifications/PERSONALITY_ENGINE_SPEC.md](04-specifications/PERSONALITY_ENGINE_SPEC.md)
- [04-specifications/RELATIONSHIP_AND_SOCIAL_INTERACTION_ENGINE_SPEC.md](04-specifications/RELATIONSHIP_AND_SOCIAL_INTERACTION_ENGINE_SPEC.md)
- [04-specifications/SECURITY_ARCHITECTURE_SPEC.md](04-specifications/SECURITY_ARCHITECTURE_SPEC.md)
- [04-specifications/SOCIAL_PLATFORM_ORCHESTRATION_SPEC.md](04-specifications/SOCIAL_PLATFORM_ORCHESTRATION_SPEC.md)
- [04-specifications/SYSTEM_SPEC.md](04-specifications/SYSTEM_SPEC.md)
- [04-specifications/TASK_CONTRACT_SPEC.md](04-specifications/TASK_CONTRACT_SPEC.md)
- [04-specifications/TOOL_GATEWAY_SPEC.md](04-specifications/TOOL_GATEWAY_SPEC.md)
- [04-specifications/VOICE_AND_SPEECH_IDENTITY_ENGINE_SPEC.md](04-specifications/VOICE_AND_SPEECH_IDENTITY_ENGINE_SPEC.md)

## 05 — Implementation

| Document                                                                               | What it settles                                                     |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| [05-implementation/AI_BUILD_GUIDE.md](05-implementation/AI_BUILD_GUIDE.md)             | The operational contract for coding agents                          |
| [05-implementation/MONOREPO.md](05-implementation/MONOREPO.md)                         | Install, build, test, debug; adding dependencies; known constraints |
| [05-implementation/DEVELOPMENT_WORKFLOW.md](05-implementation/DEVELOPMENT_WORKFLOW.md) | The loop, the gates, conventions, deferred hardening                |

## 07 — Decisions

Architecture Decision Records. A change to a domain boundary, a package dependency rule, a
contract version or the toolchain requires one.

- [07-decisions/ADR-0000-architecture-governance.md](07-decisions/ADR-0000-architecture-governance.md)
- [07-decisions/ADR-0001-monorepo-and-toolchain.md](07-decisions/ADR-0001-monorepo-and-toolchain.md)
- [07-decisions/ADR-0002-domain-boundaries.md](07-decisions/ADR-0002-domain-boundaries.md)
- [07-decisions/ADR-0003-event-contracts.md](07-decisions/ADR-0003-event-contracts.md)
- [07-decisions/ADR-0004-frontend-stack.md](07-decisions/ADR-0004-frontend-stack.md)
- [07-decisions/ADR-0005-ai-core-boundaries.md](07-decisions/ADR-0005-ai-core-boundaries.md)
- [07-decisions/ADR-0006-provider-independent-model-orchestration.md](07-decisions/ADR-0006-provider-independent-model-orchestration.md)
- [07-decisions/ADR-0007-policy-and-budget-before-execution.md](07-decisions/ADR-0007-policy-and-budget-before-execution.md)
- [07-decisions/ADR-0008-explicit-agent-state-machine.md](07-decisions/ADR-0008-explicit-agent-state-machine.md)
- [07-decisions/ADR-0009-ai-core-runtime-composition.md](07-decisions/ADR-0009-ai-core-runtime-composition.md)

## Documentation rule

Any implementation agent should be able to start from this map and navigate to the
authoritative specification for the code it is changing. If code and specification disagree,
do not silently choose one: document the discrepancy and resolve it through an ADR.
