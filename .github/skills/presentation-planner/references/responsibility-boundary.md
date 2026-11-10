# Responsibility boundary with the PPTX creation skill

`presentation-planner` and the host's PPTX skill are complementary.

| Concern | presentation-planner | PPTX creation skill |
|---|---:|---:|
| Audience, outcome, and decision | Owns | Consumes |
| Scenario and audience reasoning journey | Owns | Preserves |
| Storyline and slide sequence | Owns | Preserves |
| Assertion titles and evidence mapping | Owns | Renders |
| Design tokens and layout intent | Owns | Implements |
| `.pptx` binary creation and editing | Never | Owns |
| python-pptx/PptxGenJS/COM code | Never | Owns |
| Theme/layout extraction from an existing PPTX | Requests and consumes summary | Owns |
| Rendering and thumbnails | Never | Owns |
| Overlap, clipping, and font checks | Defines acceptance criteria | Executes |
| Speaker notes insertion | Specifies content | Implements |

## Conflict rule

If both skills could act, `presentation-planner` runs first and creates the
handoff package. The PPTX skill starts only after the planning artifacts are
complete. For a simple mechanical edit to an existing presentation where
the storyline and design are unchanged, skip `presentation-planner` and use
the PPTX skill directly.

## Failure rule

If the PPTX skill cannot implement a requested visual instruction, it must
report the constraint and proposed fallback. The planning skill may update
the design spec or slide outline, but it must not work around the constraint
by manipulating the PPTX binary itself.
