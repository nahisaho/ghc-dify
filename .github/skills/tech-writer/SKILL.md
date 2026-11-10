---
name: tech-writer
description: >-
  Structures, writes, reviews, and scores technical documents: README,
  design docs/ADRs, API references, requirements, system designs, test plans,
  operations runbooks, migration plans, security designs/threat models,
  technical proposals, Blueprints, White Papers, RFI/RFP, PR descriptions,
  commit messages, issue reports, release notes/CHANGELOG, manuals/how-to
  guides, comments/docstrings, Obsidian notes/templates, and Qiita/Zenn
  articles. Use when asked to create, improve, review, or score these
  documents in Japanese or English, including a bare goal without context.
  Asks one question at a time before writing. Owns structure, completeness,
  traceability, and reader fit; delegates sentence-level Japanese wording
  to kotonoha's original bundled japanese-prose skill with GiNZA diagnostics.
license: MIT
argument-hint: "[write|review|score] [doctype] <target file or request>"
---

# tech-writer

Structures technical documents so readers reach the information they need
with the shortest path. Covers README, design docs/ADRs, API reference, PR
descriptions/commit messages/issue reports, release notes/CHANGELOG, user
manuals/how-to guides, code comments/docstrings, requirements definitions,
system designs, test plans, operations runbooks, migration plans, security
designs/threat models, technical proposals, Blueprints, White Papers,
RFI/RFP procurement documents, Obsidian notes and templates, and Qiita/Zenn
articles.

