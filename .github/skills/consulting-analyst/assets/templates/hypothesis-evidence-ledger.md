# Hypothesis and evidence ledger

<State which decision question these hypotheses test and how the ledger will
prevent unsupported conclusions.>

## Hypotheses

| Hypothesis ID | Issue ID | Falsifiable proposition | Rationale, not proof | Confidence | Decision if true | Decision if false |
|---|---|---|---|---|---|---|
| HYP-001 | Q1.1 | <Proposition> | <Why plausible> | High / Medium / Low | <Consequence> | <Consequence> |

## Evidence

Use one evidence row per hypothesis pairing, or explicitly list multiple HYP
IDs when direction and limitations apply equally to all of them. If they
differ, use separate rows with the same EVD ID; repeated evidence is not
independent corroboration.

Preserve interpretations as `Interpretation` rows linked to their underlying
EVD IDs. Interpretations do not count as supporting evidence.

| Evidence ID | Hypothesis IDs | Direction | Statement type | Source ID and date | Finding or interpretation and underlying EVD IDs | Quality | Limitation |
|---|---|---|---|---|---|---|---|
| EVD-001 | HYP-001, <other applicable HYP IDs> | Supports / Weakens / Neutral | Fact / Estimate / Interpretation | SRC-001, <date> | <Finding, or interpretation with underlying EVD IDs> | High / Medium / Low | <Limitation> |

## Assumption register

Assumptions may guide analysis but do not count as supporting evidence.

| Assumption ID | Related issue or hypothesis | Assumption | Impact if false | Validation method | Owner | Deadline |
|---|---|---|---|---|---|---|
| ASM-001 | Q1.1 / HYP-001 | <Unverified condition> | <Impact> | <Method> | <Owner> | <Date> |

## Hypothesis decisions

A `Supported` hypothesis must cite at least one `Fact` or `Estimate` EVD row
whose direction is `Supports` for that hypothesis. Assumptions and
interpretations alone cannot establish `Supported` status.

| Hypothesis ID | Status | Reason | Remaining uncertainty | Next evidence action | Owner | Deadline |
|---|---|---|---|---|---|---|
| HYP-001 | Supported / Weakened / Rejected / Open | <Reason with EVD IDs; Supported requires at least one Fact or Estimate> | <Uncertainty> | <Action> | <Owner> | <Date> |

## Contradictions and alternative explanations

| ID | Related hypothesis | Counterevidence or alternative | Materiality | Resolution |
|---|---|---|---|---|
| ALT-001 | HYP-001 | <Alternative> | High / Medium / Low | <How handled> |
