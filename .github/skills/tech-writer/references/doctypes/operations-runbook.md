# Operations design and runbook type

An operations design and runbook makes a production service observable,
changeable, recoverable, and supportable. It combines stable operating
policies with executable procedures for routine work and incidents.

## Target reader

Service owners, on-call engineers, operators, support staff, security teams,
change approvers, and incident commanders.

## Settle before writing

- The service boundary, owners, dependencies, and operating hours
- SLI, SLO, alert, capacity, backup, RTO, and RPO targets
- On-call, escalation, change, and incident authority
- Access requirements and safety constraints for operational actions
- The symptoms and failure scenarios that require executable runbooks
- Review, exercise, and expiration frequency

## Responsibility boundary

Write steps that an authorized operator can execute and verify. Link to
automation where it exists, but preserve preconditions, safety checks,
expected results, escalation, and recovery behavior. Never include secret
values or bypass access and change controls.

The operations section in `system-design` is sufficient for architectural
operability decisions. Use a standalone `operations-runbook` when on-call
staff need executable procedures, alerts, escalation, exercises, or a review
cycle independent of the system design. When both exist, the runbook is
authoritative for live operations and the system design links to its current
approved version.

## Template

Start from `assets/templates/operations-runbook.md`.
The template is the Japanese-language skeleton; translate its headings when
the target document is English.

## Recommended skeleton

1. Service scope, dependencies, levels, owners, and escalation
2. Observability, alerts, routine work, and capacity management
3. Incident severity, common initial response, and symptom runbooks
4. Start, stop, restore, security, change, and rollback procedures
5. Disaster recovery, business continuity, risks, exercises, and review

## Checklist

- [ ] Can an unfamiliar authorized operator identify the service, owner,
      dependencies, dashboards, communication channels, and impact?
- [ ] Are SLI/SLO calculations, alert conditions, suppression, and test
      frequency specified?
- [ ] Does every procedure state preconditions, safety limits, steps,
      expected results, evidence, escalation, and recovery?
- [ ] Are backup restoration, RTO/RPO, disaster recovery, and exercises
      executable and owned?
- [ ] Are access, secret, certificate, vulnerability, audit, and security
      incident operations covered without exposing secret values?
- [ ] Are releases, emergency changes, rollback, and post-change checks clear?
- [ ] Are capacity, cost, routine maintenance, review dates, and stale
      runbook detection addressed?
