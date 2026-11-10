# Blueprint type

A Blueprint defines an agreed future state and the coordinated path from the
current state to that future state. It can cover technology, business
capabilities, operating models, governance, or a combination of them. It is
broader and more directional than a system design, but more executable than a
vision statement or strategy narrative.

## Target reader

Sponsors, architects, transformation leads, delivery owners, governance
bodies, and affected teams who must align on the destination, sequence,
decision rights, dependencies, and measures of progress.

## Settle before writing

- The outcome and planning horizon covered by the Blueprint
- The current-state baseline and evidence supporting it
- The target capabilities and principles that constrain the future state
- The dimensions in scope: business, organization, process, data, technology,
  security, governance, or operations
- The authority that approves the Blueprint and owns subsequent changes
- The level of detail needed for funding, portfolio planning, or delivery

## Responsibility boundary

A Blueprint establishes direction, boundaries, target capabilities, major
building blocks, transformation workstreams, and sequencing. It does not
replace implementation-level system designs, detailed requirements, project
plans, operating procedures, or an investment approval proposal.

Use `system-design` when teams need buildable component, interface, data, and
deployment details. Use `technical-proposal` when the primary outcome is an
approval of one investment or approach. Use `blueprint` when multiple
initiatives or organizational and technical dimensions must converge on one
future state over time.

## Template

Start from `assets/templates/blueprint.md`.
The template is the Japanese-language skeleton; translate its headings when
the target document is English.

## Recommended skeleton

1. Intended outcome, planning horizon, scope, and authority
2. Drivers, principles, current-state baseline, and constraints
3. Target capabilities and future-state operating and technical views
4. Gap analysis, workstreams, dependencies, and transition states
5. Phased roadmap with entry, exit, and decision criteria
6. Governance, measures, risks, traceability, and change control

## Checklist

- [ ] Is the planning horizon and approval authority explicit?
- [ ] Is `Analysis status: Completed / Incomplete / Not performed` recorded
      separately from approval status, with `Evidence gaps` and the analysis
      handoff location (or none)?
- [ ] For `Incomplete`, are evidence gaps and confidence visible and every
      affected conclusion or recommendation expressed with conditional wording,
      or returned to consulting-analyst? For `Not performed`, are the scope and
      reason explicit without implying completed analysis?
- [ ] Is the current state supported by evidence rather than assumption?
- [ ] Are target capabilities stated before products or implementation detail?
- [ ] Are business, process, data, technology, security, governance, and
      operations dimensions included or explicitly marked out of scope?
- [ ] Does each gap map to a workstream, owner, dependency, and target state?
- [ ] Do roadmap phases have entry conditions, exit conditions, and measurable
      outcomes rather than dates alone?
- [ ] Are transition states, coexistence, migration, and decommissioning
      concerns visible?
- [ ] Are decision rights, exception handling, and change control defined?
- [ ] Can strategic drivers be traced through capabilities and workstreams to
      measures?
- [ ] Does traceability preserve relevant Q / HYP / FND / EVD and GAP / INT / CRT
      IDs from the consulting handoff alongside driver, principle, capability,
      gap, workstream, and KPI IDs? Are inapplicable links marked `N/A` with a
      reason without forcing consulting IDs when no consulting handoff exists?
- [ ] Are assumptions, risks, unresolved decisions, and superseded versions
      recorded?
- [ ] Does the header status match the approval outcome?
