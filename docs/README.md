# OMNIS Documentation

## What is OMNIS?

OMNIS is an intelligent, autonomous, scalable and continuously learning operating system for digital media. It is designed to research, plan, create, publish, analyze and improve content for social platforms, with YouTube and Instagram as primary targets.

Its defining capability is the creation and management of persistent Digital Humans that can operate as virtual influencers while maintaining continuity across content, time, audience interactions, knowledge, skills, appearance, relationships and experience.

## Core Promise

> One intelligent operating system for digital humans, content production, audience intelligence, growth and continuous learning.

## Documentation Navigation

The repository uses a numbered structure. Every document is listed in
[SUMMARY.md](SUMMARY.md); the entries below are the ones to read first.

| Directory                                 | Contents                                                                          |
| ----------------------------------------- | --------------------------------------------------------------------------------- |
| [`01-architecture/`](01-architecture)     | System architecture, platform foundation, event architecture, security boundaries |
| [`02-domain-model/`](02-domain-model)     | Domain taxonomy and the agent mesh model                                          |
| [`03-contracts/`](03-contracts)           | Identifiers and versioning — the rules every contract obeys                       |
| [`04-specifications/`](04-specifications) | Domain and subsystem specifications (39 documents)                                |
| [`05-implementation/`](05-implementation) | AI build guide, monorepo mechanics, development workflow                          |
| [`07-decisions/`](07-decisions)           | Architecture Decision Records, ADR-0000 … ADR-0004                                |

| Start here                                                                             | When                                              |
| -------------------------------------------------------------------------------------- | ------------------------------------------------- |
| [PROJECT_STATUS.md](PROJECT_STATUS.md)                                                 | You want to know what actually exists today       |
| [ROADMAP.md](ROADMAP.md)                                                               | You want to know what comes next and why          |
| [GLOSSARY.md](GLOSSARY.md)                                                             | A term is ambiguous — one concept, one name       |
| [01-architecture/ARCHITECTURE.md](01-architecture/ARCHITECTURE.md)                     | You are reasoning about domains                   |
| [01-architecture/PLATFORM_FOUNDATION.md](01-architecture/PLATFORM_FOUNDATION.md)       | You are about to add, move or depend on a package |
| [05-implementation/DEVELOPMENT_WORKFLOW.md](05-implementation/DEVELOPMENT_WORKFLOW.md) | You are about to change code                      |
| [../AGENTS.md](../AGENTS.md)                                                           | You are a coding agent                            |

## Documentation Principles

1. Documentation is executable design: implementation agents must be able to derive code structure from it.
2. Every domain has explicit responsibilities and boundaries.
3. Every cross-domain interaction uses a contract.
4. Every important state transition is observable.
5. Every autonomous action is policy-controlled and auditable.
6. Architecture changes require an ADR.
7. Specifications are versioned and kept synchronized with code.

## Primary Domains

1. Digital Human OS
2. Character Engine
3. Life & World OS
4. Appearance & Continuity
5. Emotion & Behavior
6. Knowledge & Expertise
7. Experience & Learning
8. Memory Fabric
9. OMNIS Brain
10. Agent Mesh
11. Agent Orchestrator
12. Workflow Engine
13. Event Bus
14. Media Production OS
15. Social OS
16. Audience & Community Intelligence
17. Trend & Research OS
18. Strategy & Growth OS
19. Analytics OS
20. Experimentation OS
21. Revenue OS
22. AI Model Layer
23. Control Plane
24. Security & Governance
25. Observability
26. Data Platform
27. Infrastructure
28. Studio / Web / Desktop / Mobile Clients
29. Integration Layer

## Canonical Product Loop

`World → Research → Opportunity → Strategy → Character → Agents → Production → Publish → Audience → Feedback → Analytics → Experience → Learning → Improvement`
