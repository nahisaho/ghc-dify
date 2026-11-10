---
name: presentation-planner
description: >-
  Plans the content structure and visual design handoff for PowerPoint/PPTX
  presentations without generating or editing the .pptx file itself. Use for
  requests like "create a PowerPoint", "make a PPTX", "design a slide deck",
  "turn this proposal into slides", 「PowerPointを作って」「PPTXを作成して」
  「提案書をスライドにして」「プレゼン資料の構成を作って」
  「プレゼンシナリオを作って」. Produces a presentation brief, reusable
  scenario-based narrative, slide-by-slide outline, design specification,
  and handoff instructions for the host's dedicated PPTX creation skill. Does
  NOT implement PPTX generation, python-pptx/PptxGenJS code, binary editing,
  rendering, thumbnail creation, or visual-overlap inspection; those remain
  the responsibility of the dedicated PPTX skill. Does NOT handle simple
  edits to an existing deck, single-slide changes, or direct generation when
  the storyline and design are already settled; use the dedicated PPTX skill
  directly for those requests.
license: MIT
argument-hint: "[plan|review] <presentation request or source files>"
---

# presentation-planner

Plans what a presentation must communicate, how the story progresses, and
which visual system the PPTX renderer must apply. The output is a complete
handoff package for a dedicated PPTX creation skill, not a `.pptx` file.

## Responsibility boundary

Read `references/responsibility-boundary.md` before acting. This skill owns:

- Audience, objective, decision, and call-to-action definition
- Scenario selection, audience reasoning journey, and slide ordering
- One-message-per-slide content architecture
- Evidence and source mapping
- Selection and adaptation of a packaged design specification
- A deterministic handoff contract for the host's PPTX skill

When a presentation request still lacks a defined decision question,
evidence-backed findings, or option analysis, load kotonoha's sibling
`consulting-analyst` skill first. Consume its `synthesis-handoff.md` rather
than inventing business conclusions during storyline design. Preserve its
evidence IDs, confidence, counterevidence, decision criteria, and conditions
that would change the recommendation. If the sibling skill is absent, ask for
the decision question and evidence or label conclusions as unverified.

If the handoff status is `Incomplete`, either return decision-critical gaps
for further analysis or show the incomplete status, evidence gaps, confidence,
and conditional wording in the presentation plan. Return to analysis when
new evidence, a different audience decision, changed criteria, or a
contradiction would change the conclusion.

This skill must not:

- Create, edit, unzip, or inspect `.pptx` binaries
- Write PowerPoint generation code using python-pptx, PptxGenJS, COM, or
  similar libraries
- Render slides, create thumbnails, or detect visual overlap
- Reimplement layout or visual QA tooling supplied by the host's PPTX skill

When the host provides a registered `pptx` or PowerPoint creation skill,
delegate binary generation and visual QA to it. If no such skill is
available, still produce the five planning artifacts and report
`PPTX generation not performed`; do not silently implement a renderer.

## Execution modes

- `plan` (default): gather context, produce the five handoff artifacts, and
  delegate generation when a PPTX skill is available.
- `review`: review existing brief, scenario, outline, and design spec for
  audience fit, storyline gaps, evidence gaps, and handoff ambiguity. Do not
  inspect the binary presentation.

## 0. Route direct PPTX operations away

Before intake, skip this skill and use the dedicated PPTX skill directly
when any of the following is true:

- The request is a mechanical edit to an existing deck
- Only one slide, title, image, note, or formatting property must change
- The user supplied a final scenario, slide outline, and design with no
  request to restructure them
- The task is only binary generation, rendering, conversion, or visual QA

Use `presentation-planner` when the audience, storyline, evidence,
slide sequence, or visual system still needs design.

## 1. Gather context one question at a time

Ask only the single most informative missing question, then wait. Stop once
the following are known:

1. Target audience and what they already know
2. The decision, action, or understanding the presentation must produce
3. Presentation setting: meeting type, speaking time, and target slide count
4. Source material and evidence that may be cited
5. Required language, aspect ratio, brand rules, and accessibility needs
6. Whether an existing `.pptx` or brand template must be reused

If an existing `.pptx` must be reused, ask the host's PPTX skill to inspect
its theme and layouts. Consume the returned design summary; do not inspect
the binary in this skill.

## 2. Choose a packaged design specification

Choose the closest design under `assets/design-templates/`:

| Design | Use when | Avoid when |
|---|---|---|
| `executive-proposal.yaml` | Approval, investment, roadmap, or executive decision | Dense technical training |
| `technical-briefing.yaml` | Architecture, engineering explanation, technical proposal | Primarily financial reporting |
| `data-report.yaml` | KPI review, research findings, operational or analytical reporting | Slides without credible data |

Read `references/design-spec-schema.md` and adapt the selected design into
the presentation's `design-spec.yaml`. Preserve the schema keys so the PPTX
skill can consume it predictably.

