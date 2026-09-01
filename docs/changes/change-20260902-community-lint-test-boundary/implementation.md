---
change: change-20260902-community-lint-test-boundary
role: implementation
---

<!-- lifecycle is owned by change.md -->

# Implementation

## Unit 1 — Exact reproduction

Add a dedicated Vitest-only untyped fixture and a third lint workspace. Generalize the
workspace comparison, resolution checks, classifier, and runner tests while preserving
the existing five-runtime-dependency boundary.

## Unit 2 — Test ownership boundary

Move 19 test assets from `src/fs` to the parallel `tests/fs` topology: 5 contracts,
the family catalog, 12 backend harnesses, and the central composition root. Update all
mock/local/caching/registry and E2E imports without changing assertions or fakes.

## Unit 3 — Compile and discovery wiring

Include `tests/**/*.ts` in TypeScript and ESLint, discover only `tests/**/*.test.ts` in
Vitest, keep coverage restricted to production `src`, and add a credential-free E2E
typecheck used before all live backend commands.

## Unit 4 — Durable rules

Amend living architecture/enforcement documents and ADR 0002/0003. Historical closed
change evidence keeps its original paths and is excluded from stale-path checks.
