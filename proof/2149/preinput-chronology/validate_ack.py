"""Pure extra predicate AFTER the existing complete chunk/status/hash verifier."""

from __future__ import annotations

import hashlib
import json
import math
import re

SOURCES = [
    "visualViewport:resize",
    "visualViewport:scroll",
    "window:resize",
    "window:scroll",
]
CONTEXT_KEYS = {
    "transport_run",
    "native_run",
    "operation_id",
    "trial_id",
    "request_sha256",
    "gate_instance",
    "label",
}


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def validate_start_ack(raw_payload: bytes, receipt_sha256: str, expected: dict) -> dict:
    """Raise ValueError on any mismatch. This never dispatches native work.

    raw_payload is the exact UTF8 bytes already reconstructed by the existing
    transport, not JSON reserialized from an ACK file. Existing status200/chunk/
    end/length/nonce/epoch/prev guards remain mandatory and are not replaced here.
    Expected values come from the private reviewed case manifest/ready receipt.
    """

    def require(ok, reason):
        if not ok:
            raise ValueError(reason)

    require(
        hashlib.sha256(raw_payload).hexdigest() == receipt_sha256,
        "raw ACK digest mismatch",
    )
    data = json.loads(raw_payload)
    context = expected["context"]
    require(set(context) == CONTEXT_KEYS, "expected exact context missing")
    require(
        context["transport_run"] == expected["transport_run"],
        "expected transport context mismatch",
    )
    require(
        context["gate_instance"] == expected["gate_instance"],
        "expected gate context mismatch",
    )
    require(
        context["label"] == "before-native-" + context["operation_id"]
        and len(context["label"]) <= 60,
        "expected label mismatch",
    )
    require(
        re.fullmatch(r"[a-z0-9-]{1,80}", context["native_run"]) is not None
        and re.fullmatch(r"[a-z0-9-]{1,42}", context["operation_id"]) is not None,
        "invalid expected native identity",
    )
    require(
        re.fullmatch(r"setup[0-9]*|sham1", context["trial_id"]) is not None
        and re.fullmatch(r"[a-f0-9]{64}", context["request_sha256"]) is not None,
        "invalid expected trial/request",
    )
    require(
        data["v"] == 1 and data["run"] == expected["transport_run"],
        "transport nonce mismatch",
    )
    require(data["instance"] == expected["bridge_instance"], "bridge instance mismatch")
    require(
        data["epoch"] == expected["epoch"] and data["prev"] == expected["prev_sha256"],
        "ACK chain mismatch",
    )
    require(
        data["document_identity"] == expected["document_identity"]
        and data["base_identity"] == expected["base_identity"],
        "document/base identity mismatch",
    )
    require(
        data["op"] == "mark" and data["label"] == context["label"],
        "ACK operation/label mismatch",
    )
    require(data["condition"] == "sham" and data["stopReason"] is None, "gate not live SHAM")
    require(
        data["touchCount"] == 0 and data["activePointerIds"] == [],
        "observed contacts active",
    )
    require(
        type(data["total_rows"]) is int and 0 < data["total_rows"] < 600,
        "shared row budget stopped",
    )
    starts = [row for row in data["rows"] if row.get("kind") == "chronology-start"]
    require(len(starts) == 1, "expected one start row in this ACK delta")
    start = starts[0]
    require(
        start["context"] == context and start["label"] == context["label"],
        "full native context mismatch",
    )
    require(start["at"] == start["chronology"]["at"], "start row clock mismatch")
    for status in [start["chronology"], data["chronology"]]:
        require(
            status["version"] == 1 and status["transport_run"] == expected["transport_run"],
            "observer nonce/version mismatch",
        )
        require(
            status["gate_instance"] == expected["gate_instance"],
            "observer instance mismatch",
        )
        require(
            status["sources"] == SOURCES
            and status["live_listeners"] == 4
            and status["error"] is None,
            "four observers not live",
        )
        require(
            status["condition"] == "sham" and status["visibility"] == "visible",
            "observer state invalid",
        )
        require(
            status["shared_cap"] == 600
            and type(status["shared_rows"]) is int
            and 0 < status["shared_rows"] < 600,
            "original row budget invalid",
        )
        require(
            status["script_path"] == expected["script_path"]
            and status["bundle_sha256"] == expected["bundle_sha256"],
            "served bundle identity mismatch",
        )
        require(
            status["time_origin"] == expected["time_origin"]
            and data["timeOrigin"] == expected["time_origin"],
            "clock origin mismatch",
        )
        require(
            status["original_start"] == expected["original_start"]
            and status["installed_at"] == expected["installed_at"],
            "installation/deadline mismatch",
        )
        require(
            all(
                finite(status[k])
                for k in [
                    "time_origin",
                    "original_start",
                    "installed_at",
                    "at",
                    "remaining_ms",
                ]
            ),
            "nonfinite observer clock",
        )
        require(
            status["installed_at"] <= status["at"] <= data["at"] and start["at"] <= status["at"],
            "start chronology ordering mismatch",
        )
        require(
            abs(status["remaining_ms"] - (120000 - status["at"] + status["original_start"]))
            <= 1e-6,
            "fresh/replaced deadline",
        )
        require(
            finite(expected["min_remaining_ms"]) and 2500 < expected["min_remaining_ms"] <= 120000,
            "missing reviewed native/observation budget",
        )
        require(
            finite(data["remaining_ms"])
            and min(data["remaining_ms"], status["remaining_ms"]) >= expected["min_remaining_ms"],
            "insufficient original lifetime",
        )
        baseline = status["viewport"]
        require(
            set(baseline)
            == {
                "scale",
                "width",
                "height",
                "offsetLeft",
                "offsetTop",
                "scrollX",
                "scrollY",
            },
            "viewport schema mismatch",
        )
        require(
            all(finite(value) for value in baseline.values())
            and baseline["width"] > 0
            and baseline["height"] > 0
            and abs(baseline["scale"] - 1) <= 1e-6,
            "invalid pre-input baseline",
        )
    require(
        start["sequence"] == start["chronology"]["shared_rows"]
        and start["chronology"]["shared_rows"] + 2 <= data["total_rows"],
        "start/current row ordering mismatch",
    )
    require(
        data["chronology"]["shared_rows"] == data["total_rows"],
        "current row count mismatch",
    )
    for row in data["rows"]:
        if row.get("kind") == "viewport-chronology":
            require(
                finite(row["viewport"]["scale"]) and abs(row["viewport"]["scale"] - 1) <= 1e-6,
                "recorded pre-input nonbaseline",
            )
        if row.get("kind") == "first-window-capture" and row.get("at", -1) >= start["at"]:
            require(False, "input already observed after start before ACK")
    return {
        "result": "PASS",
        "label": context["label"],
        "context": context,
        "gate_instance": expected["gate_instance"],
        "bridge_instance": expected["bridge_instance"],
        "limit": "Snapshot predicate only. Later pre-input rows must still be checked; native admission remains the reviewed Mac coordinator's job.",
    }


