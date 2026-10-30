#!/usr/bin/env bash
# Runs a CI command. On failure, re-emits the useful part of its output as one
# workflow error annotation, so the failure is readable from the public
# checks API without downloading logs: every failing test (TAP "not ok" /
# Go "--- FAIL") with the lines after it, then the summary tail.
set -o pipefail
log=$(mktemp)
"$@" 2>&1 | tee "$log"
status=${PIPESTATUS[0]}
if [ "$status" -ne 0 ]; then
  {
    grep -n -E -A 18 '^\s*not ok |--- FAIL|^FAIL|panic:|error TS[0-9]+' "$log" | grep -v -E '^\S*-\s*$' | head -n 600
    echo "----- tail -----"
    tail -n 25 "$log"
  } > "$log.summary"
  msg=$(tr -d '\r' < "$log.summary" | head -c 60000 | sed -e 's/%/%25/g' | awk '{printf "%s%%0A", $0}')
  echo "::error title=FAILED ${1} ${2} ${3} ${4}::${msg}"
fi
exit "$status"
