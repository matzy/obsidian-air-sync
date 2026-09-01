---
change: change-20260902-community-lint-test-boundary
role: requirements
---

<!-- lifecycle is owned by change.md -->

# Requirements

- **FR-1:** Community production lint shall scan `src` without any non-test module
  importing `vitest`.
- **FR-2:** The 5 shared contracts, exact family catalog, 12 backend harnesses, and sole
  composition root shall be owned by `tests/fs` and retain their existing semantics.
- **FR-3:** Vitest shall discover the central composition root exactly once; helper
  contracts and harnesses shall not be independent test roots.
- **FR-4:** Root build and lint shall continue to typecheck and lint `tests/**/*.ts`.
- **FR-5:** `lint:bot-repro` shall run installed, runtime-untyped, and Vitest-untyped
  workspaces with identical source/config inputs and isolated type injections.
- **FR-6:** Each injected workspace shall prove both its injected dependency resolves to
  its dedicated fixture and every non-injected dependency resolves to installed types.
- **FR-7:** Live E2E entrypoints and helpers shall typecheck moved imports without reading
  credentials or opening sockets before an opt-in live run.
- **FR-8:** Unsafe rules, assertions, fake fidelity, production behavior, and coverage
  floors shall not be weakened.
