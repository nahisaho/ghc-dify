# Code comments / docstrings type

The principles and checklist for in-code documentation, where the same
"why, not what" and completeness discipline applies at the scale of a
single comment or docstring.

## Target reader

Whoever changes this code next (including your future self). The goal is
to convey "why it's written this way" — the "what" should be conveyed by
the code itself.

## Principles

1. **Write "why", not "what"**: don't repeat in a comment what the code
   already shows. Explain why this implementation/ordering/exception
   handling is necessary.
2. **Write docstrings from the caller's perspective**: order arguments,
   return values, exceptions, and side effects by what the *caller* wants
   to know, not by internal implementation order.
3. **Give `TODO`/`FIXME` a reason and, if possible, an issue link**:
   `TODO: fix later` carries zero information. Write
   `TODO(#123): running synchronously, async pending queue rollout`
   instead.
4. **Don't write comments that state the obvious**: delete comments like
   `i += 1  # increment i by 1`.
5. **Only comment on non-obvious choices**: implementations that look like
   a detour, special code for performance reasons, or external constraints
   (API quirks, past-bug workarounds) must always get a comment.

## Checklist

- [ ] Are there redundant comments left where the code's intent is clear
      even without them?
- [ ] Do non-obvious implementations have their reasoning explained?
- [ ] Is docstring argument order driven by the caller's concerns rather
      than internal variable order?
- [ ] Do `TODO`/`FIXME` items have a reason or a tracking reference
      (issue number, etc.)?
