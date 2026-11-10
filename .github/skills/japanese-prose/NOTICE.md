# Diagnostic dependency notices

This skill is an original kotonoha implementation and does not include source
code from `coji/natural-japanese`.

Morphological and syntactic analysis uses
[GiNZA](https://github.com/megagonlabs/ginza), its `ja_ginza` model, and
spaCy. These dependencies are resolved by `uv` when a diagnostic script is
run. GiNZA and its Japanese Universal Dependencies models are distributed
under the MIT License. spaCy is distributed under the MIT License.
SudachiPy and SudachiDict are distributed under the Apache License 2.0.
GiNZA documents the licenses of its remaining dependencies and training
datasets.

The implementation targets GiNZA 5.3.x and uses token surface forms, lemmas,
universal part-of-speech tags, dependency relationships, sentence boundaries,
and named-entity labels.

The edit-invariant gate uses
[markdown-it-py](https://github.com/executablebooks/markdown-it-py), distributed
under the MIT License, to parse Markdown without treating short fences
inside longer fenced code blocks as prose. Its dependencies are resolved by
`uv` when `scripts/invariants.py` is run.
