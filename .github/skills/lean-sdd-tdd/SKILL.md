---
name: lean-sdd-tdd
description: "Use when an AI agent must implement features or fix bugs autonomously with spec-driven development (SDD) and test-driven development (TDD) evidence, minimal human approval and minimal tokens: REQ/TEST IDs, Red→Green proof, hash-locked specs, trace check, compact gate. 仕様駆動(SDD)・テスト駆動(TDD)で、人間承認を最小化し自走で実装・バグ修正するときに使用。"
---
# Lean SDD/TDD / 自走型 仕様・テスト駆動

Follow the user's language. One zero-dependency script enforces the rules; the agent does the thinking.
`S="node <skill-dir>/scripts/sdd.mjs"` (Node ≥ 20, no install). Output is ≤15 lines: never paste it back.

Resolve `<skill-dir>` to this loaded skill's directory, not a fixed `.github`
path; `.claude/skills` and personal installations use the same scripts.
For questions/approvals, use Copilot CLI `ask_user` or Claude Code `AskUserQuestion`.
If unavailable, ask in conversation and stop for an explicit user response;
never record human approval without it. Use the host's available independent-agent
tools for reviews rather than assuming Copilot-specific agent names exist.

## Host defaults
| Concern | Copilot CLI | Claude Code |
| --- | --- | --- |
| Development model | GPT-6.1 Sol | The configured, available Claude model |
| Commit attribution | Configured defaults; normally `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>` | Configured Claude Code attribution; never inherit the Copilot trailer |
| Context reset | `/new` | `/clear` |

Respect explicit user/project model and attribution overrides. If a requested model is unavailable, disclose this and ask before substituting it.
These defaults do not replace required counterexample-first development or independent reviews. Suggest a context reset only at a safe task boundary with the handoff retained.

## Autonomy model (human approval is the exception)
- **Default = auto**: the agent writes the spec, gets an *independent AI review* (rubber-duck / code-review sub-agent, diff-only), fixes findings, then **locks** the spec hash itself. No human prompt.
- **Human only when the spec says `approval: human`**, which you must set for: loosening a security/policy rule, destructive or irreversible operations (data deletion, force push, release/publish), secrets/credentials handling, or an unresolvable product decision. Then `approve prepare` → show exact paths + hash + residual risks → host question tool/fallback above → `approve record --by <human>` only after explicit approval.
- The script refuses `ai:` approvers on `approval: human` specs. Never forge a human name.
- Blocked or ambiguous → pick the safest reasonable default, record it in the spec "Assumptions", continue. Ask only if the default is irreversible.

## Preflight (once per repo)
- `git config user.name` and `user.email` must be set, or commits fail with `Author identity unknown`. If unset, ask the user; when you cannot ask, set repo-local values (`git config user.name/user.email`) and say so. Never finish a task with uncommitted work because of this.
- Test scripts: use `node --test` or a glob (`node --test test/*.test.mjs`), never a bare directory (`node --test test/` fails with `Cannot find module` on Node 24).
- Updating an existing test because the spec changed its expected output is allowed for that spec's REQs only: edit the test, then `tdd red <TEST-ID> --retest "<reason>"` and `tdd green <TEST-ID>`. A gate failure `test changed since last Green` must be resolved this way, never left failing.

## 0. Tier (1 line, before reading code)
- No spec yet and the request is vague ("〜を作りたい")? Use the `sdd-spec-interview` skill first: it asks the user one question at a time and writes the spec.
- **T0** typo/docs/rename, no behavior change: edit → project checks. No spec, no ledger.
- **T1** behavior change / bug fix: spec (≤15 lines) → Red → Green → gate.
- **T2** security, policy, public contract, data, state machine, concurrency: T1 + required `## Design` section + spike + spec lock after AI review + parallel risk review.
- **Large work** (several features): split into features. With planning disabled, retain `.sdd/plan.md` (`| order | feature | depends | note |`) and `$S plan`; with planning enabled, use the JSON workflow below instead. Then do each feature as T1/T2; do not create a second requirements/design document.
Unsure → higher tier. Escalate on discovery; never downgrade silently.

## Specification-linked implementation planning (v0.2.7)

Opt in by merging `planning.required:true` into `.sdd/config.json`; the JSON form is
`"planning":{"required":true}`. Absent/false policy retains the legacy workflow
without reading JSON. Enabled mode makes `.sdd/implementation-plan.json` the sole
plan authority and ignores Markdown. This applies to both hosts; resolve `$S`
from this skill's actual installed directory, never another checkout.

