# Qiita article type

The article title lives in YAML frontmatter. Qiita's readership skews toward
searching for a specific error message or task, so apply rule 3 (order
matching how the reader looks for information) especially strictly here.

## Target reader

A developer who arrived via search for a specific error, API, or task, and
is scanning to confirm this article addresses their exact situation.

## Format

Markdown, with Qiita's frontmatter and a few platform-specific extensions
on top of GFM. The frontmatter `title` is the article title; body sections
start at `#`, with `##` used for subsections.

## Recommended frontmatter

```yaml
---
title: <Article title>
tags:
  - <tag1>
  - <tag2>
private: false # true: limited-share draft, false: public
organization_url_name: null # only if publishing under an Organization
---
```

- `title` and `tags` are required; `private` defaults the article to
  public once posted, so confirm it deliberately rather than leaving the
  default unconsidered.
- Qiita CLI also manages `updated_at`/`id`/`slide`/`ignorePublish` fields
  automatically on publish/update — don't hand-edit those unless you know
  why.

## Template

Start from `assets/templates/qiita.md`.
Use `#` for the highest-level body sections and `##` for their subsections.

## Recommended skeleton

1. **Lead paragraph (right after frontmatter, before any heading)**: the
   specific problem/error/task this article addresses and what the reader
   will be able to do — this is rule 1's "first three lines" analog, since
   there's no in-body title to carry it.
2. **Environment / versions**: state the exact versions (language,
   framework, OS) the article was verified against, before any steps —
   Qiita readers frequently hit version-specific breakage.
3. **Body sections, one concern per `#` heading**: order by how a reader
   arriving via search would scan (rule 3) — put the fix/answer before
   background explanation if the article is troubleshooting-oriented. Use
   `##` only for subsections within one concern.
4. **Code blocks with both a language tag and, where relevant, a filename**:
   Qiita supports ` ```js:example.js ` — prefer this over a bare language
   tag when the file identity matters to the reader.
5. **References / further reading** (if applicable): official docs or
   related articles, not a restatement of the body.

## Checklist

- [ ] Are `title` and `tags` present, and is `private` a deliberate choice
      rather than an unconsidered default?
- [ ] Does the lead paragraph right after frontmatter state the specific
      problem/task addressed, since there's no in-body title to do that?
- [ ] Do highest-level body sections use `#`, with `##` reserved for
      subsections?
- [ ] Are the exact versions/environment stated before the steps?
- [ ] For troubleshooting-oriented articles, does the fix appear before
      background explanation, matching how a reader arriving via search
      would scan?
- [ ] Do code blocks carry a language tag (and a filename where the file
      identity matters)?
