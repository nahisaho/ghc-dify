# Zenn article type

For this platform, the title lives in YAML frontmatter, not an in-body
heading, and readers decide whether to keep reading within the first
screen — apply rule 1 of the structure constitution to the frontmatter
`title` plus the lead paragraph together, not to an in-body '#'.

## Target reader

A developer scanning Zenn's feed or search results, deciding in a few
seconds whether this article solves their problem right now.

## Format

Markdown, with Zenn's frontmatter and a few platform-specific extensions
on top of GFM. No in-body '#' heading for the article title — sections
start at '##'.

## Recommended frontmatter

```yaml
---
title: "<Article title>"
emoji: "<One emoji representing the article>"
type: "tech" # "tech" for a technical explanation, "idea" for an opinion/experience piece
topics: ["<1-5 lowercase topics>"]
published: false # flip to true only when ready to publish
---
```

- `title`, `emoji`, `type`, `topics`, `published` are all required by Zenn;
  a missing or malformed field can silently block publishing.
- Pick `type: "tech"` vs `"idea"` deliberately — it changes how the
  article is categorized and discovered, not just a label.

## Recommended skeleton

1. **Lead paragraph (right after frontmatter, before any heading)**: what
   this article gets the reader, and why now — this is rule 1's "first
   three lines", since there's no in-body title to carry it.
2. **Prerequisites** (if applicable): versions, environment, prior
   knowledge assumed, before any steps.
3. **Body sections, one concern per `##` heading**: order them the way the
   reader would naturally need the information (rule 3).
4. **Code blocks with both a language tag and, where relevant, a filename**:
   Zenn supports ` ```js:example.js ` — prefer this over a bare language
   tag when the file identity matters to the reader.
5. **`:::message` / `:::message alert` boxes for asides**: use these for
   genuinely non-obvious caveats or warnings, not routine notes — overuse
   dilutes their signal.
6. **Closing summary or "next steps" section** (if the article is long):
   what the reader should now be able to do, echoing the lead paragraph's
   promise.

## Checklist

- [ ] Are all five required frontmatter fields present and non-empty
      (`title`, `emoji`, `type`, `topics`, `published`)?
- [ ] Does the lead paragraph right after frontmatter state what this
      article gets the reader, since there's no in-body title to do that?
- [ ] Is `type` ("tech" vs "idea") a deliberate choice, not a default left
      unconsidered?
- [ ] Do code blocks carry a language tag (and a filename where the file
      identity matters)?
- [ ] Are `:::message` boxes reserved for genuinely non-obvious asides
      rather than routine notes?
