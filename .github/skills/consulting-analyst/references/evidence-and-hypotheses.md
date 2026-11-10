# Evidence and hypothesis discipline

The analysis must preserve the difference between what is known, estimated,
assumed, interpreted, and recommended.

## Statement types

| Type | Meaning | Required handling |
|---|---|---|
| Fact | Directly supported by a traceable source | Record source, date, scope, and limitations |
| Estimate | Quantified approximation | Record method, range, sensitivity, and owner |
| Assumption | Unverified condition used to proceed | Record validation plan and impact if false |
| Interpretation | Meaning inferred from facts or estimates | Show the reasoning and alternatives |
| Recommendation | Proposed action | Trace to findings, constraints, and decision criteria |

## Hypothesis record

A useful hypothesis includes:

- A specific proposition
- The issue-tree leaf it answers
- Why it is plausible
- Supporting evidence expected
- Disconfirming evidence expected
- A confidence level
- A decision consequence if true or false

Do not write confidence as a percentage unless it comes from a defined model
or elicitation method. Use `High`, `Medium`, or `Low` with a short rationale.

## Evidence quality

Assess evidence by:

- Directness: does it measure the claimed phenomenon?
- Reliability: can the source and method be trusted?
- Recency: is it current enough for the decision?
- Representativeness: does it cover the relevant population and context?
- Independence: does it corroborate rather than repeat another source?
- Materiality: could it change the conclusion or action?

Record contradictory evidence beside supporting evidence. Do not relegate it
to an appendix that the synthesis ignores.

Use one evidence row per hypothesis pairing, or explicitly list multiple HYP
IDs if the direction and limitations are the same for each hypothesis. Where
they differ, reuse the EVD ID in separate pairing rows; this does not create
independent corroboration.

Preserve interpretations as `Interpretation` rows with links to underlying
EVD IDs and alternative explanations. Interpretations do not count as
supporting evidence. A `Supported` hypothesis requires at least one `Fact` or
`Estimate` EVD row marked `Supports` for that hypothesis; assumptions and
interpretations alone are insufficient.

## Causal claims

Before stating that one factor caused another, check:

- Temporal order
- Plausible mechanism
- Alternative explanations
- Selection and measurement bias
- Whether an intervention changed the outcome

When these conditions are not met, use association or contribution language
instead of causation.

## Evidence gaps

For every decision-critical gap, record:

- Missing evidence
- Why it matters
- Best available collection method
- Owner
- Deadline
- Decision that must wait or proceed conditionally

An explicit unknown is better than a fabricated conclusion.
