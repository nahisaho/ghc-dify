# System design type

A system design explains how approved requirements will be realized through
architecture, components, data, interfaces, deployment, security, quality
controls, and operations. It must be detailed enough for implementation,
testing, operation, and review without duplicating source code.

## Target reader

Architects, developers, testers, operators, security reviewers, and technical
approvers who must verify that the design satisfies the requirements and can
be built and operated safely.

## Settle before writing

- The approved requirements baseline and stable requirement IDs
- The system boundary, design scope, environments, and external dependencies
- The most important quality attributes and their measurable targets
- Constraints on technology, deployment, security, compliance, cost, and time
- The level of design detail needed for implementation and review
- The owner of unresolved design decisions

## Responsibility boundary

Describe implementation choices and trace them to requirements. Do not
silently redefine scope or acceptance criteria from the requirements
definition. If the design exposes a missing, conflicting, or infeasible
requirement, record it as an open issue and update the approved requirements
through change control.

Use `design-doc` or an ADR for one isolated decision and its alternatives.
Use `system-design` when the reader needs the integrated design across
components, data, interfaces, deployment, quality attributes, and operations.
Its test, operation, migration, and security sections summarize the design
decisions needed to understand the whole system. Split out a `test-plan`,
`operations-runbook`, `migration-plan`, or `security-design` when that topic
needs executable procedures, independent evidence, a different approval
authority, or a separate lifecycle. When a standalone document exists, it is
the source of truth for that topic; the system design links to and summarizes
it instead of duplicating details.

## Template

Start from `assets/templates/system-design.md`.
The template is the Japanese-language skeleton; translate its headings when
the target document is English.

## Recommended skeleton

1. Agreement target, scope, assumptions, constraints, and design drivers
2. Context, container, component, and processing-flow design
3. Data, transaction, interface, and error-contract design
4. Security, performance, capacity, availability, and reliability design
5. Deployment, network, observability, operation, backup, and recovery
6. Migration, release, rollback, test traceability, trade-offs, and approval

## Checklist

- [ ] Is the design boundary clear, and is the approved requirements
      baseline identified?
- [ ] Are major components assigned cohesive responsibilities with explicit
      dependencies and interfaces?
- [ ] Are data ownership, schemas, integrity, transactions, retention, and
      deletion addressed?
- [ ] Are authentication, authorization, encryption, audit, secrets, and
      threat controls concrete and testable?
- [ ] Are performance, capacity, availability, timeout, retry, idempotency,
      backup, RTO, and RPO decisions quantified?
- [ ] Are deployment, network boundaries, configuration, observability,
      release, operation, and incident handling implementable?
- [ ] Are migration, compatibility, rollback, and failure recovery covered?
- [ ] Is every major design element traced to requirements and tests?
- [ ] Are rejected alternatives, accepted trade-offs, risks, open decisions,
      reviewers, and change history recorded?
