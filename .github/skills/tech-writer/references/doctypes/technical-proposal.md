# Technical proposal type

A technical proposal asks decision-makers to approve a technical approach,
budget, and delivery plan. It is broader than an ADR: it must connect the
architecture to measurable outcomes, implementation cost, risks, and a
recorded decision.

This doctype is for an internal approval proposal. For a supplier's
technical bid in response to an RFP, structure the response against the
RFP's requirement IDs, requested proposal contents, pricing, and contract
deviations instead of using this template.

## Target reader

The person or group accountable for approving the investment, accepting the
trade-offs, and assigning implementation ownership.

## Settle before writing

- The exact decision or approval being requested
- The current problem and measurable target outcome
- Budget, deadline, security, compliance, and staffing constraints
- At least one alternative, including the current-state baseline
- The evaluation period used for total cost of ownership

## Template

Start from `assets/templates/technical-proposal.md`.
The template is the Japanese-language skeleton; translate its headings when
the target document is English.

## Recommended skeleton

1. Decision requested and executive summary
2. Background, measurable goals, and non-goals
3. Proposed architecture, data, and security
4. Delivery, rollout, rollback, cost, and staffing
5. Alternatives using shared cost, time, effort, and risk axes
6. Risks, success metrics, unresolved questions, and decision record

## Checklist

- [ ] Is the requested decision stated before the implementation detail?
- [ ] Are goals measurable, with an action if a target is missed?
- [ ] Are non-goals, assumptions, and constraints explicit?
- [ ] Does the comparison include a current-state baseline and shared axes?
- [ ] Are initial cost, annual recurring cost, and TCO period comparable?
- [ ] Are rollout, rollback, security, risks, and ownership covered?
- [ ] Can the final approver, date, and decision be recorded in the document?