For project-specific changes or new reusable templates, follow
`references/customizing-design-templates.md`.

## 3. Build the storyline before slide content

Read `references/scenario-templates.md`, then choose the closest scenario
under `assets/scenario-templates/`:

| Scenario | Use when |
|---|---|
| `executive-decision.md` | Approval, investment, roadmap, policy, or option selection |
| `technical-briefing.md` | Architecture, engineering behavior, or technical review |
| `data-report.md` | KPI, research, experiment, survey, or operational analysis |

Copy and adapt it into `presentation-scenario.md`. Use the shortest storyline
that gets the audience to the intended outcome. The selected template's
scenario arc is authoritative; keep its stage names unless the adaptation
records why a stage is removed, merged, or renamed.

When none of the packaged templates fits, use this generic fallback:

1. **Context**: why the audience should care now
2. **Tension**: the problem, gap, risk, or opportunity
3. **Evidence**: facts that establish scale and credibility
4. **Resolution**: the proposed answer or interpretation
5. **Plan**: actions, owners, cost, timing, and controls
6. **Decision**: the exact approval, action, or next step

Remove a stage when it adds no decision value. Do not add agenda, section
divider, or summary slides merely to increase slide count.

## 4. Produce the five handoff artifacts

Write the artifacts under `.presentation/<deck-slug>/` unless the user
specifies another directory. Derive a stable, filesystem-safe slug from the
presentation title so multiple decks do not overwrite each other.

### `presentation-brief.md`

Include:

- Working title and one-sentence purpose
- Audience and prior-knowledge floor
- Decision or call to action
- Setting, duration, slide count, language, and aspect ratio
- Source files and citation expectations
- Constraints, non-goals, and known unknowns
- Selected design template and reason

### `presentation-scenario.md`

Copy and adapt one packaged scenario template. If no packaged template fits,
write the generic fallback arc from §3 into this file using the same fields:
stage, audience question, assertion, required evidence, transition, and
suggested slide range. Include:

- Current and intended audience position
- One assertion and audience question per scenario stage
- Required evidence, source status, and assumptions
- The transition that makes the next stage relevant
- Likely objections, uncertainty, and trade-offs
- The exact final decision, action, or understanding

The scenario defines the reasoning journey, not individual slide content.

### `slide-outline.md`

Use one row per slide:

| # | Scenario stage(s) | Assertion title | Audience takeaway | Evidence/source | Visual form | Speaker note purpose |
|---:|---|---|---|---|---|---|

Rules:

- Titles state the slide's conclusion, not its topic
- Each slide has one primary message
- Every slide maps to at least one scenario stage; separate multiple stage
  names with ` / `
- Evidence is traceable to a source or marked as an assumption
- Visual form is specific: comparison table, timeline, architecture diagram,
  annotated chart, process, quote, or full-bleed image
- A slide must earn its place by advancing the decision or outcome

### `design-spec.yaml`

Copy and adapt one packaged design specification. Set `base_template` to the
packaged template ID and change `id` to a unique value such as
`<deck-slug>:<base-template>`. Resolve its placeholders, then record any
deliberate deviation in a `deviations` list.

### `pptx-handoff.md`

Follow `references/handoff-contract.md`. It must tell the PPTX skill:

- Exact input artifact paths
- Exact output `.pptx` path
- Required design template and deviations
- Slide count and aspect ratio
- Source and citation rules
- Required speaker notes and accessibility behavior
- Binary-generation and visual-QA acceptance checks

## 5. Validate the planning package

Before handoff, verify:

- Reading only assertion titles reproduces the full argument
- Reading only scenario-stage assertions reproduces the audience journey
- Every slide maps to at least one stage without introducing an unsupported
  conclusion
- The final slide asks for the exact intended decision or action
- Every factual or quantitative claim has a source or assumption marker
- No slide has more than one primary message
- Visual forms vary with the information instead of repeating one layout
- The design spec contains all required schema keys
- The handoff assigns all binary and visual checks to the PPTX skill

Use an independent `rubber-duck` reviewer when available. Fix actionable
findings and repeat for at most five rounds. A round is clean when no
unaddressed correctness, storyline, evidence, design, or handoff findings
remain. If the reviewer is unavailable, report `review not performed`. If
five rounds end with actionable findings, report `review did not converge`
with the unresolved findings and attempted fixes.

## 6. Delegate PPTX creation

Pass the five artifact paths to the host's dedicated PPTX skill. The PPTX
skill may choose its own implementation library, but it must preserve the
approved storyline and design tokens unless it reports a concrete rendering
constraint.

After generation, require the PPTX skill to report:

- Output file path and slide count
- Render/thumbnail review result
- Overlap, clipping, contrast, and font-substitution checks
- Missing assets or unsupported design instructions
- Any deviation from `slide-outline.md` or `design-spec.yaml`

Do not claim a presentation is complete from this planning skill alone.
