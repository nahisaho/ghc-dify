---
name: lean-agentic-coding
description: "Use when implementing features, fixing bugs, refactoring, reviewing code changes or preparing a PR with an AI agent, and when you want to cut token usage while keeping rigor (tests first, approval, trace, delta review) via risk tiers and compact gate output. 機能実装・バグ修正・リファクタリング・コードレビュー・PR 作成、およびトークン節約を求められたときに使用。"
---
# Lean Agentic Coding / 省トークン高信頼開発

Follow the user's language. Detail lives in `references/`; load a file only when its step is reached.
Rule: **rigor scales with risk, context scales with the diff.**

## Host tools and paths
Resolve this skill's scripts/references from its loaded directory, whether in
`.github/skills`, `.claude/skills` or a personal skill directory.
Use `ask_user` in Copilot CLI or `AskUserQuestion` in Claude Code for questions
and approvals. If unavailable, ask in conversation and stop until the user
explicitly responds; never infer approval or record it before that response.
Use the host's available independent-agent tools for reviews, not tools from another host.

## Host defaults
| Concern | Copilot CLI | Claude Code |
| --- | --- | --- |
| Development model | GPT-6.1 Sol | The configured, available Claude model |
| Commit attribution | Configured defaults; normally `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>` | Configured Claude Code attribution; never inherit the Copilot trailer |
| Context reset | `/new` | `/clear` |

Respect explicit user/project model and attribution overrides. If a requested model is unavailable, disclose this and ask before substituting it.
These defaults do not replace required counterexample-first development or independent reviews. Suggest a context reset only at a safe task boundary with the handoff retained.

## 0. Tier first (1 line, before reading code)
| Tier | When | Required |
| --- | --- | --- |
| T0 | typo, docs, rename, no behavior change | edit → fast check |
| T1 | behavior change / bug fix | contract line → Red → Green → gate |
| T2 | security, policy, public contract, data, state machine, concurrency | T1 + spike → human approval → parallel risk review |

Unsure → pick the higher tier. Escalate mid-task if a T2 trigger appears; never downgrade silently.

## 1. Context budget (all tiers)
- With `.sdd/specs`, run the bundled `lean-sdd-tdd/scripts/sdd.mjs context <feature|REQ|file>...` before reading specs; `--changed` requires every changed file to resolve. Complete feature specs, artifacts and declared prerequisites are returned within 16384 UTF-8 bytes (`--max-bytes N` overrides explicitly). Resolve errors/overflow by narrowing selectors, not by bulk-reading all specs; add explicit selectors for relationships static impact cannot infer. Reading context never replaces approval/evidence or narrows full validation; run the full gate before merge.
- Read `AGENTS.md` (≤1 KB pointer file) and the single contract file only. Locate with grep/glob; `view` with line ranges; never read whole large files, lockfiles, coverage, `node_modules`, generated output.
- Run commands with quiet flags and `| tail`/`head`; report only failures + counts. Use `scripts/gate.sh` for compact results.
- Independent reads/searches in one parallel batch. Delegate to sub-agents only work needing separate context, and give them a bounded goal + stop condition + "return ≤200 words".
- Do not restate plans, re-read unchanged files, or paste diffs back. Cite `path:line`.
- Suggest the host's context reset (see Host defaults) at a task boundary when the session grows large; carry over only the handoff block (§6).

## 2. Contract = single source of truth (T1+)
Keep one file per feature (`docs/contract/<feature>.md` or the repo's existing equivalent) with: goal, `REQ-<F>-nnn` EARS lines, non-goals, verification command per REQ. No second requirements/design copy. Missing → write ≤30 lines, not a long spec. See `references/contract-template.md`.

## Specification-linked implementation planning (v0.2.7)

With `planning.required:true`, create/update `.sdd/implementation-plan.json`
from current specifications before production implementation. Delegate the
complete schema and seven-step workflow to sibling `lean-sdd-tdd`; do not
create a second contract or invent a parallel evidence format.
Run its read-only `plan check`, then implement ready tasks in dependency order
with actual Red/Green. Run `plan verify TASK` against current native evidence
and update authored progress/receipt after each verified task.
After specification changes, replan affected/transitive bindings and obtain
fresh verification; status claims and views do not establish completion.
Retain failures and distinguish consistency, task verification, full-project
gate, frozen qualification and explicit human publication approval.
When planning is absent/disabled, retain the existing workflow.

## 3. T1 loop
0. **PASS conditions and counterexamples first**: use the host's development model (see Host defaults) to define observable success conditions and concrete violations in the existing contract (`REQ | PASS condition | counterexample | TEST/command | evidence`). Check contract, inputs, execution, verdict, history and integration risks; explain non-applicable stages. Derive expectations from the contract or an independent reference, never the implementation's output.
1. Failing test first, named/annotated with its REQ ID (`@verifies REQ-F-001`). Run it, confirm Red for the right assertion, not a setup/compile failure or skip. Add valid-input controls and relevant boundary/error cases.
2. Minimal code to Green; `@implements REQ-F-001` on the code. Refactor only after Green.
3. For each distinct changed failure mechanism, apply an isolated, bounded mutation and confirm the regression catches it; restore it and rerun affected checks. A gate fix must reject invalid evidence AND accept valid evidence. Record the command and observed result in the contract; mark unrun checks explicitly.
4. `scripts/gate.sh` (typecheck + lint + tests). Fix, rerun; stop after 3 identical failures and report the blocker.
5. Never weaken tests, skip checks, or count skipped as passed. Missing or unparseable evidence does not establish completion. Counterexample quality and mutation coverage are agent obligations, not mechanically enforced by this skill.

## 4. T2 additions (see `references/t2-protocol.md`)
1. **Spike**: isolated scratch run of the riskiest assumption (real runtime, all command shapes) before design is final; record result in 3–5 lines.
2. **Enumerate** state machines/policy tables fully and test every row.
3. **Approval**: list exact artifact paths + hash + residual risks, then use the host question tool/fallback above. Stale artifact (hash changed) → re-approve.
4. **Review**: parallel by risk axis (security / correctness / contract), each limited to the diff and the finding ledger; no whole-repo review.
5. Loosening a policy/security rule needs explicit human sign-off.

## 4b. Parallel work (T1/T2, optional)
1 session = 1 lane = 1 worktree; change only your lane's packages. Contract changes get their own PR first. 1 PR = 1 purpose; PR body lists REQ IDs.

## 5. Delta review loop
Keep a finding ledger (`references/ledger-format.md`, one line per finding: id, severity, state Open/Fixed/Rejected/Deferred). Re-review only: previous Open items + the fix diff. Stop when two consecutive passes report none. Machine checks (types, tests, gate) run before any LLM review.

## 6. Handoff block (end of task, ≤10 lines)
Tier · REQ IDs · changed paths · gate result · open findings · next step. Optionally append to `docs/devlog/` (date, goal, evidence, risk).

## Guardrails
No secrets in commits; no direct push to `main`; use the host's commit attribution (see Host defaults); do not fabricate evidence — state what was not run.
