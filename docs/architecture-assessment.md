# Shiguang Agent Architecture Assessment

Assessment date: 2026-09-18
Reference revision: `f55b4d0ce4e6f9bdf101f40b7fb705eed82b1cec` plus the explicitly reported working-tree state
OpenSpec change: `harden-agent-architecture`

## Reproduce the metrics

The metrics collector uses only Node.js built-ins and runs without installed project dependencies:

```powershell
node scripts/architecture-metrics.mjs
node scripts/architecture-metrics.mjs --json
```

The script scans TypeScript/TSX under `src/`, `electron/`, and `ui/src/`, excludes generated directories, reports production/test size, counts declared test cases, identifies the largest production modules, and summarizes cross-area import directions.

It was also executed successfully against a temporary `git archive HEAD` snapshot with only this script copied into `scripts/`, demonstrating that metric collection does not depend on the dirty working tree, `node_modules`, or generated output.

## Baseline metrics

Working-tree snapshot at apply start:

| Metric | Value |
|---|---:|
| TypeScript/TSX files | 199 |
| Production files | 140 |
| Test files | 59 |
| Total source lines | 50,906 |
| Production source lines | 36,991 |
| Declared test cases | 355 |
| Coverage | Not configured |

Largest production modules:

| File | Lines |
|---|---:|
| `ui/src/App.tsx` | 7,363 |
| `src/brain/loop.ts` | 3,347 |
| `electron/app-service.ts` | 2,524 |
| `src/brain/planner.ts` | 2,314 |
| `src/brain/completion.ts` | 1,354 |

Highest-volume cross-area dependency directions:

| Direction | Import count |
|---|---:|
| `electron → src/tools` | 33 |
| `src/brain → src/tools` | 19 |
| `electron → src/state` | 14 |
| `src/state → src/core` | 13 |
| `electron → src/brain` | 10 |
| `src/app → src/brain` | 10 |

The complete matrix is emitted by the JSON command and is intentionally generated rather than duplicated here.

## Scoring rubric

Scores use a ten-point scale. A score near 5 means the capability works but has material reliability or maintenance gaps; 7 means credible product-level implementation with known hardening work; 9 means strong production controls and evidence; 10 requires sustained operational evidence, not design intent alone.

| Dimension | Weight | Baseline | Evidence summary |
|---|---:|---:|---|
| Core layering and contracts | 15% | 8.0 | Clear core/context/runtime/tools/state contracts; oversized orchestration modules weaken isolation. |
| Agent loop and completion governance | 15% | 8.2 | Task routing, evidence, budgets, recovery, completion checks, and loop guards have broad tests. |
| Tools, approvals, and security | 15% | 7.2 | Tool contracts, workspace restrictions, previews, and approvals exist; IPC validation and approval crash semantics need hardening. |
| Context and memory | 10% | 7.8 | Provenance, ranking, compaction, and memory boundaries exist; quality regression metrics are missing. |
| State and data integrity | 10% | 6.6 | SQLite repositories exist; runtime state is also held in DesktopStore and migrations are not version-progressive. |
| Provider, Tool, and MCP extensibility | 10% | 8.4 | Unified provider/tool contracts and MCP adaptation are mature and well tested. |
| Electron and UI boundaries | 10% | 6.1 | Explicit preload and context isolation exist; runtime schemas, sandbox/CSP controls, and module decomposition are incomplete. |
| Testing and release engineering | 10% | 7.0 | Broad core tests and desktop/UI suites exist; coverage/lint gates and mandatory CI tests are not yet configured. |
| Observability and operations | 5% | 6.2 | Run events and usage data exist; structured redacted logs, diagnostics, and evaluations are incomplete. |

Weighted baseline: **7.4/10**.

The P0/P1 target is **at least 8.5/10**, with no unresolved P0 data-integrity or desktop-security finding and no regression in existing Agent behavior.

## Verification commands used for reassessment

```powershell
node scripts/architecture-metrics.mjs --json
npm run typecheck
npm test
npm run test:electron
npm run test:ui
npm run desktop:typecheck
npm run desktop:build
```

Coverage, lint, deterministic Agent evaluation, migration-fixture, and packaged smoke commands will be added by the corresponding OpenSpec tasks. Until those commands exist and pass, the related score cannot receive production-readiness credit.
