"""Synthetic ACKs produced by the actual gate and adapter, without native work."""

import copy
import hashlib
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from validate_ack import validate_cleanup_ack, validate_start_ack


class AckTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / "ack.json"
            subprocess.run(
                [
                    "node",
                    str(Path(__file__).with_name("test_gate.cjs")),
                    "--ack-fixture",
                    str(output),
                ],
                check=True,
                capture_output=True,
                text=True,
            )
            cls.fixture = json.loads(output.read_text())

    def validate(self, change=None, expected_change=None):
        data = json.loads(self.fixture["raw_payload"])
        expected = copy.deepcopy(self.fixture["expected"])
        if change:
            change(data)
        if expected_change:
            expected_change(expected)
        raw = json.dumps(data, separators=(",", ":")).encode()
        return validate_start_ack(raw, hashlib.sha256(raw).hexdigest(), expected)

    def test_actual_gate_ack_passes(self):
        self.assertEqual(self.validate()["result"], "PASS")

    def test_raw_digest_required(self):
        with self.assertRaises(ValueError):
            validate_start_ack(
                self.fixture["raw_payload"].encode(), "0" * 64, self.fixture["expected"]
            )

    def test_envelope_identity_and_chain(self):
        for key, value in [
            ("run", "wrong"),
            ("instance", "wrong"),
            ("epoch", 2),
            ("prev", "wrong"),
            ("op", "export"),
            ("label", "id-only"),
            ("condition", "armed"),
            ("stopReason", "timeout"),
            ("touchCount", 1),
            ("activePointerIds", [1]),
            ("total_rows", 600),
            ("document_identity", {}),
            ("base_identity", {}),
        ]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.validate(lambda d, key=key, value=value: d.update({key: value}))

    def test_full_context_not_id_presence(self):
        for key in self.fixture["expected"]["context"]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.validate(lambda d, key=key: d["rows"][0]["context"].update({key: "wrong"}))

    def test_live_sources_state_deadline_and_bundle(self):
        cases = [
            ("live_listeners", 3),
            ("sources", []),
            ("condition", "armed"),
            ("visibility", "hidden"),
            ("error", "clock-changed"),
            ("shared_rows", -1),
            ("shared_rows", 599),
            ("shared_cap", 601),
            ("time_origin", 1),
            ("installed_at", -1),
            ("original_start", -1),
            ("at", -1),
            ("remaining_ms", 120001),
            ("script_path", "/other.js"),
            ("bundle_sha256", "0" * 64),
        ]
        for key, value in cases:
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.validate(
                    lambda d, key=key, value=value: d["rows"][0]["chronology"].update({key: value})
                )

    def test_original_budget_cannot_reset(self):
        with self.assertRaises(ValueError):
            self.validate(lambda d: d.update(remaining_ms=2499))
        with self.assertRaises(ValueError):
            self.validate(expected_change=lambda e: e.update(min_remaining_ms=2500))

    def test_baseline_and_nonfinite_rejected(self):
        for key, value in [
            ("scale", 1.6),
            ("scale", float("nan")),
            ("width", 0),
            ("height", float("inf")),
            ("scrollX", float("nan")),
        ]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.validate(
                    lambda d, key=key, value=value: d["rows"][0]["chronology"]["viewport"].update(
                        {key: value}
                    )
                )

    def test_pre_ack_excursion_retained_and_refused(self):
        def excursion(data):
            data["rows"].insert(
                0,
                {"kind": "viewport-chronology", "at": 0.2, "viewport": {"scale": 1.6}},
            )

        with self.assertRaises(ValueError):
            self.validate(excursion)

    def test_fresher_current_snapshot_is_mandatory(self):
        for key, value in [
            ("live_listeners", 0),
            ("condition", "armed"),
            ("error", "clock-changed"),
            ("time_origin", 0),
            ("shared_rows", 1),
            ("gate_instance", "wrong"),
            ("transport_run", "wrong"),
        ]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.validate(lambda d, key=key, value=value: d["chronology"].update({key: value}))
        with self.assertRaises(ValueError):
            self.validate(lambda d: d["chronology"]["viewport"].update(scale=1.6))
        with self.assertRaises((ValueError, KeyError)):
            self.validate(lambda d: d.pop("chronology"))

    def test_cleanup_ack_normal_and_negative(self):
        data = json.loads(self.fixture["raw_payload"])
        expected = copy.deepcopy(self.fixture["expected"])
        expected["label"] = "cleanup"
        data.update(
            op="remove",
            label="cleanup",
            condition="stopped",
            stopReason="removed",
            cleanup=True,
            chronology_cleanup={"adapter_removed": True, "live_listeners": 0},
        )
        data["chronology"]["live_listeners"] = 0

        def check():
            raw = json.dumps(data).encode()
            return validate_cleanup_ack(raw, hashlib.sha256(raw).hexdigest(), expected)

        self.assertEqual(check()["result"], "PASS")
        data["chronology_cleanup"]["adapter_removed"] = False
        with self.assertRaises(ValueError):
            check()
        data["chronology_cleanup"]["adapter_removed"] = True
        data["chronology"]["live_listeners"] = 4
        with self.assertRaises(ValueError):
            check()

    def test_input_after_start_before_ack_refused(self):
        with self.assertRaises(ValueError):
            self.validate(lambda d: d["rows"].append({"kind": "first-window-capture", "at": 1}))

    def test_missing_duplicate_and_malformed_start_fail_closed(self):
        for change in [
            lambda d: d.update(rows=[]),
            lambda d: d["rows"].append(copy.deepcopy(d["rows"][0])),
        ]:
            with self.assertRaises(ValueError):
                self.validate(change)
        with self.assertRaises((ValueError, KeyError, TypeError)):
            self.validate(lambda d: d["rows"][0].pop("chronology"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
