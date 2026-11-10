# Finding ledger

File: `docs/reviews/<feature>-ledger.md` — one line per finding, append-only.

```
F-001 | HIGH | src/x.ts:42 | trust boundary: path not normalized | Open
F-002 | MED  | tests/x.test.ts:10 | missing illegal-transition case | Fixed in abc1234
F-003 | LOW  | docs/..:5 | wording | Rejected: out of scope
```

States: Open / Fixed / Rejected (reason required) / Deferred (target release).
Round header: `## Round N (base..head)`. Reviewers receive only: ledger Open items, the
diff since last round, and the contract. Stop after two consecutive rounds with no findings.
Dedupe: a finding already in the ledger is not reported again.
