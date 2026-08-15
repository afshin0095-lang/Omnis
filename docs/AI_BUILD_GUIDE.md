# OMNIS AI Build Guide

This document is the operational contract for coding agents such as Codex, Claude Code and other software agents working on OMNIS.

## 1. First Read

Before modifying code, read:

1. `AGENTS.md`
2. `docs/README.md`
3. `docs/SUMMARY.md`
4. `docs/ARCHITECTURE.md`
5. `docs/SYSTEM_SPEC.md`
6. the relevant domain document
7. relevant contracts
8. relevant ADRs
9. the existing implementation and tests

## 2. Never Guess the Architecture

Do not infer a new architecture from a local file. The documentation is the design authority. If documentation is incomplete, stop at the boundary of the missing contract and create/update the specification before implementing a large change.

## 3. Work in Small Vertical Slices

For each feature:

```text
SPEC
 ↓
CONTRACT
 ↓
DOMAIN MODEL
 ↓
IMPLEMENTATION
 ↓
TEST
 ↓
OBSERVABILITY
 ↓
DOC UPDATE
 ↓
CI
```

## 4. Change Protocol

Every architectural change requires an ADR. Every public API/event/data contract change requires a versioned contract update. Breaking changes require explicit migration documentation.

## 5. AI Provider Rule

Never scatter provider-specific SDK calls through domain code. Use the AI Model Layer and provider adapters.

## 6. Character Rule

Never generate a Character from a single prompt alone. Resolve persistent state, timeline, current context, appearance state, emotional state, knowledge state and applicable policies first.

## 7. Learning Rule

Do not silently modify Character behavior from a single outcome. Experience becomes a candidate lesson; validated lessons update the appropriate skill/knowledge/strategy layer.

## 8. Event Rule

Important cross-domain state transitions emit typed, versioned events.

## 9. Testing Rule

At minimum, new domain behavior requires unit tests. Cross-domain behavior requires integration tests. Critical workflows require end-to-end tests.

## 10. Failure Rule

Long-running AI work must have timeout, retry, cancellation, idempotency and failure reporting behavior.

## 11. Security Rule

Never commit credentials, tokens, private keys, user secrets or provider secrets. Validate permissions at the service boundary and again before sensitive autonomous actions.

## 12. Completion Rule

Do not report a feature as complete until implementation, tests, documentation and CI are green.

## 13. Preferred Agent Workflow

```text
UNDERSTAND
  ↓
LOCATE SPEC
  ↓
LOCATE CONTRACT
  ↓
INSPECT CODE
  ↓
PLAN MINIMAL CHANGE
  ↓
IMPLEMENT
  ↓
TEST
  ↓
REVIEW BOUNDARIES
  ↓
UPDATE DOCS
  ↓
RUN CI
```
