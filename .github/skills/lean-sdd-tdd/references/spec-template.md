# Spec template (`.sdd/specs/<feature>.md`, ≤30 lines)

```md
---
feature: calc
tier: T1            # T0 needs no spec; T2 requires a spec lock
approval: auto      # auto (AI review + lock) | human (only for the cases in SKILL.md)
---
# calc
Goal: <one sentence>   Non-goals: <bullets>

| ID | EARS requirement | Test |
| --- | --- | --- |
| REQ-CALC-001 | When add(a,b) is called, the system shall return a+b. | TEST-CALC-001 |
| REQ-CALC-002 | If an argument is not a number, then the system shall throw TypeError. | TEST-CALC-002 |
| REQ-CALC-003 (deferred) | Overflow handling. | — |

## PASS conditions and counterexamples
| REQ | Observable PASS condition | Counterexample (input + expected result) | TEST/command | Evidence |
| --- | --- | --- | --- | --- |
| `REQ-CALC-001` | add(2,3) returns 5 | Returning 4 must fail TEST-CALC-001 | TEST-CALC-001 | <actual Red, Green, mutation result; unrun = unknown> |
Risk stages: contract / inputs / execution / verdict / history / integration; <risks or reason not applicable>.
Oracle: <spec clause or independent reference used to derive expected results>.

## Design (≤10 lines; REQUIRED for T2, ≥2 lines): components, data flow, key decisions, state/policy tables
## Assumptions / risks: <each with the test or spike that retires it>
```

- IDs: `REQ-<F>-nnn`, `TEST-<F>-nnn`, `CODE-<F>-nnn`; globally unique. Rows marked `deferred` are excluded from coverage.
- Annotations: `/** @id TEST-CALC-001 @verifies REQ-CALC-001 */`, `/** @id CODE-CALC-001 @implements REQ-CALC-001 */`. Python/shell: consecutive `#` lines. Compatible with musubix3 annotations.
- Test title must contain its ID (vitest/jest/node:test); pytest/Go/Cargo use the lower-case underscore form (`test_calc_001`), matched via `{idu}` in `.sdd/config.json` `testCmd`.
- Large work: `.sdd/plan.md` with `| order | feature | depends | note |` rows; `sdd.mjs plan` reports state and the next feature.
- Any edit to the spec invalidates its lock; re-review and re-lock (one command).
- In the counterexample table, wrap referenced REQ IDs in backticks so they are not parsed as duplicate requirement definitions.

Reverse-spec rows may carry `[src: path:line]` (checked by `trace`). Put per-row assumptions in prose ("Row 005 …"); a `- REQ-X:` bullet is only a reference.