1. Read current approved specifications; define PASS conditions and counterexamples in those same specs.
2. Author/update the JSON feature/task graph and trusted scope before production implementation; cover every active REQ and explicit artifact owner.
3. Run `$S plan check --json`; resolve stale/unknown bindings before production changes. Planned regression tests/stubs may be needed to make TEST inputs measurable; a draft or an unknown fingerprint is not a pass.
4. Implement one ready task in dependency order using genuine assertion Red and Green, valid controls and bounded restored mutations.
5. Run `$S plan verify TASK --json` only after current native TDD evidence exists; declared checks plus guarded native verification must succeed. Never use an aggregate gate as a task check.
6. Update progress after each task: adopt the returned current successful `receipt` and set authored `status`; retain failure receipts and report pending/unknown work honestly.
7. After specification changes, update whole-file bindings and affected/transitive dependency input fingerprints; run consistency and fresh verification in dependency order, not a hash-only completion refresh.

Required JSON schema1 fields (no automatic natural-language decomposition):

| Field | Authored contract |
| --- | --- |
| `schemaVersion`, `features`, `tasks` | Version1; features have unique `id` and `dependsOn`; tasks belong to exactly one `feature`. Configured `planning.features`, or all current spec features by default, determines required scope and prerequisite closure. JSON cannot narrow it. |
| `id`, `feature`, `kind`, `reqs`, `dependsOn` | Unique task ID; `implementation` or `documentation`; owned REQs; explicit task prerequisites. Feature prerequisites also induce task dependencies. |
| `artifacts`, `condition` | Explicit in-root forward-slash paths and observable completion condition. Shared files list every owner. Documentation tasks own only .md/.rst/.txt/.adoc files. |
| `tests`, `checks` | Implementation tasks list the complete required native TEST union. Documentation may use an empty TEST list but still needs explicit checks. Each check has `name`, literal `argv`, `timeoutMs` in1..600000; trusted commands are not sandboxed. |
| `specs` | Exact owning spec path to current whole-file SHA256, including commentary. |
| `dependencies` | Every effective prerequisite task ID to its current input fingerprint from `plan check --json`, not its definition hash. Unknown partial fingerprints cannot establish current dependency bindings. Recompute affected downstream bindings as task inputs change. |
| `status`, `receipt` | Authored not-started/in-progress/blocked/complete claim and null/current in-root receipt path. Neither a claim nor an old receipt overrides observed history. Verification prints a receipt; only the agent edits JSON. |

JSON is bounded1MiB. Derived states are `not-started`, `in-progress`, `blocked`,
`replan-required`, `revalidation-required`, `complete`. Spec/definition/dependency
changes require replanning; changed artifacts, commands or evidence require
revalidation. Verification binds current tool/runtime/commands and outputs:
moving an installation can require fresh verification. Keep old failures.
An occupied lock refuses2; recover only after confirming its owner is absent,
then remove that exact lock, never an entire history or another task's lock.

Distinguish plan consistency, task verification, full-project gate, frozen release qualification and human publication approval.
`plan check` can pass
pending current-bound work; `gate --changed` requires reached tasks/prerequisites
complete; full `gate` requires the entire configured/default scope complete and
all existing checks. `--no-run` is INCOMPLETE2. Missing/unknown/skipped required
evidence never passes. Exit0 is success only for the requested stage, invalid
or stale inputs use1, missing/unresolved/unparseable evidence uses2.
Read-only plan/context views are not task evidence; fixture gates are not the
project gate. Two frozen clean qualification runs do not authorize publication:
retain exact artifact paths/hashes, residual risks and explicit human approval.
Instructions cannot mechanically guarantee agent obedience or hostile-host
attestation. Scope/policy weakening still needs explicit approval.

## 1. Spec (one file = requirements + design + approval unit)
`.sdd/specs/<feature>.md`, template in `references/spec-template.md`. Frontmatter `feature`, `tier`, optional `approval: human`. One `REQ-<F>-nnn` line per requirement (EARS). Bug fix: one REQ describing the correct behavior. First use: `$S init`.

