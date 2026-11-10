# PPTX handoff contract

Use this structure for
`.presentation/<deck-slug>/pptx-handoff.md`.

## Inputs

- Brief: `<path>/presentation-brief.md`
- Scenario: `<path>/presentation-scenario.md`
- Slide outline: `<path>/slide-outline.md`
- Design specification: `<path>/design-spec.yaml`
- Source materials: `<paths>`

## Output

- PPTX path: `<path>/<filename>.pptx`
- Aspect ratio: `<16:9 / 4:3 / custom>`
- Expected slide count: `<count or range>`

## Rendering requirements

- Preserve slide order and assertion titles.
- Preserve the approved scenario stages and audience reasoning journey.
- Require every slide to map to at least one scenario stage; preserve
  multi-stage mappings recorded with ` / ` in the outline.
- Treat evidence and citation fields as content requirements.
- Apply semantic design tokens from `design-spec.yaml`.
- Add speaker notes where specified.
- Add alt text or an equivalent description for informative visuals.
- Do not invent quantitative claims or citations.

## Required visual QA

- Render every slide to an image or thumbnail.
- Check clipping, overlap, off-canvas objects, font substitution, and
  unreadable contrast.
- Check charts for legible labels, units, legends, and source notes.
- Check diagrams for readable flow direction and connector attachment.
- Report every deviation from the outline or design specification.

## Completion report

Return:

1. Output path and final slide count
2. Visual QA result
3. Missing or substituted assets/fonts
4. Deviations from the scenario, outline, or design and their reasons
5. Remaining manual-review items
