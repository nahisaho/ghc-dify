# Migration plan type

A migration plan defines how data, users, integrations, and business
processes move from a current state to a target state with measurable
validation, controlled downtime, and a tested rollback path.

## Target reader

Migration leads, application and data engineers, business owners, operators,
support teams, security reviewers, and Go/No-Go approvers.

## Settle before writing

- The current and target states and complete migration inventory
- Allowed downtime, data-loss tolerance, and business continuity needs
- Migration approach, waves, dependencies, and change-freeze conditions
- Reconciliation and business-acceptance criteria
- Go/No-Go and rollback authority, triggers, and deadlines
- Rehearsal evidence, communication needs, and post-migration support

## Responsibility boundary

Own the executable transition plan and its decisions. Link to implementation
scripts rather than embedding large programs. Do not claim rollback is
possible unless the plan states how post-cutover writes and data consistency
will be handled.

The migration section in `system-design` is sufficient for describing the
chosen transition architecture. Use a standalone `migration-plan` when the
cutover needs rehearsals, a timed procedure, business communications,
Go/No-Go gates, reconciliation evidence, or separate approval. When both
exist, the migration plan is authoritative for execution and the system
design summarizes the strategy and links to it.

## Template

Start from `assets/templates/migration-plan.md`.
The template is the Japanese-language skeleton; translate its headings when
the target document is English.

## Recommended skeleton

1. Agreement target, current and target states, scope, and constraints
2. Inventory, dependencies, mappings, transformation, and migration method
3. Roles, rehearsals, readiness, and timed production procedure
4. Reconciliation, Go/No-Go gates, rollback, and business continuity
5. Security, communication, stabilization, decommissioning, and approval

## Checklist

- [ ] Are all data, configuration, identities, integrations, and business
      processes inventoried with owners and dependencies?
- [ ] Are mapping, transformation, default, rejection, retry, and idempotency
      rules explicit?
- [ ] Have full-scale timing, validation, and rollback been rehearsed?
- [ ] Are start, cutover, reopen, Go/No-Go, and rollback conditions objective?
- [ ] Do reconciliation checks cover counts, aggregates, referential
      integrity, and business scenarios?
- [ ] Does rollback address writes made after cutover and its last safe time?
- [ ] Are downtime communications, alternative operations, support, security,
      temporary access, and evidence covered?
- [ ] Are stabilization, cleanup, old-system retention, and decommissioning
      conditions defined?
