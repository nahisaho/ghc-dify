# Japanese prose review workflow

## Review findings in context

For every diagnostic finding, record one decision:

- `fix`: the expression increases ambiguity, reading load, or mechanical
  repetition for the intended reader
- `keep`: the expression is required by accuracy, domain convention, quoted
  material, or deliberate rhythm

Do not count a finding as resolved merely because the triggering text
disappeared. Confirm that the replacement preserves meaning.

## Check sentence structure

- The subject and predicate can be identified without rereading.
- Modifiers sit close to the words they modify.
- A long sentence contains one main relationship.
- Negation does not require the reader to reverse the meaning twice.
- Noun chains expose ownership, purpose, and target relationships.

## Check document rhythm

- Consecutive sentences do not begin with the same two lemmas without reason.
- Paragraphs do not all begin with the same connective.
- Sentence lengths vary with information weight.
- Nominal endings are not used as the default ending for every sentence.

## Check terminology

- Product names, identifiers, values, and citations are unchanged.
- An unfamiliar term is explained near its first use.
- One concept uses one preferred term unless a distinction is intentional.
- An acronym is expanded when the audience cannot be expected to know it.

## Check the whole document

Read only headings and paragraph openings. The argument must still be
predictable. Then read the finished prose continuously and verify that local
rewrites did not damage transitions or create repeated explanations.

## Require a semantic review of edits

Run `scripts/invariants.py` on the immutable pre-edit file and the edited
file. It protects numbers and known quantity units in occurrence order,
uppercase identifiers, URL/link destinations, frontmatter, heading levels,
inline code, fenced/indented code, Markdown tables, HTML, and caller-supplied
`--protect` terms. The Markdown parser recognizes nested and long fences.
The check is conservative: it may block a legitimate reorder or protected
content correction. Such changes need separate authorization, not a
reviewer override of a failed invariant.

Mechanical equality cannot establish equivalent meaning. For every changed
passage, compare the original and edited text, including nearby context:

- `actors`: who performs or receives each action is unchanged
- `negation`: polarity and the scope of negation are unchanged
- `conditions`: prerequisites, exceptions, acceptance criteria, and approval states are unchanged
- `modality`: obligations, recommendations, permissions, and uncertainty are unchanged
- `scope`: limitations such as 「だけ」「すべて」「少なくとも」 are unchanged
- `causality`: causal and temporal relationships are unchanged
- `quantity_bindings`: each quantity still refers to the same object or action
- `terminology`: proper names and domain concepts are unchanged
- `structure`: section identity, order, quoted meaning, and traceability are unchanged

Record the review as JSON. Copy `before_sha256` and `after_sha256` from the
gate output, identify the actual reviewer, and set a check to `true` only
after inspecting it. Do not infer approval from a score, an unchanged token
count, or the absence of warnings. A review can be performed by the agent or
a human, but an agent review is not a human approval or a semantic proof.

```json
{
  "before_sha256": "<hash from the gate>",
  "after_sha256": "<hash from the gate>",
  "reviewer": "<actual reviewer identifier>",
  "checks": {
    "actors": false,
    "negation": false,
    "conditions": false,
    "modality": false,
    "scope": false,
    "causality": false,
    "quantity_bindings": false,
    "terminology": false,
    "structure": false
  }
}
```

Rerun the gate with `--review <review-file>`. Exit codes are 0 for `passed`,
1 for input/runtime errors, 2 for protected-content violations, and 3 for
missing, stale, incomplete, or rejected semantic reviews. Subsequent edits
invalidate the review. If equivalence is uncertain, keep the original
wording or report the unresolved concern.

## Convergence

The review is complete when:

- every finding has a `fix` or `keep` decision
- rerunning diagnostics produces no new actionable finding
- frozen invariants match the pre-edit document
- `scripts/invariants.py` returns `passed` with a current semantic review
  for changed text
- the reader can reach the requested outcome without an unstated inference
