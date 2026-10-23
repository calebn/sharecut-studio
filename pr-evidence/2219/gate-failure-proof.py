import json
import subprocess
import sys
from pathlib import Path

head = "9ced2088f242c4daf3c050fbf8ec51aa375ece5f"
stand_ins = []
receipts = []
cases = [
    ("helper-exit-1", 1, {"mergeable": True, "head_sha": head, "blockers": []}),
    (
        "http-503-null-head",
        1,
        {"mergeable": False, "head_sha": None, "blockers": ["GitHub HTTP 503"]},
    ),
    ("passing-control", 0, {"mergeable": True, "head_sha": head, "blockers": []}),
]
for name, exit_status, payload in cases:
    command = [
        sys.executable,
        "-c",
        "import json,sys; print(json.dumps(json.loads(sys.argv[1]))); sys.exit(int(sys.argv[2]))",
        json.dumps(payload),
        str(exit_status),
    ]
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    gate = json.loads(result.stdout)
    before = len(stand_ins)
    if (
        result.returncode == 0
        and gate.get("mergeable") is True
        and gate.get("head_sha") == head
        and gate.get("blockers") == []
    ):
        stand_ins.append(name)
    receipts.append(
        {
            "case": name,
            "command": command,
            "exit_status": result.returncode,
            "json": gate,
            "stand_in_invocations": len(stand_ins) - before,
        }
    )
assert [receipt["stand_in_invocations"] for receipt in receipts] == [0, 0, 1]
report = {
    "expected_head": head,
    "receipts": receipts,
    "stand_in_count": len(stand_ins),
    "real_merge_invocations": 0,
}
Path("/workspace/lane2-state/2219-gate-failure-proof.json").write_text(
    json.dumps(report, indent=2) + "\n"
)
print(json.dumps(report, indent=2))
