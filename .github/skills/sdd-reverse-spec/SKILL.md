---
name: sdd-reverse-spec
description: "Use when code already exists and requirements are missing or outdated, before changing it: read the existing code and tests, reconstruct the current behaviour as EARS requirements (.sdd/specs/<feature>.md with REQ IDs, evidence path:line, confidence, TEST IDs), pin it with characterization tests, and ask the user one question at a time about unclear intent. 既存コードを読み、現状の挙動を EARS 書式の要件定義書(SDD spec)として再定義し、特性化テストで固定してから改修に入るときに使用。"
---
# SDD reverse spec / 既存コードから要件を再定義

Follow the user's language. Output = `.sdd/specs/<feature>.md` in the `lean-sdd-tdd` format (`../lean-sdd-tdd/references/spec-template.md`) plus characterization tests. **Behaviour is not changed here** (the only permitted edit is a comment-only `@id CODE-… @implements REQ-…` annotation, see Procedure 3). After approval, hand over to `lean-sdd-tdd` for the actual change.

A reverse spec records **current behaviour**, not intent. Every row is labelled so a reader never mistakes "what the code does" for "what it should do".

## Rules
1. **Read first, ask later.** Inspect the target (entry points, public API, tests, README, git log) before any question. Read existing `.sdd/specs/` through the bundled `lean-sdd-tdd/scripts/sdd.mjs context <feature|REQ|file>...` (complete feature specs and declared prerequisites; default 16384 UTF-8 bytes, explicit `--max-bytes N` override). Resolve errors/overflow with narrower or explicit selectors, never a bulk read; a new/unannotated target may have no spec yet. Static impact cannot infer undeclared relationships. This reading context does not narrow full validation or replace the full gate. Never ask what the code answers.
2. **Scope it.** One feature = one cohesive module or entry point. More than ~30 spec lines, or several modules → propose a split (see `sdd-spec-interview` rule 11); use `.sdd/plan.md` only with planning disabled, otherwise the JSON handoff below. Do one feature at a time.
3. **Evidence per row.** Each REQ cites `path:line` and a confidence: `high` (covered by tests or unambiguous code), `medium` (code only, no test), `low` (inferred, dead or odd code). Put them in a trailing `[src: path:line, conf: medium]`; `path` is **repo-relative** (`py/pkg/mod.py:4`, not `mod.py:4`), otherwise the gate warns the file does not exist.
4. **Observe, don't assume.** Run the code/tests to confirm a behaviour. A row whose behaviour was not observed is `low`.
5. **Ask only about intent**, one question at a time via Copilot CLI `ask_user` or Claude Code `AskUserQuestion` (2–4 options, recommended default, free text allowed). If unavailable, ask in conversation and stop for an explicit response; never fabricate answers or approval. Triggers: behaviour looks like a bug; two code paths disagree; dead branch; undocumented magic value. Options: keep as is (spec it) / treat as bug (`(deferred)` row + assumption entry) / remove. Hard cap 10 questions, then take "keep as is" and log an assumption.
6. **Never silently fix.** A suspected bug becomes a row describing the current behaviour plus a `## Assumptions / risks` entry; the fix is a later `lean-sdd-tdd` cycle.

## Procedure
1. **Map**: public entry points, inputs/outputs, state, side effects, external calls, error paths, config; language and test runner.
2. **Extract** behaviours into EARS rows (`When … the system shall …` / `If …, then …` / `While …`). Atomic, observable, concrete values/status codes. Include the error and edge behaviours the code really has.
3. **Pin** each row with a test `TEST-<F>-nnn` (`@id`) asserting the *current* result. Reuse existing tests by ID instead of duplicating. Tests pass on the unmodified code, so `tdd red` rejects them: record with `sdd.mjs tdd red <ID> --characterization "<why>"` (stored as a characterization Red, counted separately in the gate and not a weak Red; see `../lean-sdd-tdd/references/enforced-rules.md`). Then run `sdd.mjs tdd green <ID>` — Red→Green is only counted after Green. Green warns `no code carries @implements` for rows without a `(test-only)` marker: add a comment-only `@id CODE-<F>-nnn @implements REQ-<F>-nnn` to the existing code (no logic change), or mark the row `(test-only)`. Mark rows verified only this way `(test-only)`. A characterization test that fails on current code means the row is wrong: fix the row, never the code.
4. **Tier/approval**: security, policy, public contract, data, state, concurrency → `T2` (needs `## Design`: components, data flow, state machine, key decisions, riskiest assumption); otherwise `T1`. T1 specs are never hash-locked (`approve prepare` is not needed); the tests are the only guard, so never edit a row after Green to match changed code (`tdd green/refactor` warns when a T1 row changed since the previous Green). `approval: human` for destructive operations or unresolved product decisions.
5. **Close the gaps**: list `low`/untested rows, unreachable code, README-vs-code differences; ask the user (rule 5) only about those.
6. **Echo** a ≤10-line summary: scope, REQ count, confidence split, suspected bugs, assumptions.

## Writing the spec
- Path `.sdd/specs/<feature>.md`; front matter `feature`, `tier`, `approval`; first body line states `Reverse spec: rows describe current behaviour`.
- IDs `REQ-<F>-nnn`, `TEST-<F>-nnn`, globally unique. Postponed/unknown → `(deferred)` row with `—` test.
- `## Assumptions / risks`: every default taken, every suspected bug (with its evidence line), every `low` row, each with the test or question that would retire it.

## Specification-linked implementation planning (v0.2.7)

After characterization pins observed requirements, prepare the planning handoff without changing behavior or bypassing required approval.
With `planning.required:true`, author/update `.sdd/implementation-plan.json`
from those current specs; delegate the schema and seven-step workflow to
sibling `lean-sdd-tdd`. Record existing characterization honestly rather than
relabelling it a new failing regression. Run `plan check` and report unknown
bindings before production implementation.
Subsequent behavior changes require the ordinary new-REQ Red/Green cycle and
`plan verify TASK`; adopt only its current successful receipt and update
progress after each verified task. After specification changes, replan
affected/transitive bindings and freshly verify; never erase old failures.
Consistency, task verification, full gate, qualification and human publication
approval remain separate. With planning disabled, retain the Markdown handoff.

## Hand-off
1. `node <lean-sdd-tdd>/scripts/sdd.mjs approve prepare <feature>` to confirm the spec parses (T2 only needs it for approval; T1 is just a parse check).
2. Tell the user in ≤5 lines: spec path, REQ count, confidence split, suspected bugs, assumptions. Request approval listing the exact file paths from the manifest.
3. After approval, behaviour changes go through `lean-sdd-tdd` as new REQs (Red → Green → gate); `gate --changed --baseline <ref>` guards the rest.
