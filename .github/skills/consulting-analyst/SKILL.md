---
name: consulting-analyst
description: >-
  Structures ambiguous business and technical problems before writing or
  presentation design. Uses consulting frameworks selectively—not
  mechanically—to define the decision question, build issue trees, form and
  test hypotheses, compare current and target states, evaluate alternatives,
  and synthesize evidence into an actionable recommendation. Use for requests
  like "structure this problem", "build an issue tree", "analyze the root
  cause", "compare these options", "create a transformation roadmap",
  "prepare the analysis for a Blueprint or White Paper",
  「課題を構造化して」「論点を整理して」「仮説を検証して」
  「現状と目標のGapを分析して」「選択肢を比較して」
  「BlueprintやWhite Paperの分析を準備して」. Produces analysis artifacts
  and handoff inputs for tech-writer and presentation-planner. Does not own
  final document prose, slide design, implementation design, or factual
  research that has not been supplied or independently verified.
license: MIT
argument-hint: "[analyze|review|handoff] <problem, decision, or source files>"
---

# consulting-analyst

Turns an ambiguous problem into a defensible chain from question to evidence,
conclusion, and action. Frameworks are tools for reducing uncertainty, not
formats that must be filled.

## Responsibility boundary

This skill owns:

- Decision-question and success-condition definition
- Issue decomposition and MECE review
- Hypotheses, evidence needs, confidence, and falsification conditions
- Current-state, target-state, and gap analysis
- Explicit option criteria, weighting, scoring, and sensitivity analysis
- Synthesis into findings, implications, recommendations, and next actions
- Structured handoff to `tech-writer` or `presentation-planner`

This skill does not:

- Invent facts, customer evidence, market data, estimates, or citations
- Treat assumptions as verified findings
- Write the final technical document when `tech-writer` is available
- Design slide narratives or visual systems when `presentation-planner` is
  available
- Replace requirements, system design, project planning, financial modeling,
  legal review, or domain-expert judgment

When the user asks directly for a Blueprint, White Paper, proposal, or
presentation and the underlying analysis is incomplete, complete this
analysis pass first, then hand the result to the owning writing or
presentation skill.

## Modes

- `analyze` (default): create or revise the analysis artifacts and produce a
  synthesis handoff.
- `review`: challenge an existing analysis for missing branches, unsupported
  claims, hidden assumptions, biased criteria, weak evidence, and conclusions
  that do not follow.
- `handoff`: normalize existing analysis into the handoff contract without
  repeating completed work.

## 1. Gather context one question at a time

Ask only the single most informative missing question, then wait. Stop when
the following are known or explicitly recorded as unknown:

1. The decision-maker or actor who will use the analysis
2. The exact decision, problem, or question to resolve
3. The measurable outcome or decision deadline
4. Scope, constraints, and excluded topics
5. Available evidence, source files, and known data gaps
6. Required destination: analysis only, document, Blueprint, White Paper,
   proposal, or presentation

Do not ask the user which framework to use unless they have a mandatory
method. Select the smallest framework set that resolves the question.

## 2. Create the analysis workspace

Write artifacts under `.consulting/<analysis-slug>/` unless the user specifies
another directory. Use a stable, filesystem-safe slug so separate analyses do
not overwrite one another.

In `analyze` mode, create:

1. `analysis-brief.md`
2. `issue-tree.md`
3. `hypothesis-evidence-ledger.md`
4. `synthesis-handoff.md`

Start from the matching files under `assets/templates/`.
The packaged templates use English canonical field names. Translate headings
and instructions into the requested output language while preserving artifact
filenames, IDs, statement types, status values, and table semantics.

Create `decision-analysis.md` only when Current–Target–Gap analysis or option
comparison is in scope. Record omitted artifacts and the reason in
`synthesis-handoff.md`. In `review` mode, update only artifacts affected by
the findings. In `handoff` mode, normalize the supplied analysis without
creating empty framework artifacts.

## 3. Select frameworks by decision need

Read `references/framework-selection.md`. Use no more than three primary
frameworks in one analysis unless the user explicitly requests a broader
study.

| Decision need | Primary framework |
|---|---|
| Decompose an ambiguous question | Issue Tree / logic tree |
| Test an explanation or proposed answer | Hypothesis–Evidence–Falsification |
| Explain cause rather than symptoms | Causal tree / 5 Whys with evidence |
| Define a future state and transformation path | Current–Target–Gap |
| Compare alternatives transparently | Weighted decision matrix |
| Communicate the final reasoning | Pyramid Principle / SCQA |

