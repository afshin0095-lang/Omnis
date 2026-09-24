# OMNIS AI Core Foundation Specification

> Version: 1.0.0
> Status: Implementation contract

## Purpose

The AI Core is the execution substrate for every intelligent capability in OMNIS. It makes model selection, provider access, policies, budgets, tools, execution, evaluation and observability explicit and replaceable.

## Design Goals

1. Provider agnostic.
2. Model capability aware.
3. Policy controlled.
4. Budget controlled.
5. Tool access constrained.
6. Deterministic when inputs, versions and seeds are recorded.
7. Observable and auditable.
8. Cancellable and deadline aware.
9. Retry/fallback capable.
10. Testable without live providers.

## Canonical Execution

Request → Context → Policy → Budget → Model/Provider Selection → Plan → Tool/Model Execution → Evaluation → Settlement → Audit/Event

## Core Components

AI Core Types; Execution Context; Model Registry; Provider Registry; Policy Engine; Budget Engine; Tool Runtime; Evaluation Engine; Execution Kernel; Model Orchestrator; Agent Runtime.

## Execution State Machine

created → validated → authorized → reserved → planned → executing → settling → evaluating → completed

Failure and cancellation paths are explicit and observable.

## Non-Goals

AI Core does not contain Character personality, content-specific prompting, platform-specific publishing logic or UI business logic.

## Quality Requirements

- Unit tests for state transitions and policy boundaries.
- Contract tests for public interfaces.
- Integration tests for the full lifecycle.
- Deterministic CI without live providers.
- Telemetry for latency, routing, cost, failure and evaluation.
- Secret-safe logs.
- Reproducible execution metadata.

## Evolution Contract

Model selection is not permanently bound to a provider or model generation. The AI Core records capabilities, quality, cost and latency metadata and supports benchmark assessments that can update routing quality signals without changing the execution kernel. New model generations must enter through registry/adapter boundaries and pass benchmark, policy and regression gates before production routing.
