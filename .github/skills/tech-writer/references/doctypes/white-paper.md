# White Paper type

A White Paper helps a defined audience understand a consequential problem,
evaluate evidence, and reach an informed conclusion. It may explain an
emerging topic, establish a point of view, or describe a solution pattern,
but it must distinguish evidence from interpretation and must not disguise
marketing claims as independent analysis.

## Target reader

Decision-makers, practitioners, evaluators, customers, partners, regulators,
or industry readers who need a credible explanation and a defensible basis
for action.

## Settle before writing

- The reader's decision, question, or misconception the paper addresses
- The central claim and what evidence could weaken or disprove it
- The publication scope, date boundary, geography, and intended longevity
- The research method and acceptable source quality
- The publisher's relationship to products, services, sponsors, or cited data
- The desired next action, without overstating certainty

## Responsibility boundary

A White Paper explains and supports a position. It is not a requirements
specification, implementation design, sales brochure, academic paper, or
contractual promise. Product examples may illustrate a finding, but factual
claims, estimates, customer outcomes, and recommendations must remain
traceable to named evidence and limitations.

Use `technical-proposal` for an internal approval request, `blueprint` for a
future state and transformation roadmap, and `white-paper` for an
evidence-led public or stakeholder-facing argument.

## Template

Start from `assets/templates/white-paper.md`.
The template is the Japanese-language skeleton; translate its headings when
the target document is English.

## Recommended skeleton

1. Title, abstract, target reader, central claim, and disclosure
2. Problem definition, scope, terminology, and research method
3. Evidence-led findings with confidence and limitations
4. Options, solution pattern, recommendation, and adoption considerations
5. Counterarguments, risks, boundaries, and conclusion
6. References, evidence ledger, glossary, authorship, and revision history

## Checklist

- [ ] Does the abstract state the problem, conclusion, audience, and practical
      consequence?
- [ ] Is `Analysis status: Completed / Incomplete / Not performed` recorded
      separately from publication status, with `Evidence gaps` and the analysis
      handoff location (or none)?
- [ ] For `Incomplete`, are evidence gaps and confidence visible and every
      affected conclusion or recommendation expressed with conditional wording,
      or returned to consulting-analyst? For `Not performed`, are the scope and
      reason explicit without implying completed analysis?
- [ ] Is the central claim specific enough to challenge with evidence?
- [ ] Are facts, estimates, interpretations, and recommendations visibly
      distinguished?
- [ ] Does every consequential claim link to a source or evidence identifier?
- [ ] Does the evidence ledger keep SRC source records separate from EVD analysis
      evidence, preserving their IDs and meaning?
- [ ] Do claims and findings link relevant HYP / FND / EVD IDs from the handoff,
      marking inapplicable links `N/A` with a reason without forcing consulting
      IDs when no consulting handoff exists?
- [ ] Are interpretations preserved without counting as supporting evidence,
      with `Supported` hypotheses backed by relevant Fact / Estimate evidence?
- [ ] Are source date, scope, method, sample, and limitations available?
- [ ] Are contradictory evidence and credible alternatives addressed?
- [ ] Are product, sponsor, author, and data-source relationships disclosed?
- [ ] Are publication approval and legal, compliance, and claims reviews
      recorded, including approval to use customer names and quantitative
      claims?
- [ ] Does `Approved for Publication` match a complete approval record, with
      a reason recorded for every review marked not applicable?
- [ ] Are case studies labeled and prevented from implying universal results?
- [ ] Does the recommendation state where it does not apply?
- [ ] Can readers reproduce the source trail and identify the document's
      publication and revision dates?