def validate_cleanup_ack(raw_payload: bytes, receipt_sha256: str, expected: dict) -> dict:
    """Additional remove predicate after the same existing complete ACK verifier."""
    if hashlib.sha256(raw_payload).hexdigest() != receipt_sha256:
        raise ValueError("raw cleanup ACK digest mismatch")
    data = json.loads(raw_payload)
    checks = [
        data["v"] == 1,
        data["run"] == expected["transport_run"],
        data["instance"] == expected["bridge_instance"],
        data["epoch"] == expected["epoch"],
        data["prev"] == expected["prev_sha256"],
        data["document_identity"] == expected["document_identity"],
        data["base_identity"] == expected["base_identity"],
        data["op"] == "remove",
        data["label"] == expected["label"],
        data["condition"] == "stopped",
        data["stopReason"] == "removed",
        data["cleanup"] is True,
        data["chronology"]["gate_instance"] == expected["gate_instance"],
        data["chronology"]["transport_run"] == expected["transport_run"],
        data["chronology"]["live_listeners"] == 0,
        data["chronology_cleanup"] == {"adapter_removed": True, "live_listeners": 0},
    ]
    if not all(checks):
        raise ValueError("remove ACK cleanup/identity mismatch")
    return {"result": "PASS", "cleanup": data["chronology_cleanup"]}
