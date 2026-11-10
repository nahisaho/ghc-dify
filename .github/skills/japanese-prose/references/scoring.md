# Diagnostic scoring

The prose lint starts at 100 and subtracts:

- 10 points for each `critical` finding
- 4 points for each `warning` finding
- 1 point for each `info` finding

The minimum is 0. Scores compare repeated runs of the same document and
configuration; they do not compare authors, genres, or unrelated documents.

Use these bands only as triage:

| Score | Interpretation |
|---|---|
| 90–100 | Few mechanically detectable review targets |
| 75–89 | Several passages need contextual review |
| 50–74 | Reading load or repeated patterns are widespread |
| 0–49 | Review the document section by section before publication |

A high score does not prove that facts are correct, the argument is complete,
or the prose is natural. A low score does not require every finding to be
changed. Always report the finding categories and contextual decisions beside
the score.

Proofreading findings and style/readability findings contribute to the same
triage score, but they are not interchangeable measures of quality. Report
the categories separately. Do not use this score as typo-detection recall,
correction accuracy, semantic fidelity, or evidence that an LLM-assisted
rewrite is better. A correctly repaired typo may leave the score unchanged.
