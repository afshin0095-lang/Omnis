# Documentation Governance

## Purpose

Documentation is part of the OMNIS system contract. It is not auxiliary prose.

## Source of truth

The repository documentation, architecture decision records, domain specifications, contracts, schemas, and tests collectively define intended behavior.

## AI implementation rule

AI coding agents must:

1. Read `AGENTS.md`.
2. Read `docs/README.md` and `docs/SUMMARY.md`.
3. Read the relevant domain specification before editing domain code.
4. Read relevant contracts and ADRs.
5. Never invent an architectural rule when the repository already defines one.
6. Update documentation when implementation changes the documented contract.
7. Prefer small, reviewable changes.

## Architecture governance

Core architecture is frozen at v1.0. New capabilities must normally be introduced as modules, agents, plugins, workflows, integrations, or capabilities rather than by casually changing domain boundaries.

## Status labels

- Proposed
- Draft
- Accepted
- Implemented
- Deprecated
- Superseded

## Change discipline

Architecture changes require an ADR. Public contracts require versioning and compatibility notes.
