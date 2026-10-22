#!/bin/sh
# Runs the guard kept with the project's receipts when that mount exists (cloud project threads)
# and allows silently everywhere else.
# The guard prints a deny decision or nothing; any other exit from it is treated as a deny.
G="${MERGE_GUARD_SCRIPT:-/mnt/project-files/trails/tools/merge-guard.sh}"
[ -f "$G" ] || exit 0
sh "$G"
if [ $? -ne 0 ]; then
  printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"the merge guard failed to run, so this call is refused; tell the coordinator"}}'
fi
exit 0
