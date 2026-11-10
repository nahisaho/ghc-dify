---
name: japanese-prose
description: >-
  Improves Japanese prose in technical and business documents using
  kotonoha's original GiNZA-based diagnostics. Use when writing, rewriting,
  reviewing, or scoring Japanese prose; when the user asks for more natural,
  readable, concise, or less AI-like Japanese; or when tech-writer delegates
  its sentence-level quality pass. Owns wording, sentence rhythm, reading
  load, typo and grammar review, terminology, and edit-invariant checks.
  Does not own technical-document structure or presentation storylines.
license: MIT
argument-hint: "[write|proofread|review|score] [quick|full] <target file or request>"
---

# japanese-prose

Improves Japanese wording without changing approved facts, obligations,
identifiers, evidence, code, or document structure. This is an original
kotonoha implementation. It uses
[GiNZA](https://github.com/megagonlabs/ginza) for tokenization, part-of-speech
tagging, dependency parsing, lemmatization, and named-entity recognition.

## Responsibility boundary

- `tech-writer` owns doctype selection, section structure, completeness,
  traceability, and Markdown organization.
- `presentation-planner` owns audience strategy, scenarios, slide order, and
  design specifications.
- `japanese-prose` owns sentence-level Japanese: clarity, rhythm, reading
  load, terminology, repeated patterns, and contextual rewriting.

Never move, add, or remove sections unless the calling skill explicitly
authorizes it. Never alter requirement IDs, risk IDs, control IDs, numbers,
units, dates, proper nouns, citations, URLs, commands, tables, schemas,
acceptance criteria, approval states, or normative force.

## Modes

- `write`: write or rewrite Japanese prose. Use `quick` unless the document
  is external-facing, high-risk, or longer than roughly 10,000 Japanese
  characters.
- `proofread`: correct demonstrable typos and grammatical errors with minimal
  edits. Do not perform optional stylistic rewrites or chase a higher score.
- `review`: report problems and proposed corrections without editing.
- `score`: run diagnostics and report the 0–100 score without rewriting.
- `quick`: run prose lint once, review findings in context, edit, and rerun
  until no new actionable findings appear.
- `full`: run prose lint, reading-load lint, outline extraction, and
  terminology extraction; then review the whole document against
  `references/review-workflow.md`.

## Workflow

1. Read the target, audience, intended outcome, and calling skill's frozen
   invariants. Before editing, save an immutable copy of the entire original
   file as `<workdir>/prose-original.md`. Keep this separate from diagnostic
   baselines, which may change between rounds.
2. Read `references/writing-guidelines.md` before generating or rewriting
   prose. Resolve `<japanese-prose-dir>` to the directory containing this
   loaded skill; do not assume the shell is running in that directory.
3. Run the GiNZA prose diagnostic:

   ```bash
   uv run <japanese-prose-dir>/scripts/lint.py <target-file> --genre tech --json > <workdir>/prose-baseline.json
   ```

4. For `full` mode, also run:

   ```bash
   uv run <japanese-prose-dir>/scripts/lint.py <target-file> --genre tech --reading-load --json
   uv run <japanese-prose-dir>/scripts/outline.py <target-file>
   uv run <japanese-prose-dir>/scripts/terms.py <target-file> --json
   ```

5. Read the entire prose for typos, particle errors, subject/predicate
   mismatches, and incorrect inflections even when lint reports no findings.
   Classify each finding as `fix` or `keep`. A detector identifies a review
   target; it does not authorize blind replacement. Adjacent duplicate
   particles/words, Japanese bracket mismatches, and within-paragraph style
   mixing are proofreading targets, not proof of an error.
6. Correct demonstrable errors first. In `write` mode, then consider optional
   wording changes that serve the reader's stated goal. Keep these separate
   from necessary corrections. Preserve acceptable wording when a change
   merely substitutes a synonym or removes a legitimate qualification.
   Never infer a factual or proper-name correction from plausibility alone.
7. Rerun the prose diagnostic with
   `--baseline <workdir>/prose-baseline.json` to classify new, persisting,
   and resolved findings. Replace the baseline only after recording the
   decisions for the current round.
8. Run the edit-invariant gate against the immutable original:

   ```bash
   uv run <japanese-prose-dir>/scripts/invariants.py <workdir>/prose-original.md <target-file> --protect <proper-name-or-domain-term> --json
   ```

   Repeat `--protect` for each frozen proper name or domain term; omit it only
   when there are none. Exit 2 blocks changed protected content. Any edit
   requires a contextual semantic review, even if all mechanical checks
   pass: exit 3 means that review is pending or rejected, not completion.
   Follow `references/review-workflow.md` to record the hash-bound review,
   then rerun with `--review <workdir>/semantic-review.json --json`.
   Recheck after every subsequent edit; a stale review cannot approve it.
9. Stop only when every finding has a decision, no new actionable finding
   appears, and the invariant gate returns `passed`. If the gate cannot run,
   report the failure rather than declaring completion.

Allow at most three edit-and-diagnose rounds per invocation. If actionable
findings or invariant violations remain, report that the optimization did not
converge and list the unresolved items.

## Markdown emphasis

When strong emphasis touches surrounding prose, put half-width spaces outside
the delimiters: `これは **重要** です`, not `これは**重要**です`. Spaces are
unnecessary at line boundaries or next to punctuation, and must not be placed
inside `**`. Use ASCII spaces (`U+0020`), never full-width spaces (`U+3000`),
tabs, or non-breaking spaces, immediately before and after emphasis embedded
in prose. Write `これは **「重要」** と説明する`, not
`これは　**「重要」**　と説明する`.

## Diagnostic interpretation

The score is a triage aid, not a quality certificate. Read
`references/scoring.md` before presenting it. GiNZA provides linguistic
observations; the agent remains responsible for deciding whether a change is
correct in context.

## Completion report

Report:

- mode and diagnostics executed
- initial and final scores
- findings fixed and findings deliberately kept
- any skipped diagnostic and its reason
- invariant verification result
- necessary corrections versus optional wording changes
- semantic review status and any remaining uncertainty; mechanical equality
  is not a guarantee of preserved meaning
- `completed` or `did not converge`
