# Technical Document Structure Constitution (8 rules)

Constraints to fix a technical document's *structure* before writing.
Sentence-level naturalness, vocabulary, and rhythm are out of scope here
(→ the domain of kotonoha's bundled `japanese-prose` skill).

## Scope: living documents vs. atomic artifacts

These 8 rules assume a **living, multi-section reference document** —
README, design doc/ADR, API reference, release notes/CHANGELOG file as a
whole, user manual, requirements definition, system design, test plan,
operations runbook, migration plan, security design, technical proposal,
Blueprint, White Paper, RFI/RFP (including a supplier's RFP response), or
Zenn/Qiita article. Apply all 8 rules to those doctypes. For Zenn and Qiita,
rule 1's article title lives in YAML frontmatter — see their
doctype reference files for the platform-specific fields. Zenn body sections
start at `##`; Qiita body sections start at `#` and use `##` for subsections.
Every other rule (code examples, disclosed limitations, etc.) still applies
verbatim.

**Atomic, single-purpose artifacts** — commit messages, PR descriptions,
issue reports, code comments/docstrings, and a single new entry appended
to an existing release-notes/CHANGELOG file — have their own skeleton in
`references/doctypes/pr-commit.md`, `references/doctypes/code-comments.md`,
and `references/doctypes/release-notes.md` that already encodes the
equivalent discipline in a form that fits their size (e.g. a PR
description's What/Why/How opens the same way rule 1 asks a README to; a
single release-notes entry opens with its version/date heading instead of
a title-plus-paragraph). Follow that doctype's own skeleton for those
instead of applying the heading-hierarchy and document-metadata rules
below verbatim; where the two disagree, the doctype reference wins.

## Markdown emphasis spacing

In generated Markdown, add half-width spaces outside strong-emphasis
delimiters when they touch surrounding prose. Write
`これは **強調** になる` rather than `これは**強調**にならない`.
The spaces are unnecessary at a line boundary or next to punctuation, for
example `**重要**: 設定を確認する`. Use ASCII spaces (`U+0020`), not
full-width spaces (`U+3000`), tabs, or non-breaking spaces, immediately before
and after emphasis embedded in prose. Write `これは **「重要」** と説明する`,
not `これは　**「重要」**　と説明する`. Never put spaces inside the
delimiters.

## 1. Say "what this is" and "the outcome" in the first three lines

Readers decide "is this relevant to me" within the first three lines. Don't
open with background or acknowledgments. State up front what the document is
for and what the reader can do after reading it.

- Bad (Japanese example): 「本プロジェクトは日々成長を続けており、多くの貢献者の協力により…」
- Good (Japanese example): 「kotonoha は技術文書の構成を整えるための Copilot スキルです。README・設計書・PR説明文などを型に沿って書けます。」

## 2. Make headings labels that preview content

Generic labels like "Overview", "Usage", "Notes" tell the reader nothing
until they read the body. Include *what* is being overviewed or used.

- Bad: `## Overview` `## Usage` `## Notes`
- Good: `## What kotonoha solves` `## Installing the skill into .github/skills` `## Behavior without sudachipy installed`

## 3. Order steps as executed, and put prerequisites before the steps

Readers execute a document top to bottom. Placing prerequisites
(dependencies, permissions, prior setup) mid-way or at the end forces
readers to redo work partway through. Always give prerequisites their own
section before the steps.

## 4. One action per numbered step

Don't pack multiple actions into one numbered item. "Install A, configure B,
and run C" should be three steps. Numbered steps let readers track exactly
where they are.

## 5. Put a concrete example or number right after an abstract term

Words like "fast", "safe", "flexible", "easy to understand" convey nothing
by themselves. Follow them immediately with a concrete number, condition, or
code example.

- Bad: "lint.py runs fast."
- Good: "lint.py processes a 10,000-character document in under 1 second (excluding sudachipy initialization)."

## 6. Keep code examples minimal and runnable; mark omissions explicitly

A code example that doesn't run as copy-pasted costs the reader time before
they realize it's broken. When omitting something, mark it explicitly (e.g.
`# ...`) and note that the reader should substitute their own values.

## 7. Disclose known limitations and unsupported cases; don't hide them

"Not yet supported" or "doesn't work under this condition" doesn't lower a
document's value — it prevents the reader's wasted effort. State it in its
own section instead of omitting it.

## 8. Keep a last-updated date or target version/branch where staleness is a real risk

A living reference document (README, design doc, API reference, user
manual) starts going stale the moment it's written. When such a document
could plausibly be read long after it stops being accurate, state when or
against what version/branch it was written, so the reader doesn't pay an
extra verification cost of "is this still accurate?" Skip this rule for
artifacts whose own metadata already carries that information (a commit
timestamp, a PR's merge date, a versioned release-notes heading).
