# Design doc / ADR / RFC type

The recommended skeleton and checklist for a design decision record: a
document meant to earn a reviewer's agreement now and explain the "why" to
someone reading it long after the decision was made.

## Target reader

Someone reviewing to reach a decision, or someone later tracing the history
of that decision. The goal is "consensus" or "record", not a how-to guide
for implementation.

## Recommended skeleton (ADR format)

1. **Title**: a noun phrase naming the decision (e.g. "Adopt Redis for the
   async job queue").
2. **Status**: Proposed / Accepted / Rejected / Superseded — state one.
3. **Context**: why this decision is needed now. State the current
   constraints as facts, separate from opinion.
4. **Decision**: say what was chosen in one sentence first, then the
   details.
5. **Alternatives considered**: keep at least one, including why it was
   rejected. Prevents future re-litigation of "why not A".
6. **Consequences**: not just the upside — include the costs/constraints
   accepted.
7. **Open questions** (optional): leave unresolved points during review.

## Design doc (RFC format, pre-implementation) specifics

- Stating "what we will *not* build" (Non-Goals) before "what we will build"
  keeps review discussion from drifting.
- If there are diagrams (sequence/architecture), make the diagram carry the
  primary information; keep the prose as supporting detail only.

## Checklist

- [ ] Is the decision stated in one sentence up front?
- [ ] Are alternatives and their rejection reasons present (not written as
      "the only option")?
- [ ] Are trade-offs (what's given up) stated explicitly?
- [ ] Are Non-Goals stated (for RFCs)?
- [ ] Does the status reflect the current state?
