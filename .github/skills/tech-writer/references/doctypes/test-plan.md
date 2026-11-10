# Test plan type

A test plan defines how requirements and quality risks will be verified,
which environments and data are needed, and what evidence permits a release
or acceptance decision. It covers planning and traceability rather than
replacing executable test code.

## Target reader

Test leads, developers, product owners, business acceptance testers,
operators, security reviewers, and release approvers.

## Settle before writing

- The approved requirements and design baselines
- The approved security-design baseline and security test IDs, when present
- In-scope systems, environments, platforms, and quality attributes
- The highest-impact quality risks and required test levels
- Measurable entry, exit, and release criteria
- Environment, data, tooling, staffing, and schedule constraints
- Defect severity definitions and residual-risk approval authority

## Responsibility boundary

Define the verification strategy, cases, criteria, ownership, and evidence.
Keep detailed automation implementation in test code. A test plan must not
weaken an approved acceptance criterion; record conflicts as open issues and
resolve them through requirement change control.

The test section in `system-design` is sufficient while verification remains
an integrated design summary. Use a standalone `test-plan` when execution
needs its own environments, schedule, evidence, release gates, or approvers.
When both exist, the test plan is authoritative for test execution and
release evidence, while the system design retains the architectural rationale.
When a `security-design` exists, import its security test, threat, and control
IDs. Preserve `SEC-TC-*` as the planned security-test identity and map it to
the executable `TC-*` case that produces release evidence.

## Template

Start from `assets/templates/test-plan.md`.
The template is the Japanese-language skeleton; translate its headings when
the target document is English.

## Recommended skeleton

1. Agreement target, baselines, scope, quality goals, and risks
2. Test levels, non-functional testing, environment, and data
3. Entry, exit, release, and residual-risk criteria
4. Requirement-to-test traceability and defect management
5. Schedule, ownership, evidence, risks, and approval

## Checklist

- [ ] Are the requirement and design baselines uniquely identified?
- [ ] Are scope, exclusions, environments, platforms, data, and production
      differences explicit?
- [ ] Does the strategy prioritize tests using concrete quality risks?
- [ ] Are functional and non-functional criteria measurable?
- [ ] Can every Must requirement and acceptance condition be traced to tests?
- [ ] Can every applicable security test, threat, and control be traced from
      the security design to an executable case and its evidence?
- [ ] Are entry, exit, defect, release, and residual-risk criteria objective?
- [ ] Are suspension and resumption conditions defined for blocked or invalid
      test cycles?
- [ ] Are evidence storage, ownership, schedule, and approval defined?
- [ ] Are test-data privacy, cleanup, and environment reset covered?
