# Customizing presentation design templates

Use this guide to adapt a packaged design for one presentation or to add a
new reusable design to kotonoha. Design templates are YAML specifications;
they are not `.pptx` theme files and do not replace the host's PPTX creation
skill.

## Choose between a deck override and a packaged template

Use a **deck override** when one presentation needs different colors, type,
spacing, or component behavior. Copy a packaged design into:

```text
.presentation/<deck-slug>/design-spec.yaml
```

Use a **new packaged template** only when the design will be reused across
multiple presentations or teams. Add it under:

```text
skills/presentation-planner/assets/design-templates/<template-id>.yaml
```

Do not edit a packaged template merely to customize one deck; that changes
future presentations and makes upgrades harder to compare.

## Copy and identify an adapted design

1. Copy the closest packaged YAML file to the deck directory.
2. Set `base_template` to the packaged template's original `id`.
3. Change `id` to a deck-specific value such as
   `<deck-slug>:<base-template>`.
4. Keep every documented top-level key from
   `design-spec-schema.md`.
5. Record intentional changes under `deviations`.

Example:

```yaml
id: migration-proposal:executive-proposal
base_template: executive-proposal
deviations:
  - "Use the customer-approved heading font."
  - "Increase the table row limit from 7 to 9 for the appendix."
```

## Change colors by semantic role

Change the meaning-bearing token rather than replacing colors wherever they
appear.

```yaml
colors:
  background: "#FFFFFF"
  surface: "#F3F3F3"
  text_primary: "#1B1B1B"
  text_secondary: "#505050"
  accent: "#005A9E"
  accent_soft: "#E5F1FB"
  border_neutral: "#8A8886"
  positive: "#107C10"
  warning: "#8A5A00"
  critical: "#A4262C"
```

The packaged designs expose Microsoft's corporate logo colors as brand
tokens:

```yaml
brand_red: "#F25022"
brand_green: "#7FBA00"
brand_blue: "#00A4EF"
brand_yellow: "#FFB900"
```

Keep the following rules when changing the palette:

- Keep `background` white unless the presentation requirement explicitly
  overrides the packaged visual direction.
- Maintain at least the declared `minimum_contrast_ratio` for text.
- Do not use the four logo colors for small text on white without checking
  the actual contrast.
- Give `brand_yellow` and other low-contrast chart series a direct label plus
  pattern or marker encoding.
- Never use color as the only way to communicate status or series identity.
- Keep categorical charts to the packaged three-series sequence where
  possible; use pattern, marker, or shape encoding for additional series.

## Change typography and spacing

Update font families only when the target environment has them or the PPTX
skill can embed or substitute them predictably.

```yaml
typography:
  heading_font: "Aptos Display"
  body_font: "Aptos"
  title_size_pt: 30
  body_size_pt: 18

spacing:
  outer_margin_percent: 6
  content_gap_percent: 2
  card_padding_percent: 2
```

- Keep body text at or above `accessibility.minimum_body_size_pt`.
- Use percentages for margins and gaps instead of absolute object
  coordinates.
- Record required font substitutions in `deviations`.

## Change components and slide patterns

Use only values documented in `design-spec-schema.md`.

```yaml
components:
  tables:
    header_fill: accent_soft
    header_text: text_primary
    maximum_rows: 7
  charts:
    style: direct-label
    gridlines: minimal
    direct_labels_required: true
    series_outline: background
```

`slide_patterns` declares supported presentation intents, not PowerPoint
layout names or coordinates. Add a pattern only when the handoff can describe
its information structure and the PPTX skill can render it without
template-specific code in `presentation-planner`.

## Validate an adapted design before handoff

Check all of the following:

- The YAML parses successfully.
- All top-level keys from `design-spec-schema.md` remain present.
- Every token reference resolves to a key under `colors`.
- Text and table-header foreground/background pairs meet the contrast floor.
- Chart series remain distinguishable without color alone.
- `id`, `base_template`, and `deviations` describe the adaptation accurately.
- The PPTX handoff points to the adapted file, not the packaged base file.

If the renderer cannot implement a token or component value, update the
design spec with an explicit fallback. Do not add PPTX generation code to
this skill.

## Add a reusable packaged template

When adding a new base template:

1. Add `<template-id>.yaml` under `assets/design-templates/`.
2. Add the template to the selection table in `SKILL.md`.
3. Document its intended and unsuitable use cases.
4. Add the filename to the packed-artifact test in `test/install.test.js`.
5. Update `CHANGELOG.md`.
6. Run the repository tests, Markdown lint, YAML schema checks, and contrast
   checks before committing.
