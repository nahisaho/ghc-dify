#!/usr/bin/env bash
# Compact gate: runs typecheck/lint/test (whichever exist) and prints PASS/FAIL + only the tail of failures.
# Usage: gate.sh [test-filter]   Env: GATE_PM (npm|pnpm|yarn), GATE_TAIL (lines, default 25)
set -u
PM="${GATE_PM:-}"
if [ -z "$PM" ]; then
  if [ -f pnpm-lock.yaml ]; then PM=pnpm; elif [ -f yarn.lock ]; then PM=yarn; else PM=npm; fi
fi
TAIL="${GATE_TAIL:-25}"
FILTER="${1:-}"
fail=0
has() { node -e "process.exit((require('./package.json').scripts||{})['$1']?0:1)" 2>/dev/null; }
for step in typecheck lint test; do
  if ! has "$step"; then echo "SKIP  $step (no script)"; continue; fi
  if [ "$step" = test ] && [ -n "$FILTER" ]; then cmd=("$PM" run test -- "$FILTER"); else cmd=("$PM" run "$step"); fi
  out=$("${cmd[@]}" 2>&1); rc=$?
  if [ $rc -eq 0 ]; then echo "PASS  $step"; else echo "FAIL  $step (exit $rc)"; echo "$out" | tail -n "$TAIL"; fail=1; fi
done
# Skipped steps are reported, never counted as success.
[ $fail -eq 0 ] && echo "GATE: PASS (skipped steps above were NOT run)" || echo "GATE: FAIL"
exit $fail
