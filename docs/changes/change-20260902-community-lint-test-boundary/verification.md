---
change: change-20260902-community-lint-test-boundary
role: verification
---

<!-- lifecycle is owned by change.md -->

# Verification

## RED

- A copied community workspace with only `vitest` mapped to an untyped declaration exits
  1 and reports unsafe-call/member/assignment in the 17 non-test contract/harness files.
- The old runner lacks a third named workspace and its isolated resolution contract.

## GREEN

- No non-test file under `src` imports `vitest`.
- All three lint workspaces return zero unsafe findings; injected and non-injected module
  resolutions match their exact expected boundaries.
- The central contract matrix, registry, mock, local, and caching consumers pass.
- Credential-free E2E typecheck passes without authentication or network I/O.
- `npm run lint`, `npm run lint:bot-repro`, `npm run build`, and
  `npm run test:coverage` pass.
- docs lint/conformance, tracked-change scope coverage, and `git diff --check` pass.

## Evidence

- `npm run lint:bot-repro`: 29 runner/classifier tests pass; installed,
  runtime-untyped, and Vitest-untyped candidates each report zero unsafe findings.
- Focused filesystem contract run: 6 files and 332 tests pass.
- `npm run typecheck:e2e` and `npm run build`: pass.
- `npm run test:coverage`: 90 files and 1651 tests pass; production coverage remains
  restricted to `src` (86.41% statements, 80.72% branches, 86.38% functions, 87.53% lines).
- `npm run lint`, docs lint/conformance, and `git diff --check`: pass.
- Independent review: approved after correcting the classifier to preserve unsafe
  findings from real ESLint `exitStatus: 1` results ahead of generic exit-status errors.
- `dev-evidence` places every tracked changed path inside the declared change scope.
  Its only remaining readiness finding is the pre-existing
  `.claude/settings.local.json`, which is globally gitignored and is neither modified nor
  included in this change.
