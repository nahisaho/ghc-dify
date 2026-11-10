# Analysis handoff contract

The handoff transfers reasoning and evidence without transferring ownership
of final prose or presentation design.

## Required fields

`synthesis-handoff.md` must include:

- Decision-maker and decision question
- Intended outcome and deadline
- Recommended answer and confidence
- Supporting issue, hypothesis, finding, source, and evidence IDs
- Assumptions and estimates
- Counterevidence and alternative interpretations
- Options, criteria, weights, and sensitivity when applicable
- Current, target, gap, intervention, and action IDs when applicable
- Risks, unresolved questions, and evidence-gathering actions
- Required destination and target doctype or presentation purpose
- Frozen items the receiving skill must preserve

## ID semantics and traceability

- `Q` identifies an issue; `HYP` a hypothesis; `FND` a synthesized finding.
- `SRC` identifies a source record; `EVD` an analysis evidence record linked
  to its source. Never rename a source record to `EVD` or overwrite analysis
  evidence with a source citation.
- `GAP` identifies a current-to-target gap; `INT` an intervention defined in
  Current–Target–Gap; `CRT` an option criterion; `ACT` a recommended action.
- Findings preserve their Q / HYP and EVD links and reference relevant
  GAP / INT / CRT IDs. Actions link to supporting FND IDs, related Q / HYP
  IDs, and applicable GAP / INT / CRT IDs. Transition risks reference the
  affected GAP / INT IDs.
- Preserve this chain in destination documents. Blueprint traceability keeps
  relevant Q / HYP / FND / EVD and GAP / INT / CRT alongside its driver,
  principle, capability, workstream, and KPI IDs. White Paper claims link
  relevant HYP / FND / EVD IDs, while source records remain SRC IDs.
- Use only defined, relevant IDs. Mark inapplicable links `N/A` with a reason;
  do not require consulting IDs when no consulting handoff exists.

If `Analysis status` is `Incomplete`, the receiving skill must either return
the decision-critical gaps for further analysis or visibly preserve the
incomplete status, evidence gaps, confidence, and conditional nature of every
affected conclusion. It must not convert an incomplete handoff into an
unqualified recommendation.

## Handoff to tech-writer

`tech-writer` owns document structure, doctype completeness, Markdown, and
reader-facing prose. It may:

- Reorder analysis to fit the doctype
- Rename headings
- Condense repeated evidence
- Add doctype-required metadata and controls

It must not:

- Change evidence IDs or source meaning
- Present assumptions as facts
- Remove counterevidence that affects the conclusion
- Change criteria, weights, scores, confidence, or recommendation without
  returning the change to analysis

## Handoff to presentation-planner

`presentation-planner` owns audience reasoning, scenario, slide order, and
visual handoff. It may:

- Select the shortest evidence set that supports the audience decision
- Split findings across slides
- Adapt the order for the audience's prior knowledge

It must preserve:

- The decision question and requested action
- Evidence status and confidence
- Material caveats and counterevidence
- Option-comparison logic
- Conditions that would change the recommendation

## Return conditions

Return the handoff to `consulting-analyst` when:

- A new conclusion is required
- New evidence changes confidence or ranking
- The audience asks a different decision question
- Criteria or target-state dimensions change
- Communication edits expose a contradiction in the analysis
