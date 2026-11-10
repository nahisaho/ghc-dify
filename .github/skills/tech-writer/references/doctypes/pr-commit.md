# PR description / commit message / issue report type

This doctype directly affects a reviewer's decision speed, so apply it more
strictly than the other types.

## Commit messages

### Format

```text
<type>: <summary (imperative mood, ~50 chars)>

<body (optional) - what and why the change was made; the diff already
shows the "what" implementation details, so don't repeat them>

<footer (optional) - Fixes #123, BREAKING CHANGE: ... etc.>
```

- Use imperative mood consistently in the summary line (e.g. "Fix", not
  "Fixed"/"Fixes").
- The body should explain *why* the change was made, not restate *what*
  changed — the diff already shows that.
- One concern per commit. Don't bundle unrelated changes into one commit
  message.

### Checklist

- [ ] Can the change be inferred from the summary line alone (not just
      "fix" or "update")?
- [ ] Does the body explain "why" rather than paraphrase the diff?
- [ ] Is the related issue number in the footer?

## PR descriptions

### Recommended skeleton

1. **What**: what changed, in 1–3 sentences.
2. **Why**: why this change is needed (link to the background issue, bug
   report, or request).
3. **How**: the main approach. Leave implementation detail to code
   comments and the diff; state only the design decisions here.
4. **How to verify**: concrete steps the reviewer can use to reproduce and
   verify — test commands, or where to find screenshots/GIFs.
5. **Impact / breaking changes**: state explicitly if this affects other
   teams' code or API consumers.
6. **Remaining work / follow-ups** (if applicable): preempt likely review
   questions about unfinished items.

### Checklist

- [ ] Are What/Why/How separated, so reading only "What" gives the shape
      of the change?
- [ ] Are there concrete steps (commands, URLs, repro conditions) the
      reviewer can use to verify locally?
- [ ] Are breaking changes, DB migrations, config changes — anything a
      reviewer could miss and cause an incident — near the top?
- [ ] Is there a link to the related issue/ticket?
- [ ] For UI changes, are screenshots actually attached?

## Issue reports (bug reports / feature requests)

### Bug report skeleton

1. **Summary**: the symptom, in one sentence.
2. **Steps to reproduce**: numbered, with environment info (version, OS,
   browser, etc.) stated *before* the steps.
3. **Expected vs. actual result**: contrast them explicitly.
4. **Impact**: who is affected, and how often.

### Feature request skeleton

1. **Problem to solve**: state the situation causing pain before the
   feature itself.
2. **Proposed solution** (optional): if you have one in mind.
3. **Alternatives considered** (optional).

### Checklist (issues, common)

- [ ] Are the repro steps (or use case) concrete enough to reproduce
      independent of the reader's environment?
- [ ] Are "expected" and "actual" explicitly contrasted (bug reports)?
- [ ] Is environment info stated before the repro steps?
