#!/bin/sh
# PreToolUse guard for the Agent tool: every launch must name a model, and the expensive
# tiers need a stated reason in the description. See docs/contributing.md § Agent model guard.
#   opus  -> judgment work: verify/verifier/review/audit/judgment/design decision
#   fable -> deliberate escalation only: description must say "hardest" or "escalat..."
# Fails open (allows the launch, prints a warning on stderr) when jq is missing.
if ! command -v jq >/dev/null 2>&1; then
  echo "agent-model-guard: jq not found, model tiers are not enforced for this launch." >&2
  exit 0
fi
input=$(cat)
model=$(printf '%s' "$input" | jq -r '.tool_input.model // ""')
desc=$(printf '%s' "$input" | jq -r '.tool_input.description // ""' | tr '[:upper:]' '[:lower:]')
stype=$(printf '%s' "$input" | jq -r '.tool_input.subagent_type // ""')

deny() {
  jq -n --arg r "$1" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
  exit 0
}

# Read-only search/plan helpers carry their own fixed model.
case "$stype" in Explore|Plan|claude-code-guide|statusline-setup) exit 0 ;; esac

[ -z "$model" ] && deny "Agent launch needs an explicit model (pstack tiers: sonnet for implementation/bug-fix/feature/rebase, haiku for mechanical steps, opus for verification/judgment, fable only for a stated hardest-task escalation)."

case "$model" in
  *fable*)
    case "$desc" in
      *hardest*|*escalat*) exit 0 ;;
      *) deny "fable is the hardest-task tier. Put 'hardest' or 'escalation' and the reason in the description, or use sonnet (implementation) / opus (verification, judgment)." ;;
    esac ;;
  *opus*)
    case "$desc" in
      *verif*|*review*|*audit*|*judg*|*design*|*hardest*|*escalat*) exit 0 ;;
      *) deny "opus is the judgment tier (verify, review, audit, judgment, design). This description reads as implementation: use sonnet, or haiku for mechanical work. If this really needs opus, say why in the description." ;;
    esac ;;
esac
exit 0
