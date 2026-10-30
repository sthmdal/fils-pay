#!/usr/bin/env bash
# Runs a CI command. On failure, re-emits the tail of its output as one
# workflow error annotation, so the failure is readable from the public
# checks API without downloading logs.
set -o pipefail
log=$(mktemp)
"$@" 2>&1 | tee "$log"
status=${PIPESTATUS[0]}
if [ "$status" -ne 0 ]; then
  msg=$(tail -n 150 "$log" | tr -d '\r' | sed -e 's/%/%25/g' | awk '{printf "%s%%0A", $0}')
  echo "::error title=FAILED ${1} ${2} ${3}::${msg}"
fi
exit "$status"
