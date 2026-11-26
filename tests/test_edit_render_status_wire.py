"""Pin the exact wire output of EditService.render_status for projects with no premix."""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

import edit_wire_render as rr
from edit_wire_helpers import build_workspace, normalize
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import EditService

pytestmark = pytest.mark.unscoped_ok

_SCENARIOS: dict[str, Callable[[Path], ProjectWorkspace]] = {
    "never-rendered": lambda root: build_workspace(root),
    "never-rendered-with-edits": lambda root: build_workspace(root, approve=("m1", "r1")),
    "never-rendered-pending-and-trim": lambda root: build_workspace(
        root, approve=("m1",), pending=True, trim=True
    ),
    "stems-without-hash": lambda root: rr.stems(build_workspace(root)),
    "stems-one-hashed": lambda root: rr.hashed(rr.stems(build_workspace(root)), "host"),
    "stems-hashed-no-premix": lambda root: rr.hashed(
        rr.stems(build_workspace(root)), "host", "guest"
    ),
    "stems-behind-an-applied-cut": lambda root: rr.hashed(
        rr.stems(build_workspace(root, approve=("r1",))), "host", "guest"
    ),
    "host-stem-longer-than-timeline": lambda root: rr.hashed(
        rr.stems(build_workspace(root), host=7.0), "host", "guest"
    ),
}

