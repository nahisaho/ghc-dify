# Technical briefing presentation scenario

Use this scenario to explain an architecture, engineering change, technical
proposal, system behavior, or implementation approach to a technical audience.

- Working title: <presentation title>
- Audience: <engineers, architects, operators, reviewers>
- Prior-knowledge floor: <what can be assumed>
- Understanding or decision required: <outcome>
- Technical depth: Overview / Working knowledge / Review-ready
- Target slide count: <count or range>

## Scenario arc

| Stage | Audience question | Assertion to establish | Required evidence | Transition to next stage | Suggested slides |
|---|---|---|---|---|---:|
| Context | What system and constraint are we discussing? | <boundary, users, and constraints define the problem> | <context diagram, requirements> | Show where the current design fails or must change | 1–2 |
| Problem | What technical problem must be solved? | <specific quality or delivery gap requires a design response> | <failure mode, measurement, limitation> | State the design drivers used to judge solutions | 1–2 |
| Drivers | What properties matter most? | <requirements and quality attributes determine the design> | <NFRs, constraints, priorities> | Introduce the architecture that satisfies them | 1 |
| Architecture | How is the solution structured? | <components and boundaries assign clear responsibilities> | <context, container, deployment diagrams> | Walk through the critical behavior | 2–3 |
| Flow | What happens in the important scenarios? | <data and control flow meet functional and failure requirements> | <sequence, state, data flow> | Examine trade-offs and failure behavior | 1–3 |
| Trade-offs | Why this design instead of alternatives? | <accepted costs are justified by the design drivers> | <alternatives, benchmarks, risks> | Show that the design can be operated and evolved | 1–2 |
| Operations | How will it be secured, observed, scaled, and recovered? | <operational controls make the design production-ready> | <SLO, threat controls, runbook, capacity> | Close with implementation or review actions | 1–2 |
| Next step | What must the audience do next? | <review decision, implementation step, or open issue is explicit> | <owners, dates, unresolved decisions> | End with the required action | 1 |

## Technical evidence map

| Assertion | Requirement or decision ID | Source artifact | Confidence | Missing validation |
|---|---|---|---|---|
| <assertion> | <FR/NFR/ADR/Issue> | <file or URL> | High / Medium / Low | <test or review> |

## Complexity controls

- Terms requiring definition: <terms>
- Details delegated to appendix: <schemas, exhaustive tables, code>
- Diagrams required: <context, sequence, data, deployment>
- Known limitations: <unsupported or deferred behavior>

## Scenario acceptance checks

- The system boundary and design drivers appear before component detail.
- Architecture diagrams and processing flows carry the primary explanation.
- Alternatives and accepted trade-offs are explicit.
- Security, operation, failure, and recovery behavior are not deferred silently.
- The final stage identifies a review decision or implementation action.