## 2. T1/T2 loop (each step one command)
0. **PASS conditions and counterexamples first**: use the host's development model (see Host defaults) to write observable success conditions and concrete violations in the same spec (`REQ | PASS condition | counterexample | TEST/command | evidence`); wrap referenced REQ IDs in backticks to avoid duplicate definitions. Check contract, inputs, execution, verdict, history and integration risks; explain non-applicable stages. Derive expectations from the spec or an independent reference, not implementation output. Include valid-input controls and relevant boundary/error cases.
1. Write the test with `/** @id TEST-F-001 @verifies REQ-F-001 */` above it and the test title containing `TEST-F-001`.
2. T2 only: spike risky assumptions in scratch (see `references/t2.md`), AI-review the spec, then `$S approve record <feature> --by ai:<reviewer> --review "<1 line>"`. `approval: human`: see Autonomy model (prepare again after any spec edit).
3. `$S tdd red TEST-F-001` → must fail by assertion. Load/compile error is rejected: add a failing stub (preferred) or `--weak`.
4. Implement minimal code with `/** @id CODE-F-001 @implements REQ-F-001 */`. Do not edit the test. REQ verified only by golden/characterization tests: mark the REQ line `(test-only)` (or `(deferred)`) as a delimited marker, never prose. A `(test-only)` REQ's passing Red is recorded automatically as a characterization (no `--characterization` needed).
5. `$S tdd green TEST-F-001`. Test edited since Red → rejected: revert, or record a new Red.
6. Optional refactor, then `$S tdd refactor TEST-F-001`.
6a. For each distinct changed failure mechanism, apply a bounded mutation in isolation and confirm the regression detects it; restore it and rerun affected checks. A gate fix must reject invalid evidence AND accept valid evidence. Record actual Red/Green/mutation commands and outcomes in the spec. Unrun, skipped or unparseable evidence cannot justify completion; do not fabricate ledger entries.
7. `$S gate --changed` (trace + evidence for touched REQs + project checks). Fix; stop after 3 identical failures and report.
Impact: `$S impact <REQ|TEST|CODE|file> [--json]` lists implementing files, verifying tests and cross-feature REQs reached via imports (precision per language: `references/enforced-rules.md`). Run before changing a shared REQ.
Batch: write all tests for a feature, then red each, implement, green each, **one** gate at the end.

## 3. Rules the script enforces (details: `references/enforced-rules.md`)
- Spec lock (T2, `approval: human`); REQ line changed after its test's Green ⇒ evidence stale (`tdd refactor` for wording-only, `tdd red`/`green` for behaviour; new requirement = edit spec first, then test).
- Red before Green with identical test hash; hash-chained `.sdd/tdd.jsonl` (conflict ⇒ `tdd merge-ledger`).
- Every REQ has a test, every annotation resolves (orphan/unknown REQ = error); skipped checks ⇒ `INCOMPLETE` (exit 2), never PASS.
- Human approvals: `--by` must be a real name (generic/`ai` names refused); `approve prepare` first; later `@implements` code change ⇒ gate warning. A REQ with Green evidence deleted from every spec warns (fails under `scopePolicy: strict`) until `approve retire <REQ-ID> --by <human>` (recorded in `.sdd/retired-reqs.json`).
- Not enforced (agent discipline): PASS-condition/counterexample quality, mutation coverage, security review. Report actual evidence; do not claim the script enforces these obligations.

## 3a. Config, runners, stubs (read only when needed)
- `references/config.md`: install, `.sdd/config.json` (`scan`, `timeoutMs`, `prepare`, `changedCmd`/hub scoping), per-stack `testCmd` (Go, Rust, Maven, Gradle, CMake, Make, .NET, PHP, Julia, R, other), monorepo `projects`.
- `references/stubs.md`: `tdd stub <TEST-ID>` per-language capabilities and limits.
- Red variants (`--weak`, `--expect`, `--allow-setup-red`, `--missing-module`, `--characterization`), `trace --baseline`, review-file schema (`$S review template|check`): see `references/enforced-rules.md`.
- Always run the full `gate` (no `--changed`) before merge.
- Release qualification is separate from exploratory dogfooding: use the fixed support/candidate matrix and two-run evidence rules in `docs/design-sdd-hardening.md` §3.5 when present; otherwise use the release-readiness workflow in `references/enforced-rules.md`. Two arbitrary exploratory waves are not release proof, and technical readiness never replaces human release approval.
- Without Git, `gate --changed` explicitly falls back to full evidence/checks; manifest discovery, impact and C# stubs use filesystem discovery.