_EXPECTED: dict[str, dict[str, Any]] = {
    "never-rendered": {
        "invalidations": [],
        "needs_rerender": True,
        "premix": {
            "exists": False,
            "is_stale": False,
            "path": None,
            "stale_vs_mix": False,
            "stale_vs_stems": False,
        },
        "reconciliation": {
            "fingerprint": "<hash:0>",
            "last_reconciliation_hash": None,
            "reconciliation_stale_flag": False,
            "stale": True,
        },
        "tracks": {
            "guest": {
                "balance_measured_lufs": None,
                "balance_stale": None,
                "balance_ungated": None,
                "duration_mismatch": False,
                "expected_duration_sec": None,
                "render_hash": "<hash:1>",
                "stem_duration_sec": None,
                "stem_exists": False,
                "stem_is_fresh": False,
                "stem_path": None,
                "stored_hash": None,
            },
            "host": {
                "balance_measured_lufs": None,
                "balance_stale": None,
                "balance_ungated": None,
                "duration_mismatch": False,
                "expected_duration_sec": None,
                "render_hash": "<hash:2>",
                "stem_duration_sec": None,
                "stem_exists": False,
                "stem_is_fresh": False,
                "stem_path": None,
                "stored_hash": None,
            },
        },
    },
    "never-rendered-with-edits": {
        "invalidations": [
            {
                "at": "<ts>",
                "id": "<inv:0>",
                "reason": "mute",
                "timeline_end": 1.4,
                "timeline_start": 1.0,
                "track_ids": ["host"],
            },
            {
                "at": "<ts>",
                "id": "<inv:1>",
                "reason": "cut",
                "timeline_end": 3.4,
                "timeline_start": 3.0,
                "track_ids": ["host", "guest"],
            },
        ],
        "needs_rerender": True,
        "premix": {
            "exists": False,
            "is_stale": False,
            "path": None,
            "stale_vs_mix": False,
            "stale_vs_stems": False,
        },
        "reconciliation": {
            "fingerprint": "<hash:2>",
            "last_reconciliation_hash": None,
            "reconciliation_stale_flag": True,
            "stale": True,
        },
        "tracks": {
            "guest": {
                "balance_measured_lufs": None,
                "balance_stale": None,
                "balance_ungated": None,
                "duration_mismatch": False,
                "expected_duration_sec": None,
                "render_hash": "<hash:3>",
                "stem_duration_sec": None,
                "stem_exists": False,
                "stem_is_fresh": False,
                "stem_path": None,
                "stored_hash": None,
            },
            "host": {
                "balance_measured_lufs": None,
                "balance_stale": None,
                "balance_ungated": None,
                "duration_mismatch": False,
                "expected_duration_sec": None,
                "render_hash": "<hash:4>",
                "stem_duration_sec": None,
                "stem_exists": False,
                "stem_is_fresh": False,
                "stem_path": None,
                "stored_hash": None,
            },
        },
    },
    "never-rendered-pending-and-trim": {
        "invalidations": [
            {
                "at": "<ts>",
                "id": "<inv:0>",
                "reason": "mute",
                "timeline_end": 1.4,
                "timeline_start": 1.0,
                "track_ids": ["host"],
            }
        ],
        "needs_rerender": True,
        "premix": {
            "exists": False,
            "is_stale": False,
            "path": None,
            "stale_vs_mix": False,
            "stale_vs_stems": False,
        },
        "reconciliation": {
            "fingerprint": "<hash:1>",
            "last_reconciliation_hash": None,
            "reconciliation_stale_flag": True,
            "stale": True,
        },
        "tracks": {
            "guest": {
                "balance_measured_lufs": None,
                "balance_stale": None,
                "balance_ungated": None,
                "duration_mismatch": False,
                "expected_duration_sec": None,
                "render_hash": "<hash:2>",
                "stem_duration_sec": None,
                "stem_exists": False,
                "stem_is_fresh": False,
                "stem_path": None,
                "stored_hash": None,
            },
            "host": {
                "balance_measured_lufs": None,
                "balance_stale": None,
                "balance_ungated": None,
                "duration_mismatch": False,
                "expected_duration_sec": None,
                "render_hash": "<hash:3>",
                "stem_duration_sec": None,
                "stem_exists": False,
                "stem_is_fresh": False,
                "stem_path": None,
                "stored_hash": None,
            },
        },
    },
    "stems-without-hash": {
        "invalidations": [],
        "needs_rerender": True,
        "premix": {
            "exists": False,
            "is_stale": False,
            "path": None,
            "stale_vs_mix": False,
            "stale_vs_stems": False,
        },
        "reconciliation": {
            "fingerprint": "<hash:0>",
            "last_reconciliation_hash": None,
            "reconciliation_stale_flag": False,
            "stale": True,
        },
        "tracks": {
            "guest": {
                "balance_measured_lufs": None,
                "balance_stale": None,
                "balance_ungated": None,
                "duration_mismatch": False,
                "expected_duration_sec": 6.0,
                "render_hash": "<hash:1>",
                "stem_duration_sec": 6.0,
                "stem_exists": True,
                "stem_is_fresh": False,
                "stem_path": "<ws>/artifacts/tracks/guest.wav",
                "stored_hash": None,
            },
            "host": {
                "balance_measured_lufs": None,
                "balance_stale": None,
                "balance_ungated": None,
                "duration_mismatch": False,
                "expected_duration_sec": 6.0,
                "render_hash": "<hash:2>",
                "stem_duration_sec": 6.0,
                "stem_exists": True,
                "stem_is_fresh": False,
                "stem_path": "<ws>/artifacts/tracks/host.wav",
                "stored_hash": None,
            },
        },
    },
    "stems-one-hashed": {
        "invalidations": [],
        "needs_rerender": True,
        "premix": {
            "exists": False,
            "is_stale": False,
            "path": None,
            "stale_vs_mix": False,
            "stale_vs_stems": False,
        },
        "reconciliation": {
            "fingerprint": "<hash:0>",
            "last_reconciliation_hash": None,
            "reconciliation_stale_flag": False,
            "stale": True,
        },
        "tracks": {
            "guest": {
                "balance_measured_lufs": None,
                "balance_stale": None,
                "balance_ungated": None,
                "duration_mismatch": False,
                "expected_duration_sec": 6.0,
                "render_hash": "<hash:1>",
                "stem_duration_sec": 6.0,
                "stem_exists": True,
                "stem_is_fresh": False,
                "stem_path": "<ws>/artifacts/tracks/guest.wav",
                "stored_hash": None,
            },
            "host": {
                "balance_measured_lufs": None,
                "balance_stale": None,
                "balance_ungated": None,
                "duration_mismatch": False,
                "expected_duration_sec": 6.0,
                "render_hash": "<hash:2>",
                "stem_duration_sec": 6.0,
                "stem_exists": True,
                "stem_is_fresh": True,
                "stem_path": "<ws>/artifacts/tracks/host.wav",
                "stored_hash": "<hash:2>",
            },
        },
    },
    "stems-hashed-no-premix": {
        "invalidations": [],
        "needs_rerender": True,
        "premix": {
            "exists": False,
            "is_stale": False,
            "path": None,
            "stale_vs_mix": False,
            "stale_vs_stems": False,
        },
        "reconciliation": {
            "fingerprint": "<hash:0>",
            "last_reconciliation_hash": None,
            "reconciliation_stale_flag": False,
            "stale": True,
        },
        "tracks": {
            "guest": {
                "balance_measured_lufs": None,
                "balance_stale": None,
                "balance_ungated": None,
                "duration_mismatch": False,
                "expected_duration_sec": 6.0,
                "render_hash": "<hash:1>",
                "stem_duration_sec": 6.0,
                "stem_exists": True,
                "stem_is_fresh": True,
                "stem_path": "<ws>/artifacts/tracks/guest.wav",
                "stored_hash": "<hash:1>",
            },
            "host": {
                "balance_measured_lufs": None,
                "balance_stale": None,
                "balance_ungated": None,
                "duration_mismatch": False,
                "expected_duration_sec": 6.0,
                "render_hash": "<hash:2>",
                "stem_duration_sec": 6.0,
                "stem_exists": True,
                "stem_is_fresh": True,
                "stem_path": "<ws>/artifacts/tracks/host.wav",
                "stored_hash": "<hash:2>",
            },
        },
    },
    "stems-behind-an-applied-cut": {
        "invalidations": [
            {
                "at": "<ts>",
                "id": "<inv:0>",
                "reason": "cut",
                "timeline_end": 3.4,
                "timeline_start": 3.0,
                "track_ids": ["host", "guest"],
            }
        ],
        "needs_rerender": True,
        "premix": {
            "exists": False,
            "is_stale": False,
            "path": None,
            "stale_vs_mix": False,
            "stale_vs_stems": False,
        },
        "reconciliation": {
            "fingerprint": "<hash:1>",
            "last_reconciliation_hash": None,
            "reconciliation_stale_flag": True,
            "stale": True,
        },
        "tracks": {
            "guest": {
                "balance_measured_lufs": None,
                "balance_stale": None,
                "balance_ungated": None,
                "duration_mismatch": True,
                "expected_duration_sec": 5.6,
                "render_hash": "<hash:2>",
                "stem_duration_sec": 6.0,
                "stem_exists": True,
                "stem_is_fresh": False,
                "stem_path": "<ws>/artifacts/tracks/guest.wav",
                "stored_hash": "<hash:2>",
            },
            "host": {
                "balance_measured_lufs": None,
                "balance_stale": None,
                "balance_ungated": None,
                "duration_mismatch": True,
                "expected_duration_sec": 5.6,
                "render_hash": "<hash:3>",
                "stem_duration_sec": 6.0,
                "stem_exists": True,
                "stem_is_fresh": False,
                "stem_path": "<ws>/artifacts/tracks/host.wav",
                "stored_hash": "<hash:3>",
            },
        },
    },
    "host-stem-longer-than-timeline": {
        "invalidations": [],
        "needs_rerender": True,
        "premix": {
            "exists": False,
            "is_stale": False,
            "path": None,
            "stale_vs_mix": False,
            "stale_vs_stems": False,
        },
        "reconciliation": {
            "fingerprint": "<hash:0>",
            "last_reconciliation_hash": None,
            "reconciliation_stale_flag": False,
            "stale": True,
        },
        "tracks": {
            "guest": {
                "balance_measured_lufs": None,
                "balance_stale": None,
                "balance_ungated": None,
                "duration_mismatch": False,
                "expected_duration_sec": 6.0,
                "render_hash": "<hash:1>",
                "stem_duration_sec": 6.0,
                "stem_exists": True,
                "stem_is_fresh": True,
                "stem_path": "<ws>/artifacts/tracks/guest.wav",
                "stored_hash": "<hash:1>",
            },
            "host": {
                "balance_measured_lufs": None,
                "balance_stale": None,
                "balance_ungated": None,
                "duration_mismatch": True,
                "expected_duration_sec": 6.0,
                "render_hash": "<hash:2>",
                "stem_duration_sec": 7.0,
                "stem_exists": True,
                "stem_is_fresh": False,
                "stem_path": "<ws>/artifacts/tracks/host.wav",
                "stored_hash": "<hash:2>",
            },
        },
    },
}


@pytest.mark.parametrize("surface", list(rr.STATUS_SURFACES))
@pytest.mark.parametrize("name", list(_SCENARIOS))
def test_render_status_wire(tmp_path, name, surface):
    ws = _SCENARIOS[name](tmp_path)
    assert normalize(rr.STATUS_SURFACES[surface](ws), ws) == _EXPECTED[name]


def test_render_status_is_a_plain_dict_with_five_keys(tmp_path):
    result = EditService(build_workspace(tmp_path)).render_status()
    assert type(result) is dict
    assert sorted(result) == [
        "invalidations",
        "needs_rerender",
        "premix",
        "reconciliation",
        "tracks",
    ]


def test_gui_view_adds_only_proxy_hashes(tmp_path):
    ws = rr.hashed(rr.stems(build_workspace(tmp_path)), "host", "guest")
    status = rr.web_view(ws)["render_status"]
    proxy = status.pop("proxy_hashes")
    assert normalize(status, ws) == normalize(EditService(ws).render_status(), ws)
    assert sorted(proxy) == ["guest", "host"]
    assert all(len(value) == 16 for value in proxy.values())
