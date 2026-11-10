# Requirements definition type

A requirements definition establishes agreement on what outcomes, scope,
capabilities, quality levels, and acceptance conditions a system must
satisfy. It describes the required behavior and measurable constraints
without prematurely prescribing the implementation architecture.

## Target reader

Business owners, product owners, users, architects, delivery teams,
operators, security reviewers, and approvers who must agree on what will be
built and how acceptance will be judged.

## Settle before writing

- The business problem, target users, and measurable outcome
- In-scope and out-of-scope business processes, systems, and data
- Requirement priorities and the authority that resolves conflicts
- Constraints covering budget, schedule, law, policy, and existing systems
- Measurable acceptance conditions for functional and non-functional needs
- The identifier or naming convention used for traceability

## Responsibility boundary

State what the system must achieve and the constraints it must meet. Do not
turn preferred products, component layouts, database schemas, or deployment
topologies into requirements unless they are genuine externally imposed
constraints. Put implementation choices in a system design document and
link them back to requirement IDs.

## Template

Start from `assets/templates/requirements-definition.md`.
The template is the Japanese-language skeleton; translate its headings when
the target document is English.

## Recommended skeleton

1. Agreement target, background, problem, purpose, and success measures
2. Scope, stakeholders, assumptions, and constraints
3. Business flow, business rules, and prioritized functional requirements
4. Measurable non-functional, data, and external-interface requirements
5. Migration, operation, acceptance, and traceability
6. Risks, open questions, approval, and change history

## Checklist

- [ ] Are purpose, scope, exclusions, stakeholders, assumptions, and
      constraints explicit?
- [ ] Does every requirement have a stable ID, priority, and independently
      verifiable acceptance condition?
- [ ] Are non-functional requirements measurable under stated conditions?
- [ ] Are data ownership, classification, retention, quality, and deletion
      requirements covered?
- [ ] Are external interfaces, migration, operations, and failure handling
      included where applicable?
- [ ] Can each requirement be traced to a problem or objective and forward
      to an acceptance test and design or implementation artifact?
- [ ] Are implementation preferences separated from actual constraints?
- [ ] Are unresolved items owned and time-bound, with approval and change
      history recorded?
