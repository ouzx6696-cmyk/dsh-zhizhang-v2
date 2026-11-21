# V2 workspace rules

This file governs only this independent V2 workspace. It does not replace or modify the v1.x rules in the original repository.

## Current scope

- The repository contains the engineering skeleton and test-only samples. The acceptance samples live under `test/`. Shared contracts go under `src/contracts/` after review.
- Keep V2 independent from the original Electron application. Do not add Pi SDK integration, Electron code, v1.x workspace migration, legacy API or disk-format compatibility, or retired flags.
- Do not assume DsH Host, Client, Slot, identity, command, or lifecycle APIs. Add platform adapters only after the target version is verified in an authorized isolated profile and the relevant contract is recorded.
- Do not modify the original repository or its author baseline from this workspace. The original V2 baseline remains immutable.
- Do not install bundles, access or modify a DSH profile, call real models, access networks for model work, incur fees, configure remotes, or publish without explicit authorization.

## Boundaries

- `contracts/` owns shared types and schemas after they are reviewed and frozen.
- `host/` is the composition and verified Host adapter boundary; it must not own domain rules.
- The DsH host surface is declared **only** in `host/dsh-adapter.ts`; the upstream tool shape lives **only** in `host/dsh-tools-adapter.ts`. Every other module depends on those narrow interfaces. Until decision #5 authorizes an isolated-profile recording, both files are explicitly marked "inferred from public docs" and must not be described as verified.
- `storage/` owns persistence mechanics; domain packages must not import Host or Client code.
- `workflow/` owns orchestration and run state, not author decisions or business state transitions.
- `domain/shared/`, `domain/fanqie/`, and `domain/toutiao/` own separate business rules; the two product domains must not import each other.
- `client/` consumes public contracts and application operations; it must not access storage directly.
- `bundle/` owns packaging metadata only; it must not become a second business-logic entrypoint.

Do not freeze public APIs, business states, title rules, scenario mappings, budgets, or persistence formats in placeholder modules. Capture author decisions and approved contracts before implementation.

## Local verification

- Use the Node and TypeScript versions recorded in `README.md` and `package.json`.
- `npm run check` must be read-only and emit no build artifacts.
- `npm run test` must be deterministic, local-only, and use Node's built-in test runner.
- `npm run build` may write only to ignored `dist/`; do not treat a successful build as Host or Bundle verification.
- No package installation scripts or network-dependent checks are part of the default verification path.

## Protected business rules

The author-protected v1.x business semantics are the Toutiao title cap `34`, the QA pass line `84`, at most two editorial rejections, at most two automatic QA refinement rounds, the fixed delivery ending, and both product lines' status word tables and transition constraints. V2 keeps the semantics and rebuilds the implementation; none of these may be changed, widened, narrowed or re-derived without explicit author authorization. Recorded v1.x divergences (for example the micro title applicability) are evidence for the author, never a licence to pick a side.

**Single definition site**: these constants live only in `src/contracts/protected-rules.ts` (pure `as const`, browser-safe, zero imports). Domain and client modules import or re-export them unchanged; no other file may restate the values. The single exception is the browser-served mirror `src/client/contracts/protected-rules.ts` (the workbench is served under `/api/zhizhang/` and cannot import `src/contracts/`); it must stay a verbatim copy of the canonical export block, enforced by `test/db-v23.test.mjs`. Consolidating a value into that module is not a semantic change, but altering a value there is — it needs explicit author authorization and a guard test asserting the original number.

## Records that live outside this repository

The contract draft, the freeze checklist and the task tracker live in the original workspace under its locally ignored `plans/v2.0/`. This repository holds only code and test-only samples; do not copy the plan here and do not treat it as a public dependency. When a count, status or fixture reference changes here, update the plan records in the same round.

## Test layout rule

Node's default test discovery runs every `.mjs` under `test/` as a test file, so a shared support module placed there is executed as a test and inflates the reported count. Shared fixtures live outside `test/` (currently `support/`). Keep it that way, and keep the reported total equal to the sum of the `test/*.test.mjs` files.

## Sample limits

- The offline samples under `test/` prove local behaviour only. Their SQLite schema, protocol fields and state names are not the frozen contract, and they do not select the target Host driver.
- No sample authenticates or authorizes an actor. Identity, permission boundaries and tool isolation must be proven against the real target Host before any Agent-facing capability ships.
