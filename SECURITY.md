# Security Policy

## Reporting a vulnerability

Please **do not** open a public GitHub issue for a security vulnerability.

Email the maintainers at **security@omnis.dev** with:

- a description of the issue and its impact;
- step-by-step reproduction instructions or a proof of concept;
- affected versions, packages or endpoints;
- whether the issue is already public.

We aim to acknowledge a report within **3 business days** and to publish a fix or a documented
mitigation within **14 days** for confirmed high-severity issues. Reporters who follow this policy and
do not disclose the issue before a fix is available will not be pursued.

## Scope

In scope: the packages under `packages/`, the applications under `apps/`, the build and CI
configuration, and any credential-handling behaviour of the platform.

Out of scope: denial-of-service testing against shared infrastructure, social engineering, and
findings in third-party services that OMNIS integrates with (report those to the provider).

## Security boundaries in this repository

The authoritative description lives in
[docs/01-architecture/SECURITY_BOUNDARIES.md](docs/01-architecture/SECURITY_BOUNDARIES.md). The rules
that matter most when changing code:

1. **Secrets never enter a repository, a log line, an event payload or an error message.**
   `@omnis/errors` redacts before serialization and `@omnis/logging` redacts on emit; both are covered
   by tests. `pnpm verify:secrets` scans every tracked file for credential-shaped material and fails the
   build on a match. The only sanctioned exception is a _fictitious_ credential in a redaction test,
   which must be marked inline with `// omnis-secret-scan:allow <reason>`; every suppression is printed
   in the scan report so it stays auditable.
2. **Events carry configuration key _names_, never values** — a redaction bug in one place would
   otherwise become a leak in every subscriber.
3. **Audience data is minimised.** Inbound signals reference an author by an opaque platform handle,
   never by name, email or profile URL.
4. **Every record is tenant-attributed.** `tenantId` and `correlationId` are mandatory on events,
   commands, logs and spans; tenancy is enforced at the service boundary and again before a sensitive
   autonomous action.
5. **Autonomous, high-impact actions are gated.** Publishing and spending require an explicit approval
   decision recorded at job-creation time, so a retry path cannot skip it.
6. **Production configuration fails fast.** A missing or invalid variable aborts startup rather than
   degrading into an insecure default.

## Supported versions

OMNIS is pre-1.0. Only the current `main` branch and the active Sprint branch receive security fixes.

| Version                       | Supported          |
| ----------------------------- | ------------------ |
| `0.1.x` (Sprint 0 foundation) | :white_check_mark: |
| anything older                | :x:                |
