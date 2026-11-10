# Japanese prose optimization handoff

Use this pass after a Japanese document's structure and required information
are complete. The goal is to remove mechanical or translated-sounding prose
without changing the document's approved meaning, obligations, evidence, or
traceability.

The optimizer is kotonoha's original bundled `japanese-prose` skill.
Kotonoha owns document structure and completeness; `japanese-prose` owns
sentence-level clarity, rhythm, word choice, reading load, terminology, and
detection of repeated AI-like phrasing through GiNZA analysis.

## Run this pass when

- The requested final language is Japanese, including a bilingual document
  whose audience-facing prose is primarily Japanese.
- The task is `write` mode.
- The artifact is a living, multi-section document.
- The bundled `japanese-prose` skill is readable.

Skip it for English documents, generated machine-readable files, and source
code. Also skip atomic artifacts such as commit messages, PR descriptions,
issue reports, single release-note entries, and code comments/docstrings
unless the user explicitly requests prose polishing and supplies the prose in
a standalone file. For in-scope mixed-language documents, optimize only
Japanese prose.

## Freeze these invariants

Give the prose optimizer the target file, doctype, reader, and intended
outcome. Require it to preserve:

- Heading hierarchy, section order, and doctype-required sections
- Requirement, risk, control, test, interface, and decision IDs
- Numbers, units, dates, proper nouns, citations, URLs, and source mappings
- Normative force such as Must / Should / May, approval states, and
  acceptance criteria
- Tables, code blocks, commands, schemas, frontmatter keys, and placeholders
- Markdown emphasis spacing: keep ASCII half-width spaces (`U+0020`) between
  surrounding prose and both sides of `**strong emphasis**` delimiters; never
  substitute full-width spaces (`U+3000`), tabs, or non-breaking spaces
- Explicit assumptions, limitations, residual risks, and unresolved items

Heading wording may improve only when its meaning and hierarchy stay intact.
Never trade technical precision for conversational phrasing.

## Optimization loop

1. Invoke kotonoha's bundled `japanese-prose` through the host's
   skill-loading mechanism. If the host exposes only skill files, resolve
   `<tech-writer-dir>/../japanese-prose/SKILL.md` first, then check
   `.github/skills/japanese-prose/SKILL.md`,
   `.claude/skills/japanese-prose/SKILL.md`,
   `.copilot/skills/japanese-prose/SKILL.md`, and
   `$HOME/.copilot/skills/japanese-prose/SKILL.md`, then
   `$HOME/.claude/skills/japanese-prose/SKILL.md`; expand `$HOME`, load the
   discovered skill,
   and follow its workflow.
2. Ask the loaded skill to review and rewrite only the Japanese prose under
   the frozen invariants. Save an immutable pre-edit copy, pass the frozen
   proper names and domain terms for `--protect`, and keep necessary
   corrections separate from optional wording changes.
3. Let `<japanese-prose-dir>` be the directory containing the loaded
   optimizer's `SKILL.md`. When its diagnostics are available, run the
   optimizer's scripts with their qualified paths:

   ```bash
   uv run <japanese-prose-dir>/scripts/lint.py <target-file> --genre tech --json > <workdir>/prose-baseline.json
   uv run <japanese-prose-dir>/scripts/lint.py <target-file> --genre tech --reading-load
   uv run <japanese-prose-dir>/scripts/outline.py <target-file>
   uv run <japanese-prose-dir>/scripts/terms.py <target-file>
   ```

   Do not substitute `skills/tech-writer/scripts/lint.py`; kotonoha's script
   checks document structure and does not support these prose diagnostics.
4. Triage findings in context. Do not perform blind global replacements;
   retain a flagged expression when changing it would weaken precision or
   alter a defined term.
5. Re-run the optimizer's rubric and diagnostics after edits. One round is
   one kotonoha-to-optimizer handoff and its returned edits. Allow at most
   three rounds per §5 invocation; stop earlier when no actionable prose
   findings remain. A later rubber-duck edit opens a new invocation limited
   to the changed Japanese prose. Across the complete write workflow, do not
   exceed 15 optimizer handoffs.
6. Compare the optimized document against the frozen invariants. Revert any
   violating edit, give the violated invariant back to the optimizer, and
   retry within the round limit. If the violation cannot be resolved, report
   `Japanese prose optimization did not converge`.
   Run `<japanese-prose-dir>/scripts/invariants.py` against the immutable
   original and current target. Require a hash-bound contextual semantic
   review for changed prose, following the optimizer's review workflow.
   A `review_required` result or an unavailable/failed invariant gate cannot
   be treated as completion. Rerun after rubber-duck edits; old review hashes
   do not approve new text.
7. Re-run kotonoha's doctype checklist and structural lint before
   rubber-duck review.

## Required status

When this pass is in scope (a living, multi-section document whose requested
final language is Japanese, in `write` mode), report exactly one status:

- `Japanese prose optimization completed`: the registered optimizer ran and
  no actionable prose findings remain, and the invariant gate passed with
  a current semantic review of any edits. A missing optional diagnostic may
  be noted, but a missing or failed invariant gate prevents this status.
- `Japanese prose optimization not performed`: the bundled optimizer was
  missing or unreadable, so no prose review or rewrite ran; include the
  concrete reason. A standard `npx kotonoha install` should prevent this
  state.
- `Japanese prose optimization did not converge`: three rounds completed with
  unresolved actionable findings or invariant violations, or the optimizer
  started but failed before producing a valid result, a required
  post-rubber-duck rerun failed or could not start because all 15 handoffs
  were already used, or the invariant gate/semantic review could not pass;
  list the findings, violations, failure, and attempted fixes.

Do not claim natural-language optimization based only on kotonoha's
structural lint. Documents outside the scope of this pass require no Japanese
optimization status.
