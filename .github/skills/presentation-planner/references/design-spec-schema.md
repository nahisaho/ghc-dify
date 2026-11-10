# Design specification schema

Each packaged YAML design uses the following stable top-level keys.

| Key | Purpose |
|---|---|
| `id` | Unique specification identifier; change it for an adapted deck |
| `base_template` | Packaged template ID from which the spec was adapted |
| `intent` | Presentations this design supports |
| `canvas` | Aspect ratio, dimensions, safe area, and grid |
| `colors` | Semantic color tokens and chart sequence |
| `typography` | Font families, sizes, weights, and line spacing |
| `spacing` | Margins, gaps, and density limits |
| `components` | Cards, callouts, tables, charts, and diagrams |
| `slide_patterns` | Supported layout intents, not binary PPTX layouts |
| `accessibility` | Contrast, minimum type, alt text, and color-use rules |
| `constraints` | Rules the PPTX skill must not violate |
| `deviations` | Deliberate differences from the packaged base template |

## Portable component vocabulary

Use only these renderer-independent values unless a deviation explains the
fallback:

| Field | Allowed values |
|---|---|
| `corner_radius` | `none`, `small`, `medium`, `large` |
| `shadow` | `none`, `subtle`, `medium` |
| `charts.style` | `direct-label`, `technical`, `analytical` |
| `charts.gridlines` | `none`, `subtle`, `minimal` |
| `charts.series_outline` | `none` or an exact key under `colors` |
| `charts.direct_labels_required` | `true` or `false` |
| `connector_style` | `simple`, `orthogonal`, `curved` |
| `cards.border` | `none` or an exact key under `colors` |
| `tables.header_fill` | `none` or an exact key under `colors` |
| `tables.header_text` | an exact key under `colors` |

Values that reference a color token must exactly match a key under `colors`,
for example `accent_soft`, not a display label such as `accent-soft`.
Do not assume that `accent` text is readable on `accent_soft`; validate the
actual foreground/background pair against `minimum_contrast_ratio`.

The packaged designs expose Microsoft's four corporate logo colors as
`brand_red`, `brand_green`, `brand_blue`, and `brand_yellow`. Treat them as
brand or decorative tokens, not as an automatic categorical chart palette.
Do not use them for small text on white unless the actual pair passes the
contrast threshold; `brand_yellow` requires a direct label plus pattern or
marker encoding on a white canvas.

The packaged categorical `chart_sequence` is intentionally capped at three
well-separated series: dark Microsoft blue, Microsoft red, and neutral gray.
When a chart needs more than three series, add pattern, marker, or shape
encoding instead of appending the remaining logo colors.

`charts.series_outline: background` separates adjacent stacked, pie, or area
segments; it does not make a light fill visible against the canvas. Use
direct labels and pattern or marker encoding for light series.

Nested typography and component keys may be omitted when irrelevant. A
renderer must use its documented defaults for missing optional keys rather
than treating every packaged template as an identical nested schema.

## Adaptation rules

- Keep the documented top-level keys stable. Optional nested keys may vary by
  presentation intent.
- Use brand colors only after assigning semantic roles such as `accent`,
  `positive`, `warning`, and `critical`.
- Do not specify absolute object coordinates. Layout engines differ; use
  proportions, alignment, safe areas, and maximum element counts.
- Prefer one dominant visual hierarchy per slide.
- Record all changes from the packaged template under `deviations`.
