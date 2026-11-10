# T2 protocol (high risk)

1. **Spike (scratch, disposable)**: list assumptions that would invalidate the design if false. Run each against the real runtime in an isolated dir (never the repo tree). Cover every command shape you will use. Record: assumption · command · observed result · verdict (3–5 lines). Simplify the execution environment (one launcher, hermetic env) before designing on it.
2. **Contract-first**: write/update the contract; for APIs/IPC/state machines keep ONE machine-readable source (schema/table) and generate types/docs from it; commit generated output and diff-check it in CI.
3. **Exhaustive enumeration**: state × event matrix or policy table → table-driven test covering every cell, including "illegal" cells that must be rejected.
4. **Approval packet** (Copilot CLI `ask_user` / Claude Code `AskUserQuestion`, before implementing; if unavailable, ask in conversation and stop for explicit approval):
   - exact artifact file paths (not only the hash)
   - sha256 of each / combined manifest
   - residual risks and what was not verified
   Any later change to those files invalidates approval.
5. **Implement** via T1 loop. Evidence (test output, gate result) is saved under `docs/evidence/<feature>/` as short JSON/text, not pasted into chat.
6. **Parallel risk review** (one sub-agent per axis, diff-only, ≤200-word replies):
   security/trust-boundary · correctness/state/concurrency · contract/compat · test adequacy.
   Merge into the ledger; fix; delta re-review.
7. **Release/merge**: all REQ traced, gate green, ledger has no Open items, PR lists REQ IDs and design section.
