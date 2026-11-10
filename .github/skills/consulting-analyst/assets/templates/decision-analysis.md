# Decision analysis

Use the Current–Target–Gap section, the option-comparison section, or both
only when they are required by the decision.

## Current–Target–Gap

| Dimension | Current state and evidence | Target state and measure | Gap ID | Intervention ID | Required intervention | Dependency | Owner |
|---|---|---|---|---|---|---|---|
| <Capability, process, data, technology, governance, people, or operations> | <State and EVD IDs> | <State and target> | GAP-001 | INT-001 | <Intervention> | <Dependency> | <Owner> |

### Transition risks

| Risk ID | Gap or intervention IDs | Risk | Trigger | Mitigation | Decision owner |
|---|---|---|---|---|---|
| RSK-001 | GAP-001 / INT-001 | <Risk> | <Trigger> | <Mitigation> | <Owner> |

## Option criteria

Define criteria and weights before scoring options.

| Criterion ID | Criterion | Definition | Direction | Weight | Scoring anchors | Mandatory threshold |
|---|---|---|---|---:|---|---|
| CRT-001 | <Criterion> | <Definition> | Higher / Lower is better | <Percent> | 1=<anchor>, 3=<anchor>, 5=<anchor> | <Threshold or none> |

The weights must sum to 100%. Record and resolve any exception before scoring.

## Option score details

Use one row per option and criterion so every score has its own evidence.

| Option | Criterion ID | Score | Weight | Weighted score | Evidence | Rationale and caveat |
|---|---|---:|---:|---:|---|---|
| <Option> | CRT-001 | <1–5> | <Percent> | <Score × weight> | <EVD IDs> | <Why this anchor applies> |

## Option summary

| Option | Weighted total | Mandatory threshold result | Disqualified | Rank | Material caveat |
|---|---:|---|---|---:|---|
| <Option> | <Total> | Pass / Fail | Yes / No | <Rank> | <Caveat> |

## Sensitivity analysis

At minimum, test:

1. Equal weights across all criteria
2. A one-anchor increase and decrease for the top-weighted criterion scores
3. A plausible weight shift away from the highest-weighted criterion
4. Every case where a change causes a rank flip or threshold failure

| Scenario | Exact perturbation | Recalculated ranking | Rank or threshold change | Decision impact |
|---|---|---|---|
| Base case | None | <Ranking> | None | <Impact> |
| Equal weights | <Weights> | <Ranking> | <Change> | <Whether recommendation changes> |
| Score stress | <Option, criterion, ±1 anchor> | <Ranking> | <Change> | <Impact> |
| Weight stress | <Criterion and weight change> | <Ranking> | <Change> | <Impact> |

## Decision interpretation

- Recommended option or intervention set: <Answer>
- Why the arithmetic supports but does not determine the judgment: <Reason>
- Conditions that would change the ranking: <Conditions>