Default format: Markdown for every doctype in this skill, except a git
commit message body (plain text by convention — light "-" bullets are
fine, but don't add Markdown headings or fenced code there) and code
comments/docstrings (the target programming language's own comment/
docstring syntax). Qiita and Zenn use Markdown with a platform-specific
YAML frontmatter and a few platform extensions on top — see their doctype
reference files. Obsidian uses YAML properties, wikilinks, and callouts;
see `references/doctypes/obsidian.md` for core Templates compatibility.
For an existing Vault's conventions, related-note suggestions, link diagnosis,
or authorized direct edits or CLI plan-approved saves, use the sibling
`obsidian-vault` skill when available.
Tech-writer still owns document structure and the reusable template; it must
hand Vault writes back to that skill's selected workflow, not bypass its scope
checks or write into the Vault on its own.
Preserve the user's working directory when handing off: use a user-specified
directory, or the current directory at request start if none was specified.
Resolve the final target there without reinterpreting an explicitly absolute or
Vault-relative path. Do not replace the target with a copy in session-state
storage; retain Vault scope checks and separate consent for any auxiliary copies.
Route standalone `.base` configuration to `obsidian-bases`, not the Markdown
template or Vault Markdown writer; its host workflow validates without evaluating
formulas and never mutates source-note properties.

## Division of labor

Document creation can span three layers: "is the reasoning defensible", "is
the structure right", and "is the prose natural and readable". The bundled
`consulting-analyst` skill owns problem decomposition, hypotheses, evidence,
option evaluation, and synthesis when those are not yet settled. This skill
owns structure, document type conventions, completeness, and reader fit. The
bundled `japanese-prose` skill owns sentence-level naturalness, reading load,
terminology, and repeated-pattern analysis.

When a request for a Blueprint, White Paper, proposal, or decision document
still lacks a defensible analysis, load the sibling `consulting-analyst`
skill first and consume its `synthesis-handoff.md`. Do not silently invent
the missing analysis inside document prose. If the sibling skill is absent,
ask for the decision question and evidence or label analytical conclusions as
unverified. Preserve issue, hypothesis, source, evidence, criterion, weight,
score, confidence, counterevidence, and uncertainty records. Return the work
to analysis when new evidence, a new decision question, changed criteria, or
a contradictory conclusion requires analytical judgment.

If the handoff status is `Incomplete`, either return the decision-critical
gaps to `consulting-analyst` or preserve that status, the evidence gaps, the
confidence, and conditional wording visibly in the document. Never turn an
incomplete handoff into an unqualified recommendation. Tech-writer then locks
down the document structure and orchestrates the §5 handoff to
japanese-prose during `write` mode before the final rubber-duck review.

- Rule of thumb: "does removing a heading still make sense?" tests structure
  (this skill's job). "Does the recommendation follow from evidence?" tests
  analysis (`consulting-analyst`). "Does rereading a single sentence change
  its meaning?" tests prose (`japanese-prose`).
- Code comments/docstrings document code itself, but the same
  structure-and-completeness framing still applies.

## Execution modes

Infer the mode from the argument or the request:

- `write` (default): new document, or restructuring a draft. Runs the full
  §1–§6 workflow, starting with the intake loop in §1 and ending only after
  the rubber-duck review loop has no remaining actionable findings. If an
  independent review cannot run or cannot converge, returns the explicit
  review status required by §6 instead of claiming a clean review. For a
  in-scope Japanese living document, also return the §5 Japanese prose
  optimization status.
- `review`: structural review of an existing document. Does not rewrite;
  reports the gap against the doctype checklist (§7).
- `score`: structure-only quick diagnostic. Runs
  `scripts/lint.py --json <file>` and summarizes the findings (no rewrite).

If no mode is given, interpret "write/create" requests as `write`,
"fix/review" requests as `review`, and "how does this look?/diagnose"
requests as `score`.

## 1. Gather context — one question at a time, then act

Requests are often bare goals ("I want to write a README", "○○を書きたい")
without enough context to start. Do not front-load a long questionnaire or
hand the user a checklist to fill in. Instead:

1. **Determine the doctype first**, from the table below. If the request
   itself doesn't make it clear, that ambiguity is your first question. If
   the table maps the request to `pr-commit`, resolve the **subtype** —
   commit message, PR description, bug report, or feature request — as
   part of this same first question: `references/doctypes/pr-commit.md`
   gives each a different skeleton and different musts, so don't proceed
   past this doctype without knowing which one applies. Similarly, a bare
   "write a tech blog post" request doesn't by itself say Qiita, Zenn, or
   neither — ask which platform (or "no platform, just a plain document")
   as part of this same first question. For a "technical proposal", ask
   whether it is an internal approval proposal or a supplier response to an
   RFP; only the internal approval proposal maps to `technical-proposal`.
   For a supplier response, structure the document against the supplied
   RFP's requirement IDs, requested proposal contents, pricing format, and
   contract deviations, then apply the general principles in
   `references/style-constitution.md`. For a bare "Blueprint" request, ask
   whether the reader needs an integrated future state and transformation
   path (`blueprint`), implementation-level system detail (`system-design`),
   or approval for one investment (`technical-proposal`). For a bare "White
   Paper" request, ask whether the goal is an evidence-led publication
   (`white-paper`) or an internal approval request (`technical-proposal`);
   do not treat a sales brochure as an evidence-led White Paper.
2. Open the matching reference file and note its target reader and any
   "settle before writing" items. Combined with the general musts below,
   this is your information checklist — but never show it to the user as a
   form.
3. **Ask exactly one question at a time**: pick the single most
   information-gaining missing item, ask only that, and wait for the
   answer before asking the next one. Never batch multiple questions into
   one message.
4. Stop asking once you have, at minimum: (a) the reader, (b) the
   one-sentence outcome the reader should reach after reading, (c) the
   doctype (and subtype, for `pr-commit`), and (d) any doctype-specific
   musts (e.g. the decision and alternatives for a design doc, the
   prior-knowledge floor for a user manual, breaking-change status for
   release notes, the related issue for a PR description or bug report,
   measurable acceptance conditions for a requirements definition, the
   approved requirements baseline for a system design, exit criteria for a
   test plan, RTO/RPO for an operations runbook, rollback conditions for a
   migration plan, assets and trust boundaries for a threat model, market
   unknowns for an RFI, evaluation rules for an RFP, planning horizon,
   approval authority, and baseline evidence for a Blueprint, or the central
   claim, evidence standard, and publisher or sponsor conflicts for a White
   Paper).
5. **A "don't know" / "not applicable" / "no ticket for this" answer
   satisfies a must — it is not a reason to keep asking.** Ask that must
   at most once; if the answer is a non-answer, record it as a stated
   assumption or an open question inside the document itself (design docs
   already have an Open Questions section for this; for others, add a
   one-line note) and move on.
6. **Once complete, do not ask the user to compose anything.** Synthesize
   the gathered answers into the best possible generation approach yourself
   and immediately continue into §2–§6 in the same turn to produce the
   document. Skip further confirmation unless the doctype is release-facing
   and consequential (e.g. a public release note with breaking changes) or
   the user explicitly asked to see a plan first.
7. If the user already volunteered some of this information in the initial
   request, skip the corresponding question — don't re-ask what's already
   known.

| Request | doctype | reference file |
|---|---|---|
| README / project overview | readme | `references/doctypes/readme.md` |
| Design doc / ADR / RFC | design-doc | `references/doctypes/design-doc.md` |
| API reference | api-docs | `references/doctypes/api-docs.md` |
| PR description / commit message / issue report | pr-commit | `references/doctypes/pr-commit.md` |
| Release notes / CHANGELOG | release-notes | `references/doctypes/release-notes.md` |
| User manual / how-to guide / tutorial | user-manual | `references/doctypes/user-manual.md` |
| Code comments / docstrings | code-comments | `references/doctypes/code-comments.md` |
| Requirements definition / 要件定義書 | requirements-definition | `references/doctypes/requirements-definition.md` |
| System design / システム設計書 | system-design | `references/doctypes/system-design.md` |
| Test plan / テスト計画書 | test-plan | `references/doctypes/test-plan.md` |
| Operations design / Runbook / 運用設計書 | operations-runbook | `references/doctypes/operations-runbook.md` |
| Migration plan / 移行計画書 | migration-plan | `references/doctypes/migration-plan.md` |
| Security design / Threat model / セキュリティ設計書 | security-design | `references/doctypes/security-design.md` |
| Internal technical proposal | technical-proposal | `references/doctypes/technical-proposal.md` |
| Blueprint / 将来構想・変革設計図 | blueprint | `references/doctypes/blueprint.md` |
| White Paper / ホワイトペーパー | white-paper | `references/doctypes/white-paper.md` |
| Request for information / RFI | rfi | `references/doctypes/rfi.md` |
| Request for proposal / RFP | rfp | `references/doctypes/rfp.md` |
| Obsidian note / vault template | obsidian | `references/doctypes/obsidian.md` |
| Zenn article | zenn | `references/doctypes/zenn.md` |
| Qiita article | qiita | `references/doctypes/qiita.md` |

For technical documents that don't fit any of these, apply only the general
principles in `references/style-constitution.md`, using the same
one-question-at-a-time intake for reader and outcome.

## 2. Outline first for long documents

For documents likely to run long — design docs/ADRs, user manuals with
multiple steps, API references covering several endpoints, requirements
definitions, system designs, test plans, operations runbooks, migration
plans, security designs, technical proposals, Blueprints, White Papers,
RFI/RFP documents, or anything the user calls
"long"/"detailed"/"comprehensive" — draft a table of contents (heading
outline) before writing any body prose.

1. Build the heading outline from the reader and outcome gathered in §1 and
   the doctype's recommended skeleton (in its reference file).
2. **Review the outline from the reader's point of view before writing
   further**: read only the headings, in order, as the reader identified in
   §1 would. Check whether they can predict what they'll learn from each
   section, whether the order matches how they'd naturally look for that
   information, and whether following the outline gets them to the
   §1 outcome. Reorder, merge, or split headings if not — this is cheaper
   to fix in outline form than after the prose is written.
3. Only once the outline holds up under that reader-perspective read-through
   should you write the body, section by section.

Skip this step for inherently short, atomic artifacts (a single commit
message, a short PR description, one new entry appended to an existing
release-notes/CHANGELOG file, a code comment/docstring) and draft directly
under §3 — see the scope note at the top of
`references/style-constitution.md`. This exception is about a single
*entry*, not the release-notes/CHANGELOG document as a whole: a CHANGELOG
being drafted or restructured from scratch is still a living, multi-section
document and needs the outline step below.

## 3. Write — under the structure constitution

For living, multi-section documents (README, design doc, API reference,
release notes, user manual, requirements definition, system design, test
plan, operations runbook, migration plan, security design, technical
proposal, Blueprint, White Paper, RFI/RFP, Obsidian note, Zenn/Qiita article), write under
the 8 rules
in `references/style-constitution.md`. Summary: state "what this is" and
"the outcome for the reader" in the first three lines; make headings
labels that preview content (not "Overview", but "Overview of what");
order steps as executed and put prerequisites before the steps; one
action per numbered step; put a concrete example or number right after
any abstract term; keep code examples minimal and runnable, marking
omissions explicitly; disclose known limitations and unsupported cases
instead of hiding them; and keep a last-updated date or target version
where staleness is a real risk. For Zenn/Qiita, rule 1's "first three
lines" maps to the frontmatter `title` plus the lead paragraph right
after it. Zenn body sections start at `##`; Qiita body sections start at
`#` and use `##` for subsections.

For every Markdown doctype, surround `**strong emphasis**` with half-width
spaces when the delimiters would otherwise touch prose. For example, write
`これは **強調** になる`, not `これは**強調**にならない`. Spaces are not
required at line boundaries or next to punctuation, and must not be placed
inside the `**` delimiters. Use ASCII spaces (`U+0020`), never full-width
spaces (`U+3000`), tabs, or non-breaking spaces, immediately before and after
emphasis embedded in prose. Write `これは **「重要」** と説明する`, not
`これは　**「重要」**　と説明する`.

For atomic artifacts (commit messages, PR descriptions, issue reports,
code comments/docstrings, a single entry appended to an existing
release-notes/CHANGELOG file), follow their own skeleton in
`references/doctypes/pr-commit.md`, `references/doctypes/code-comments.md`,
or `references/doctypes/release-notes.md` instead — see the scope note in
`references/style-constitution.md` for why the 8 rules don't apply
verbatim there.

Sentence-level concerns — keeping individual sentences concise, avoiding
double negatives, not dropping the subject, and general naturalness — belong
to a prose-polishing skill. In `write` mode for a Japanese document, perform
the explicit handoff in §5 after the structure is complete. If no compatible
optimizer is available, still apply ordinary careful-writing judgment and
report the missing optimization pass explicitly.


## 4. Review — structural check

After writing, work through the following in order. For atomic artifacts
(commit message, PR description, issue report, code comment/docstring, a
single appended release-notes entry), steps 1 and 4 collapse into simply
re-reading the short artifact against its own doctype skeleton — treat
step 2 as the primary check for those.

1. **Skeleton read-through, from the reader's seat**: extract just the
   headings and the first sentence of each section, and re-read them as the
   §1 reader would — not as the author. Confirm the argument holds together
   and nothing assumes knowledge that reader doesn't have yet. If not,
   revisit how the headings are structured (for long documents, this is the
   same lens as the §2 outline review, now applied to the finished prose).
2. **Doctype checklist**: compare against the checklist at the end of the
   matching reference file.
3. **Structural lint**: where possible, run `uv run scripts/lint.py <file>`
   (add `--atomic` for a commit message, PR description, issue report,
   code comment/docstring, or a single release-notes entry) to
   mechanically catch heading-level skips, code blocks missing a
   language tag, leftover placeholders, suspicious links, and strong-emphasis
   delimiters that directly touch prose. Findings are flags, not mandates —
   deliberate exceptions can stay; note the reason briefly.
   Placeholder detection is lexical: `todo : pending` and `Todo：pending`
   are flagged, while ordinary lower/title-case todo names, compound names
   such as `TODO-cli`, URL tokens, inline link destinations, and code are
   excluded. Link labels and markers outside those tokens are still checked.
   Backtick spans require matching delimiter lengths; fences use the existing
   fence parser. Unpunctuated lowercase `todo finish this` remains ambiguous
   and accepted: use an uppercase marker or a colon for an unfinished item.
   A nonempty annotation such as `TODO (#123)` remains accepted without
   validating the ticket or reason; empty/unclosed annotations are flagged.
   This is not a full Markdown parser: multiline spans, reference links,
   nested destinations and list-container code parsing are not covered.
4. **Reader-goal recheck**: confirm the "what the reader can do after
   reading" outcome from §1 is actually achievable from this document alone.

## 5. Optimize Japanese prose without changing the structure — write mode only

For a living, multi-section document whose requested final language is
Japanese, read `references/japanese-prose-optimization.md` and hand the
completed draft to kotonoha's bundled `japanese-prose` skill. This pass is
mandatory for an in-scope document.

Load `japanese-prose` through the host's skill-loading mechanism. When only
installed skill files are exposed, resolve the sibling path
`<tech-writer-dir>/../japanese-prose/SKILL.md` first, then check
`.github/skills/japanese-prose/SKILL.md`,
`.claude/skills/japanese-prose/SKILL.md`,
`.copilot/skills/japanese-prose/SKILL.md`, and
`$HOME/.copilot/skills/japanese-prose/SKILL.md`, then
`$HOME/.claude/skills/japanese-prose/SKILL.md`. Load the discovered
`SKILL.md` and follow its quick or full workflow. A standard
`npx kotonoha install` installs this sibling skill automatically. Treat the
pass as unavailable only when someone copied or installed tech-writer without
its bundled sibling, or when the optimizer cannot start.

Freeze heading hierarchy, section order, identifiers, numeric facts,
citations, normative language, tables, code, commands, acceptance criteria,
and explicit risks before handoff. Require sentence-level optimization and
request AI-pattern diagnostics, reading-load review, and terminology checks
when their scripts are runnable, without changing those invariants. Missing
optional diagnostics are a reported limitation, not proof that the prose pass
did not run. After the prose pass, repeat the doctype checklist and structural
lint from §4.

For an in-scope Japanese document in `write` mode, report one explicit status.
Do not run this pass or report a status for atomic artifacts such as commit
messages, PR descriptions, issue reports, single release-note entries, or
code comments/docstrings unless the user explicitly requests prose polishing
and supplies the prose in a standalone file:

- `Japanese prose optimization completed`
- `Japanese prose optimization not performed`
- `Japanese prose optimization did not converge`

Across the complete write workflow, allow at most 15 optimizer handoffs,
including reruns after rubber-duck edits. If no compatible optimizer can be
loaded, use
`Japanese prose optimization not performed` and state the reason. If the
optimizer starts but fails, or an edit violates a frozen invariant, revert
the invalid edit and retry within the three-round limit; unresolved failures
or invariant violations use
`Japanese prose optimization did not converge`. Do not claim this
optimization from kotonoha's structural lint alone. Documents that are not
within the Japanese final-language scope defined above require no optimization
status.

## 6. Rubber-duck review loop — write mode only

After the structural review in §4 and any Japanese prose optimization in §5,
use the host's subagent mechanism to
launch an independent reviewer in the `rubber-duck` role to challenge the
completed document for meaningful problems that the authoring pass may have
missed. Prefer a registered `rubber-duck` agent when the host provides one;
otherwise use an independent general-purpose or critic-style subagent with
the same review prompt. Treat the reviewer as unavailable only when the host
has no independent subagent mechanism. Do not substitute the author's own
self-review: independence is the point of this pass. This loop is mandatory
for `write` mode; do not run it for `review` or `score` mode.

1. **Start the review with full context**: give the reviewer the target file,
   doctype, intended reader, one-sentence reader outcome from §1, and any
   explicit constraints or assumptions. Ask it to report concrete,
   actionable problems in correctness, logic, missing information, reader
   flow, examples, and stated limitations — not cosmetic preferences.
2. **Resolve every valid finding**: edit the document rather than merely
   listing proposed fixes. If a finding conflicts with a stated requirement
   or is factually inapplicable, record a one-line reason for declining it.
3. **Re-run the relevant checks after each edit round**: if a fix changed
   Japanese prose, repeat the §5 optimization over the changed prose before
   reporting its final status. Then repeat the doctype checklist and
   structural lint from §4 before asking for another rubber-duck review. A
   fix must not introduce a new structural defect or leave the final Japanese
   prose outside the completed optimization pass. If a required rerun cannot
   start because all 15 handoffs were already used, or cannot complete,
   report `Japanese prose optimization did not converge`, not `completed`.
4. **Review again with the prior decisions**: reuse the same reviewer context
   when supported. Otherwise, include the previous findings, applied fixes,
   and declined findings with their reasons in every new review prompt. Ask
   specifically for unresolved or newly introduced actionable findings.
5. **Use a bounded convergence rule**: allow at most five rubber-duck rounds
   for a living, multi-section document. For an atomic artifact, run one
   round and finish immediately if it is clean; only continue after an
   actionable finding, with a maximum of three rounds. A round is clean only
   when no unaddressed actionable correctness, logic, completeness,
   reader-flow, example, or limitation findings remain. A finding declined
   with a recorded requirement-based or factual reason is a resolved
   exception rather than an open finding. If another round runs, supply that
   exception back to the reviewer under step 4. Purely cosmetic preferences
   are not actionable.
6. **Report non-clean outcomes precisely**: if the host has no independent
   reviewer, label the result `review not performed` and do not claim the
   rubber-duck pass completed. If the round limit is reached with
   unaddressed actionable findings, or findings oscillate between
   contradictory requirements, label it `review did not converge` and
   include the latest unresolved findings and fixes already attempted.

## 7. Doctype checklist summary

See each reference file for detail. The items below are for living,
multi-section documents (README, design doc, API reference, release notes,
user manual, requirements definition, system design, test plan, operations
runbook, migration plan, security design, technical proposal, Blueprint,
White Paper, RFI/RFP, Obsidian note, Zenn/Qiita article). Atomic
artifacts (commit message, PR
description, issue report, code comment/docstring, a single appended
release-notes entry) are already covered by their own doctype checklist
via step 2 in §4 — these common items don't add extra requirements on top
of that. Common items to confirm:

- Do the first three lines convey the purpose and target reader?
- Does reading only the headings trace the whole document's flow?
- Are prerequisites/dependencies stated before the usage steps?
- Can code/command examples be copied and run as-is?
- Are known limitations/unsupported cases/caveats stated, not omitted?
- Where staleness is a real risk, is the version/last-updated date/target
  branch stated?

## Acknowledgment

The bundled prose optimizer is an original kotonoha implementation built on
[GiNZA](https://github.com/megagonlabs/ginza) (MIT License). Tech-writer owns
technical-document structure while japanese-prose uses GiNZA's morphology,
dependency, and named-entity analysis for sentence-level review.
