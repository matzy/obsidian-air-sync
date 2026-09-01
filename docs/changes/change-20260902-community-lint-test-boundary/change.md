---
id: change-20260902-community-lint-test-boundary
kind: change
title: Align test contracts with community lint boundary
status: active
created: '2026-09-02'
profile: sdd@1
intent: Keep Vitest-dependent filesystem contract infrastructure outside the community
  production scan and reproduce missing test declarations locally.
outcomes:
- Community lint reports zero unsafe diagnostics when Vitest declarations are unavailable.
- All shared backend contracts remain centrally composed and typechecked exactly once.
- Real-backend E2E imports are checked without credentials before live execution.
scope:
- tests/fs/ shared contracts, backend harnesses, family catalog, and composition root
- lint-bot-repro.mjs classifier tests and isolated untyped fixtures
- eslint.config.mts tsconfig.json vitest.config.ts and package scripts
- e2e/ credential-free typecheck and moved contract imports
- AGENTS.md ARCHITECTURE.md CONTRIBUTING.md and living enforcement/E2E docs
- docs/adr/0002-backends-verified-by-shared-behaviour-contracts.md and ADR 0003
- ARCHITECTURE.md living architecture ownership
- CONTRIBUTING.md contributor gate documentation
- docs/adr/0003-opt-in-e2e-validates-fakes-against-real-backends.md E2E boundary ADR
- docs/code-enforcement.md enforced test and lint boundaries
- docs/e2e-testing.md E2E typecheck contract
- lint-bot-repro-classifier.mjs three-environment classifier
- lint-bot-repro.test.mjs reproduction contract tests
- package.json E2E typecheck scripts
- src/__mocks__/ contract consumer imports
- src/fs/caching/remote-fs.contract.test.ts moved contract import
- src/fs/contracts/ moved test-owned definitions and catalog
- src/fs/dropbox/ contract-harness moves only
- src/fs/googledrive/ contract-harness moves only
- src/fs/local/local-fs.contract.test.ts moved contract import
- src/fs/onedrive/ contract-harness moves only
- src/fs/registry.test.ts moved family catalog import
- src/fs/remote-backend-contracts.test.ts moved composition root
- test-fixtures/lint-bot-repro/ isolated untyped fixtures
- tsconfig.json tests tree compilation
- vitest.config.ts tests tree discovery and production coverage
non_goals:
- Changing contract assertions production filesystem behavior or live API semantics
- Weakening unsafe lint rules adding casts or hiding tests through discovery exclusions
change_classes:
- responsibility
- boundary
governance:
  gate: auto
  reasons: []
members:
- role: requirements
  path: changes/change-20260902-community-lint-test-boundary/requirements.md
  required: true
- role: implementation
  path: changes/change-20260902-community-lint-test-boundary/implementation.md
  required: true
- role: verification
  path: changes/change-20260902-community-lint-test-boundary/verification.md
  required: true
promotion: []
unresolved_decisions: []
tags: []
owners: []
relations: []
source_paths: []
summary: Move filesystem test contracts to tests/fs and add a Vitest-untyped community
  lint reproduction.
updated: '2026-09-02'
---

## Summary

Community lint scans `src` while ignoring only `*.test.ts`. Reusable filesystem
contracts and backend harnesses were non-test files under `src` that imported Vitest,
so missing Vitest declarations collapsed their assertion API to error types. Move the
complete unit-contract ownership boundary to `tests/fs` and add an exact Vitest-untyped
reproduction workspace.

## Closure Notes