## 3b. Early project diagnostics

For an in-scope TS/JS project (root `tsconfig.json`, local TypeScript 5.9.x and
ESLint 9.x with one root flat config), run `$S diagnostics --root <app> --json`.
For standalone JS, run `$S diagnostics --root <app> --profile javascript --json`
(local ESLint 9.x and one root flat config, no TypeScript/tsconfig).
For Python, run `$S diagnostics --root <app> --profile python --json`
(root `.venv`: Python 3.14.x, Ruff 0.17.1 and mypy 2.4.0).
For Rust, run `$S diagnostics --root <app> --profile rust --json`
(installed cargo/rustc 1.99.x, root Cargo.toml/Cargo.lock, one package,
existing external Cargo home and offline dependencies).
Select a profile explicitly for those stacks; omission means TypeScript,
never autodetection. Run after each coherent code-edit batch and before claiming completion.
`PASS`/0 means all required providers completed without errors; `FAIL`/1 means static
errors were found; `INCOMPLETE`/2 means diagnosis could not finish. Report its
reasons, never call a missing tool or an ignored-only target set clean.
Repair only issues within the user's requested change scope; bound repair to
three attempts and disclose remaining issues instead of looping indefinitely.
Diagnostics are a snapshot, not Red, Green, approval or gate evidence.
Do not weaken or replace targeted tests, expected-assertion Red, approvals or
the final full gate because diagnostics passed. Never add diagnostics to gate
automatically. Never require TypeScript for standalone JS/Python/Rust, ESLint for
Python/Rust, or diagnostic tools for unsupported stacks.
Providers share a cumulative 8-MiB native stdout/stderr budget and have
60 seconds each, except cargo-check (180 seconds); worker output is separately capped.
Python uses isolated startup, root config/native exclusions, no bytecode/cache,
and null columns plus an info notice for mypy diagnostics on non-ASCII lines.
JS/Python enumeration fails closed if a symlink target outside excluded directories
cannot be resolved, even for an unrelated extension.
Rust checks all targets with default features, offline and locked. The parent owns
and removes private external target/build output after stopping workers; cleanup
failure is INCOMPLETE. Normal external Cargo cache bookkeeping/archive extraction
may persist; automatic cache GC is disabled. Do not promise sandboxing, network
isolation, or cleanup after parent SIGKILL/power loss/self-detached descendants.
The command does not install tools, fix sources or save evidence. Configurations,
plugins, build scripts and proc macros execute trusted local code with possible
arbitrary side effects. See both READMEs for selection/count/config details.

## 4. Review without humans
T2 only: parallel sub-agents by risk axis (security · correctness/state · contract · test adequacy), each diff-only, ≤200-word replies, findings to one file per feature, `.sdd/review-<feature>.md` (never share one `review.md` across features: it goes stale when the next feature overwrites it) (one line each: id|sev|path:line|state). Re-review Open items + fix diff only; stop after two clean rounds, then lock/merge.

## 5. Token rules
Before reading existing specs, run `$S context <feature|REQ|file>...` (or `--changed` when every changed file maps to specs). It returns complete selected specs, declared artifacts and recursive `plan.md` prerequisites, not a summary. Default stdout budget: 16384 UTF-8 bytes; override explicitly with `--max-bytes N`, use `--json` for automation. On errors/overflow, resolve selectors or narrow the task; never treat partial/missing context as sufficient, and never bulk-read all specs as a fallback. Static file impact cannot infer undeclared relationships: add explicit feature selectors when needed. Context is not approval/test evidence and does not narrow validation; keep the full gate before merge.
Read the spec and the specific files only; `view` ranges; quiet commands; one parallel batch for independent reads; no plan recaps; cite `path:line`. Suggest the host's context reset (see Host defaults) at boundaries. End with ≤8 lines: tier · REQs · gate verdict · open findings · next.

## Deterministic tests
No fixed `sleep` (poll with a deadline); inject clock/random; bind port 0; generous timeouts that print diagnostics; isolate signal/kill tests. A gate pass on re-run is `FLAKY suspected` (ledger type `flaky`; `flaky.policy` in `references/config.md`). Only the gate `test` check is retried; a flake in `tdd green` is a plain `GREEN REJECTED` — re-run it.

## Guardrails
No secrets; no push to `main` without request; use the host's commit attribution (see Host defaults); state what was not run.
