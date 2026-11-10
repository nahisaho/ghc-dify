# Presentation scenario templates

A presentation scenario defines the audience's reasoning journey between the
brief and the slide-by-slide outline. It is not a script and does not repeat
all slide content. It records the assertions, evidence, transitions,
objections, and final action that make the deck persuasive and coherent.

## Artifact boundary

| Artifact | Question it answers |
|---|---|
| `presentation-brief.md` | Who is the audience, and what outcome is required? |
| `presentation-scenario.md` | What reasoning journey moves them to that outcome? |
| `slide-outline.md` | Which slides deliver each assertion and piece of evidence? |
| `design-spec.yaml` | Which visual system expresses the content? |
| `pptx-handoff.md` | How must the PPTX skill generate and validate the deck? |

Do not use the scenario as a second slide outline. A scenario stage may span
several slides, or two stages may share one slide when the argument remains
clear.

## Choose a template

| Template | Use when | Avoid when |
|---|---|---|
| `executive-decision.md` | The audience must approve an option, investment, roadmap, or policy | The goal is purely educational |
| `technical-briefing.md` | The audience must understand or review architecture and technical behavior | The deck is primarily KPI analysis |
| `data-report.md` | Findings, trends, research, or experiments must support an action | Credible data is unavailable |

Copy the closest template to
`.presentation/<deck-slug>/presentation-scenario.md`, then remove stages that
do not advance the required outcome. Do not add stages or slides merely to
match the template.

If none fits, create `presentation-scenario.md` from the generic fallback in
`SKILL.md`, preserving the same stage, audience-question, assertion, evidence,
transition, and suggested-slide-range fields used by packaged templates.

## Adaptation rules

- Express each stage as an assertion the audience must accept.
- Record the audience question answered by each stage.
- Map factual claims to sources or mark them as assumptions.
- State the transition: why accepting one stage makes the next relevant.
- Include objections, uncertainty, and trade-offs before the final action.
- Keep the final decision or call to action singular and testable.
- Set suggested slide counts only as planning ranges, never quotas.

## Validation

- Reading only stage assertions reconstructs the argument.
- Every stage changes what the audience knows, believes, or is ready to do.
- Evidence strength matches the certainty of the assertion.
- The slide outline maps every slide to a scenario stage.
- No slide introduces a new conclusion absent from the approved scenario.
