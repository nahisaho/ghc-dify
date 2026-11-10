# User manual / how-to guide / tutorial type

For this doctype, quality is almost entirely determined by "can the reader
actually reproduce this by following it", so apply it more strictly than
the other types.

## Target reader

Someone using the target product/feature for the first time, or after a
long gap. Assume thin prior knowledge of jargon.

## Settle before writing

1. **Floor of prior knowledge**: state up front "this guide assumes you
   already know X". Without it, the reader pays a recurring cost of
   deciding whether they're the intended audience.
2. **Completion condition**: at the end of the steps, state what "success"
   looks like in a verifiable form (a screen shown, a value returned, a
   file produced).

## Recommended skeleton

1. **What this guide gets you**: the first three lines (rule 1 of the
   structure constitution).
2. **Prerequisites**: required permissions, installed software, versions.
   A separate section, before the steps.
3. **Steps**: one action per numbered step (rule 4). Each step has three
   parts:
   - the action to take (command/click target)
   - how the screen/output changes afterward (so the reader can
     self-verify they're on track)
   - any tricky branch point, noted right there (not collected at the end)
4. **Completion check**: a concrete way to verify "if you see this,
   you've succeeded".
5. **Troubleshooting**: symptom → cause → fix, as a table. Avoid phrasing
   that just offloads the problem to the reader, like "if you see an
   error, contact your administrator".

## Tutorial-specific notes

- A tutorial's goal is "one success experience via the shortest path", not
  exhaustive coverage. Move advanced options to a "further reading"
  section instead of lengthening the main steps.
- Placing a verification point (screenshot, expected output sample) right
  after each step lets the reader proceed without doubt.

## Checklist

- [ ] Are prerequisites (permissions/environment/pre-installs) stated in
      their own section before the steps?
- [ ] Is each step a single action, with information to confirm the state
      change after executing it?
- [ ] Is the completion condition stated in a verifiable form (screen,
      output, artifact)?
- [ ] Is troubleshooting in "symptom → cause → fix" form, without
      offloading action entirely to the reader?
- [ ] Is jargon given a brief explanation on first use (relative to the
      target reader's prior knowledge)?