SWOT, 3C, PESTLE, Five Forces, capability maps, and impact/effort matrices
may be supporting lenses. Do not use them unless each field changes a
decision, hypothesis, criterion, or action.

## 4. Build a testable issue tree

Use `references/evidence-and-hypotheses.md`.

1. Write one decision question at the root.
2. Decompose by one explicit logic at each level, such as causes, options,
   capabilities, lifecycle stages, or economics.
3. Make sibling branches collectively sufficient for the parent question and
   remove material overlap.
4. Mark branches as `priority`, `supporting`, `out of scope`, or `unknown`.
5. Define what evidence would answer every priority leaf.

Do not claim perfect MECE when the domain is uncertain. Record residual
overlap and known omissions.

## 5. Form hypotheses and manage evidence

For each priority issue:

- State the hypothesis as a falsifiable proposition
- Record why it is plausible without presenting that rationale as proof
- Define evidence that supports and weakens it
- Identify source, date, owner, and confidence
- Separate `fact`, `estimate`, `assumption`, `interpretation`, and
  `recommendation`
- Set the next evidence-gathering action and owner

Never upgrade an assumption to a finding because it appears in several
frameworks. Repetition is not corroboration.

## 6. Analyze gaps or alternatives

Use the path that fits the decision:

### Current–Target–Gap

Describe current and target states with the same dimensions and evidence
standard. Map each material gap to an intervention, dependency, owner,
measure, and transition risk. Do not jump directly from aspiration to a
roadmap.

### Weighted decision matrix

Define criteria before scoring options. State:

- Criterion definition and direction
- Weight and rationale
- Scoring scale with anchors
- Evidence behind each score
- Mandatory thresholds or disqualifiers
- Sensitivity to plausible changes in weights or scores

The arithmetic supports judgment; it does not replace it.

## 7. Synthesize without overclaiming

Build the synthesis in this order:

1. **Answer**: the current best answer to the decision question
2. **Because**: two to four mutually distinct supporting findings
3. **Evidence**: traceable sources and confidence for each finding
4. **So what**: implication for the decision-maker
5. **Now what**: action, owner, timing, and validation checkpoint
6. **Uncertainty**: assumptions, counterevidence, and conditions that would
   change the recommendation

Use the Pyramid Principle for the final reasoning structure. Use SCQA only
when it clarifies the audience's path to the question; do not manufacture
dramatic tension.

## 8. Handoff to the owning skill

Read `references/handoff-contract.md`.

- For a technical or business document, pass `synthesis-handoff.md` to
  `tech-writer`, including the target doctype.
- For a presentation, pass it to `presentation-planner`, including the exact
  audience decision and evidence status.
- When both are requested, write the source document first unless the user
  explicitly prioritizes the presentation.

The receiving skill may restructure the communication, but it must preserve
evidence IDs, confidence, assumptions, disconfirming evidence, decision
criteria, and unresolved questions.

## 9. Quality gate

Before reporting completion, confirm:

- The root question names an actor and decision
- Every recommendation traces to findings and evidence
- Every priority issue has an answer, explicit unknown, or next action
- Facts, estimates, assumptions, and interpretations remain distinguishable
- A hypothesis marked `Supported` cites at least one `Fact` or `Estimate`;
  that evidence must support the specific hypothesis. Assumptions and
  interpretations may guide analysis but never count as supporting evidence
- Criteria and weights were defined before option scoring
- Decision-matrix weights sum to 100%, and sensitivity checks follow the
  minimum procedure in `decision-analysis.md`
- Current and target states use comparable dimensions
- Counterevidence and uncertainty are visible
- No framework section exists only because a template contained it
- Every omitted artifact is named with the reason it was unnecessary
- The handoff identifies what the next skill may and may not change

If evidence is insufficient, report `analysis incomplete` with the unresolved
decision-critical gaps. Do not create a success-shaped recommendation.

## Completion report

Report:

- Mode and selected frameworks with reasons
- Artifacts created or reviewed
- Decision question and current answer
- Confirmed findings, assumptions, and unresolved evidence gaps
- Handoff destination, if any
- `analysis completed` or `analysis incomplete`
