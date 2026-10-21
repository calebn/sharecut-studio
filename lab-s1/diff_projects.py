"""usage: diff_projects.py base.json new.json -- deep compare ignoring ids/timestamps, floats within 1 ms."""
import json, sys
IGNORE = {"id", "applied_at", "at", "created_at", "decision_ids", "snapshot_file", "started_at", "finished_at", "updated_at", "audio_mtime_ns"}
a, b = (json.load(open(p)) for p in sys.argv[1:3])
diffs = []
def cmp(x, y, path):
    if isinstance(x, dict) and isinstance(y, dict):
        for k in sorted((set(x) | set(y)) - IGNORE):
            if k not in x or k not in y: diffs.append((path + "/" + k, x.get(k, "<absent>"), y.get(k, "<absent>")))
            else: cmp(x[k], y[k], path + "/" + k)
    elif isinstance(x, list) and isinstance(y, list):
        if len(x) != len(y): diffs.append((path, f"len {len(x)}", f"len {len(y)}")); return
        for i, (p, q) in enumerate(zip(x, y)): cmp(p, q, f"{path}[{i}]")
    elif isinstance(x, (int, float)) and isinstance(y, (int, float)) and not isinstance(x, bool):
        if abs(x - y) > 1e-3: diffs.append((path, x, y))
    elif x != y: diffs.append((path, x, y))
cmp(a, b, "")
log = a["editorial"]["edit_log"]
print("edit_log entries", len(log), len(b["editorial"]["edit_log"]), "clips", len(a["timeline"]["clips"]), len(b["timeline"]["clips"]), "decisions", len(a["editorial"]["edit_decisions"]), len(b["editorial"]["edit_decisions"]), "decisions applied flag", sum(bool(d["applied"]) for d in a["editorial"]["edit_decisions"]), sum(bool(d["applied"]) for d in b["editorial"]["edit_decisions"]))
for d in diffs[:30]: print("DIFF", d)
print("RESULT", "IDENTICAL (ids/timestamps ignored, floats within 1 ms)" if not diffs else f"{len(diffs)} DIFFERENCES")
